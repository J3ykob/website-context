/**
 * Business Info Audit — scans scraped chunks for key business information
 * and identifies gaps. Used for:
 * 1. Auto-injecting found info into system prompt (always available)
 * 2. Weekly gap emails to business owners
 */

export interface BusinessInfo {
  phone: string | null;
  email: string | null;
  address: string | null;
  hours: string | null;
  pricing: boolean;
  bookingUrl: string | null;
  socialMedia: string[];
  gaps: string[];
}

// Phone candidates: a +international number, or digit groups joined by separators.
// Deliberately does NOT match an unseparated run like "899000.00" — that (a luxury
// car PRICE) used to be extracted as the phone, so the bot told prospects to call
// "899000.00". extractPhone() additionally rejects price/measurement-shaped matches.
const PHONE_CANDIDATE = /\+\d{1,3}(?:[\s.\-]?\d{2,4}){2,5}|\d{2,4}(?:[\s.\-]\d{2,4}){1,4}/g;
const PHONE_KEYWORD = /(tel|telefon|phone|mobile|kom[óo]rk|gsm|kontakt|zadzwo[nń]|whats?app|call|☎|📞)/i;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const HOURS_PATTERNS = [
  /(?:pon|mon|tue|wed|thu|fri|sat|sun|niedz|sob|wt|śr|czw|pt)\w*[:\s-]+\d{1,2}[:.]\d{2}/gi,
  /\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2}/g,
  /(?:open|hours|godziny|otwarcie|czynne)\s*[:.]?\s*\d/gi,
];
const PRICE_PATTERNS = [
  /\d+[.,]\d{2}\s*(?:zł|PLN|€|EUR|\$|USD|£|GBP)/gi,
  /(?:cena|price|koszt|cost|od|from)\s*[:.]?\s*\d+/gi,
  /\d+\s*(?:zł|PLN|€|EUR)/g,
];
const BOOKING_PATTERNS = [
  /(?:rezerwacja|book|reserve|appointment|umów|termin|zapisy)/gi,
];
const ADDRESS_PATTERNS = [
  /(?:ul\.|ulica|street|str\.|aleja|al\.)\s*[\w\sąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+\d+/gi,
  // postal code + a Capitalized city word (so "00-200 km" / mileage isn't an address)
  /\d{2}-\d{3}\s+[A-ZÀ-ÿĄĆĘŁŃÓŚŹŻ][\wąćęłńóśźż]+/g,
];
const SOCIAL_PATTERNS = [
  /(?:facebook\.com|fb\.com)\/[\w.-]+/gi,
  /instagram\.com\/[\w.-]+/gi,
  /twitter\.com\/[\w.-]+/gi,
  /linkedin\.com\/(?:company|in)\/[\w.-]+/gi,
];

// Extract a real phone number — not a price, mileage, year, or other big number.
// Rules: 9-15 digits; reject a trailing 2-digit decimal (",00"/".00" = a price);
// reject if a currency/unit (zł, €, km, ...) immediately follows or a price word
// (cena/price/od/przebieg/...) immediately precedes; PREFER candidates next to a
// phone keyword or written in +international form. Returns null rather than risk a
// wrong number — an honest "I don't have the phone" beats sending a prospect to a
// dead line (the Select-Automotive "call 899000.00" failure).
export function extractPhone(text: string): string | null {
  const strong: string[] = [];
  const weak: string[] = [];
  const re = new RegExp(PHONE_CANDIDATE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    if (/[.,]\d{2}$/.test(raw)) continue; // trailing ,00 / .00 -> a price/decimal, not a phone
    const before = text.slice(Math.max(0, m.index - 28), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (/^\s*(z[łl]|pln|eur|usd|gbp|€|\$|£|km|kg|m2|m²|%|kw|km\/h)/i.test(after)) continue; // price/measurement
    if (/(cena|price|koszt|od|from|rok|year|vin|przebieg|mileage|nr)\s*[:.]?\s*$/i.test(before)) continue;
    (PHONE_KEYWORD.test(before) || PHONE_KEYWORD.test(after) || raw.startsWith("+") ? strong : weak).push(raw);
  }
  return strong[0] || weak[0] || null;
}

export function auditBusinessInfo(chunks: { content: string }[]): BusinessInfo {
  const allContent = chunks.map(c => c.content).join("\n\n");

  // Extract phone (price/measurement-aware — see extractPhone above)
  const phone = extractPhone(allContent);

  // Extract email
  const emails = allContent.match(EMAIL_REGEX) || [];
  const validEmails = emails.filter(e => !e.endsWith(".png") && !e.endsWith(".jpg") && !e.includes("example"));
  const email = validEmails[0] || null;

  // Extract hours
  let hours: string | null = null;
  for (const pattern of HOURS_PATTERNS) {
    const match = allContent.match(pattern);
    if (match && match.length > 0) {
      hours = match.slice(0, 5).join("; ");
      break;
    }
  }

  // Detect pricing
  let pricing = false;
  for (const pattern of PRICE_PATTERNS) {
    if (pattern.test(allContent)) {
      pricing = true;
      break;
    }
  }

  // Detect booking capability
  let bookingUrl: string | null = null;
  for (const pattern of BOOKING_PATTERNS) {
    if (pattern.test(allContent)) {
      const urlMatch = allContent.match(/https?:\/\/[^\s"'<>]+(?:rezerwacja|book|reserve|appointment|calendar)[^\s"'<>]*/i);
      bookingUrl = urlMatch ? urlMatch[0] : "available";
      break;
    }
  }

  // Extract address
  let address: string | null = null;
  for (const pattern of ADDRESS_PATTERNS) {
    const match = allContent.match(pattern);
    if (match) {
      address = match[0].trim();
      break;
    }
  }

  // Extract social media
  const socialMedia: string[] = [];
  for (const pattern of SOCIAL_PATTERNS) {
    const matches = allContent.match(pattern);
    if (matches) socialMedia.push(...matches.slice(0, 2));
  }

  // Identify gaps
  const gaps: string[] = [];
  if (!phone) gaps.push("phone number");
  if (!email) gaps.push("email address");
  if (!address) gaps.push("physical address / location");
  if (!hours) gaps.push("opening hours / business hours");
  if (!pricing) gaps.push("pricing / rates");
  if (!bookingUrl) gaps.push("booking / appointment system");

  return { phone, email, address, hours, pricing, bookingUrl, socialMedia, gaps };
}

/**
 * Generate context notes from extracted business info.
 * These get injected into the system prompt so the bot always has them.
 */
export function businessInfoToNotes(info: BusinessInfo): { question: string; answer: string }[] {
  const notes: { question: string; answer: string }[] = [];

  if (info.phone) {
    notes.push({ question: "What is the phone number?", answer: info.phone });
  }
  if (info.email) {
    notes.push({ question: "What is the email address?", answer: info.email });
  }
  if (info.address) {
    notes.push({ question: "What is the address / location?", answer: info.address });
  }
  if (info.hours) {
    notes.push({ question: "What are the opening hours?", answer: info.hours });
  }
  if (info.bookingUrl && info.bookingUrl !== "available") {
    notes.push({ question: "How can I book / make a reservation?", answer: `Book online at: ${info.bookingUrl}` });
  } else if (info.bookingUrl === "available" && info.phone) {
    notes.push({ question: "How can I book / make a reservation?", answer: `Call ${info.phone} to book.` });
  }

  return notes;
}

/**
 * Generate the weekly gap audit email content.
 */
export function generateGapEmail(
  domain: string,
  gaps: string[],
  dashboardUrl: string
): { subject: string; html: string } | null {
  if (gaps.length === 0) return null;

  const gapList = gaps.map(g => `<li style="padding:4px 0;color:#cbd5e1;">${g}</li>`).join("");

  return {
    subject: `Your ${domain} chatbot is missing info on ${gaps.length} topic${gaps.length > 1 ? "s" : ""}`,
    html: `
<div style="font-family:system-ui,sans-serif;background:#0a0e1a;padding:40px 20px;">
  <div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;border:1px solid rgba(255,255,255,0.08);padding:40px;">
    <div style="width:32px;height:32px;background:#3b82f6;border-radius:8px;margin-bottom:24px;"></div>
    <h2 style="color:#f1f5f9;font-size:22px;margin:0 0 12px;">Your chatbot needs your help</h2>
    <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 20px;">
      Visitors to <strong style="color:#f1f5f9;">${domain}</strong> are asking questions your chatbot can't answer yet. Here's what's missing:
    </p>
    <ul style="list-style:none;padding:0;margin:0 0 24px;">
      ${gapList}
    </ul>
    <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">
      Add this info in your dashboard and your chatbot will learn it instantly.
    </p>
    <a href="${dashboardUrl}" style="display:inline-block;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none;">Add missing info</a>
    <p style="color:#334155;font-size:11px;margin-top:24px;">Whisp — whisp.so</p>
  </div>
</div>`,
  };
}
