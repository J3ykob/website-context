/**
 * Sanitiser for LLM-generated micro-site HTML. The page is public, so this is the
 * safety boundary: we allow a bounded set of layout/text tags + one <style> block,
 * and strip anything executable — <script>, event handlers, javascript:/data: URLs,
 * forms, iframes, and CSS expression()/@import. Not a substitute for a browser
 * sandbox, but it removes the realistic XSS vectors from prompt-injected output.
 */
import * as cheerio from "cheerio";

const ALLOWED = new Set([
  "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "button", "caption",
  "code", "div", "em", "figure", "figcaption", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "i", "img", "li", "main", "mark", "nav", "ol", "p", "picture", "pre",
  "section", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "u", "ul", "time", "style", "dl", "dt", "dd", "s",
]);
const DROP = new Set([
  "script", "iframe", "object", "embed", "form", "input", "textarea", "select", "option",
  "base", "meta", "link", "noscript", "template", "svg", "canvas", "audio", "video",
  "applet", "frame", "frameset", "math", "portal",
]);

// Safe: known-safe scheme, hash, or a relative URL (no scheme at all).
const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/|\.\/|\.\.\/|[^:]*$)/i;

function cleanCss(css: string): string {
  return String(css || "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "(")
    .replace(/javascript:/gi, "")
    .replace(/url\(\s*(['"]?)\s*javascript:/gi, "url($1");
}

export function sanitizeSiteHtml(html: string, maxLen = 90000): string {
  if (!html) return "";
  const noComments = String(html).slice(0, maxLen).replace(/<!--[\s\S]*?-->/g, "");
  const $ = cheerio.load(noComments, {}, false);

  DROP.forEach((tag) => $(tag).remove());

  // <style>/<script> parse to node type "style"/"script" (not "tag"), so the main
  // element loop below skips them. Scripts are already dropped; clean <style> CSS here.
  $("style").each((_: any, el: any) => { $(el).text(cleanCss($(el).text())); });

  // Static list — replaceWith/unwrap during a live selection can skip nodes.
  $("*").toArray().forEach((el: any) => {
    if (!el || el.type !== "tag") return;
    const name = String(el.tagName || el.name || "").toLowerCase();
    const $el = $(el);

    if (DROP.has(name)) { $el.remove(); return; }
    if (!ALLOWED.has(name)) { $el.replaceWith($el.contents()); return; }

    for (const attr of Object.keys(el.attribs || {})) {
      const a = attr.toLowerCase();
      const v = String(el.attribs[attr] || "");
      if (a.startsWith("on")) { $el.removeAttr(attr); continue; }
      if (a === "srcdoc" || a === "formaction") { $el.removeAttr(attr); continue; }
      if (a === "style") { if (/expression\s*\(|javascript:/i.test(v)) $el.attr("style", cleanCss(v)); continue; }
      if (a === "href" || a === "src" || a === "action" || a === "xlink:href" || a === "srcset" || a === "poster" || a === "background") {
        const val = v.trim();
        const okImg = name === "img" && (a === "src" || a === "srcset") && /^data:image\//i.test(val);
        if (/javascript:/i.test(val) || (!okImg && !SAFE_URL.test(val))) $el.removeAttr(attr);
      }
    }
    if (name === "button") $el.attr("type", "button");
    if (name === "a") { $el.attr("rel", "noopener noreferrer nofollow"); }
  });

  return $.root().html() || "";
}
