/**
 * AI prompt-to-site — the owner describes a change in plain language and an LLM
 * rewrites the micro-site's DESIGN SPEC (not raw HTML). Modelled on Lovable's
 * "the design system is everything / change exactly what's asked / never invent"
 * approach, but scoped to our safe, bounded siteCard so the result always renders,
 * stays factual (facts come from the KB, not the design model), and keeps the Whisp
 * chat injected by us. The spec maps 1:1 onto what render-site.ts already supports,
 * so a generated result renders with no code changes.
 */
import { OpenRouterProvider } from "../llm/openrouter-provider.js";
import { sanitizeSiteHtml } from "./sanitize-html.js";

export interface CurrentSite {
  theme: "light" | "dark";
  accent: string;
  tagline: string;
  eyebrow: string;
  phone: string;
  sections: { label: string; text: string }[];
  suggestions: string[];
}
export interface SiteSpec extends CurrentSite {
  changeSummary: string;
}

function normHex(raw: string): string {
  const h = (raw || "").trim();
  if (/^#[0-9a-fA-F]{3}$/.test(h)) return ("#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]).toLowerCase();
  if (/^#[0-9a-fA-F]{6}$/.test(h)) return h.toLowerCase();
  return "";
}
function extractJson(text: string): any {
  if (!text) return null;
  const t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

const SYSTEM = (brand: string) =>
  `You are a web designer for "${brand}", a small local business whose ONLY web presence is this one-page micro-site. You edit its site from the owner's plain-language instruction.\n` +
  `HARD RULES:\n` +
  `- Return ONLY strict JSON matching the schema below. No HTML, CSS, JS, or prose outside the JSON.\n` +
  `- Change EXACTLY what the owner asks; copy every other current value through UNCHANGED.\n` +
  `- NEVER invent facts (hours, prices, address, phone). Only rephrase/reorganise existing text or use text the owner explicitly gives. If the owner asks for info you don't have, leave it out.\n` +
  `- Keep it tasteful — the result must always look good. Write in the site's language (default Polish).\n` +
  `- accent is a single hex colour (#rrggbb). theme is "light" or "dark". Do not add sections the instruction doesn't imply.\n` +
  `- The Whisp chat assistant and contact details are injected by the system — never mention or remove them.\n` +
  `Schema:\n` +
  `{"theme":"light|dark","accent":"#rrggbb","tagline":"...","eyebrow":"...","phone":"...","sections":[{"label":"...","text":"..."}],"suggestions":["..."],"changeSummary":"one sentence, in the site's language: what changed and what stayed"}`;

// ─── Free-form HTML mode (true prompt-to-site) ───────────────────────────────
export interface HtmlResult { html: string; changeSummary: string }

function factsBlock(brand: string, card: any): string {
  const c = card || {};
  const lines = [`Business name: ${brand}`];
  if (c.tagline) lines.push(`Tagline: ${c.tagline}`);
  if (c.eyebrow) lines.push(`Short label: ${c.eyebrow}`);
  if (c.phone) lines.push(`Phone: ${c.phone}`);
  (Array.isArray(c.sections) ? c.sections : []).forEach((s: any) => {
    if (s && (s.label || s.text)) lines.push(`- ${s.label || ""}: ${s.text || ""}`);
  });
  return lines.join("\n");
}

const HTML_SYSTEM = (brand: string) =>
  `You are a web designer for "${brand}", a local business whose ONLY website is this single page. You output or edit its page BODY as HTML.\n` +
  `OUTPUT: ONLY HTML — the inner HTML of the page body. Include exactly ONE <style> block with CSS for a beautiful, cohesive, RESPONSIVE design (mobile-first). NO <script>, NO <form>, NO external JS or trackers. End your output with a single HTML comment: <!--SUMMARY: one sentence, in the site's language, of what you changed-->.\n` +
  `WHISP ASSISTANT (critical): include the EXACT token {{WHISP_CHAT}} once, on its own line, where the AI chat assistant belongs (e.g. a hero "ask us anything" area). The system swaps it for a real working assistant — never wrap it in a link, style it, or remove it.\n` +
  `FACTS: use ONLY the facts given below. NEVER invent prices, hours, address, or phone. If asked for something you don't have, leave it out.\n` +
  `LANGUAGE: write in the site's language (default Polish).\n` +
  `EDITING: if a CURRENT PAGE is provided, change EXACTLY what the instruction asks and keep everything else intact. If none is provided, build a complete, elegant one-page site from the facts.`;

export async function generateSiteHtml(brand: string, card: any, currentHtml: string, prompt: string): Promise<HtmlResult> {
  const provider = new OpenRouterProvider();
  const user =
    `FACTS:\n${factsBlock(brand, card)}\n\n` +
    `CURRENT PAGE HTML:\n${(currentHtml && currentHtml.trim()) ? currentHtml.slice(0, 30000) : "(none yet — build it fresh)"}\n\n` +
    `OWNER INSTRUCTION:\n"${String(prompt).slice(0, 600)}"\n\nReturn the page body HTML now.`;

  const { content } = await provider.chat(
    [ { role: "system", content: HTML_SYSTEM(brand) }, { role: "user", content: user } ],
    { maxTokens: 5000, temperature: 0.5 }
  );

  let raw = String(content || "").replace(/```html/gi, "").replace(/```/g, "").trim();
  const m = raw.match(/<!--\s*SUMMARY:\s*([\s\S]*?)-->/i);
  const changeSummary = ((m && m[1]) || "").trim().slice(0, 220) || "Zaktualizowano stronę.";
  let html = sanitizeSiteHtml(raw); // sanitize also strips all comments
  if (!/\{\{WHISP_CHAT\}\}/.test(html)) {
    html += '\n<div style="max-width:640px;margin:40px auto;padding:0 20px">{{WHISP_CHAT}}</div>';
  }
  return { html, changeSummary };
}

export async function generateSiteSpec(brand: string, current: CurrentSite, prompt: string): Promise<SiteSpec> {
  const provider = new OpenRouterProvider();
  const cur: CurrentSite = {
    theme: current.theme === "dark" ? "dark" : "light",
    accent: normHex(current.accent) || "#bb5a30",
    tagline: current.tagline || "",
    eyebrow: current.eyebrow || "",
    phone: current.phone || "",
    sections: Array.isArray(current.sections) ? current.sections : [],
    suggestions: Array.isArray(current.suggestions) ? current.suggestions : [],
  };

  const userMsg =
    `CURRENT SITE (JSON):\n${JSON.stringify(cur)}\n\nOWNER INSTRUCTION:\n"${String(prompt).slice(0, 600)}"\n\nReturn the updated site JSON now.`;

  const { content } = await provider.chat(
    [ { role: "system", content: SYSTEM(brand) }, { role: "user", content: userMsg } ],
    { maxTokens: 1800, temperature: 0.4 }
  );

  const p = extractJson(content) || {};
  const str = (v: any, fallback: string, n: number) =>
    (typeof v === "string" && v.trim()) ? v.trim().slice(0, n) : fallback;

  const sections = Array.isArray(p.sections) && p.sections.length
    ? p.sections.slice(0, 24).map((s: any) => ({ label: str(s?.label, "", 120), text: str(s?.text, "", 2000) })).filter((s: any) => s.label || s.text)
    : cur.sections;
  const suggestions = Array.isArray(p.suggestions) && p.suggestions.length
    ? p.suggestions.slice(0, 6).map((s: any) => str(s, "", 160)).filter(Boolean)
    : cur.suggestions;

  return {
    theme: p.theme === "dark" ? "dark" : (p.theme === "light" ? "light" : cur.theme),
    accent: normHex(p.accent) || cur.accent,
    tagline: str(p.tagline, cur.tagline, 120),
    eyebrow: str(p.eyebrow, cur.eyebrow, 80),
    phone: str(p.phone, cur.phone, 40),
    sections,
    suggestions,
    changeSummary: str(p.changeSummary, "Zaktualizowano stronę.", 220),
  };
}
