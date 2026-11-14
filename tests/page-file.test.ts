import { describe, it, expect } from "vitest";
import { tmpdir } from "os";
import { resolve } from "path";
import { rm } from "fs/promises";
import { crawlFileWriter, replayCrawlFile } from "../src/scraper/page-file.js";
import type { ScrapedPage } from "../src/scraper/types.js";

// Pages read on another machine reach the server as a file and are handed on one by one, HTML included.
describe("pages brought in as a file", () => {
  it("every page written is replayed in order with its HTML, and the result reads like a crawl's", async () => {
    const file = resolve(tmpdir(), `page-file-test-${process.pid}.jsonl.gz`);
    const w = crawlFileWriter(file);
    const big = "<p>Tort czekoladowy z wiśniami, 48 zł za sztukę.</p>".repeat(4000); // ~200 KB a page
    for (let i = 0; i < 40; i++) {
      await w.onPage({ url: `https://cukiernia.example/p${i}`, title: `Strona ${i}`, description: "", content: [], metadata: {} as any, links: [], forms: [], structuredData: [], scrapedAt: "", renderMethod: "static", fetch: { html: `<h1>Żurawina ${i}</h1>${big}`, finalUrl: `https://cukiernia.example/p${i}`, statusCode: 200, renderMethod: "static", headers: { "content-type": "text/html" } } } as ScrapedPage);
    }
    expect(await w.close()).toBe(40);
    const seen: string[] = [];
    const r = await replayCrawlFile(file, "https://cukiernia.example/", (p) => { expect(p.fetch!.html.startsWith(`<h1>Żurawina ${seen.length}</h1>`)).toBe(true); expect(p.fetch!.html.length).toBeGreaterThan(200000); seen.push(p.url); });
    await rm(file, { force: true });
    expect(seen.length).toBe(40);
    expect(r.stats.successPages).toBe(40);
    expect(r.pages[0].url).toBe("https://cukiernia.example/p0");
    expect(r.pages.every((p) => !p.fetch)).toBe(true); // HTML dropped once handed on
  });
});
