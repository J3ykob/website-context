/**
 * Scrapes Google Maps/Places data for a business and converts it to context chunks.
 * Uses the public Google Maps search page (no API key needed).
 */

import { chromium } from "playwright";
import type { ContentChunk } from "../context/types.js";
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

export async function scrapeGooglePlaces(businessName: string, location: string): Promise<PlacesData | null> {
  const query = encodeURIComponent(`${businessName} ${location}`);
  const url = `https://www.google.com/maps/search/${query}`;

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });

    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });

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
      const firstResult = page.locator('[role="feed"] > div').first();
      if (await firstResult.isVisible({ timeout: 3000 })) {
        await firstResult.click();
        await page.waitForTimeout(2000);
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

    // Name
    try {
      data.name = await page.locator('h1').first().textContent() || "";
    } catch {}

    // Rating
    try {
      const ratingText = await page.locator('[role="img"][aria-label*="star"], span:has-text(".")').first().textContent();
      if (ratingText) {
        const match = ratingText.match(/([\d.]+)/);
        if (match) data.rating = parseFloat(match[1]);
      }
    } catch {}

    // Review count
    try {
      const reviewText = await page.locator('button:has-text("review"), button:has-text("opini")').first().textContent();
      if (reviewText) {
        const match = reviewText.match(/([\d,. ]+)/);
        if (match) data.reviewCount = parseInt(match[1].replace(/[,. ]/g, ""));
      }
    } catch {}

    // Address
    try {
      const addressBtn = page.locator('[data-item-id="address"] .fontBodyMedium, button[aria-label*="Address"], button[aria-label*="Adres"]');
      if (await addressBtn.isVisible({ timeout: 2000 })) {
        data.address = await addressBtn.textContent() || null;
      }
    } catch {}

    // Phone
    try {
      const phoneBtn = page.locator('[data-item-id*="phone"] .fontBodyMedium, button[aria-label*="Phone"], button[aria-label*="Telefon"]');
      if (await phoneBtn.isVisible({ timeout: 2000 })) {
        data.phone = await phoneBtn.textContent() || null;
      }
    } catch {}

    // Categories
    try {
      const catButtons = page.locator('button[jsaction*="category"]');
      const count = await catButtons.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        const text = await catButtons.nth(i).textContent();
        if (text) data.categories.push(text.trim());
      }
    } catch {}

    // Hours
    try {
      const hoursTable = page.locator('[aria-label*="hour"], [aria-label*="godzin"]');
      if (await hoursTable.isVisible({ timeout: 2000 })) {
        await hoursTable.click();
        await page.waitForTimeout(1000);
        const hourRows = page.locator('table[role="presentation"] tr');
        const rowCount = await hourRows.count();
        for (let i = 0; i < rowCount; i++) {
          const text = await hourRows.nth(i).textContent();
          if (text) data.hours.push(text.trim());
        }
      }
    } catch {}

    // Reviews — scroll the reviews panel
    try {
      const reviewsBtn = page.locator('button:has-text("review"), button:has-text("opini")').first();
      if (await reviewsBtn.isVisible({ timeout: 2000 })) {
        await reviewsBtn.click();
        await page.waitForTimeout(2000);

        // Scroll to load more reviews
        const scrollable = page.locator('[role="feed"], .m6QErb.DxyBCb');
        for (let i = 0; i < 3; i++) {
          await scrollable.evaluate((el) => el.scrollBy(0, 1000));
          await page.waitForTimeout(800);
        }

        // Extract reviews
        const reviewEls = page.locator('[data-review-id], .jftiEf');
        const reviewCount = Math.min(await reviewEls.count(), 15);

        for (let i = 0; i < reviewCount; i++) {
          try {
            const el = reviewEls.nth(i);
            const author = await el.locator('.d4r55, [class*="author"]').first().textContent() || "Anonymous";
            const ratingEl = await el.locator('[role="img"]').first().getAttribute("aria-label") || "";
            const ratingMatch = ratingEl.match(/([\d])/);
            const rating = ratingMatch ? parseInt(ratingMatch[1]) : 0;
            const text = await el.locator('.wiI7pd, [class*="review-text"], .MyEned').first().textContent() || "";
            const time = await el.locator('.rsqaWe, [class*="publish"]').first().textContent() || "";

            if (text.length > 10) {
              data.reviews.push({ author: author.trim(), rating, text: text.trim(), time: time.trim() });
            }
          } catch {}
        }
      }
    } catch {}

    return data.name ? data : null;
  } catch (err) {
    console.error("[google-places] Scrape failed:", (err as Error).message);
    return null;
  } finally {
    if (browser) await browser.close();
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
