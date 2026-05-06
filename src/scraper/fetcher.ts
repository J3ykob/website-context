import { chromium, Browser, Page } from "playwright";

export interface FetchResult {
  html: string;
  finalUrl: string;
  statusCode: number;
  renderMethod: "static" | "dynamic";
  headers: Record<string, string>;
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; WebsiteContextBot/1.0; +https://websitecontext.dev/bot)";

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
  const response = await fetch(url, {
    headers: {
      "User-Agent": options.userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    signal: AbortSignal.timeout(options.timeout),
    redirect: "follow",
  });

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

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  }
  return browserInstance;
}

async function fetchDynamic(
  url: string,
  options: { timeout: number; userAgent: string }
): Promise<Omit<FetchResult, "renderMethod">> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: options.userAgent,
    viewport: { width: 1280, height: 720 },
  });

  const page: Page = await context.newPage();

  try {
    const response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: options.timeout,
    });

    // Wait a bit more for any late-loading content
    await page.waitForTimeout(1000);

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
    await context.close();
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
