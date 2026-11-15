import { safeFetch } from "./safe-url.js";
import { getHeapStatistics, setFlagsFromString } from "v8";
import { runInNewContext } from "vm";
import { fetchPage, closeBrowser } from "./fetcher.js";
import { extractPage } from "./extractor.js";
import { fetchPdfAsPage } from "./pdf.js";
import type { ScrapedPage, CrawlResult, CrawlOptions, CrawlStats, SiteMapNode } from "./types.js";
import { createHash } from "crypto";

// The collector, callable (node has it behind a flag; switched on here, for the crawl's memory brake only).
let gc: (() => void) | null | undefined;
function collect(): void {
  if (gc === undefined) { try { setFlagsFromString("--expose-gc"); gc = runInNewContext("gc") as () => void; } catch { gc = null; } }
  try { gc?.(); } catch { /* measured as it is */ }
}

const DEFAULT_OPTIONS: Required<Omit<CrawlOptions, "onPage" | "signal" | "skip" | "triage" | "forceTriage" | "maxTime">> = {
  // No page count decides what is read (owner, 2026-11-14: a 500-page ceiling cut a cake shop's 691 declared
  // pages, and the cake a customer asked about was among the unread). Which pages are read is the triage's
  // judgement; a caller may still pass a count (onboarding before the owner has claimed the business).
  maxPages: Infinity,
  maxDepth: 10,
  respectRobotsTxt: true,
  rateLimit: 100,
  minGap: 500,
  useSitemap: true,
  concurrency: 6,
  includePatterns: [],
  excludePatterns: [
    // (\?|$) not $: binary links often carry cache-buster query strings
    // (".pdf?rand=123" slipped past a $-anchored pattern and raw PDF bytes
    // ended up chunked into the knowledge base). PDFs are NOT excluded here —
    // they take the text-extraction path in the crawl loop (menus/price lists
    // often live in PDFs).
    /\.(zip|tar|gz|mp4|mp3|avi|mov|jpg|jpeg|png|gif|svg|webp|ico|woff|woff2|ttf|eot|docx?|xlsx?|pptx?)(\?|$)/i,
    /\?(utm_|fbclid|gclid)/i,
    /\/(wp-admin|wp-login|admin|login|logout|cart|checkout|koszyk|zamowienie|my-account|moje-konto)\//i,
    /[?&](replytocom|add-to-cart|orderby|sort|filter_[a-z_]+|s)=/i,
    /\/(feed|wp-json|xmlrpc\.php)(\/|$)/i,
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
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const baseUrl = new URL(startUrl);
  // Both apex and www variants: sitemaps often list the other one.
  const bareHost = baseUrl.hostname.replace(/^www\./, "");
  const allowedHosts = new Set([baseUrl.hostname, bareHost, `www.${bareHost}`]);
  const visited = new Set<string>();
  const contentHashes = new Set<string>();
  const queue: { url: string; depth: number; parent?: string; attempt?: number }[] = [{ url: startUrl, depth: 0 }];
  // Politeness: a 429/503 pauses ALL workers (Retry-After or 5s x attempt), re-queues the page (max 3
  // attempts), and from then on requests go one at a time, `politeDelay` apart across all workers (doubled
  // on each new throttle, max 8 s). Six workers resuming together after a pause were throttled together
  // again: a florist's shop stuck at 25 of 150 pages for half an hour, the scrape queue behind it.
  // Pace: requests to one site START at least `minGap` apart, however many workers there are (they still
  // overlap, so a slow page does not hold the rest). Unpaced, 12 workers read a cake shop's 430 pages in
  // 20 s - about 21 requests a second at a small host, twice in one day - and its firewall then refused
  // our server (2026-11-14: three re-scrapes failed on the home page, hours apart).
  const minGap = Math.max(0, opts.minGap);
  let pausedUntil = 0;
  let politeDelay = opts.rateLimit;
  let throttled = false;
  let nextSlot = 0;
  // A site that throttles every request (a firewall's penalty window on our IP, extended by each retry)
  // is left after 12 throttles in a row with the pages read so far - not held for an hour with the
  // scrape queue behind it.
  let throttledInRow = 0;
  let givenUp = false;
  let browserSite = false; // the start page needed the browser (a bot check): every page goes through it
  const waitTurn = async (): Promise<void> => {
    for (;;) {
      const now = Date.now();
      const at = Math.max(pausedUntil, nextSlot);
      if (at <= now) { nextSlot = now + Math.max(minGap, throttled ? politeDelay : 0); return; }
      await sleep(at - now);
    }
  };
  const pages: ScrapedPage[] = [];
  const failures: string[] = [];
  const startTime = Date.now();
  let staticCount = 0;
  let dynamicCount = 0;
  let inFlight = 0;

  // Large sites: candidates wait in `pending` until a Jev batch says they are worth reading (triage.ts).
  let triageOn = !!options.triage && !!options.forceTriage;
  const ownPages = new Set<string>(); // declared in the site's page/post sitemaps: read without triage
  const pending: { url: string; depth: number; parent?: string; text: string }[] = [];
  const pendingSeen = new Set<string>();
  let triaging: Promise<void> | null = null;
  let skippedByTriage = 0;
  // From this many addresses on, each further page is judged before it is read: declared in the sitemap,
  // or pages already read on a site that declares none (candidates still waiting are judged too).
  const triageMin = Number(process.env.TRIAGE_MIN_URLS) || 300;
  let stoppedBy: "time" | "pages" | "memory" | "throttle" | undefined;
  // The server's memory is the other brake (2026-11-15: a shop's 1,400 product pages filled the 384 MB heap and the
  // whole server restarted, dropping 14 queued re-scrapes): at this share of the heap limit the crawl hands over the
  // pages it has, leaving the rest of the heap for building the bot from them.
  // What counts is what is still in use: the raw figure includes what the collector has not freed yet, and after a large
  // crawl it stayed at 70-80% - the next eight crawls were stopped after 13-41 pages (2026-11-15). Over the mark, the
  // collector runs first and the heap is measured again.
  const heapStop = Number(process.env.SCRAPE_HEAP_STOP) || 0.7;
  const heapShare = () => process.memoryUsage().heapUsed / getHeapStatistics().heap_size_limit;
  const heapFull = () => { if (heapShare() < heapStop) return false; collect(); return heapShare() >= heapStop; };
  const runTriage = async (): Promise<void> => {
    const batch = pending.splice(0, 60); // smaller batches: each address gets attention
    if (!batch.length) return;
    const keep = await options.triage!(batch.map((b) => ({ url: b.url, text: b.text }))).catch(() => null);
    batch.forEach((b, i) => { if (!keep || keep[i]) queue.push(b); else skippedByTriage++; });
  };
  // Key pages (contact, pricing, hours...) jump the queue so they are fetched early.
  const enqueue = (next: { url: string; depth: number; parent?: string; text?: string }) => {
    const n = normalizeUrl(next.url);
    if (visited.has(n)) return;
    if (options.skip?.(n)) return;
    let path = "";
    try { path = new URL(n).pathname; } catch { return; }
    // Crawler trap: relative links (href="kategoria-produktu/x") resolved on a nested page nest deeper
    // forever, and many CMSs serve any such path (empro.pro, 2026-10-29: 30 min of
    // /kategoria-produktu/a/kategoria-produktu/b/kategoria-produktu/c...). A path naming the same
    // word segment twice is skipped.
    const segs = path.split("/").filter((x) => x.length >= 3 && !/^\d+$/.test(x));
    if (new Set(segs).size < segs.length) return;
    if (triageOn && !KEY_PAGE_PATTERN.test(path) && next.depth > 0 && !ownPages.has(n)) {
      if (!pendingSeen.has(n)) { pendingSeen.add(n); pending.push({ ...next, text: next.text || "" }); }
      return;
    }
    if (KEY_PAGE_PATTERN.test(path)) {
      const firstNonKey = queue.findIndex((q) => { try { return !KEY_PAGE_PATTERN.test(new URL(q.url).pathname); } catch { return true; } });
      queue.splice(firstNonKey < 0 ? queue.length : firstNonKey, 0, next);
    } else queue.push(next);
  };

  let disallowedPaths: string[] = [];
  const robots = await fetchRobotsTxt(baseUrl.origin, opts.userAgent);
  if (opts.respectRobotsTxt) disallowedPaths = robots.disallowed;

  // Sitemap-first discovery: every URL the site declares, not only what is
  // reachable within a few link hops from the homepage.
  if (opts.useSitemap) {
    const sitemapUrls = await fetchSitemapUrls(baseUrl.origin, robots.sitemaps, opts.userAgent, ownPages);
    if (options.triage && sitemapUrls.length >= triageMin) triageOn = true;
    let added = 0;
    for (const u of sitemapUrls) {
      try { if (!allowedHosts.has(new URL(u).hostname)) continue; } catch { continue; }
      enqueue({ url: u, depth: 1, parent: startUrl });
      added++;
    }
    console.log(`  [sitemap] ${sitemapUrls.length} URL(s) declared, ${added} queued`);
  }

  // Hand each page to the consumer right away (it converts the page and drops
  // the HTML); without a consumer the HTML stays on the page for buildContext.
  const deliver = async (page: ScrapedPage) => {
    if (!options.onPage) return;
    try { await options.onPage(page); }
    catch (e) { console.warn(`  [onPage] ${page.url}: ${(e as Error).message}`); }
    finally { page.fetch = undefined; }
  };

  const handle = async (item: { url: string; depth: number; parent?: string; attempt?: number }, normalizedUrl: string): Promise<void> => {
    console.log(`  [${pages.length + 1}${Number.isFinite(opts.maxPages) ? `/${opts.maxPages}` : ""}] Crawling: ${normalizedUrl} (depth: ${item.depth})`);

    // PDFs take a dedicated extraction path (text via unpdf), never the HTML fetcher.
    if (/\.pdf(\?|$)/i.test(normalizedUrl)) {
      const pdfPage = await fetchPdfAsPage(normalizedUrl, { timeout: opts.timeout, userAgent: opts.userAgent });
      if (pdfPage) {
        pages.push(pdfPage);
        await deliver(pdfPage);
        staticCount++;
        console.log(`  [PDF] extracted ${pdfPage.content.length} block(s): ${pdfPage.title}`);
      } else {
        console.log(`  [PDF] skipped (too large, scanned, or unreadable): ${normalizedUrl}`);
      }
      return;
    }

    let fetchResult = await fetchPage(normalizedUrl, { timeout: opts.timeout, userAgent: opts.userAgent, browser: browserSite });
    if (fetchResult.statusCode === 429 || fetchResult.statusCode === 503) {
      const attempt = (item.attempt || 0) + 1;
      const ra = Number(fetchResult.headers["retry-after"]);
      const waitMs = Math.min(60000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5000 * attempt);
      pausedUntil = Math.max(pausedUntil, Date.now() + waitMs);
      throttled = true;
      politeDelay = Math.min(8000, Math.max(1000, politeDelay * 2));
      if (++throttledInRow >= 12 && !givenUp) { givenUp = true; stoppedBy ??= "throttle"; console.warn(`  [${fetchResult.statusCode}] ${baseUrl.hostname} throttles every request - stopping with ${pages.length} page(s)`); }
      if (attempt <= 3) {
        console.log(`  [${fetchResult.statusCode}] throttled on ${normalizedUrl}, pausing ${Math.round(waitMs / 1000)}s (attempt ${attempt}/3)`);
        visited.delete(normalizedUrl);
        queue.unshift({ ...item, attempt });
      } else failures.push(normalizedUrl);
      return;
    }
    throttledInRow = 0;
    if (fetchResult.statusCode >= 400) { failures.push(normalizedUrl); return; }

    // Content-type is the authority, extensions are just a fast pre-filter.
    const ctype = (fetchResult.headers["content-type"] || "").toLowerCase();
    if (ctype.includes("application/pdf")) {
      const pdfPage = await fetchPdfAsPage(normalizedUrl, { timeout: opts.timeout, userAgent: opts.userAgent });
      if (pdfPage) { pages.push(pdfPage); await deliver(pdfPage); staticCount++; console.log(`  [PDF] extracted ${pdfPage.content.length} block(s): ${pdfPage.title}`); }
      return;
    }
    if (ctype && !/text\/html|application\/xhtml|text\/plain/.test(ctype)) {
      console.log(`  [SKIP] non-HTML content-type (${ctype.split(";")[0]}): ${normalizedUrl}`);
      return;
    }

    const finalNorm = normalizeUrl(fetchResult.finalUrl);
    if (finalNorm !== normalizedUrl && pages.some((p) => normalizeUrl(p.url) === finalNorm)) return; // redirect to a page we already have
    visited.add(finalNorm);

    const effectiveHost = new URL(fetchResult.finalUrl).hostname;
    if (!allowedHosts.has(effectiveHost)) {
      allowedHosts.add(effectiveHost);
      if (opts.respectRobotsTxt) {
        const more = await fetchRobotsTxt(new URL(fetchResult.finalUrl).origin, opts.userAgent);
        disallowedPaths.push(...more.disallowed);
      }
    }

    let page = extractPage(fetchResult);
    // A start page that links nowhere on its site may be a bot check served to our servers instead of the
    // site (pelnyparkiet.pl: "One moment, please..." - the whole site became that one page): once, a real
    // browser, which runs the check and waits for the site; kept only if it finds the site's links.
    const ownLinks = (p: typeof page) => p.links.some((l) => { try { return allowedHosts.has(new URL(l.href).hostname); } catch { return false; } });
    if (item.depth === 0 && fetchResult.renderMethod === "static" && !ownLinks(page)) {
      const viaBrowser = await fetchPage(normalizedUrl, { timeout: opts.timeout, userAgent: opts.userAgent, browser: true }).catch(() => null);
      if (viaBrowser && viaBrowser.statusCode < 400) {
        const again = extractPage(viaBrowser);
        // The site shows its bot check to every plain request: its other pages go through the browser too
        // (they came back as the same check page and were dropped as duplicates - 1 page of Sosnowy Dwór's 20).
        if (ownLinks(again)) { console.log(`  [BROWSER] start page had no links, the browser found ${again.links.length} - the whole site through the browser: ${normalizedUrl}`); fetchResult = viaBrowser; page = again; browserSite = true; }
      }
      // Still no links on its site, through the browser too: not kept as the site's home page (Sosnowy Dwór's
      // home page was saved as its bot check while the sitemap pages came through) - tried once more at the end.
      // A one-page site with nothing else to read keeps it (a business page with only phone and e-mail links).
      if (!ownLinks(page) && (queue.length > 0 || pages.length > 0)) {
        if (!item.attempt) { console.log(`  [CHECK?] start page links nowhere, even in a browser - retried at the end: ${normalizedUrl}`); visited.delete(normalizedUrl); queue.push({ ...item, attempt: 1 }); }
        else { console.log(`  [CHECK?] start page still links nowhere - not kept: ${normalizedUrl}`); failures.push(normalizedUrl); }
        return;
      }
    }
    // The page names its real address (rel=canonical): an alias of a page we have, or will fetch, is not
    // fetched twice - and its links (resolved against the alias) are not followed.
    const canonicalRaw = page.metadata?.canonical;
    if (canonicalRaw) {
      let canonical = "";
      try { canonical = normalizeUrl(new URL(canonicalRaw, normalizedUrl).toString()); } catch {}
      let finalNorm = normalizedUrl;
      try { finalNorm = normalizeUrl(fetchResult.finalUrl || normalizedUrl); } catch {}
      // Its own address after a redirect (vitejs.dev -> vite.dev) is not an alias of another page.
      if (canonical && canonical !== normalizedUrl && canonical !== finalNorm && allowedHosts.has(new URL(canonical).hostname)) {
        if (visited.has(canonical)) { console.log(`  [DUP] alias of ${canonical}: ${normalizedUrl}`); return; }
        visited.add(canonical);
        page.url = canonical; // sources and links point at the real address
      }
    }
    // Same text under a different URL (query variants, print views, aliases): skip.
    const hash = contentHash(page);
    if (hash && contentHashes.has(hash)) { console.log(`  [DUP] same content as an earlier page: ${normalizedUrl}`); return; }
    if (hash) contentHashes.add(hash);
    // Keep the fetched HTML so buildContext does not fetch every page again.
    page.fetch = fetchResult;
    pages.push(page);
    await deliver(page);
    if (page.renderMethod === "static") staticCount++;
    else dynamicCount++;

    for (const link of page.links) {
      let linkHost = "";
      try { linkHost = new URL(link.href).hostname; } catch { continue; }
      if (allowedHosts.has(linkHost)) enqueue({ url: link.href, depth: item.depth + 1, parent: normalizedUrl, text: (link.text || "").slice(0, 80) });
    }
    // A consumer already processed the page: keep only what the site map needs.
    if (options.onPage) { page.content = []; page.links = []; page.forms = []; page.structuredData = []; }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (pages.length + inFlight >= opts.maxPages) { stoppedBy = "pages"; return; }
      // Safety stop, not a selection: the crawl hands over what it has read while the job still has time
      // to build the bot from it (a job that runs out of time fails whole and keeps nothing).
      if (options.maxTime && Date.now() - startTime >= options.maxTime) { stoppedBy = "time"; return; }
      if (heapFull()) { stoppedBy = "memory"; return; }
      if (options.signal?.aborted || givenUp) return; // the job timed out (or the site throttles everything): stop
      if (options.triage && !triageOn && pages.length >= triageMin) {
        triageOn = true;
        console.log(`  [triage] ${pages.length} pages read - further pages are judged before they are read`);
        for (const waiting of queue.splice(0)) enqueue(waiting);
      }
      if (!queue.length && pending.length) {
        if (!triaging) triaging = runTriage().finally(() => { triaging = null; });
        await triaging;
        continue;
      }
      const item = queue.shift();
      if (!item) {
        if (inFlight === 0 && !pending.length && !triaging) return;
        await sleep(100); // another worker may still add links
        continue;
      }
      const normalizedUrl = normalizeUrl(item.url);
      if (visited.has(normalizedUrl)) continue;
      if (item.depth > opts.maxDepth) continue;
      if (!isAllowedUrl(normalizedUrl, allowedHosts, opts, disallowedPaths)) continue;
      visited.add(normalizedUrl);
      inFlight++;
      await waitTurn();
      try {
        await handle(item, normalizedUrl);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`  [FAIL] ${normalizedUrl}: ${msg}`);
        failures.push(normalizedUrl);
      } finally {
        inFlight--;
      }
      if (politeDelay > 0) await sleep(politeDelay);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  await closeBrowser();

  if (triageOn) console.log(`  [triage] ${skippedByTriage} page(s) judged not worth reading, ${pending.length} left unjudged`);
  // Never silent: a crawl stopped by its time or a caller's page count says how many addresses it left.
  const leftUnread = stoppedBy ? queue.filter((q) => !visited.has(normalizeUrl(q.url))).length + pending.length : 0;
  if (stoppedBy && leftUnread) console.warn(`  [STOPPED] by ${stoppedBy === "time" ? "the crawl's time" : stoppedBy === "throttle" ? "the site throttling every request" : stoppedBy === "memory" ? `the server's memory (heap at ${Math.round(heapShare() * 100)}%)` : `the caller's ${opts.maxPages}-page count`}: ${pages.length} pages read, ${leftUnread} address(es) left unread`);
  const stats: CrawlStats = {
    ...(stoppedBy && (leftUnread || stoppedBy === "throttle") ? { stoppedBy, leftUnread } : {}),
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

function contentHash(page: ScrapedPage): string {
  const text = page.content.map((b) => b.content + (b.items || []).join(" ")).join("\n").replace(/\s+/g, " ").trim();
  if (text.length < 200) return ""; // too thin to call two pages identical
  return createHash("sha1").update(text).digest("hex");
}

const MAX_SITEMAPS = 25;
const MAX_SITEMAP_URLS = 5000;

/** URLs from robots.txt Sitemap: lines, /sitemap.xml and /sitemap_index.xml, following sitemap indexes. */
export async function fetchSitemapUrls(origin: string, declared: string[], userAgent: string, ownPages?: Set<string>): Promise<string[]> {
  const toVisit = [...new Set([...declared, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`])];
  const seenMaps = new Set<string>();
  const urls = new Set<string>();
  while (toVisit.length > 0 && seenMaps.size < MAX_SITEMAPS && urls.size < MAX_SITEMAP_URLS) {
    const sm = toVisit.shift()!;
    if (seenMaps.has(sm) || /\.gz(\?|$)/i.test(sm)) continue;
    seenMaps.add(sm);
    try {
      const r = await safeFetch(sm, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const xml = await r.text();
      if (!/<(urlset|sitemapindex)\b/i.test(xml)) continue;
      const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
      if (/<sitemapindex\b/i.test(xml)) toVisit.push(...locs);
      else for (const u of locs) {
        if (urls.size >= MAX_SITEMAP_URLS) break;
        urls.add(u);
        // The site's own pages and posts (page-sitemap.xml, post-sitemap.xml, sitemap-pages.xml...): always read.
        if (ownPages && /(^|[\/_-])(page|pages|post|posts)([_-]?sitemap|[_-]?\d*\.xml)|sitemap[_-]?(page|pages|post|posts)\b/i.test(sm)) ownPages.add(normalizeUrl(u));
      }
    } catch {}
  }
  return [...urls];
}

async function fetchRobotsTxt(origin: string, userAgent: string): Promise<{ disallowed: string[]; sitemaps: string[] }> {
  try {
    const response = await safeFetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": userAgent },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { disallowed: [], sitemaps: [] };

    const text = await response.text();
    const disallowed: string[] = [];
    const sitemaps: string[] = [];
    let relevantSection = false;

    for (const line of text.split("\n")) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith("sitemap:")) {
        const u = line.trim().slice("sitemap:".length).trim();
        if (/^https?:\/\//i.test(u)) sitemaps.push(u);
      } else if (trimmed.startsWith("user-agent:")) {
        const agent = trimmed.slice("user-agent:".length).trim();
        relevantSection = agent === "*" || userAgent.toLowerCase().includes(agent);
      } else if (relevantSection && trimmed.startsWith("disallow:")) {
        const path = line.trim().slice("disallow:".length).trim();
        if (path) disallowed.push(path);
      }
    }

    return { disallowed, sitemaps };
  } catch {
    return { disallowed: [], sitemaps: [] };
  }
}

function isAllowedUrl(
  url: string,
  allowedHosts: Set<string>,
  opts: Required<Omit<CrawlOptions, "onPage" | "signal" | "skip" | "triage" | "forceTriage" | "maxTime">>,
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
