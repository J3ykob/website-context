import { randomUUID } from "crypto";
import { createHash } from "crypto";
import type { CrawlResult, ScrapedPage } from "../scraper/types.js";
import { htmlToMarkdown, type MarkdownSection } from "../scraper/markdown.js";
import { fetchPage } from "../scraper/fetcher.js";
import { OpenRouterProvider } from "../llm/openrouter-provider.js";
import type {
  WebsiteContext,
  PageContext,
  SectionContext,
  SiteMapEntry,
  ContentChunk,
  ChunkMetadata,
} from "./types.js";

// Harvest canonical contact data from tel:/mailto: links in the raw HTML. These are
// the site's OWN structured contact links (present on almost every page's header/
// footer), so they're reliable — unlike a phone guessed from prose, which turned a
// car price into "899000.00". The header/footer where they live is usually dropped
// during markdown extraction, so without this the real number never reaches a chunk.
function extractTelMailto(html: string): { phones: string[]; emails: string[] } {
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    let raw: string;
    try { raw = decodeURIComponent(m[1]); } catch { raw = m[1]; }
    raw = raw.replace(/[^\d+\s().-]/g, "").trim();
    if (raw.replace(/\D/g, "").length >= 7) phones.add(raw);
  }
  for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)["']/gi)) {
    let e: string;
    try { e = decodeURIComponent(m[1]); } catch { e = m[1]; }
    e = e.trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e) && !/\.(png|jpg|jpeg|svg|gif)$/.test(e)) emails.add(e);
  }
  return { phones: [...phones].slice(0, 3), emails: [...emails].slice(0, 3) };
}

export async function buildContext(crawlResult: CrawlResult): Promise<WebsiteContext> {
  const pages: PageContext[] = [];
  const chunks: ContentChunk[] = [];
  const siteMap: SiteMapEntry[] = [];
  const contactPhones = new Set<string>();
  const contactEmails = new Set<string>();

  for (const scrapedPage of crawlResult.pages) {
    // Re-fetch for markdown (we already have the HTML in memory during crawl,
    // but for now we'll work from the scraped page data)
    const fetchResult = await fetchPage(scrapedPage.url, { timeout: 10000 });
    const markdown = htmlToMarkdown(fetchResult);

    // Harvest canonical contact data from this page's tel:/mailto: links.
    const ci = extractTelMailto(fetchResult.html);
    ci.phones.forEach((p) => contactPhones.add(p));
    ci.emails.forEach((e) => contactEmails.add(e));

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

  // Add ONE reliable contact chunk from the collected tel:/mailto: links, so the bot
  // can give the real phone/email even when the header/footer didn't survive markdown
  // extraction and the dedicated contact page wasn't crawled.
  if ((contactPhones.size || contactEmails.size) && crawlResult.pages.length > 0) {
    const lines: string[] = [];
    if (contactPhones.size) lines.push(`Telefon / phone: ${[...contactPhones].join(", ")}`);
    if (contactEmails.size) lines.push(`Email: ${[...contactEmails].join(", ")}`);
    const body = `## Kontakt / Contact\n\n${lines.join("\n")}`;
    const url = crawlResult.pages[0].url;
    const pageId = generatePageId(url);
    chunks.push({
      id: chunkId(pageId, ["Kontakt"], 0, body),
      pageId,
      content: body,
      contextPrefix: `Official contact details (phone / email) for this business, taken from the site's tel: and mailto: links.`,
      metadata: { url, title: "Kontakt / Contact", headingHierarchy: ["Kontakt", "Contact"], type: "form-description" },
    });
  }

  await enrichChunks(chunks);

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

    // Enrichment (summary + descriptors) is applied later in enrichChunks(),
    // after large sections are split, so it lands on the final chunk bodies.
    const bodies = content.length <= 4000 ? [content] : splitIntoChunks(content, 2500, 150);
    bodies.forEach((body, i) => {
      chunks.push({
        id: chunkId(pageId, section.headingPath, i, body),
        pageId,
        content: body,
        contextPrefix,
        metadata: {
          url: page.url,
          title: page.title,
          headingHierarchy: section.headingPath,
          type: chunkType,
        },
      });
    });
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
 * Enrich every chunk with an LLM-generated summary + descriptor keywords.
 * Keywords are CATEGORY descriptors ("dimensions", "opening hours", "warranty"),
 * not just literal values, so "what are the dimensions?" retrieves a chunk that
 * only lists raw measurements. Falls back to regex enrichment when no API key is
 * set or the call fails, so a scrape never silently loses all enrichment.
 */
async function enrichChunks(chunks: ContentChunk[]): Promise<void> {
  const hasKey = !!process.env.OPENROUTER_API_KEY;
  const concurrency = 8;
  let next = 0;

  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const heading = chunk.metadata.headingHierarchy.slice(-1)[0] || "";
      const llm = hasKey && chunk.content.trim().length >= 60
        ? await llmEnrich(chunk.content).catch(() => null)
        : null;
      if (llm) {
        chunk.content = `${llm.summary} Keywords: ${llm.keywords.join(", ")}.\n\n${chunk.content}`;
      } else {
        chunk.content = enrichChunk(chunk.content, chunk.metadata.type, heading);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, worker)
  );
}

const ENRICH_SYSTEM =
  "You label chunks of website content for a semantic search index that powers a customer-facing chatbot. You return a one-line summary and a list of search keywords as strict JSON.";

async function llmEnrich(content: string): Promise<{ summary: string; keywords: string[] }> {
  const provider = new OpenRouterProvider({
    model: process.env.ENRICH_MODEL || process.env.OPENROUTER_MODEL,
    maxTokens: 300,
    temperature: 0.2,
  });

  const user = `Analyze this chunk of content from a business website. Produce metadata that helps a retrieval system find it when a customer asks a question.

Return ONLY strict JSON: {"summary": string, "keywords": string[]}

"summary": one short sentence describing WHAT KIND of information the chunk contains (not a sales pitch). Examples: "Lists the dimensions, weight and materials of the product.", "Opening hours for each day of the week.", "Renovation pricing per square metre with warranty terms."

"keywords": 8-15 short search terms. CRITICAL - include CATEGORY DESCRIPTORS for the TYPES of information present, not only the literal values. For example, if the chunk lists "200x90cm, oak, 80kg" include descriptors like "dimensions", "size", "width", "height", "material", "weight" - not just the numbers. Other descriptor examples: "pricing", "opening hours", "contact details", "address", "warranty", "delivery", "technical specifications", "capacity", "ingredients", "availability". Also include the most important specific topics or product names from the chunk.

Write the summary and keywords in the SAME language as the content. For the category descriptors, also add the English equivalent (e.g. for Polish content include both "wymiary" and "dimensions").

Do not invent information that is not present in the chunk.

Content:
"""
${content.slice(0, 6000)}
"""`;

  const res = await provider.chat([
    { role: "system", content: ENRICH_SYSTEM },
    { role: "user", content: user },
  ]);

  const parsed = parseEnrichJSON(res.content);
  if (!parsed) throw new Error("enrich: unparseable response");
  return parsed;
}

function parseEnrichJSON(raw: string): { summary: string; keywords: string[] } | null {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const brace = s.match(/\{[\s\S]*\}/);
  if (brace) s = brace[0];
  try {
    const obj = JSON.parse(s) as { summary?: unknown; keywords?: unknown };
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    const keywords = Array.isArray(obj.keywords)
      ? (obj.keywords.filter((k) => typeof k === "string") as string[])
          .map((k) => k.trim())
          .filter(Boolean)
          .slice(0, 15)
      : [];
    if (!summary && keywords.length === 0) return null;
    let normSummary = summary || "Website content.";
    if (!/[.!?]$/.test(normSummary)) normSummary += ".";
    return { summary: normSummary, keywords };
  } catch {
    return null;
  }
}

/**
 * Regex enrichment - fallback used when the LLM call is unavailable.
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

// Deterministic chunk ID from the RAW body + position. Re-scrapes of unchanged
// content yield the same ID, so the vector is overwritten rather than duplicated
// (Vectorize has no delete-by-filter). Hashing the raw body — not the enriched
// content — keeps IDs stable despite non-deterministic LLM enrichment.
function chunkId(pageId: string, headingPath: string[], index: number, body: string): string {
  return createHash("sha256")
    .update(`${pageId} ${headingPath.join(">")} ${index} ${body}`)
    .digest("hex")
    .slice(0, 32);
}
