import {
  connect,
  type Options as RealBrowserOption,
} from "puppeteer-real-browser";
import type { GoToOptions, HTTPResponse } from "rebrowser-puppeteer-core";
import type { Browser, Page } from "rebrowser-puppeteer-core";
import { PuppeteerBlocker } from "@ghostery/adblocker-puppeteer";
import { load } from "cheerio";
import { pageSemaphore } from "./semaphore.js";

const realBrowserOption: RealBrowserOption = {
  args: ["--start-maximized"],
  turnstile: true,
  headless: false,
  // disableXvfb: true,
  // ignoreAllFlags:true,
  customConfig: {},
  connectOption: {
    defaultViewport: null,
  },
  plugins: [],
  // read proxy settings from environment variables if available
  proxy: parseProxy(process.env.PROXY_URI),
};

function parseProxy(proxyString: string | undefined) {
  if (!proxyString) {
    return;
  }

  try {
    const url = new URL(proxyString);
    return {
      host: url.hostname,
      port: Number(url.port),
      username: url.username,
      password: url.password,
    };
  } catch (error) {
    console.error("Failed to parse proxy string:", error);
    return;
  }
}

let browserInstance: Browser | null = null;
let blocker: PuppeteerBlocker | null = null;

async function getBrowser(): Promise<{
  browser: Browser;
  blocker: PuppeteerBlocker;
}> {
  if (!browserInstance || !blocker) {
    const { browser } = await connect(realBrowserOption);
    browserInstance = browser;
    blocker = await PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch);
  }
  return {
    browser: browserInstance,
    blocker: blocker,
  };
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    try {
      await browserInstance.close();
      browserInstance = null;
      blocker = null;
    } catch (error) {
      console.error("Error closing browser:", error);
    }
  }
}

export type Options = {
  url: string | string[];
  selector: string;
} & GoToOptions;

export type RawResponse = {
  body: Uint8Array;
  contentType?: string;
  status: number;
};

async function tryGetHtmlFromResponse(
  page: Page,
  url: string,
  selector: string,
  timeout: number
) {
  return new Promise<string>((resolve, reject) => {
    const responseHandler = async (response: HTTPResponse) => {
      try {
        const responseUrl = response.url();
        const contentType = response.headers()["content-type"] || "";
        const request = response.request();
        const resourceType = request.resourceType();
        const method = request.method();

        if (
          responseUrl === url &&
          resourceType === "document" &&
          (contentType.includes("text/html") || !contentType)
        ) {
          const text = await response.text().catch(() => null);
          if (!text) {
            return;
          }

          const $ = load(text);
          if ($(selector).length > 0) {
            page.off("response", responseHandler);
            console.log(
              `(tryGetHtmlFromResponse): Found selector "${selector}" in response for ${url}`
            );
            resolve(text);
          }
        }
      } catch (error) {
        console.error(`Error processing response for ${url}:`, error);
      }
    };

    page.on("response", responseHandler);

    setTimeout(() => {
      page.off("response", responseHandler);
      reject(
        new Error(
          `(tryGetHtmlFromResponse): Timeout waiting for selector "${selector}" on page ${url}`
        )
      );
    }, timeout);
  });
}

async function getHtmlFromPageContent(
  page: Page,
  url: string,
  selector: string,
  timeout: number
): Promise<string> {
  let verified = false;
  const startDate = Date.now();
  while (Date.now() - startDate < timeout) {
    if (page.isClosed()) {
      throw new Error(`Page closed unexpectedly while waiting for selector`);
    }

    const res = await page.$(selector);
    if (res) {
      verified = true;
      break;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!verified) {
    throw new Error(
      `(getHtmlFromPageContent): Timeout waiting for selector "${selector}" on page ${url}`
    );
  }

  const content = await page.content();
  console.log(
    `(getHtmlFromPageContent): Found selector "${selector}" in page content for ${url}`
  );
  return content;
}

async function fetchSingleUrl(
  browser: Browser,
  blocker: PuppeteerBlocker,
  url: string,
  selector: string,
  goToOptions: GoToOptions
): Promise<string> {
  await pageSemaphore.acquire();

  let page: Page | undefined;
  try {
    console.log(`Fetching URL: ${url}`);
    page = await browser.newPage();
    await blocker.enableBlockingInPage(page as any);

    const timeout = goToOptions.timeout || 30000;
    const currentPage = page;

    const responsePromise = tryGetHtmlFromResponse(
      currentPage,
      url,
      selector,
      timeout
    );

    const gotoPromise = currentPage.goto(url, goToOptions).then(async () => {
      return await getHtmlFromPageContent(currentPage, url, selector, timeout);
    });

    const content = await Promise.any([responsePromise, gotoPromise]);

    return content;
  } catch (error) {
    throw error;
  } finally {
    if (page) {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch (err) {
        console.error(`Failed to close page for ${url}:`, err);
      }
    }

    pageSemaphore.release();
  }
}

async function fetchSingleUrlWithRetry(
  browser: Browser,
  blocker: PuppeteerBlocker,
  url: string,
  selector: string,
  goToOptions: GoToOptions,
  maxRetries: number = 3
): Promise<string> {
  let lastError: Error | unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${maxRetries} for ${url}`);
      const content = await fetchSingleUrl(
        browser,
        blocker,
        url,
        selector,
        goToOptions
      );
      return content;
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        console.error(
          `Failed to fetch ${url} after ${maxRetries} attempts:`,
          error
        );
        throw error;
      }

      // Wait before retrying (exponential backoff)
      const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
      console.log(`Retrying in ${waitTime}ms...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  throw lastError;
}

async function fetchRawResponse(
  browser: Browser,
  blocker: PuppeteerBlocker,
  url: string,
  goToOptions: GoToOptions
): Promise<RawResponse> {
  await pageSemaphore.acquire();

  let page: Page | undefined;
  try {
    console.log(`Fetching raw URL: ${url}`);
    page = await browser.newPage();
    await blocker.enableBlockingInPage(page as any);

    const response = await page.goto(url, goToOptions);
    if (!response) {
      throw new Error(`No response received for ${url}`);
    }

    const body = await response.buffer();
    const headers = response.headers();

    return {
      body,
      contentType: headers["content-type"],
      status: response.status(),
    };
  } finally {
    if (page) {
      try {
        if (!page.isClosed()) {
          await page.close();
        }
      } catch (err) {
        console.error(`Failed to close page for ${url}:`, err);
      }
    }

    pageSemaphore.release();
  }
}

export async function getPageContent(options: Options) {
  const { url, selector, ...goToOptions } = options;
  const { browser, blocker } = await getBrowser();

  const urls = Array.isArray(url) ? url : [url];

  const results = await Promise.all(
    urls.map((currentUrl) =>
      fetchSingleUrlWithRetry(
        browser,
        blocker,
        currentUrl,
        selector,
        goToOptions
      )
    )
  );

  return results;
}

export async function getRawResponse(
  options: Omit<Options, "selector">
): Promise<RawResponse> {
  const { url, ...goToOptions } = options;
  const { browser, blocker } = await getBrowser();

  if (Array.isArray(url)) {
    throw new Error("Raw response only supports a single URL");
  }

  return fetchRawResponse(browser, blocker, url, goToOptions);
}
