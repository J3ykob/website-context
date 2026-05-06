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

    if (content.length <= 4000) {
      chunks.push({
        id: randomUUID(),
        pageId,
        content,
        contextPrefix,
        metadata: {
          url: page.url,
          title: page.title,
          headingHierarchy: section.headingPath,
          type: chunkType,
        },
      });
    } else {
      const subChunks = splitIntoChunks(content, 2500, 150);
      for (const subChunk of subChunks) {
        chunks.push({
          id: randomUUID(),
          pageId,
          content: subChunk,
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
): "content" | "faq" | "product" | "form-description" | "navigation" {
  const heading = section.heading.toLowerCase();

  if (heading.includes("faq") || heading.includes("frequently asked")) return "faq";
  if (heading.includes("product") || heading.includes("pricing")) return "product";
  if (heading.includes("contact") || heading.includes("form")) return "form-description";

  return "content";
}

function generatePageId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}
