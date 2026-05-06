import { fetchPage, closeBrowser } from "../src/scraper/fetcher.js";
import { htmlToMarkdown } from "../src/scraper/markdown.js";

const r = await fetchPage("https://restauracjasloik.pl/menu/");
const md = htmlToMarkdown(r);

console.log("Render method:", r.renderMethod);
console.log("Full markdown length:", md.fullMarkdown.length);
console.log("Fit markdown length:", md.fitMarkdown.length);
console.log("Sections:", md.sections.length);
console.log("");
console.log("Has Szarlotka:", md.fullMarkdown.includes("Szarlotka"));
console.log("Has Fondant:", md.fullMarkdown.includes("Fondant"));
console.log("Has desery:", md.fullMarkdown.includes("desery"));
console.log("");

if (md.fullMarkdown.includes("Szarlotka")) {
  const idx = md.fullMarkdown.indexOf("Szarlotka");
  console.log("=== CONTEXT AROUND SZARLOTKA ===");
  console.log(md.fullMarkdown.slice(Math.max(0, idx - 100), idx + 200));
} else {
  console.log("=== LAST 500 CHARS OF FULL MARKDOWN ===");
  console.log(md.fullMarkdown.slice(-500));
}

await closeBrowser();
