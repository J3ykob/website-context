import * as cheerio from "cheerio";
import type { AnyNode, Element, Text } from "domhandler";
import type { FetchResult } from "./fetcher.js";

export interface MarkdownResult {
  fullMarkdown: string;
  fitMarkdown: string; // noise-filtered, LLM-optimized
  sections: MarkdownSection[];
}

export interface MarkdownSection {
  heading: string;
  level: number;
  content: string;
  url: string; // source page URL
  headingPath: string[]; // e.g., ["Products", "Pricing", "Enterprise"]
}

// Price pattern: digits with optional decimal, followed by currency
const PRICE_PATTERN = /\d+[.,]\d{2}\s*(zł|PLN|€|\$|USD|EUR|£|GBP|CHF|CZK|Kč)/i;
const PRICE_PATTERN_STANDALONE = /^\s*\d+[.,]\d{2}\s*(zł|PLN|€|\$|USD|EUR|£|GBP|CHF|CZK|Kč)?\s*$/i;

// Classes that indicate item-like containers
const ITEM_CLASSES = [
  "entry", "item", "card", "product", "menu-item", "service",
  "listing", "post", "offer", "dish", "meal", "treatment",
  "price-item", "pricing-item", "service-item", "menu-entry",
];

// URL path segments indicating content-heavy pages (menus, pricing, etc.)
const CONTENT_PAGE_PATHS = [
  "menu", "cennik", "pricing", "uslugi", "services",
  "oferta", "offer", "produkty", "products", "karta",
  "carta", "speisekarte", "katalog", "catalog", "lista",
];

export function htmlToMarkdown(fetchResult: FetchResult): MarkdownResult {
  const $ = cheerio.load(fetchResult.html);

  // Remove noise elements
  $(
    "nav, header, footer, script, style, noscript, iframe, " +
    ".cookie-banner, .cookie-consent, .popup, .modal, .overlay, " +
    "[role='navigation'], [role='banner'], [role='contentinfo'], " +
    ".sidebar, .breadcrumb, .pagination, .social-share, " +
    ".advertisement, .ad, .ads, [class*='cookie'], [id*='cookie'], " +
    "[class*='popup'], [class*='modal'], [class*='newsletter'], " +
    "form[action*='subscribe'], form[action*='newsletter']"
  ).remove();

  // NOTE: We do NOT remove .menu here — on restaurant sites .menu IS the content.
  // Navigation menus are already removed via <nav> and [role='navigation'].

  // Check if this is a content-heavy page (menu, pricing, etc.) based on URL
  const isContentPage = isContentHeavyPage(fetchResult.finalUrl);

  // Find main content area
  const mainSelectors = [
    "main", "[role='main']", "article", ".content", ".main-content",
    "#content", "#main", ".post-content", ".entry-content", ".page-content",
    ".article-body", ".prose",
    // WordPress/theme-specific
    ".site-content", "#primary", ".main-wrapper",
    ".content-area", "[role='document']",
    ".fw-main-row", // Flavor theme (restauracjasloik.pl)
    ".elementor-widget-container", // Elementor
    ".wp-block-group", // WordPress blocks
    "#main-content",
    // Page builders
    ".elementor-section", ".elementor",
    ".vc_row", ".wpb_wrapper", // WPBakery
    ".et_pb_section", ".et_builder_inner_content", // Divi
  ];

  let $main: cheerio.Cheerio<AnyNode> | null = null;

  if (isContentPage) {
    // For content-heavy pages, use the full body to avoid missing content
    $main = $("body");
  } else {
    for (const selector of mainSelectors) {
      const found = $(selector);
      if (found.length > 0) {
        $main = found.first();
        break;
      }
    }

    if (!$main) {
      // If no main content found, check if body has multiple sections
      const sections = $("body > section, body section");
      if (sections.length >= 2) {
        // Use all sections combined by using body
        $main = $("body");
      } else {
        $main = $("body");
      }
    }
  }

  const fullMarkdown = convertToMarkdown($, $main);
  const sections = extractSections(fullMarkdown, fetchResult.finalUrl);
  const fitMarkdown = filterForLLM(sections);

  return { fullMarkdown, fitMarkdown, sections };
}

function isContentHeavyPage(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return CONTENT_PAGE_PATHS.some((p) => pathname.includes(p));
  } catch {
    return false;
  }
}

function hasItemClass(el: Element): boolean {
  const classes = (el.attribs?.class || "").toLowerCase();
  return ITEM_CLASSES.some((cls) => classes.includes(cls));
}

function extractItemContent(
  $: cheerio.CheerioAPI,
  $el: cheerio.Cheerio<Element>
): string | null {
  // Try to extract structured item info (title, description, price)
  const titleSelectors = [
    "h2", "h3", "h4", "h5",
    ".title", ".name", ".entry-title", ".item-title",
    ".product-title", ".dish-name", ".menu-item-title",
  ];
  const descSelectors = [
    "p", ".description", ".excerpt", ".entry-excerpt",
    ".item-description", ".product-description",
  ];
  const priceSelectors = [
    ".price", ".amount", ".cost", ".cena",
    ".entry-price", ".item-price", ".menu-price",
    ".menu-item-price", ".product-price", ".pricing",
    "[class*='price']",
  ];

  let title = "";
  let description = "";
  let price = "";

  // Find title
  for (const sel of titleSelectors) {
    const found = $el.find(sel).first();
    if (found.length > 0) {
      title = found.text().trim();
      if (title) break;
    }
  }

  // Find description
  for (const sel of descSelectors) {
    const found = $el.find(sel).first();
    if (found.length > 0) {
      const text = found.text().trim();
      // Don't use the title element as description
      if (text && text !== title) {
        description = text;
        break;
      }
    }
  }

  // Find price - first by selectors
  for (const sel of priceSelectors) {
    const found = $el.find(sel).first();
    if (found.length > 0) {
      price = found.text().trim();
      if (price) break;
    }
  }

  // If no price found via selectors, search for price patterns in text
  if (!price) {
    const fullText = $el.text();
    const priceMatch = fullText.match(PRICE_PATTERN);
    if (priceMatch) {
      price = priceMatch[0].trim();
    }
  }

  // If we found at least a title or meaningful text, format it
  if (title) {
    const parts: string[] = [`### ${title}`];
    if (description) parts.push(description);
    if (price) parts.push(`**${price}**`);
    return parts.join("\n");
  }

  // Fallback: if the div has meaningful text content, return it
  const fullText = $el.text().trim();
  if (fullText.length > 3) {
    // Check if it looks like a structured item (has price or short lines)
    if (PRICE_PATTERN.test(fullText) || fullText.length < 200) {
      return fullText;
    }
  }

  return null;
}

function convertToMarkdown(
  $: cheerio.CheerioAPI,
  $root: cheerio.Cheerio<AnyNode>
): string {
  const lines: string[] = [];
  const SKIP = new Set(["script", "style", "noscript", "svg", "canvas", "iframe"]);
  const INLINE = new Set(["span", "strong", "b", "em", "i", "small", "sub", "sup", "mark", "abbr", "time", "cite"]);

  function walk(el: AnyNode): void {
    if (el.type === "text") {
      const t = (el as Text).data?.trim();
      if (t) lines.push(t);
      return;
    }
    if (el.type !== "tag") return;
    const elem = el as Element;
    const tag = elem.tagName?.toLowerCase();
    if (!tag || SKIP.has(tag)) return;
    const $el = $(elem);

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const t = $el.text().trim();
      if (t) { lines.push(""); lines.push("#".repeat(parseInt(tag[1])) + " " + t); lines.push(""); }
      return;
    }

    // Section with id — use id as heading hint
    if (tag === "section") {
      const id = $el.attr("id");
      if (id && !/^(page|main|content|site|wrapper|app|cherry)/i.test(id)) {
        lines.push(""); lines.push("## " + id.replace(/[-_]/g, " ")); lines.push("");
      }
      $el.contents().each((_, c) => walk(c));
      return;
    }

    // Lists
    if (tag === "ul" || tag === "ol") {
      lines.push("");
      $el.children("li").each((i, li) => {
        const t = $(li).text().trim();
        if (t) lines.push((tag === "ol" ? (i+1) + ". " : "- ") + t);
      });
      lines.push("");
      return;
    }

    // Tables
    if (tag === "table") {
      const rows: string[][] = [];
      $el.find("tr").each((_, tr) => {
        const cells = $(tr).find("th,td").map((_, c) => $(c).text().trim()).get();
        if (cells.length) rows.push(cells);
      });
      if (rows.length) {
        lines.push("");
        lines.push("| " + rows[0].join(" | ") + " |");
        lines.push("| " + rows[0].map(() => "---").join(" | ") + " |");
        rows.slice(1).forEach(r => lines.push("| " + r.join(" | ") + " |"));
        lines.push("");
      }
      return;
    }

    // Pre/code
    if (tag === "pre" || tag === "code") {
      const t = $el.text().trim();
      if (t) { lines.push(""); lines.push("```"); lines.push(t); lines.push("```"); lines.push(""); }
      return;
    }

    // Blockquotes
    if (tag === "blockquote") {
      const t = $el.text().trim();
      if (t) { lines.push(""); lines.push("> " + t); lines.push(""); }
      return;
    }

    // Images
    if (tag === "img") { return; } // skip images, they add noise

    // Line breaks
    if (tag === "br") { lines.push(""); return; }
    if (tag === "hr") { lines.push(""); lines.push("---"); lines.push(""); return; }

    // Paragraphs
    if (tag === "p") {
      const t = $el.text().trim();
      if (t) { lines.push(t); lines.push(""); }
      return;
    }

    // Everything else: recurse into children, preserving ALL text
    $el.contents().each((_, c) => walk(c));
    if (!INLINE.has(tag)) lines.push("");
  }

  $root.contents().each((_, c) => walk(c));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractSections(markdown: string, url: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const lines = markdown.split("\n");
  const headingStack: { heading: string; level: number }[] = [];
  let currentContent: string[] = [];
  let currentHeading = "";
  let currentLevel = 0;

  function flushSection() {
    const content = currentContent.join("\n").trim();
    if (content || currentHeading) {
      sections.push({
        heading: currentHeading,
        level: currentLevel,
        content,
        url,
        headingPath: headingStack.map((h) => h.heading),
      });
    }
    currentContent = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushSection();

      const level = headingMatch[1].length;
      const heading = headingMatch[2].trim();

      // Update heading stack
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop();
      }
      headingStack.push({ heading, level });

      currentHeading = heading;
      currentLevel = level;
    } else {
      currentContent.push(line);
    }
  }

  flushSection();
  return sections;
}

function filterForLLM(sections: MarkdownSection[]): string {
  const meaningful = sections.filter((section) => {
    const content = section.content.trim();
    if (!content) return false;
    // Lowered from 20 to 5: short menu items like "Szarlotka 26,90" are valuable
    if (content.length < 5) return false;

    // Filter out sections that are likely navigation or boilerplate
    const lowerHeading = section.heading.toLowerCase();
    const boilerplateHeadings = [
      "cookie", "privacy", "terms", "subscribe", "newsletter",
      "follow us", "social", "share", "related posts", "comments",
    ];
    if (boilerplateHeadings.some((b) => lowerHeading.includes(b))) return false;

    // Filter out sections that are mostly links (but only for longer sections)
    const linkCount = (content.match(/\[.*?\]\(.*?\)/g) || []).length;
    const wordCount = content.split(/\s+/).length;
    if (linkCount > 0 && linkCount / wordCount > 0.5 && wordCount > 10) return false;

    return true;
  });

  return meaningful
    .map((s) => {
      const heading = s.heading ? `${"#".repeat(s.level)} ${s.heading}\n\n` : "";
      return heading + s.content;
    })
    .join("\n\n")
    .trim();
}
