import { chromium, Browser, Page } from "playwright";

export interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number;
  renderMethod: "static" | "dynamic";
  headers: Record<string, string>;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export async function fetchPage(
  url: string,
  options: { timeout?: number; userAgent?: string } = {}
): Promise<FetchResult> {
  const { timeout = 15000, userAgent = DEFAULT_USER_AGENT } = options;

  // Try static fetch first (fast path)
  const staticResult = await fetchStatic(url, { timeout, userAgent });

  if (hasSubstantialContent(staticResult.html)) {
    return { ...staticResult, renderMethod: "static" };
  }

  // Fall back to dynamic rendering if static HTML is minimal
  const dynamicResult = await fetchDynamic(url, { timeout, userAgent });
  return { ...dynamicResult, renderMethod: "dynamic" };
}

async function fetchStatic(
  url: string,
  options: { timeout: number; userAgent: string }
): Promise<Omit<FetchResult, "renderMethod">> {
  const fetchOpts = {
    headers: {
      "User-Agent": options.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    signal: AbortSignal.timeout(options.timeout),
    redirect: "follow" as const,
  };

  let response: Response;
  try {
    response = await fetch(url, fetchOpts);
  } catch (err: any) {
    const code = err?.cause?.code;
    if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
      const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      try {
        response = await fetch(url, fetchOpts);
      } finally {
        if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
      }
    } else {
      throw err;
    }
  }

  const html = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    html,
    finalUrl: response.url,
    statusCode: response.status,
    headers,
  };
}

let browserInstance: Browser | null = null;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "";
// browserless v2 host (the v1 chrome.browserless.io domain is dead).
export const BROWSERLESS_HOST = process.env.BROWSERLESS_HOST || "production-sfo.browserless.io";

// Remote browserless when a token is set, otherwise (or if the remote connect
// fails) the locally-installed Chromium — the Docker image ships one and points
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH at it.
export async function connectScrapeBrowser(): Promise<Browser> {
  if (BROWSERLESS_TOKEN) {
    try {
      return await chromium.connectOverCDP(`wss://${BROWSERLESS_HOST}?token=${BROWSERLESS_TOKEN}`, { timeout: 20000 });
    } catch (err) {
      console.warn(`[fetcher] browserless connect failed (${(err as Error).message}), falling back to local Chromium`);
    }
  }
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
}

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await connectScrapeBrowser();
  }
  return browserInstance;
}

async function fetchDynamic(
  url: string,
  options: { timeout: number; userAgent: string }
): Promise<Omit<FetchResult, "renderMethod">> {
  const browser = await getBrowser();
  const context = BROWSERLESS_TOKEN
    ? browser.contexts()[0] || await browser.newContext({ userAgent: options.userAgent, viewport: { width: 1280, height: 720 } })
    : await browser.newContext({ userAgent: options.userAgent, viewport: { width: 1280, height: 720 } });

  const page: Page = await context.newPage();

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeout,
    });

    await page.waitForTimeout(2000);

    const html = await page.content();
    const headers: Record<string, string> = {};
    if (response) {
      const allHeaders = await response.allHeaders();
      Object.assign(headers, allHeaders);
    }

    return {
      html,
      finalUrl: page.url(),
      statusCode: response?.status() ?? 200,
      headers,
    };
  } finally {
    await page.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

function hasSubstantialContent(html: string): boolean {
  // Check for common SPA indicators first
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    const bodyContent = bodyMatch[1]
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
      .replace(/<link[^>]*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();

    // Common SPA patterns: single div#root, div#app, div#__next with no content
    if (/^<div\s+id="(root|app|__next|__nuxt|___gatsby)"[^>]*>\s*<\/div>$/i.test(bodyContent)) {
      return false;
    }

    // Body has almost nothing except scripts
    const bodyText = bodyContent.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (bodyText.length < 50 && bodyContent.length < 200) {
      return false;
    }
  }

  // Check overall text content
  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Very minimal text AND no meaningful HTML structure = needs JS
  if (textContent.length < 50) return false;

  return true;
}
