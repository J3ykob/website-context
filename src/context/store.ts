import { randomUUID } from "crypto";
import { createHash } from "crypto";
import type { CrawlResult, ScrapedPage } from "../scraper/types.js";
import { htmlToMarkdown, type MarkdownSection } from "../scraper/markdown.js";
import { fetchPage } from "../scraper/fetcher.js";
import type {
  WebsiteContext,
  PageContext,
  SectionContext,
  SiteMapEntry,
  ContentChunk,
  ChunkMetadata,
} from "./types.js";

export async function buildContext(crawlResult: CrawlResult): Promise<WebsiteContext> {
  const pages: PageContext[] = [];
  const chunks: ContentChunk[] = [];
  const siteMap: SiteMapEntry[] = [];

  for (const scrapedPage of crawlResult.pages) {
    // Re-fetch for markdown (we already have the HTML in memory during crawl,
    // but for now we'll work from the scraped page data)
    const fetchResult = await fetchPage(scrapedPage.url, { timeout: 10000 });
    const markdown = htmlToMarkdown(fetchResult);

    const pageId = generatePageId(scrapedPage.url);
    const sections = buildSections(markdown.sections, pageId);
    const pageChunks = buildChunks(markdown.sections, pageId, scrapedPage);

    const page: PageContext = {
      id: pageId,
      url: scrapedPage.url,
      title: scrapedPage.title,
      description: scrapedPage.description,
      lastScraped: scrapedPage.scrapedAt,
      contentHash: hashContent(markdown.fitMarkdown),
      sections,
      forms: scrapedPage.forms.map((f) => ({
        id: randomUUID(),
        name: f.name || f.id || "Form",
        description: `${f.method} form with ${f.fields.length} fields`,
        action: f.action,
        method: f.method,
        fields: f.fields.map((field) => ({
          name: field.name,
          label: field.label || field.name,
          type: field.type,
          required: field.required,
          placeholder: field.placeholder,
          options: field.options,
        })),
      })),
      structuredData: scrapedPage.structuredData.map((s) => s.data),
    };

    pages.push(page);
    chunks.push(...pageChunks);

    // Build site map entry
    const path = new URL(scrapedPage.url).pathname;
    const depth = path === "/" ? 0 : path.split("/").filter(Boolean).length;
    siteMap.push({
      id: pageId,
      url: scrapedPage.url,
      title: scrapedPage.title,
      depth,
      type: classifyPageType(scrapedPage),
    });
  }

  return {
    tenantId: "", // set by caller
    version: 1,
    lastUpdated: new Date().toISOString(),
    siteMap,
    pages,
    flows: [],
    chunks,
  };
}

function buildSections(sections: MarkdownSection[], pageId: string): SectionContext[] {
  return sections
    .filter((s) => s.heading && s.content.trim())
    .map((s) => ({
      id: randomUUID(),
      heading: s.heading,
      level: s.level,
      content: s.content,
      parentSectionId: undefined,
    }));
}

function buildContextPrefix(page: ScrapedPage, section: MarkdownSection): string {
  let domain: string;
  try {
    domain = new URL(page.url).hostname;
  } catch {
    domain = "unknown site";
  }
  const hierarchy = section.headingPath.length > 0
    ? section.headingPath.join(" > ")
    : "main content";
  return `This chunk is from the page '${page.title}' on ${domain}. Section: ${hierarchy}.`;
}

function buildChunks(
  sections: MarkdownSection[],
  pageId: string,
  page: ScrapedPage
): ContentChunk[] {
  // Step 1: Merge small consecutive sections under the same parent heading.
  // This prevents menu items, service lists, etc. from being split into
  // tiny chunks that embed poorly. "Szarlotka" + "Fondant" + "Sernik"
  // under "desery" become one chunk instead of three.
  const merged: MarkdownSection[] = [];
  let accumulator: MarkdownSection | null = null;

  let pendingParentHeading = "";

  for (const section of sections) {
    let content = section.heading
      ? `## ${section.heading}\n\n${section.content}`
      : section.content;

    // If this section is just a heading with no body content, save it
    // as a prefix for the next section (e.g., "## desery" followed by items)
    if (section.heading && section.content.trim().length < 5) {
      pendingParentHeading = `## ${section.heading}\n\n`;
      continue;
    }

    // Prepend any pending parent heading
    if (pendingParentHeading) {
      content = pendingParentHeading + content;
      pendingParentHeading = "";
    }

    if (content.trim().length < 10) continue;

    // Determine the parent heading (one level up in the path)
    const parentKey = section.headingPath.slice(0, -1).join(" > ") || "__root__";
    const accParentKey = accumulator
      ? (accumulator.headingPath.slice(0, -1).join(" > ") || "__root__")
      : null;

    const isSmall = content.length < 200;
    const sameParent = parentKey === accParentKey;

    if (isSmall && accumulator && sameParent && (accumulator.content.length + content.length) < 3000) {
      // Merge into accumulator
      accumulator = {
        heading: accumulator.heading,
        level: accumulator.level,
        url: accumulator.url,
        headingPath: accumulator.headingPath,
        content: accumulator.content + "\n\n" + content,
      };
    } else {
      // Flush accumulator
      if (accumulator) merged.push(accumulator);

      if (isSmall) {
        // Start new accumulator
        accumulator = { heading: section.heading, level: section.level, url: section.url, headingPath: [...section.headingPath], content };
      } else {
        accumulator = null;
        merged.push({ heading: section.heading, level: section.level, url: section.url, headingPath: [...section.headingPath], content });
      }
    }
  }
  if (accumulator) merged.push(accumulator);

  // Step 2: Create chunks from merged sections
  const chunks: ContentChunk[] = [];

  for (const section of merged) {
    const content = section.content;
    if (content.trim().length < 15) continue;

    const contextPrefix = buildContextPrefix(page, section);
    const chunkType = classifyChunkType(section, page);

    const enrichedContent = enrichChunk(content, chunkType, section.heading || "");

    if (enrichedContent.length <= 4000) {
      chunks.push({
        id: randomUUID(),
        pageId,
        content: enrichedContent,
        contextPrefix,
        metadata: {
          url: page.url,
          title: page.title,
          headingHierarchy: section.headingPath,
          type: chunkType,
        },
      });
    } else {
      const subChunks = splitIntoChunks(enrichedContent, 2500, 150);
      for (const subChunk of subChunks) {
        chunks.push({
          id: randomUUID(),
          pageId,
          content: enrichChunk(subChunk, chunkType, section.heading || ""),
          contextPrefix,
          metadata: {
            url: page.url,
            title: page.title,
            headingHierarchy: section.headingPath,
            type: chunkType,
          },
        });
      }
    }
  }

  return chunks;
}

/**
 * Checks whether a paragraph is part of a list or table block.
 * List lines start with `- `, `* `, or `1.` (ordered list).
 * Table lines start with `|`.
 */
function isListOrTable(paragraph: string): boolean {
  const lines = paragraph.split("\n");
  return lines.some((l) => /^\s*[-*]\s|^\s*\d+\.\s|^\s*\|/.test(l));
}

function splitIntoChunks(text: string, maxSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  // Split on double-newlines but keep list/table blocks together
  const rawParagraphs = text.split(/\n\n+/);

  // Merge consecutive list/table paragraphs so they aren't split
  const paragraphs: string[] = [];
  for (const para of rawParagraphs) {
    if (
      isListOrTable(para) &&
      paragraphs.length > 0 &&
      isListOrTable(paragraphs[paragraphs.length - 1])
    ) {
      // Merge with previous list/table block
      paragraphs[paragraphs.length - 1] += "\n\n" + para;
    } else {
      paragraphs.push(para);
    }
  }

  let current = "";

  for (const para of paragraphs) {
    // Never split in the middle of a list or table — allow exceeding maxSize
    const wouldExceed = current.length + para.length > maxSize && current.length > 0;
    const paraIsListOrTable = isListOrTable(para);

    if (wouldExceed && !paraIsListOrTable) {
      chunks.push(current.trim());
      // Keep overlap from end of current chunk
      const words = current.split(/\s+/);
      const overlapWords = words.slice(-Math.floor(overlap / 5));
      current = overlapWords.join(" ") + "\n\n" + para;
    } else if (wouldExceed && paraIsListOrTable) {
      // Flush current, then keep the entire list/table block intact
      if (current.trim()) {
        chunks.push(current.trim());
      }
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

function classifyPageType(
  page: ScrapedPage
): "page" | "section" | "form" | "product" | "article" | "faq" {
  const hasProduct = page.structuredData.some(
    (s) => s.type === "Product" || s.type === "ProductGroup"
  );
  if (hasProduct) return "product";

  const hasFAQ = page.structuredData.some((s) => s.type === "FAQPage");
  if (hasFAQ) return "faq";

  const hasArticle = page.structuredData.some(
    (s) => s.type === "Article" || s.type === "BlogPosting" || s.type === "NewsArticle"
  );
  if (hasArticle) return "article";

  if (page.forms.length > 0) return "form";

  return "page";
}

function classifyChunkType(
  section: MarkdownSection,
  page: ScrapedPage
): "content" | "faq" | "product" | "form-description" | "navigation" | "pricing" {
  const heading = section.heading.toLowerCase();
  const content = section.content.toLowerCase();

  // Detect pricing content by heading OR content patterns
  const pricingHeadings = /pric|cennik|tarif|kosten|preis|rate|fee|cost|cena|opłat/i;
  const pricingContent = /\d+[.,]?\d*\s*(zł|PLN|€|EUR|\$|USD|£|GBP|kr|SEK|NOK|DKK)|\d+\s*(zł|PLN|€)\/m[²2]|per\s*(month|year|night|hour|person)/i;

  if (pricingHeadings.test(heading) || (pricingContent.test(content) && content.includes("|"))) return "pricing";
  if (heading.includes("faq") || heading.includes("frequently asked")) return "faq";
  if (heading.includes("product") || heading.includes("pricing")) return "product";
  if (heading.includes("contact") || heading.includes("form")) return "form-description";

  return "content";
}

/**
 * Enrich every chunk with a summary line + keywords extracted from content.
 * This bridges the gap between how users ask questions and how data is stored.
 * "1,850 zł/m2" in a table becomes findable by "how much does renovation cost?"
 */
function enrichChunk(content: string, type: string, heading: string): string {
  const keywords = extractKeywords(content, heading);
  const summary = generateSummary(content, type, heading);

  if (summary || keywords.length > 0) {
    const parts: string[] = [];
    if (summary) parts.push(summary);
    if (keywords.length > 0) parts.push(`Keywords: ${keywords.join(", ")}`);
    return `${parts.join(". ")}.\n\n${content}`;
  }

  return content;
}

function extractKeywords(content: string, heading: string): string[] {
  const kw: Set<string> = new Set();

  // Add heading as keyword
  if (heading) kw.add(heading.toLowerCase().trim());

  // Extract prices
  const prices = content.match(/\d[\d\s,.]*\s*(zł|PLN|€|EUR|\$|USD|£|GBP|kr|SEK|NOK|DKK)(\/m[²2])?/gi) || [];
  if (prices.length > 0) { kw.add("pricing"); kw.add("price"); kw.add("cost"); kw.add("cennik"); kw.add("cena"); }

  // Extract times/hours
  if (/\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2}/.test(content)) { kw.add("hours"); kw.add("opening hours"); kw.add("godziny otwarcia"); kw.add("schedule"); }

  // Extract phone numbers
  if (/(?:\+?\d[\d\s()-]{7,})/.test(content)) { kw.add("phone"); kw.add("contact"); kw.add("telefon"); kw.add("call"); }

  // Extract emails
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(content)) { kw.add("email"); kw.add("contact"); kw.add("kontakt"); }

  // Extract addresses
  if (/(?:ul\.|ulica|street|str\.|aleja|al\.|road|avenue)\s/i.test(content)) { kw.add("address"); kw.add("location"); kw.add("adres"); kw.add("directions"); }

  // Detect tables
  if (content.includes("|") && content.includes("---")) { kw.add("table"); kw.add("comparison"); kw.add("details"); }

  // Detect FAQ patterns
  if (/\?[\s\n]/.test(content)) { kw.add("faq"); kw.add("questions"); kw.add("answers"); }

  // Detect booking/reservation
  if (/book|reserv|rezerwac|termin|appointment|umów/i.test(content)) { kw.add("booking"); kw.add("reservation"); kw.add("rezerwacja"); }

  // Detect menu/food
  if (/menu|dish|course|danie|zupa|deser|starter|main/i.test(content)) { kw.add("menu"); kw.add("food"); kw.add("dishes"); }

  return [...kw].slice(0, 10);
}

function generateSummary(content: string, type: string, heading: string): string {
  if (type === "pricing") {
    const prices = content.match(/\d[\d\s,.]*\s*(zł|PLN|€|EUR|\$|USD|£|GBP|kr|SEK|NOK|DKK)(\/m[²2])?/gi) || [];
    return prices.length > 0
      ? `This section contains pricing: ${prices.slice(0, 5).join(", ")}`
      : "This section contains pricing and cost information";
  }

  // Auto-generate summary from heading + detected content types
  const detections: string[] = [];
  if (/\d{1,2}[:.]\d{2}/.test(content)) detections.push("schedules/hours");
  if (/(?:\+?\d[\d\s()-]{7,})/.test(content)) detections.push("phone numbers");
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(content)) detections.push("email addresses");
  if (content.includes("|") && content.includes("---")) detections.push("tabular data");

  if (detections.length > 0) {
    return `${heading ? heading + ": " : ""}contains ${detections.join(", ")}`;
  }

  return "";
}

function generatePageId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}
