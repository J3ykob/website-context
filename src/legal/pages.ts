/**
 * The legal pages - privacy policy, Terms (Regulamin) and the data processing agreement - are templates in
 * public/ with {{NAME}} placeholders, filled on every request (scripts/serve-multi-tenant.ts legalPage)
 * from the company's details in the Render env. The values live here so a test can check that every
 * placeholder a page uses is filled and every value is used (tests/legal-pages.test.ts): an unknown
 * placeholder renders as an empty string, and an unused one drifts from the code - CHAT_RETENTION said
 * "12 miesięcy od ostatniej wiadomości" while the retention job deletes each message 365 days after it
 * was written.
 */
import { chatRetentionDays } from "../security/retention.js";

type Env = Record<string, string | undefined>;

// Each page with its own effective date (render.yaml): the Terms and the DPA used to fall back to the
// privacy policy's date, so dating a new policy re-dated them too.
export const LEGAL_PAGES = [
  { routes: ["/polityka-prywatnosci", "/privacy"], file: "polityka-prywatnosci.html", dateVar: "PRIVACY_EFFECTIVE_DATE" },
  { routes: ["/regulamin", "/terms"], file: "regulamin.html", dateVar: "TERMS_EFFECTIVE_DATE" },
  { routes: ["/umowa-powierzenia", "/dpa"], file: "umowa-powierzenia.html", dateVar: "TERMS_EFFECTIVE_DATE" },
] as const;

const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function legalVars(e: Env, dateVar: string): Record<string, string> {
  const ids = [e.COMPANY_NIP ? `NIP ${e.COMPANY_NIP}` : "", e.COMPANY_REGISTRY || ""].filter(Boolean);
  const phone = (e.NETWORK_INVITE_PHONE || "").trim();
  return {
    COMPANY_NAME: esc(e.COMPANY_NAME || ""), COMPANY_ADDRESS: esc(e.COMPANY_ADDRESS || ""),
    COMPANY_NIP: e.COMPANY_NIP ? `<br>NIP ${esc(e.COMPANY_NIP)}` : "", COMPANY_REGISTRY: e.COMPANY_REGISTRY ? `<br>${esc(e.COMPANY_REGISTRY)}` : "",
    COMPANY_IDS: ids.length ? `, ${esc(ids.join(", "))}` : "",
    PRIVACY_EMAIL: esc(e.PRIVACY_EMAIL || "jakub@whisp.so"),
    // Our number, the one in the invites and the "new offer" SMS (notify-channels.ts): calls to it come to us.
    PHONE: phone ? ` (${esc(phone)})` : "",
    // The day count the retention job deletes chats and model decisions by - one setting for both.
    CHAT_RETENTION_DAYS: String(chatRetentionDays(e)),
    // A fixed date, set in render.yaml when the page's text changes - the default only for a page set up without one.
    EFFECTIVE_DATE: esc(e[dateVar] || "2026-10-31"),
    TYPESAFE_LOCATION: esc(e.TYPESAFE_LOCATION || "USA"),
  };
}

export const fillLegal = (html: string, vars: Record<string, string>): string => html.replace(/\{\{([A-Z_]+)\}\}/g, (_m, k: string) => vars[k] ?? "");
