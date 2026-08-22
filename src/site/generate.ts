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
