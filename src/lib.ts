import {
  connect,
  type Options as RealBrowserOption,
} from "puppeteer-real-browser";
import type { GoToOptions } from "rebrowser-puppeteer-core";
import type { Browser } from "rebrowser-puppeteer-core";
import { PuppeteerBlocker } from "@ghostery/adblocker-puppeteer";
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
    console.log("No proxy string provided");
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
    console.log("Closing browser...");
    try {
      await browserInstance.close();
      browserInstance = null;
      blocker = null;
      console.log("Browser closed successfully");
    } catch (error) {
      console.error("Error closing browser:", error);
    }
  }
}

export type Options = {
  url: string | string[];
  selector?: string;
} & GoToOptions;

async function fetchSingleUrl(
  browser: Browser,
  blocker: PuppeteerBlocker,
  url: string,
  selector: string | undefined,
  goToOptions: GoToOptions
): Promise<string> {
  await pageSemaphore.acquire();
  console.log(`Acquired lock for ${url}`);

  let page;
  try {
    page = await browser.newPage();
    await blocker.enableBlockingInPage(page as any);

    await page.goto(url, goToOptions);

    let verified = false;

    if (selector) {
      const startDate = Date.now();
      while (Date.now() - startDate < (goToOptions.timeout || 30000)) {
        if (page.isClosed()) {
          throw new Error(
            `Page closed unexpectedly while waiting for selector`
          );
        }

        const res = await page.$(selector);
        if (res) {
          verified = true;
          break;
        }

        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    if (selector && !verified) {
      throw new Error(
        `Selector "${selector}" not found on ${url} within timeout`
      );
    }

    const content = await page.content();
    return content;
  } catch (error) {
    console.error(`Failed to fetch ${url}:`, error);
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
    console.log(`Released lock for ${url}`);
  }
}

export async function getPageContent(options: Options) {
  const { url, selector, ...goToOptions } = options;
  const { browser, blocker } = await getBrowser();

  const urls = Array.isArray(url) ? url : [url];

  const results = await Promise.all(
    urls.map((currentUrl) =>
      fetchSingleUrl(browser, blocker, currentUrl, selector, goToOptions)
    )
  );

  return results;
}
