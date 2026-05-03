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

function buildChunks(
  sections: MarkdownSection[],
  pageId: string,
  page: ScrapedPage
): ContentChunk[] {
  const chunks: ContentChunk[] = [];

  for (const section of sections) {
    const content = section.heading
      ? `## ${section.heading}\n\n${section.content}`
      : section.content;

    if (content.trim().length < 30) continue;

    // If section is too long, split into sub-chunks
    if (content.length > 1500) {
      const subChunks = splitIntoChunks(content, 1000, 150);
      for (const subChunk of subChunks) {
        chunks.push({
          id: randomUUID(),
          pageId,
          content: subChunk,
          metadata: {
            url: page.url,
            title: page.title,
            headingHierarchy: section.headingPath,
            type: classifyChunkType(section, page),
          },
        });
      }
    } else {
      chunks.push({
        id: randomUUID(),
        pageId,
        content,
        metadata: {
          url: page.url,
          title: page.title,
          headingHierarchy: section.headingPath,
          type: classifyChunkType(section, page),
        },
      });
    }
  }

  return chunks;
}

function splitIntoChunks(text: string, maxSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length > maxSize && current.length > 0) {
      chunks.push(current.trim());
      // Keep overlap from end of current chunk
      const words = current.split(/\s+/);
      const overlapWords = words.slice(-Math.floor(overlap / 5));
      current = overlapWords.join(" ") + "\n\n" + para;
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
