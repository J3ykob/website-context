import { crawlSite } from "./scraper/index.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const command = process.argv[2];

if (command === "scrape") {
  const url = process.argv[3];
  const maxPages = parseInt(process.argv[4] || "20");

  if (!url) {
    console.error("Usage: npm run scrape -- <url> [maxPages]");
    process.exit(1);
  }

  console.log(`\nCrawling: ${url} (max ${maxPages} pages)\n`);

  const result = await crawlSite(url, { maxPages, rateLimit: 800 });

  // Save results
  const outputDir = join(process.cwd(), "output");
  mkdirSync(outputDir, { recursive: true });

  const hostname = new URL(url).hostname.replace(/\./g, "_");
  const outputFile = join(outputDir, `${hostname}_${Date.now()}.json`);
  writeFileSync(outputFile, JSON.stringify(result, null, 2));

  console.log(`\n--- Crawl Complete ---`);
  console.log(`Pages crawled: ${result.stats.successPages}`);
  console.log(`Failed: ${result.stats.failedPages}`);
  console.log(`Static: ${result.stats.staticPages}`);
  console.log(`Dynamic: ${result.stats.dynamicPages}`);
  console.log(`Time: ${(result.stats.totalTime / 1000).toFixed(1)}s`);
  console.log(`Output: ${outputFile}\n`);
} else {
  console.log("Website Context CLI");
  console.log("Commands:");
  console.log("  scrape <url> [maxPages]  - Crawl and extract a website");
}
