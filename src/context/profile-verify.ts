/**
 * Second pass over the Official Business Info profile, with Jev (the extractor itself stays pure).
 *
 * 1. Structured data checked against what the pages SHOW: a site's JSON-LD / microdata can be stale
 *    (rutas.pl: schema says "ul. Stefana Okrzei 1A", Mon-Fri; its contact page says "ul. Milenijna 43
 *    lok.2", Mon-Fri + Sat). A typed fact the visible contact text contradicts is dropped - no profile
 *    line beats a wrong one, the page passages still answer.
 * 2. Gaps filled from the visible text: code proposes LITERAL candidates (phone-like numbers that pass
 *    isRealPhone, emails, Polish street addresses with a postal code), Jev picks the business's own
 *    main one or none. Nothing is invented (the value is a substring of the page), nothing is taken by
 *    regex alone (the 899000.00 price-as-phone bug). Filled facts are medium confidence.
 * Without Jev the profile is returned unchanged.
 */
import * as cheerio from "cheerio";
import type { OfficialBusinessInfo, BusinessFact } from "./types.js";
import { isRealPhone } from "./business-profile.js";
import { jevAsk, jevEnabled, type JevQuestion } from "../llm/jev.js";

const CONTACTISH = /kontakt|contact|impressum|contatti|contacto|nous-contacter|o-nas|about/i;
const PRICEISH = /[€$£%]|\bz[łl]\b|\bkr\b|\beur\b|\busd\b|\bpln\b|cena|price|brutto|netto/i;

/** Visible text of a page (scripts removed), and the text of its inline data (JS-rendered sites keep it there). */
function texts(html: string): { visible: string; data: string } {
  let visible = "", data = "";
  try {
    const $ = cheerio.load(html);
    data = $("script:not([type='application/ld+json'])").map((_: any, e: any) => $(e).text()).get().join(" ").replace(/\\n|\\u002F/g, (m) => (m === "\\n" ? " " : "/"));
    $("script,style,noscript").remove();
    visible = $("body").text();
  } catch {
    visible = html.replace(/<[^>]+>/g, " ");
  }
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  return { visible: norm(visible), data: norm(data) };
}

interface Candidate { value: string; context: string }

function around(text: string, i: number, len: number): string {
  return text.slice(Math.max(0, i - 140), i + len + 140);
}

function phoneCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const re = /(?<![\d\w])(\+?\d[\d\s().\-/]{7,16}\d)(?![\d\w])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = m[1].trim();
    const d = v.replace(/\D/g, "");
    if (d.length < 9 || d.length > 12 || !isRealPhone(v)) continue;
    // Not phones: decimals (coordinates "297.353648"), and long bare digit runs (ids, tax numbers,
    // timestamps) - a bare number counts only with exactly 9 digits.
    if (/\d\.\d{3,}/.test(v) || (!/[\s\-()/+]/.test(v) && d.length !== 9)) continue;
    if (/^\d{2}-\d{3}$/.test(v) || /^\d{4}[-./]\d{2}[-./]\d{2}$/.test(v)) continue; // postal code, date
    const ctx = around(text, m.index, v.length);
    if (PRICEISH.test(text.slice(Math.max(0, m.index - 12), m.index + v.length + 8))) continue;
    out.push({ value: v.replace(/\s+/g, " "), context: ctx });
  }
  return out;
}

function emailCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (/\.(png|jpe?g|gif|svg|webp)$/i.test(m[0]) || /sentry|example|wixpress|domain\.com/i.test(m[0])) continue;
    out.push({ value: m[0].toLowerCase(), context: around(text, m.index, m[0].length) });
  }
  return out;
}

// Polish street addresses: "ul. Milenijna 43 lok.2, 03-130 Warszawa", "al. Krakowska 172A, 05-552 Łazy".
function addressCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const re = /\b(?:ul\.|al\.|pl\.|os\.|ulica|aleja)\s*[A-ZĄĆĘŁŃÓŚŹŻ0-9][^,;|]{1,40}?\s\d+[A-Za-z]?(?:\/\d+)?(?:\s*(?:lok\.?|m\.)\s*\d+[A-Za-z]?)?[,\s]+\d{2}-\d{3}\s+[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+(?:[- ][A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ value: m[0].replace(/\s+/g, " ").trim(), context: around(text, m.index, m[0].length) });
  return out;
}

/** Up to `max` distinct candidates, the most frequent first (a site's own line repeats on its pages); one seen in the visible text counts 3x one only in page data. */
function rank(cands: (Candidate & { w?: number })[], key: (v: string) => string, max = 6): Candidate[] {
  const by = new Map<string, { c: Candidate; n: number }>();
  for (const c of cands) { const k = key(c.value); const w = c.w ?? 1; const e = by.get(k); if (e) e.n += w; else by.set(k, { c, n: w }); }
  return [...by.values()].sort((a, b) => b.n - a.n).slice(0, max).map((e) => e.c);
}

const KIND_NAME = { phone: "main phone number", email: "main email address", address: "address (office, shop or headquarters)" } as const;
type Kind = keyof typeof KIND_NAME;

async function pick(kind: Kind, business: string, cands: Candidate[]): Promise<Candidate | null> {
  if (!cands.length) return null;
  if (process.env.PROFILE_DEBUG) console.log(`[profile] ${kind} candidates:`, cands.map((c) => c.value));
  const criteria: Record<string, string> = { none: `None of these is this business's own ${KIND_NAME[kind]} (they belong to someone else, are examples, prices, or not a ${kind}).` };
  cands.forEach((c, i) => { criteria[`c${i + 1}`] = `"${c.value}" - seen as: …${c.context.slice(0, 300)}…`; });
  const a = await jevAsk({ business }, {
    pick: { type: "choice", instructions: `From the website of \`business\`: which of these is the business's OWN ${KIND_NAME[kind]}, as it presents its contact details to customers - not a partner's, a client's, another company's, an example or a price?`, criteria },
  }, 6000).catch(() => null);
  const c = a?.pick as { choice?: string; probabilities?: Record<string, number> } | undefined;
  if (process.env.PROFILE_DEBUG) console.log(`[profile] ${kind} pick:`, c?.choice, c?.probabilities);
  if (!c?.choice || c.choice === "none" || (c.probabilities?.[c.choice] ?? 0) < 0.6) return null;
  return cands[Number(c.choice.slice(1)) - 1] || null;
}

async function shownOnPage(kind: "address" | "phone" | "hours", value: string, pageText: string): Promise<number | null> {
  const name = kind === "hours" ? "opening hours" : kind === "phone" ? "phone number" : "address";
  const a = await jevAsk({ page_text: pageText.slice(0, 6000), value }, {
    shown: {
      type: "noul",
      instructions: `\`value\` is this business's ${name} taken from its website's structured data. Does \`page_text\` (what its pages show) agree with it? Different formatting or abbreviations still agree. Answer no only if \`page_text\` clearly states a DIFFERENT ${name} for the business${kind === "hours" ? " - other times, or days the value leaves out (e.g. the page also lists Saturday hours)" : ""}; if it states none at all, answer yes.`,
    },
  }, 6000).catch(() => null);
  const n = (a?.shown as { noul?: number } | undefined)?.noul;
  return typeof n === "number" ? n : null;
}

export async function verifyOfficialInfo(info: OfficialBusinessInfo, pages: { url: string; html: string }[], businessName = ""): Promise<OfficialBusinessInfo> {
  if (!jevEnabled() || !pages.length) return info;
  const ordered = [...pages].sort((a, b) => Number(CONTACTISH.test(b.url)) - Number(CONTACTISH.test(a.url)));
  const T = ordered.slice(0, 4).map((p) => ({ url: p.url, ...texts(p.html) }));
  const contactText = T.map((t) => t.visible).join(" \n ").slice(0, 12000);
  const out: OfficialBusinessInfo = { ...info };
  const notes: string[] = [];
  const name = businessName || info.businessName?.value || new URL(pages[0].url).hostname;

  // 1. Structured facts the visible pages contradict.
  const checks: [keyof OfficialBusinessInfo, "address" | "phone" | "hours"][] = [["primaryAddress", "address"], ["primaryPhone", "phone"], ["openingHours", "hours"]];
  await Promise.all(checks.map(async ([field, kind]) => {
    const f = out[field] as BusinessFact | undefined;
    if (!f || (f.source !== "json-ld" && f.source !== "microdata")) return;
    const p = await shownOnPage(kind, f.value, contactText);
    if (p !== null && p < 0.3) { delete out[field]; notes.push(`${kind} "${f.value.slice(0, 60)}" from structured data dropped - the pages show a different one (${p.toFixed(2)})`); }
  }));

  // 2. Gaps filled from the pages' own text (visible first, then inline page data of JS-rendered sites).
  const all = (fn: (t: string) => Candidate[]) => T.flatMap((t) => [...fn(t.visible).map((c) => ({ ...c, w: 3 })), ...fn(t.data)]);
  const fill = async (field: "primaryPhone" | "primaryEmail" | "primaryAddress", kind: Kind, cands: Candidate[]) => {
    if (out[field]) return;
    const c = await pick(kind, name, cands);
    if (!c) return;
    const page = T.find((t) => t.visible.includes(c.value) || t.data.includes(c.value))?.url || pages[0].url;
    out[field] = { value: c.value, source: "contact-page", confidence: "medium", sourceUrl: page };
    notes.push(`${kind}=page text, Jev-picked`);
  };
  await Promise.all([
    fill("primaryPhone", "phone", rank(all(phoneCandidates), (v) => v.replace(/\D/g, "").slice(-9))),
    fill("primaryEmail", "email", rank(all(emailCandidates), (v) => v)),
    fill("primaryAddress", "address", rank(all(addressCandidates), (v) => v.toLowerCase().replace(/\W/g, ""))),
  ]);
  // 3. The main phone as the site's own labels present it: a footer's most frequent number can be one
  // department's line (bostabeton.pl: "Wylewki Anhydrytowe: +48 606 ..." next to "Sprzedaż w Warszawie: +48 22 ...").
  if (out.contactText) {
    const lines = out.contactText.split("\n");
    const found = new Map<string, string>();
    lines.forEach((l, i) => { for (const m of l.matchAll(/(?:\+?\d[\d\s().-]{7,}\d)/g)) { const d = m[0].replace(/\D/g, "").slice(-9); if (d.length === 9 && !found.has(d)) found.set(d, [lines[i - 1] || "", l].join(" / ").slice(0, 200)); } });
    if (found.size >= 2) {
      const opts = [...found.entries()].slice(0, 8);
      const criteria: Record<string, string> = {};
      opts.forEach(([d, ctx], k) => { criteria[`n${k}`] = `${d} - shown as: ${ctx}`; });
      criteria.unclear = "None of them, or it is unclear which one is the general line.";
      const a = await jevAsk({ contact_text: out.contactText.slice(0, 4000) }, { main: { type: "choice", instructions: "Which number does `contact_text` present as the business's general contact for customers (main line, office, sales, reception) - not one department's, product's or person's line?", criteria } }, 6000).catch(() => null);
      const c = a?.main as { choice?: string; probabilities?: Record<string, number> } | undefined;
      const k = c?.choice && c.choice !== "unclear" && (c.probabilities?.[c.choice] ?? 0) >= 0.6 ? Number(c.choice.slice(1)) : -1;
      const cur = (out.primaryPhone?.value || "").replace(/\D/g, "").slice(-9);
      if (k >= 0 && opts[k][0] !== cur) {
        const chosen = opts[k][1].match(/(?:\+?\d[\d\s().-]{7,}\d)/g)?.find((x) => x.replace(/\D/g, "").endsWith(opts[k][0])) || opts[k][0];
        if (out.primaryPhone) out.alternatePhones = [out.primaryPhone.value, ...(out.alternatePhones || [])].slice(0, 6);
        out.primaryPhone = { value: chosen.trim(), source: "contact-page", confidence: "medium", sourceUrl: out.primaryPhone?.sourceUrl || pages[0].url };
        notes.push(`phone=the general line by the site's labels (was ${cur || "none"})`);
      }
    }
  }
  if (notes.length) out.extractionBasis = `${info.extractionBasis}; verified: ${notes.join("; ")}`;
  return out;
}
