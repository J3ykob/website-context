/**
 * Page text as the bot gets it, on real sites where it went wrong (2026-10-25 quality review):
 * Elementor pages converted to nothing, <br> glued address lines, lists made of headings were dropped.
 */
import { describe, it, expect, afterAll } from "vitest";
import { fetchPage, closeBrowser } from "../src/scraper/fetcher.js";
import { htmlToMarkdown } from "../src/scraper/markdown.js";
import { createContextBuilder } from "../src/context/store.js";

afterAll(async () => { await closeBrowser(); });

describe("page text", () => {
  it("keeps the content of an Elementor page whose first widget is empty", async () => {
    const md = htmlToMarkdown(await fetchPage("https://beton-lazy.pl/beton-z-mikrowloknem/"));
    expect(md.fullMarkdown).toMatch(/mikrow/i);
    expect(md.fullMarkdown.length).toBeGreaterThan(1000);
  }, 30000);

  it("keeps line breaks apart (street number and postal code)", async () => {
    const md = htmlToMarkdown(await fetchPage("https://bostabeton.pl/kontakt/wytwornie/wytwornie-warszawa/"));
    expect(md.fullMarkdown).toContain("Płytowa 1\n03-046");
    expect(md.fullMarkdown).not.toContain("Płytowa 103-046");
  }, 30000);

  it("keeps a list made of headings in the chunks", async () => {
    const url = "https://www.insanit.waw.pl/oferta/budynki-mieszkalne/domy-jednorodzinne/";
    const b = createContextBuilder();
    await b.addPage({ url, title: "", description: "", content: [], links: [], forms: [], structuredData: [], metadata: {}, scrapedAt: "", fetch: await fetchPage(url) } as any);
    const ctx = await b.finish(url);
    expect(ctx.chunks.map((c) => c.content).join("\n")).toContain("Pompy ciepła");
  }, 120000);
});
