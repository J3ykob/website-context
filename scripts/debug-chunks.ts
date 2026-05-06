import { fetchPage, closeBrowser } from "../src/scraper/fetcher.js";
import { htmlToMarkdown } from "../src/scraper/markdown.js";
import { buildContext } from "../src/context/store.js";
import { crawlSite } from "../src/scraper/crawler.js";

// Crawl just the menu page
const result = await crawlSite("https://restauracjasloik.pl/menu/", { maxPages: 1, maxDepth: 0, rateLimit: 500 });
await closeBrowser();

const context = await buildContext(result);
await closeBrowser();

console.log("Total chunks:", context.chunks.length);
console.log("");

// Find dessert chunks
for (const chunk of context.chunks) {
  const lower = chunk.content.toLowerCase();
  if (lower.includes("deser") || lower.includes("szarlotka") || lower.includes("fondant")) {
    console.log("=== CHUNK (", chunk.content.length, "chars) ===");
    console.log("Prefix:", chunk.contextPrefix?.slice(0, 100));
    console.log("Path:", chunk.metadata.headingHierarchy);
    console.log("Content:", chunk.content.slice(0, 400));
    console.log("");
  }
}
