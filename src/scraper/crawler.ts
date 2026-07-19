import { fetchPage, closeBrowser } from "./fetcher.js";
import { extractPage } from "./extractor.js";
import type { ScrapedPage, CrawlResult, CrawlOptions, CrawlStats, SiteMapNode } from "./types.js";

const DEFAULT_OPTIONS: Required<CrawlOptions> = {
  maxPages: 100,
  maxDepth: 5,
  respectRobotsTxt: true,
  rateLimit: 1000,
  includePatterns: [],
  excludePatterns: [
    // (\?|$) not $: binary links often carry cache-buster query strings
    // (".pdf?rand=123" slipped past a $-anchored pattern and raw PDF bytes
    // ended up chunked into the knowledge base).
    /\.(pdf|zip|tar|gz|mp4|mp3|avi|mov|jpg|jpeg|png|gif|svg|webp|ico|woff|woff2|ttf|eot|docx?|xlsx?|pptx?)(\?|$)/i,
    /\?(utm_|fbclid|gclid)/i,
    /\/(wp-admin|wp-login|admin|login|logout|cart|checkout)\//i,
  ],
  timeout: 15000,
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};

// URL paths that almost always hold high-value info (contact details, pricing,
// services, hours, location) — crawled first so they're never missed under the cap.
const KEY_PAGE_PATTERN = /(kontakt|contact|o-?nas|about|cennik|pricing|prices?|us[lł]ugi|services?|oferta|offer|godziny|opening|hours|dojazd|lokaliz|location|menu)/i;

export async function crawlSite(
  startUrl: string,
  options: CrawlOptions = {}
): Promise<CrawlResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const baseUrl = new URL(startUrl);
  const allowedHosts = new Set([baseUrl.hostname]);
  const visited = new Set<string>();
  const queue: { url: string; depth: number; parent?: string }[] = [{ url: startUrl, depth: 0 }];
  const pages: ScrapedPage[] = [];
  const failures: string[] = [];
  const startTime = Date.now();
  let staticCount = 0;
  let dynamicCount = 0;

  // Fetch robots.txt if needed
  let disallowedPaths: string[] = [];
  if (opts.respectRobotsTxt) {
    disallowedPaths = await fetchRobotsTxt(baseUrl.origin, opts.userAgent);
  }

  while (queue.length > 0 && pages.length < opts.maxPages) {
    const item = queue.shift()!;
    const normalizedUrl = normalizeUrl(item.url);

    if (visited.has(normalizedUrl)) continue;
    if (item.depth > opts.maxDepth) continue;
    if (!isAllowedUrl(normalizedUrl, allowedHosts, opts, disallowedPaths)) continue;

    visited.add(normalizedUrl);

    try {
      // Rate limiting
      if (pages.length > 0) {
        await sleep(opts.rateLimit);
      }

      console.log(`  [${pages.length + 1}/${opts.maxPages}] Crawling: ${normalizedUrl} (depth: ${item.depth})`);

      const fetchResult = await fetchPage(normalizedUrl, {
        timeout: opts.timeout,
        userAgent: opts.userAgent,
      });

      if (fetchResult.statusCode >= 400) {
        failures.push(normalizedUrl);
        continue;
      }

      // Content-type is the authority, extensions are just a fast pre-filter:
      // anything that isn't an HTML-ish document gets skipped, never chunked.
      const ctype = (fetchResult.headers["content-type"] || "").toLowerCase();
      if (ctype && !/text\/html|application\/xhtml|text\/plain/.test(ctype)) {
        console.log(`  [SKIP] non-HTML content-type (${ctype.split(";")[0]}): ${normalizedUrl}`);
        continue;
      }

      // Track effective hostname after redirects
      const effectiveHost = new URL(fetchResult.finalUrl).hostname;
      if (!allowedHosts.has(effectiveHost)) {
        allowedHosts.add(effectiveHost);
        // Fetch robots.txt for the new host too
        if (opts.respectRobotsTxt) {
          const newOrigin = new URL(fetchResult.finalUrl).origin;
          const newDisallowed = await fetchRobotsTxt(newOrigin, opts.userAgent);
          disallowedPaths.push(...newDisallowed);
        }
      }

      const page = extractPage(fetchResult);
      pages.push(page);

      if (page.renderMethod === "static") staticCount++;
      else dynamicCount++;

      // Add links to queue (internal = same allowed hosts). Key pages (contact,
      // about, pricing, services, hours) JUMP the queue so they're crawled even on
      // large sites where they'd otherwise fall outside the page cap — this is how
      // a contact page (with the phone) gets reliably captured.
      for (const link of page.links) {
        const linkHost = new URL(link.href).hostname;
        const isInternal = allowedHosts.has(linkHost);
        if (isInternal && !visited.has(normalizeUrl(link.href))) {
          const next = { url: link.href, depth: item.depth + 1, parent: normalizedUrl };
          if (KEY_PAGE_PATTERN.test(new URL(link.href).pathname)) queue.unshift(next);
          else queue.push(next);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`  [FAIL] ${normalizedUrl}: ${msg}`);
      failures.push(normalizedUrl);
    }
  }

  await closeBrowser();

  const stats: CrawlStats = {
    totalPages: visited.size,
    successPages: pages.length,
    failedPages: failures.length,
    totalTime: Date.now() - startTime,
    staticPages: staticCount,
    dynamicPages: dynamicCount,
  };

  const siteMap = buildSiteMap(pages, startUrl);

  return {
    baseUrl: startUrl,
    pages,
    siteMap,
    crawledAt: new Date().toISOString(),
    stats,
  };
}

async function fetchRobotsTxt(origin: string, userAgent: string): Promise<string[]> {
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": userAgent },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];

    const text = await response.text();
    const disallowed: string[] = [];
    let relevantSection = false;

    for (const line of text.split("\n")) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith("user-agent:")) {
        const agent = trimmed.slice("user-agent:".length).trim();
        relevantSection = agent === "*" || userAgent.toLowerCase().includes(agent);
      } else if (relevantSection && trimmed.startsWith("disallow:")) {
        const path = line.trim().slice("disallow:".length).trim();
        if (path) disallowed.push(path);
      }
    }

    return disallowed;
  } catch {
    return [];
  }
}

function isAllowedUrl(
  url: string,
  allowedHosts: Set<string>,
  opts: Required<CrawlOptions>,
  disallowedPaths: string[]
): boolean {
  try {
    const parsed = new URL(url);

    // Must be one of the allowed hosts
    if (!allowedHosts.has(parsed.hostname)) return false;

    // Must be http/https
    if (!parsed.protocol.startsWith("http")) return false;

    const path = parsed.pathname;

    // Check robots.txt disallowed
    for (const disallowed of disallowedPaths) {
      if (path.startsWith(disallowed)) return false;
    }

    // Check exclude patterns
    for (const pattern of opts.excludePatterns) {
      if (pattern.test(url)) return false;
    }

    // Check include patterns (if any specified, URL must match one)
    if (opts.includePatterns.length > 0) {
      const matches = opts.includePatterns.some((p) => p.test(url));
      if (!matches) return false;
    }

    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove fragment
    parsed.hash = "";
    // Remove trailing slash (except for root)
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function buildSiteMap(pages: ScrapedPage[], startUrl: string): SiteMapNode {
  const root: SiteMapNode = {
    url: startUrl,
    title: pages.find((p) => p.url === startUrl)?.title || startUrl,
    children: [],
    depth: 0,
  };

  const nodeMap = new Map<string, SiteMapNode>();
  nodeMap.set(normalizeUrl(startUrl), root);

  for (const page of pages) {
    const normalized = normalizeUrl(page.url);
    if (normalized === normalizeUrl(startUrl)) continue;

    const path = new URL(page.url).pathname;
    const depth = path.split("/").filter(Boolean).length;

    const node: SiteMapNode = {
      url: page.url,
      title: page.title,
      children: [],
      depth,
    };
    nodeMap.set(normalized, node);

    // Find parent by path hierarchy
    const segments = path.split("/").filter(Boolean);
    let parentNode = root;
    for (let i = segments.length - 1; i >= 0; i--) {
      const parentPath = "/" + segments.slice(0, i).join("/");
      const parentUrl = normalizeUrl(new URL(parentPath, startUrl).toString());
      if (nodeMap.has(parentUrl)) {
        parentNode = nodeMap.get(parentUrl)!;
        break;
      }
    }
    parentNode.children.push(node);
  }

  return root;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
