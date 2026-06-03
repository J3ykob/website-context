/**
 * Canonical "Official Business Info" extractor.
 *
 * Builds ONE authoritative profile (main phone/email/address/hours/name) from the most
 * structurally-reliable sources, so the chat answers "what's your main X?" from a single
 * always-injected block instead of losing to testimonial/listing chunks in retrieval.
 *
 * Source priority (per field, stop at first trustworthy hit):
 *   T1  JSON-LD LocalBusiness/Organization/Restaurant/... (author-declared, machine-typed)
 *   T3  site-wide <a href="tel:"> / <a href="mailto:"> links (the site's OWN typed links)
 *   T4  <footer>/[contentinfo] — only as a tie-breaker for a site-wide phone winner
 *
 * Hard rule (the [[feedback_no_brittle_patches]] / "899000.00" guard): phones & emails are
 * ONLY ever taken from TYPED sources (JSON-LD value or a tel:/mailto: href). A number sitting
 * in body prose is NEVER promoted — categorically excluded. Address/hours come only from
 * JSON-LD (a mis-parsed footer blob would be worse than absent; the footer text still reaches
 * retrieval via the Site-Info chunk). Absence is a first-class state: no source -> field omitted
 * -> the bot says it doesn't have the confirmed detail rather than guessing.
 *
 * Used by both the scrape pipeline (buildContext) and the cheap no-LLM backfill script, so
 * fresh scrapes and existing tenants share one code path.
 */
import * as cheerio from "cheerio";
import type { OfficialBusinessInfo, BusinessFact } from "./types.js";

const BIZ_TYPE = /localbusiness|organization|restaurant|store|realestateagent|hotel|professionalservice|lodgingbusiness|foodestablishment|legalservice|school|medicalbusiness|autodealer|autorepair|dentist|attorney|bakery|cafe|barorpub|nightclub|spa|gym|salon/i;

const digits = (s: string): string => (s || "").replace(/\D/g, "");
// Compare phones ignoring country code / formatting (last 9 significant digits).
const phoneKey = (s: string): string => { const d = digits(s); return d.length > 9 ? d.slice(-9) : d; };

function* walk(node: any): Generator<any> {
  if (node && typeof node === "object") {
    if (!Array.isArray(node)) yield node;
    for (const k of Object.keys(node)) yield* walk(node[k]);
  }
}

function parseJsonLd(html: string): any[] {
  const out: any[] = [];
  try {
    const $ = cheerio.load(html);
    $('script[type="application/ld+json"]').each((_: any, el: any) => {
      try { out.push(JSON.parse($(el).text().trim())); } catch { /* invalid JSON-LD */ }
    });
  } catch { /* unparseable */ }
  return out;
}

function fmtAddress(a: any): string | null {
  if (!a) return null;
  if (typeof a === "string") return a.trim().replace(/\s+/g, " ") || null;
  if (typeof a === "object") {
    const parts = [a.streetAddress, a.postalCode, a.addressLocality, a.addressRegion, a.addressCountry]
      .filter((x) => x && typeof x === "string")
      .map((x) => (x as string).trim());
    return parts.length ? [...new Set(parts)].join(", ") : null;
  }
  return null;
}

function fmtHours(h: any): string | null {
  if (!h) return null;
  if (typeof h === "string") return h.trim() || null;
  const arr = Array.isArray(h) ? h : [h];
  const strs = arr.map((x) => {
    if (typeof x === "string") return x;
    if (x && typeof x === "object") {
      const days = Array.isArray(x.dayOfWeek) ? x.dayOfWeek.join(",") : x.dayOfWeek;
      const dd = String(days || "").replace(/https?:\/\/schema\.org\//gi, "").trim();
      if (x.opens && x.closes) return `${dd} ${x.opens}-${x.closes}`.trim();
      return dd;
    }
    return "";
  }).filter(Boolean);
  return strs.length ? strs.join("; ").slice(0, 200) : null;
}

// Guarded prose-phone fallback — used ONLY when no typed source (JSON-LD/tel:) exists.
// Looks on the contact page (preferred), then others, for a phone-shaped number IMMEDIATELY
// adjacent to an explicit phone LABEL (tel/telefon/phone/...). Label-adjacency + strict shape
// + price-context rejection keep this from re-becoming the blind "number-from-prose" bug (the
// 899000.00 price-as-phone): a price is never preceded by "tel:". Returned at medium confidence.
const CONTACTISH = /kontakt|contact|impressum|contatti|contacto|nous-contacter/i;
function extractProsePhone(pages: { url: string; html: string }[]): { value: string; url: string } | null {
  const ordered = [...pages].sort((a, b) => (CONTACTISH.test(b.url) ? 1 : 0) - (CONTACTISH.test(a.url) ? 1 : 0));
  const labelRe = /(?:tel|telefon|t[eé]l[eé]phone|telefoon|tel[eé]fono|phone|call us|ring oss|tlf|rufen sie uns|fon)\b[\s.:)\-]*/gi;
  for (const pg of ordered) {
    let text = "";
    try { const $ = cheerio.load(pg.html); $("script,style,noscript").remove(); text = $("body").text(); }
    catch { text = pg.html.replace(/<[^>]+>/g, " "); }
    text = text.replace(/\s+/g, " ");
    labelRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = labelRe.exec(text)) !== null) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 26);
      const pm = after.match(/^(\+?\d[\d\s().\-/]{6,}\d)/);
      if (!pm) continue;
      const d = pm[1].replace(/\D/g, "");
      if (d.length < 7 || d.length > 14) continue;
      // Reject price/postal-ish contexts (belt-and-suspenders; the label guard already excludes most).
      const ctx = text.slice(Math.max(0, m.index - 14), m.index) + after;
      if (/[€$£%]|\bz[łl]\b|\bkr\b|\beur\b|\busd\b|cena|price|\bod\b/i.test(ctx)) continue;
      return { value: pm[1].trim().replace(/\s+/g, " "), url: pg.url };
    }
  }
  return null;
}

/**
 * Build the canonical profile from a set of pages' raw HTML. Pass the homepage first
 * (it's preferred when entities conflict). Pure + deterministic — no network, no LLM.
 */
export function extractOfficialInfo(
  pages: { url: string; html: string }[],
  homepageUrl?: string
): OfficialBusinessInfo {
  const home = homepageUrl || pages[0]?.url || "";

  // --- T1: JSON-LD business entity (first non-null per field; homepage preferred by order) ---
  const jl: { name?: string; tel?: string; email?: string; address?: string; hours?: string } = {};
  let jlTelPageUrl = "";
  for (const pg of pages) {
    for (const block of parseJsonLd(pg.html)) {
      for (const node of walk(block)) {
        const t = (node as any)["@type"];
        const ts = Array.isArray(t) ? t.join(" ") : String(t || "");
        if (!BIZ_TYPE.test(ts)) continue;
        if (!jl.name && node.name && typeof node.name === "string") jl.name = node.name;
        if (!jl.tel && node.telephone) { jl.tel = String(node.telephone); jlTelPageUrl = pg.url; }
        if (!jl.email && node.email && typeof node.email === "string") jl.email = node.email;
        if (!jl.address) { const a = fmtAddress(node.address); if (a) jl.address = a; }
        if (!jl.hours) { const h = fmtHours(node.openingHours ?? node.openingHoursSpecification); if (h) jl.hours = h; }
      }
    }
  }

  // --- T3: tel:/mailto: links across pages, with frequency + footer-presence ---
  const telCount = new Map<string, { display: string; count: number; inFooter: boolean }>();
  const mailCount = new Map<string, number>();
  for (const pg of pages) {
    for (const m of pg.html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
      let raw: string; try { raw = decodeURIComponent(m[1]); } catch { raw = m[1]; }
      const disp = raw.replace(/[^\d+\s().-]/g, "").trim();
      if (digits(disp).length < 7 || digits(disp).length > 15) continue;
      const k = phoneKey(disp);
      const e = telCount.get(k) || { display: disp, count: 0, inFooter: false };
      e.count++; telCount.set(k, e);
    }
    for (const m of pg.html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)["']/gi)) {
      let e: string; try { e = decodeURIComponent(m[1]); } catch { e = m[1]; }
      e = e.trim().toLowerCase();
      if (/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e) && !/\.(png|jpg|jpeg|svg|gif|webp)$/.test(e)) {
        mailCount.set(e, (mailCount.get(e) || 0) + 1);
      }
    }
    // T4: mark which tel: numbers appear in the site-wide footer (they're the main line).
    try {
      const $ = cheerio.load(pg.html);
      $("footer, [role='contentinfo']").each((_: any, el: any) => {
        for (const m of ($(el).html() || "").matchAll(/tel:([^"']+)/gi)) {
          const e = telCount.get(phoneKey(m[1])); if (e) e.inFooter = true;
        }
      });
    } catch { /* ignore */ }
  }
  // Rank tel candidates: footer-present first, then by cross-page frequency.
  const telCandidates = [...telCount.values()].sort(
    (a, b) => (Number(b.inFooter) - Number(a.inFooter)) || (b.count - a.count)
  );

  const info: OfficialBusinessInfo = { extractedAt: new Date().toISOString(), extractionBasis: "" };
  const basis: string[] = [];

  if (jl.name) info.businessName = { value: jl.name.trim(), source: "json-ld", confidence: "high", sourceUrl: home };

  // --- PHONE ---
  // Pick the primary phone from the most authoritative live source. Helper used for the
  // tel:-link cases (single -> primary; many -> footer winner, else abstain on ambiguity).
  const selectFromTelLinks = () => {
    if (telCandidates.length === 1) {
      info.primaryPhone = { value: telCandidates[0].display, source: "tel-mailto", confidence: "high", sourceUrl: home };
      basis.push("phone=single tel: link");
    } else {
      const [first, second] = telCandidates;
      const clearWinner = first.inFooter && (!second.inFooter || first.count >= second.count * 2);
      if (clearWinner) {
        info.primaryPhone = { value: first.display, source: "footer", confidence: "medium", sourceUrl: home };
        info.alternatePhones = telCandidates.slice(1).map((t) => t.display).slice(0, 6);
        basis.push("phone=site-wide footer line (clear winner)");
      } else {
        // Genuinely ambiguous (e.g. real-estate agency, many agent mobiles) -> ABSTAIN.
        info.alternatePhones = telCandidates.map((t) => t.display).slice(0, 6);
        basis.push(`phone=ABSTAINED (${telCandidates.length} contacts, no clear primary)`);
      }
    }
  };

  const jlKey = jl.tel ? phoneKey(jl.tel) : "";
  if (jl.tel && telCount.has(jlKey)) {
    // JSON-LD telephone corroborated by a live tel: link -> highest confidence.
    info.primaryPhone = { value: jl.tel.trim(), source: "json-ld", confidence: "high", sourceUrl: jlTelPageUrl || home };
    basis.push("phone=JSON-LD (corroborated by tel: link)");
    const alts = telCandidates.filter((t) => phoneKey(t.display) !== jlKey).map((t) => t.display);
    if (alts.length) info.alternatePhones = alts.slice(0, 6);
  } else if (jl.tel && telCandidates.length > 0) {
    // CROSS-VALIDATION: JSON-LD phone disagrees with every live tel: link. JSON-LD is the
    // likeliest stale source (set-and-forget), so trust the clickable links and keep the
    // JSON-LD number only as an alternate.
    selectFromTelLinks();
    info.alternatePhones = [jl.tel.trim(), ...(info.alternatePhones || [])].slice(0, 6);
    basis.push("phone: JSON-LD disagreed with tel: links -> used tel:, JSON-LD demoted (possibly stale)");
  } else if (jl.tel) {
    // JSON-LD is the only typed source (no tel: link to cross-check) -> medium confidence.
    info.primaryPhone = { value: jl.tel.trim(), source: "json-ld", confidence: "medium", sourceUrl: jlTelPageUrl || home };
    basis.push("phone=JSON-LD (uncorroborated, no tel: link to verify)");
  } else if (telCandidates.length > 0) {
    selectFromTelLinks();
  } else {
    // No typed source at all -> guarded, label-adjacent prose fallback (contact page).
    const prose = extractProsePhone(pages);
    if (prose) {
      info.primaryPhone = { value: prose.value, source: "contact-page", confidence: "medium", sourceUrl: prose.url };
      basis.push("phone=contact-page prose (label-adjacent, no typed source)");
    } else {
      basis.push("phone=absent (no typed source)");
    }
  }

  // --- EMAIL (typed sources only) ---
  if (jl.email) {
    info.primaryEmail = { value: jl.email.trim().toLowerCase(), source: "json-ld", confidence: "high", sourceUrl: home };
    const alts = [...mailCount.keys()].filter((e) => e !== jl.email!.toLowerCase());
    if (alts.length) info.alternateEmails = alts.slice(0, 6);
    basis.push("email=JSON-LD");
  } else {
    const mails = [...mailCount.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
    if (mails.length === 1) { info.primaryEmail = { value: mails[0], source: "tel-mailto", confidence: "high", sourceUrl: home }; basis.push("email=single mailto"); }
    else if (mails.length > 1) { info.alternateEmails = mails.slice(0, 6); basis.push(`email=ABSTAINED (${mails.length} addresses)`); }
  }

  // --- ADDRESS / HOURS (JSON-LD only — never a mis-parsed footer blob) ---
  if (jl.address) { info.primaryAddress = { value: jl.address, source: "json-ld", confidence: "high", sourceUrl: home }; basis.push("address=JSON-LD"); }
  if (jl.hours) { info.openingHours = { value: jl.hours, source: "json-ld", confidence: "high", sourceUrl: home }; basis.push("hours=JSON-LD"); }

  info.extractionBasis = basis.join("; ") || "no canonical sources found";
  return info;
}

/**
 * Render the profile as the always-injected "Official Business Info" system-prompt block.
 * Returns "" when there's nothing trustworthy to assert (so the bot falls back honestly).
 */
export function renderOfficialInfo(info?: OfficialBusinessInfo): string {
  if (!info) return "";
  const lines: string[] = [];
  if (info.businessName) lines.push(`- Business name: ${info.businessName.value}`);
  if (info.primaryPhone) lines.push(`- Main phone: ${info.primaryPhone.value}`);
  if (info.primaryEmail) lines.push(`- Main email: ${info.primaryEmail.value}`);
  if (info.primaryAddress) lines.push(`- Address: ${info.primaryAddress.value}`);
  if (info.openingHours) lines.push(`- Opening hours: ${info.openingHours.value}`);

  // Multi-contact abstain case: no single main line, but we DO have real candidates.
  const abstained = !info.primaryPhone && info.alternatePhones && info.alternatePhones.length > 0;
  if (abstained) lines.push(`- Contact numbers (no single main reception line — ask which department/person they need): ${info.alternatePhones!.join(", ")}`);

  if (lines.length === 0) return "";

  return `\n\n## Official Business Info (AUTHORITATIVE — use this for primary contact questions):
${lines.join("\n")}

These are our OFFICIAL primary details. When asked for our main phone, email, address, opening hours, or business name, answer from THIS block — it overrides any number/detail in the page snippets below. Snippets may contain OTHER people's or departments' contact details (specific agents, listings, staff); use those ONLY when the user explicitly asks about that specific person, listing, or page. If a primary detail is NOT listed above, say you don't have that confirmed detail and offer to help another way — do NOT substitute a number or address found in a snippet.${abstained ? " Since multiple contact numbers exist with no single main line, present them and ask which the user needs rather than picking one." : ""}`;
}
