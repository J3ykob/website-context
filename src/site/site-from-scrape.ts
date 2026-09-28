/**
 * Build the /site micro-site card from a SCRAPED website — the "new site" offer for
 * businesses whose own site is outdated (no HTTPS, not mobile, years stale).
 *
 * The interview path (onboarding/interview.ts) builds a siteCard from the owner's
 * answers; this is the same card shape built from what we already crawled. One LLM
 * call writes the prose (brand, tagline, sections, suggestions) strictly from page
 * text; contact facts (phone/email/address/hours) come from the canonical
 * OfficialBusinessInfo extractor, never from the model.
 */
import { OpenRouterProvider } from "../llm/openrouter-provider.js";
import type { ContentChunk, OfficialBusinessInfo } from "../context/types.js";

export interface ScrapedSiteCard {
  brand?: string;
  tagline?: string;
  eyebrow?: string;
  phone?: string;
  suggestions: string[];
  sections: { label: string; text: string }[];
  source: "scrape";
  generatedAt: string;
}

const MAX_SOURCE_CHARS = 14000;

// Shallow pages (home, o-nas, oferta, kontakt) describe the business best; deep
// pages (single blog posts, gallery items) mostly add noise. Maps chunks (reviews)
// are left out — the card describes the business in its own words.
function pickSource(chunks: ContentChunk[]): string {
  const depth = (u: string) => { try { return new URL(u).pathname.split("/").filter(Boolean).length; } catch { return 9; } };
  const site = chunks.filter((c) => c.metadata?.url && /^https?:/.test(c.metadata.url) && c.content.trim().length > 40);
  site.sort((a, b) => depth(a.metadata.url) - depth(b.metadata.url));
  const seen = new Set<string>();
  let out = "";
  for (const c of site) {
    const text = c.content.replace(/\s+/g, " ").trim();
    const key = text.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    const block = `[${c.metadata.title || c.metadata.url}]\n${text}\n\n`;
    if (out.length + block.length > MAX_SOURCE_CHARS) break;
    out += block;
  }
  return out;
}

function contactSection(info?: OfficialBusinessInfo): { label: string; text: string } | null {
  if (!info) return null;
  const lines = [
    info.primaryAddress?.value && `Adres: ${info.primaryAddress.value}`,
    info.primaryPhone?.value && `Telefon: ${info.primaryPhone.value}`,
    info.primaryEmail?.value && `E-mail: ${info.primaryEmail.value}`,
    info.openingHours?.value && `Godziny: ${info.openingHours.value}`,
  ].filter(Boolean);
  return lines.length ? { label: "Kontakt", text: lines.join("\n") } : null;
}

export async function synthesizeSiteCardFromScrape(
  domain: string, chunks: ContentChunk[], info?: OfficialBusinessInfo,
): Promise<ScrapedSiteCard | null> {
  const source = pickSource(chunks);
  if (source.length < 200) return null;

  const system =
    "You write the content of a one-page website for a business, using ONLY the text scraped from its current website. " +
    "Output STRICT JSON only: {\"brand\":\"...\",\"tagline\":\"...\",\"eyebrow\":\"...\",\"suggestions\":[\"...\"],\"sections\":[{\"label\":\"...\",\"text\":\"...\"}]}. " +
    "Write in the same language as the source (default Polish), in the business's own voice (we/our). " +
    "brand: the business's short trading name as the site presents it (not the legal form, no 'sp. z o.o.' unless it is part of the name). " +
    "tagline: one concrete line, max 9 words, saying what they do and for whom. " +
    "eyebrow: very short 'City · Category' label, e.g. 'Warszawa · Remonty i wykończenia'; empty string if unknown. " +
    "sections: 4-7 cards a customer scans: what they offer (split into 1-3 cards by service group if the source supports it), area served, how they work / process, experience or credentials, anything distinctive. " +
    "Each text 1-4 plain sentences or a short list separated by newlines. Short labels (1-3 words). " +
    "Do NOT include a contact card (added separately). Do NOT invent prices, years, certificates, numbers, guarantees or claims that are not in the source; omit a card rather than guess. " +
    "suggestions: 3-4 short questions a customer would ask this business, answerable from the source.";
  const prompt = `Domain: ${domain}\n\nScraped website text:\n${source}\n\nReturn the JSON now.`;

  let content = "";
  try {
    const r = await new OpenRouterProvider().chat(
      [{ role: "system", content: system }, { role: "user", content: prompt }],
      { maxTokens: 1600, temperature: 0.3 },
    );
    content = r.content || "";
  } catch {
    return null;
  }
  const parsed = extractJson(content);
  if (!parsed) return null;

  const str = (v: any, n: number) => (typeof v === "string" ? v.trim() : "").slice(0, n);
  const sections = (Array.isArray(parsed.sections) ? parsed.sections : [])
    .map((s: any) => ({ label: str(s?.label, 120), text: str(s?.text, 2000) }))
    .filter((s: { label: string; text: string }) => s.label && s.text.length > 10)
    .slice(0, 8);
  if (sections.length === 0) return null;
  const contact = contactSection(info);
  if (contact) sections.push(contact);

  return {
    brand: str(parsed.brand, 120) || undefined,
    tagline: str(parsed.tagline, 120) || undefined,
    eyebrow: str(parsed.eyebrow, 80) || undefined,
    phone: info?.primaryPhone?.value?.slice(0, 40) || undefined,
    suggestions: (Array.isArray(parsed.suggestions) ? parsed.suggestions : []).map((s: any) => str(s, 160)).filter(Boolean).slice(0, 4),
    sections,
    source: "scrape",
    generatedAt: new Date().toISOString(),
  };
}

function extractJson(text: string): any {
  if (!text) return null;
  const t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}
