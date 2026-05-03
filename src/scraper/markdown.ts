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

export function htmlToMarkdown(fetchResult: FetchResult): MarkdownResult {
  const $ = cheerio.load(fetchResult.html);

  // Remove noise elements
  $(
    "nav, header, footer, script, style, noscript, iframe, " +
    ".cookie-banner, .cookie-consent, .popup, .modal, .overlay, " +
    "[role='navigation'], [role='banner'], [role='contentinfo'], " +
    ".sidebar, .menu, .breadcrumb, .pagination, .social-share, " +
    ".advertisement, .ad, .ads, [class*='cookie'], [id*='cookie'], " +
    "[class*='popup'], [class*='modal'], [class*='newsletter'], " +
    "form[action*='subscribe'], form[action*='newsletter']"
  ).remove();

  // Find main content area
  const mainSelectors = [
    "main", "[role='main']", "article", ".content", ".main-content",
    "#content", "#main", ".post-content", ".entry-content", ".page-content",
    ".article-body", ".prose",
  ];

  let $main: cheerio.Cheerio<AnyNode> | null = null;
  for (const selector of mainSelectors) {
    const found = $(selector);
    if (found.length > 0) {
      $main = found.first();
      break;
    }
  }

  if (!$main) {
    $main = $("body");
  }

  const fullMarkdown = convertToMarkdown($, $main);
  const sections = extractSections(fullMarkdown, fetchResult.finalUrl);
  const fitMarkdown = filterForLLM(sections);

  return { fullMarkdown, fitMarkdown, sections };
}

function convertToMarkdown(
  $: cheerio.CheerioAPI,
  $root: cheerio.Cheerio<AnyNode>
): string {
  const lines: string[] = [];

  function processNode(el: AnyNode, depth: number = 0): void {
    if (el.type === "text") {
      const text = (el as Text).data?.trim();
      if (text) lines.push(text);
      return;
    }

    if (el.type !== "tag") return;
    const element = el as Element;
    const tag = element.tagName?.toLowerCase();

    if (!tag) return;

    const $el = $(element);

    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const level = parseInt(tag[1]);
        const text = $el.text().trim();
        if (text) {
          lines.push("");
          lines.push("#".repeat(level) + " " + text);
          lines.push("");
        }
        break;
      }
      case "p": {
        const text = $el.text().trim();
        if (text && text.length > 5) {
          lines.push(text);
          lines.push("");
        }
        break;
      }
      case "ul": case "ol": {
        lines.push("");
        $el.children("li").each((i, li) => {
          const text = $(li).text().trim();
          if (text) {
            const prefix = tag === "ol" ? `${i + 1}. ` : "- ";
            lines.push(prefix + text);
          }
        });
        lines.push("");
        break;
      }
      case "table": {
        const rows: string[][] = [];
        $el.find("tr").each((_, tr) => {
          const cells = $(tr).find("th, td").map((_, cell) => $(cell).text().trim()).get();
          if (cells.length > 0) rows.push(cells);
        });
        if (rows.length > 0) {
          lines.push("");
          lines.push("| " + rows[0].join(" | ") + " |");
          lines.push("| " + rows[0].map(() => "---").join(" | ") + " |");
          for (const row of rows.slice(1)) {
            lines.push("| " + row.join(" | ") + " |");
          }
          lines.push("");
        }
        break;
      }
      case "pre": case "code": {
        const text = $el.text().trim();
        if (text) {
          lines.push("");
          lines.push("```");
          lines.push(text);
          lines.push("```");
          lines.push("");
        }
        break;
      }
      case "blockquote": {
        const text = $el.text().trim();
        if (text) {
          lines.push("");
          lines.push("> " + text);
          lines.push("");
        }
        break;
      }
      case "a": {
        const href = $el.attr("href");
        const text = $el.text().trim();
        if (text && href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          lines.push(`[${text}](${href})`);
        } else if (text) {
          lines.push(text);
        }
        break;
      }
      case "img": {
        const alt = $el.attr("alt")?.trim();
        if (alt) {
          lines.push(`[Image: ${alt}]`);
        }
        break;
      }
      case "strong": case "b": {
        const text = $el.text().trim();
        if (text) lines.push(`**${text}**`);
        break;
      }
      case "em": case "i": {
        const text = $el.text().trim();
        if (text) lines.push(`*${text}*`);
        break;
      }
      case "br": {
        lines.push("");
        break;
      }
      case "hr": {
        lines.push("");
        lines.push("---");
        lines.push("");
        break;
      }
      default: {
        // Recursively process children for generic containers
        const children = $el.contents();
        children.each((_, child) => processNode(child, depth + 1));
        break;
      }
    }
  }

  $root.contents().each((_, child) => processNode(child));

  // Clean up excessive blank lines
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    if (content.length < 20) return false;

    // Filter out sections that are likely navigation or boilerplate
    const lowerHeading = section.heading.toLowerCase();
    const boilerplateHeadings = [
      "cookie", "privacy", "terms", "subscribe", "newsletter",
      "follow us", "social", "share", "related posts", "comments",
    ];
    if (boilerplateHeadings.some((b) => lowerHeading.includes(b))) return false;

    // Filter out sections that are mostly links
    const linkCount = (content.match(/\[.*?\]\(.*?\)/g) || []).length;
    const wordCount = content.split(/\s+/).length;
    if (linkCount > 0 && linkCount / wordCount > 0.5) return false;

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

