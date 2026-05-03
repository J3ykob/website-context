import { describe, it, expect, afterAll } from "vitest";
import { fetchPage, closeBrowser } from "../src/scraper/fetcher.js";
import { htmlToMarkdown } from "../src/scraper/markdown.js";

afterAll(async () => {
  await closeBrowser();
});

describe("HTML to LLM-ready Markdown", () => {
  it("converts a static page to clean markdown", async () => {
    const fetchResult = await fetchPage("https://example.com");
    const md = htmlToMarkdown(fetchResult);

    expect(md.fullMarkdown).toContain("Example Domain");
    expect(md.fullMarkdown.length).toBeGreaterThan(50);
    // Should not contain HTML tags
    expect(md.fullMarkdown).not.toMatch(/<[a-z][^>]*>/i);
    console.log("\n--- example.com markdown ---");
    console.log(md.fullMarkdown.slice(0, 500));
  }, 15000);

  it("extracts structured sections from a docs page", async () => {
    const fetchResult = await fetchPage("https://docs.github.com/en/get-started");
    const md = htmlToMarkdown(fetchResult);

    expect(md.sections.length).toBeGreaterThan(0);
    expect(md.fitMarkdown.length).toBeGreaterThan(100);

    // fitMarkdown should be shorter than fullMarkdown (noise filtered)
    expect(md.fitMarkdown.length).toBeLessThanOrEqual(md.fullMarkdown.length);

    console.log("\n--- docs.github.com sections ---");
    console.log(`Full: ${md.fullMarkdown.length} chars, Fit: ${md.fitMarkdown.length} chars`);
    console.log(`Sections: ${md.sections.length}`);
    md.sections.slice(0, 5).forEach((s) => {
      console.log(`  [${"#".repeat(s.level)}] ${s.heading} (${s.content.length} chars)`);
    });
  }, 30000);

  it("produces heading hierarchy paths", async () => {
    const fetchResult = await fetchPage("https://vite.dev/guide/");
    const md = htmlToMarkdown(fetchResult);

    const deepSection = md.sections.find((s) => s.headingPath.length >= 2);
    if (deepSection) {
      expect(deepSection.headingPath.length).toBeGreaterThanOrEqual(2);
      console.log("\n--- vite.dev heading path example ---");
      console.log(`Path: ${deepSection.headingPath.join(" > ")}`);
      console.log(`Content preview: ${deepSection.content.slice(0, 150)}`);
    }
    expect(md.sections.length).toBeGreaterThan(3);
  }, 30000);

  it("filters out navigation noise in fitMarkdown", async () => {
    const fetchResult = await fetchPage("https://vite.dev/");
    const md = htmlToMarkdown(fetchResult);

    // fitMarkdown should not contain cookie/privacy noise
    const fitLower = md.fitMarkdown.toLowerCase();
    expect(fitLower).not.toContain("cookie policy");
    expect(fitLower).not.toContain("subscribe to our newsletter");

    // But should contain real content
    expect(md.fitMarkdown.length).toBeGreaterThan(100);
    console.log("\n--- vite.dev fit markdown preview ---");
    console.log(md.fitMarkdown.slice(0, 400));
  }, 30000);
});
