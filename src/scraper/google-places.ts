/**
 * Scrapes Google Maps/Places data for a business and converts it to context chunks.
 * Uses the public Google Maps search page (no API key needed).
 */

import { chromium, type Browser } from "playwright";
import type { ContentChunk } from "../context/types.js";
import { BROWSERLESS_HOST } from "./fetcher.js";
import { randomUUID } from "crypto";

export interface PlacesData {
  name: string;
  rating: number | null;
  reviewCount: number | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  hours: string[];
  categories: string[];
  reviews: { author: string; rating: number; text: string; time: string }[];
  description: string | null;
}

export async function scrapeGooglePlaces(businessName: string, location: string, maxTimeMs = 25000): Promise<PlacesData | null> {
  const query = encodeURIComponent(`${businessName} ${location}`);
  const url = `https://www.google.com/maps/search/${query}`;

  let browser: Browser | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    // Remote browser only when one is configured: Google Maps in a local Chromium
    // does not fit next to the server in 512 MB (OOM crash loop, 2026-09-28).
    // Maps data is a supplement, so if the remote browser is unreachable we skip it.
    if (process.env.BROWSERLESS_TOKEN) {
      try {
        browser = await chromium.connectOverCDP(`wss://${BROWSERLESS_HOST}?token=${process.env.BROWSERLESS_TOKEN}`, { timeout: 20000 });
      } catch (err) {
        console.warn(`[google-places] remote browser unavailable (${(err as Error).message}), skipping Maps`);
        return null;
      }
    } else {
      browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      });
    }
    // Self-bound: force-close the browser if the scrape runs long, so it can never be
    // orphaned (the caller no longer races + abandons us). In-flight page ops then
    // error and we return null via the catch below.
    watchdog = setTimeout(() => { browser?.close().catch(() => {}); }, maxTimeMs);

    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    // Not "networkidle": Maps keeps streaming tiles and never goes idle (every
    // scrape timed out at 20 s). Wait for the page, then for a result to render.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.locator('h1, [role="feed"], form[action*="consent"], button:has-text("Accept all"), button:has-text("Zaakceptuj wszystko")').first().waitFor({ timeout: 10000 }).catch(() => {});

    // Accept cookies if prompted
    try {
      const acceptBtn = page.locator('button:has-text("Accept all"), button:has-text("Zaakceptuj wszystko")');
      if (await acceptBtn.isVisible({ timeout: 3000 })) {
        await acceptBtn.click();
        await page.waitForTimeout(1000);
      }
    } catch {}

    // Click on first result if we're on search results page
    try {
      // A result list: open the first place (its link, not the list's header row).
      const firstResult = page.locator('[role="feed"] a[href*="/maps/place"]').first();
      if (await firstResult.isVisible({ timeout: 3000 })) {
        await firstResult.click();
        await page.waitForURL(/\/maps\/place\//, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
    } catch {}

    // Wait for place details to load
    await page.waitForTimeout(2000);

    // Extract data
    const data: PlacesData = {
      name: "",
      rating: null,
      reviewCount: null,
      address: null,
      phone: null,
      website: null,
      hours: [],
      categories: [],
      reviews: [],
      description: null,
    };

    // Extract from stable, language-independent markers (data-item-id, roles);
    // Google's CSS class names change often and broke the old selectors.
    // Headless/remote sessions get Maps' "limited view": no reviews tab, so
    // reviews are best-effort (usually none).
    try {
      // Expand the weekly opening hours when collapsed.
      const hoursToggle = page.locator('[aria-expanded="false"][jsaction*="openhours"]').first();
      if (await hoursToggle.isVisible({ timeout: 1500 })) { await hoursToggle.click(); await page.waitForTimeout(1500); }
    } catch {}
    try {
      // Passed as a string: tsx/esbuild wraps named helpers in __name(), which
      // does not exist inside the page and made every extraction throw.
      const x: {
        name: string; rating: string; reviewCount: string; address: string; phone: string; website: string;
        categories: string[]; hours: string[]; reviews: { author: string; stars: string; text: string }[];
      } = await page.evaluate(`(() => {
        var text = function (e) { return ((e && e.textContent) || "").replace(/\\s+/g, " ").trim(); };
        var leaf = function (sel, re) {
          var els = Array.prototype.slice.call(document.querySelectorAll(sel));
          for (var i = 0; i < els.length; i++) { var t = els[i].children.length === 0 ? text(els[i]) : ""; if (re.test(t)) return t; }
          return "";
        };
        var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
        var phoneEl = document.querySelector('[data-item-id^="phone:tel:"]');
        var site = document.querySelector('a[data-item-id="authority"]');
        return {
          name: text(document.querySelector("h1")),
          rating: leaf("span, div", /^[1-5][.,]\\d$/),
          reviewCount: leaf("span, button", /^\\([\\d\\s.,\\u00a0]+\\)$/),
          address: text(document.querySelector('[data-item-id="address"]')),
          phone: phoneEl ? (phoneEl.getAttribute("data-item-id") || "").slice(10) : "",
          website: site ? site.href : text(document.querySelector('[data-item-id="authority"]')),
          categories: all('button[jsaction*="category"]').map(text).filter(Boolean).slice(0, 5),
          hours: all("table tr").map(text).filter(function (t) { return t.length > 3 && t.length < 80; }).slice(0, 7),
          reviews: all("[data-review-id]").slice(0, 15).map(function (r) {
            var img = r.querySelector('[role="img"][aria-label]');
            return { author: r.getAttribute("aria-label") || "Anonymous", stars: img ? img.getAttribute("aria-label") : "", text: text(r.querySelector("[lang], .wiI7pd")) };
          }),
        };
      })()`);
      data.name = x.name;
      data.rating = x.rating ? parseFloat(x.rating.replace(",", ".")) : null;
      data.reviewCount = x.reviewCount ? parseInt(x.reviewCount.replace(/\D/g, ""), 10) || null : null;
      data.address = x.address || null;
      data.phone = x.phone || null;
      data.website = x.website || null;
      data.categories = x.categories;
      // The limited view often lists only today; partial hours ("Monday 8-17")
      // would read as "open only on Monday", so keep them only for a full week.
      data.hours = x.hours.length >= 7 ? x.hours : [];
      const seen = new Set<string>();
      for (const r of x.reviews) {
        if (r.text.length <= 10 || seen.has(r.text)) continue;
        seen.add(r.text);
        const m = r.stars.match(/([1-5])/);
        data.reviews.push({ author: r.author.trim(), rating: m ? parseInt(m[1], 10) : 0, text: r.text, time: "" });
      }
    } catch {}

    return data.name ? data : null;
  } catch (err) {
    console.error("[google-places] Scrape failed:", (err as Error).message);
    return null;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
  }
}

export function placesToChunks(data: PlacesData, tenantId: string): ContentChunk[] {
  const chunks: ContentChunk[] = [];
  const meta = {
    url: "google-maps",
    title: data.name + " — Google Maps",
    headingHierarchy: ["Google Maps", data.name],
    type: "content" as const,
  };

  // Business overview chunk
  const overviewParts: string[] = [];
  overviewParts.push(`${data.name} — Google Maps Business Profile`);
  if (data.rating) overviewParts.push(`Rating: ${data.rating}/5 (${data.reviewCount || 0} reviews)`);
  if (data.address) overviewParts.push(`Address: ${data.address}`);
  if (data.phone) overviewParts.push(`Phone: ${data.phone}`);
  if (data.categories.length > 0) overviewParts.push(`Categories: ${data.categories.join(", ")}`);
  if (data.hours.length > 0) overviewParts.push(`Opening hours:\n${data.hours.join("\n")}`);

  chunks.push({
    id: randomUUID(),
    pageId: "google-maps",
    content: overviewParts.join("\n"),
    metadata: { ...meta, headingHierarchy: ["Google Maps", "Business Info"] },
  });

  // Reviews as individual chunks (grouped in batches of 3)
  if (data.reviews.length > 0) {
    // Summary chunk
    const avgRating = data.reviews.reduce((s, r) => s + r.rating, 0) / data.reviews.length;
    const positive = data.reviews.filter((r) => r.rating >= 4).length;
    const negative = data.reviews.filter((r) => r.rating <= 2).length;

    chunks.push({
      id: randomUUID(),
      pageId: "google-maps",
      content: `Customer Review Summary for ${data.name}:\n` +
        `Average rating: ${avgRating.toFixed(1)}/5 from ${data.reviews.length} reviews\n` +
        `Positive reviews (4-5 stars): ${positive}\n` +
        `Negative reviews (1-2 stars): ${negative}\n` +
        `Overall sentiment: ${avgRating >= 4 ? "Very positive" : avgRating >= 3 ? "Mixed" : "Needs improvement"}`,
      metadata: { ...meta, headingHierarchy: ["Google Maps", "Review Summary"] },
    });

    // Individual review chunks (batches of 3)
    for (let i = 0; i < data.reviews.length; i += 3) {
      const batch = data.reviews.slice(i, i + 3);
      const reviewText = batch
        .map((r) => `${r.author} (${r.rating}★, ${r.time}): "${r.text}"`)
        .join("\n\n");

      chunks.push({
        id: randomUUID(),
        pageId: "google-maps",
        content: `Customer Reviews for ${data.name}:\n\n${reviewText}`,
        metadata: { ...meta, headingHierarchy: ["Google Maps", "Reviews", `Reviews ${i + 1}-${i + batch.length}`] },
      });
    }
  }

  return chunks;
}
