import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getPageContent, getRawResponse, closeBrowser } from "./lib.js";
import { responseCache } from "./cache.js";

const app = new Hono();

const shouldReturnRaw = (rawParam?: string | string[]) => {
  const rawValue = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (rawValue === undefined) {
    return false;
  }

  const normalizedRawValue = rawValue.toLowerCase();
  return (
    normalizedRawValue !== "false" &&
    normalizedRawValue !== "0"
  );
};

const shouldEnableAdblock = (adblockParam?: string | string[]) => {
  const adblockValue = Array.isArray(adblockParam)
    ? adblockParam[0]
    : adblockParam;
  if (adblockValue === undefined) {
    return true;
  }

  const normalizedAdblockValue = adblockValue.toLowerCase();
  return (
    normalizedAdblockValue !== "false" &&
    normalizedAdblockValue !== "0"
  );
};

app.get("/", async (c) => {
  try {
    const queryParams = c.req.query();
    const {
      url,
      selector,
      raw: rawParam,
      adblock: adblockParam,
      ...options
    } = queryParams;
    const returnRaw = shouldReturnRaw(rawParam);
    const enableAdblock = shouldEnableAdblock(adblockParam);
    const cacheOptions = { ...options, adblock: enableAdblock };

    if (!url) {
      return c.json({
        success: false,
        error: "URL parameter is required",
      });
    }

    if (returnRaw) {
      if (selector !== undefined) {
        return c.json(
          {
            success: false,
            error: "raw parameter cannot be used with selector",
          },
          400
        );
      }

      if (Array.isArray(url)) {
        return c.json(
          {
            success: false,
            error: "raw parameter only supports a single URL",
          },
          400
        );
      }
    } else if (!selector) {
      return c.json({
        success: false,
        error: "selector parameter is required",
      });
    }

    let result = responseCache.get(url, cacheOptions);
    let fromCache = false;

    if (!returnRaw) {
      if (result) {
        fromCache = true;
      } else {
        result = await getPageContent({
          url,
          selector,
          adblock: enableAdblock,
          ...options,
        });
        responseCache.set(url, cacheOptions, result);
      }

      return c.json({
        success: true,
        fromCache,
        data: result,
      });
    }

    const rawResponse = await getRawResponse({
      url,
      adblock: enableAdblock,
      ...options,
    });
    const headers = rawResponse.contentType
      ? { "Content-Type": rawResponse.contentType }
      : undefined;
    return new Response(Buffer.from(rawResponse.body), {
      status: rawResponse.status,
      headers,
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  }
);

// Handle graceful shutdown
const cleanup = async () => {
  console.log("\nReceived shutdown signal, cleaning up...");
  await closeBrowser();
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
