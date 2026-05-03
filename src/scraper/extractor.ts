import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type {
  ScrapedPage,
  ContentBlock,
  PageMetadata,
  PageLink,
  FormElement,
  FormField,
  StructuredDataItem,
} from "./types.js";
import type { FetchResult } from "./fetcher.js";

export function extractPage(fetchResult: FetchResult): ScrapedPage {
  const $ = cheerio.load(fetchResult.html);

  return {
    url: fetchResult.finalUrl,
    title: extractTitle($),
    description: extractDescription($),
    content: extractContent($),
    metadata: extractMetadata($),
    links: extractLinks($, fetchResult.finalUrl),
    forms: extractForms($),
    structuredData: extractStructuredData($),
    scrapedAt: new Date().toISOString(),
    renderMethod: fetchResult.renderMethod,
  };
}

function extractTitle($: cheerio.CheerioAPI): string {
  return (
    $("title").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("h1").first().text().trim() ||
    ""
  );
}

function extractDescription($: cheerio.CheerioAPI): string {
  return (
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    ""
  );
}

function extractMetadata($: cheerio.CheerioAPI): PageMetadata {
  return {
    ogTitle: $('meta[property="og:title"]').attr("content")?.trim(),
    ogDescription: $('meta[property="og:description"]').attr("content")?.trim(),
    ogImage: $('meta[property="og:image"]').attr("content")?.trim(),
    ogType: $('meta[property="og:type"]').attr("content")?.trim(),
    canonical: $('link[rel="canonical"]').attr("href")?.trim(),
    language: $("html").attr("lang")?.trim(),
    keywords: $('meta[name="keywords"]')
      .attr("content")
      ?.split(",")
      .map((k) => k.trim())
      .filter(Boolean),
    author: $('meta[name="author"]').attr("content")?.trim(),
  };
}

function extractContent($: cheerio.CheerioAPI): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Remove non-content elements
  const $content = $.root().clone();
  $content.find("nav, header, footer, script, style, noscript, iframe, .nav, .navbar, .footer, .header, .sidebar, .menu, .cookie-banner, .cookie-consent, [role='navigation'], [role='banner'], [role='contentinfo']").remove();

  // Try to find the main content area
  const mainSelectors = [
    "main",
    "[role='main']",
    "article",
    ".content",
    ".main-content",
    "#content",
    "#main",
    ".post-content",
    ".entry-content",
    ".page-content",
  ];

  let $main: cheerio.Cheerio<AnyNode> | null = null;
  for (const selector of mainSelectors) {
    const found = $content.find(selector);
    if (found.length > 0) {
      $main = found.first();
      break;
    }
  }

  // If no main content area found, use body
  if (!$main) {
    $main = $content.find("body");
  }

  if (!$main || $main.length === 0) return blocks;

  // Extract blocks from main content
  $main.find("h1, h2, h3, h4, h5, h6, p, ul, ol, table, pre, code, blockquote, img").each((_, el) => {
    const $el = $(el);
    const tag = (el as unknown as Element).tagName?.toLowerCase();

    if (!tag) return;

    if (tag.match(/^h[1-6]$/)) {
      const level = parseInt(tag[1]);
      const text = $el.text().trim();
      if (text) {
        blocks.push({ type: "heading", content: text, level });
      }
    } else if (tag === "p") {
      const text = $el.text().trim();
      if (text && text.length > 10) {
        blocks.push({ type: "paragraph", content: text });
      }
    } else if (tag === "ul" || tag === "ol") {
      const items = $el
        .find("li")
        .map((_, li) => $(li).text().trim())
        .get()
        .filter((t) => t.length > 0);
      if (items.length > 0) {
        blocks.push({ type: "list", content: items.join("\n"), items });
      }
    } else if (tag === "table") {
      const rows: string[][] = [];
      $el.find("tr").each((_, tr) => {
        const cells = $(tr)
          .find("th, td")
          .map((_, cell) => $(cell).text().trim())
          .get();
        if (cells.length > 0) rows.push(cells);
      });
      if (rows.length > 0) {
        blocks.push({ type: "table", content: rows.map((r) => r.join(" | ")).join("\n"), rows });
      }
    } else if (tag === "pre" || tag === "code") {
      const text = $el.text().trim();
      if (text) {
        blocks.push({ type: "code", content: text });
      }
    } else if (tag === "blockquote") {
      const text = $el.text().trim();
      if (text) {
        blocks.push({ type: "blockquote", content: text });
      }
    } else if (tag === "img") {
      const src = $el.attr("src");
      const alt = $el.attr("alt")?.trim();
      if (src && alt) {
        blocks.push({ type: "image", content: alt, src, alt });
      }
    }
  });

  return blocks;
}

function extractLinks($: cheerio.CheerioAPI, pageUrl: string): PageLink[] {
  const links: PageLink[] = [];
  const seen = new Set<string>();
  const baseUrl = new URL(pageUrl);

  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href")?.trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
      return;
    }

    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(href, pageUrl).toString();
    } catch {
      return;
    }

    if (seen.has(resolvedUrl)) return;
    seen.add(resolvedUrl);

    const isInternal = new URL(resolvedUrl).hostname === baseUrl.hostname;
    const isNavigation = $el.closest("nav, header, .nav, .navbar, .menu, [role='navigation']").length > 0;

    links.push({
      href: resolvedUrl,
      text: $el.text().trim().slice(0, 200),
      isInternal,
      isNavigation,
    });
  });

  return links;
}

function extractForms($: cheerio.CheerioAPI): FormElement[] {
  const forms: FormElement[] = [];

  $("form").each((_, el) => {
    const $form = $(el);
    const fields: FormField[] = [];

    $form.find("input, select, textarea").each((_, fieldEl) => {
      const $field = $(fieldEl);
      const tag = (fieldEl as unknown as Element).tagName?.toLowerCase();
      const type = $field.attr("type") || (tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text");
      const name = $field.attr("name") || $field.attr("id") || "";

      if (type === "hidden" || type === "submit" || !name) return;

      // Try to find the label
      const id = $field.attr("id");
      let label = id ? $(`label[for="${id}"]`).text().trim() : "";
      if (!label) {
        label = $field.closest("label").text().trim();
      }

      const field: FormField = {
        type,
        name,
        label: label || undefined,
        placeholder: $field.attr("placeholder")?.trim(),
        required: $field.attr("required") !== undefined || $field.attr("aria-required") === "true",
      };

      if (tag === "select") {
        field.options = $field
          .find("option")
          .map((_, opt) => $(opt).text().trim())
          .get()
          .filter(Boolean);
      }

      fields.push(field);
    });

    if (fields.length > 0) {
      forms.push({
        action: $form.attr("action") || "",
        method: ($form.attr("method") || "GET").toUpperCase(),
        id: $form.attr("id"),
        name: $form.attr("name"),
        fields,
      });
    }
  });

  return forms;
}

function extractStructuredData($: cheerio.CheerioAPI): StructuredDataItem[] {
  const items: StructuredDataItem[] = [];

  // Extract JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const text = $(el).text().trim();
      const data = JSON.parse(text);

      if (Array.isArray(data)) {
        for (const item of data) {
          if (item["@type"]) {
            items.push({ type: item["@type"], data: item });
          }
        }
      } else if (data["@graph"]) {
        for (const item of data["@graph"]) {
          if (item["@type"]) {
            items.push({ type: item["@type"], data: item });
          }
        }
      } else if (data["@type"]) {
        items.push({ type: data["@type"], data });
      }
    } catch {
      // Invalid JSON-LD, skip
    }
  });

  // Extract microdata (basic)
  $("[itemtype]").each((_, el) => {
    const $el = $(el);
    const itemType = $el.attr("itemtype") || "";
    const typeName = itemType.split("/").pop() || "";

    if (!typeName) return;

    const data: Record<string, unknown> = { "@type": typeName };
    $el.find("[itemprop]").each((_, propEl) => {
      const $prop = $(propEl);
      const propName = $prop.attr("itemprop") || "";
      const value = $prop.attr("content") || $prop.text().trim();
      if (propName && value) {
        data[propName] = value;
      }
    });

    items.push({ type: typeName, data });
  });

  return items;
}
