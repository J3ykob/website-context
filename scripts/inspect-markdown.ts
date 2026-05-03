import { fetchPage, closeBrowser } from "../src/scraper/fetcher.js";
import { htmlToMarkdown } from "../src/scraper/markdown.js";

const url = process.argv[2] || "https://vite.dev/guide/";

const result = await fetchPage(url);
const md = htmlToMarkdown(result);

console.log("=== FIT MARKDOWN (LLM-ready) ===");
console.log("Length:", md.fitMarkdown.length, "chars");
console.log("");
console.log(md.fitMarkdown.slice(0, 2000));
console.log("");
console.log("=== SECTIONS ===");
console.log("Total:", md.sections.length);
md.sections.slice(0, 10).forEach((s, i) => {
  console.log(
    `${i + 1}. [${"#".repeat(s.level)}] ${s.heading} (${s.content.length} chars) path=[${s.headingPath.join(" > ")}]`
  );
});

await closeBrowser();
