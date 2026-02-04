import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getPageContent, closeBrowser } from "./lib.js";
import { responseCache } from "./cache.js";

const app = new Hono();

const isRawResponseRequested = (rawParam?: string | string[]) => {
  const rawValue = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  if (rawValue === undefined) {
    return false;
  }

  const normalizedRawValue = String(rawValue).toLowerCase();
  return (
    normalizedRawValue !== "false" &&
    normalizedRawValue !== "0"
  );
};

app.get("/", async (c) => {
  try {
    const queryParams = c.req.query();
    const { url, selector, raw: rawParam, ...options } = queryParams;
    const shouldReturnRaw = isRawResponseRequested(rawParam);

    if (!url) {
      return c.json({
        success: false,
        error: "URL parameter is required",
      });
    }

    if (!selector) {
      return c.json({
        success: false,
        error: "selector parameter is required",
      });
    }

    let result = responseCache.get(url, options);
    let fromCache = false;

    if (result) {
      fromCache = true;
    } else {
      result = await getPageContent({ url, selector, ...options });
      responseCache.set(url, options, result);
    }

    if (shouldReturnRaw) {
      return c.json(result);
    }

    return c.json({
      success: true,
      fromCache,
      data: result,
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
