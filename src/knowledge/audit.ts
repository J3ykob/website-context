/**
 * Knowledge audit: what a business's assistant can and can't answer from its scraped site, so the owner
 * can add the missing information to their knowledge store. Two kinds of checks:
 * - data: what the scrape produced (pages that converted to no text, garbled text, contact details and
 *   opening hours missing from the official info);
 * - questions: standard customer questions asked through the real reply pipeline (a test turn, not a
 *   recorded conversation), judged the way the assistant itself judges them - answered, partly answered
 *   (it covers the topic but not the detail) or not answered - plus a Jev check that an "answer" really
 *   gives the information and doesn't just say "call us".
 * The report (tenants/<id>/knowledge-audit.json) is shown in the panel as optional hints ("Worth adding"), never
 * in the list of questions customers asked: these are our own test questions, not a customer's.
 */
import type { WebsiteContext } from "../context/types.js";
import type { KnowledgeCatalog } from "./catalog.js";
import { jevAsk, type JevNoulAnswer } from "../llm/jev.js";
import { AUDIT_QUESTIONS } from "./audit-questions.js";

export type AuditStatus = "ok" | "partial" | "missing";
/** `failed`: the test question could not be run (the probe threw twice) - the status says nothing about the
 * knowledge then, and the panel shows no hint for it. `urls`: the pages item's pages that gave no text. */
export interface AuditItem { kind: "data" | "question"; topic: string; status: AuditStatus; detail: string; question?: string; reply?: string; failed?: true; urls?: string[] }
export interface AuditReport { tenantId: string; at: string; language: "pl" | "en"; items: AuditItem[]; summary: Record<AuditStatus, number> }
export interface ProbeResult { reply: string; behaviour: string[]; route: string }

const QUESTIONS = AUDIT_QUESTIONS;
export { SELF_TEST_QUESTIONS, AUDIT_HINT_KEYS } from "./audit-questions.js";

function siteLanguage(context: WebsiteContext, catalog: KnowledgeCatalog | null): "pl" | "en" {
  const sample = (catalog?.chunks || []).slice(0, 40).map((c) => c.content).join(" ") || context.pages.slice(0, 5).map((p) => p.title).join(" ");
  return (sample.match(/[ąćęłńóśźż]/gi) || []).length > 20 ? "pl" : "en";
}

/** The scrape's own problems: pages with no text, garbled text, missing contact details and hours. */
export function dataChecks(context: WebsiteContext, catalog: KnowledgeCatalog | null): AuditItem[] {
  const items: AuditItem[] = [];
  const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[#?].*$/, "").replace(/\/$/, "");
  const withText = new Set((catalog?.chunks || []).map((c) => norm(c.url)));
  const pages = context.siteMap.filter((p) => !/\.(jpe?g|png|gif|webp|svg|zip|docx?|xlsx?)$/i.test(p.url));
  const empty = catalog ? pages.filter((p) => !withText.has(norm(p.url))) : [];
  items.push(empty.length
    ? { kind: "data", topic: "pages", status: empty.length > pages.length / 4 ? "missing" : "partial", urls: empty.slice(0, 8).map((p) => p.url), detail: `${empty.length} of ${pages.length} pages gave no text the assistant can use: ${empty.slice(0, 8).map((p) => p.url).join(", ")}` }
    : { kind: "data", topic: "pages", status: "ok", detail: `${pages.length} pages read` });
  const garbled = (catalog?.chunks || []).filter((c) => /�/.test(c.content) || /\d\d-\d{3}[A-ZŁŚŻ]/.test(c.content));
  if (garbled.length) items.push({ kind: "data", topic: "garbled", status: "partial", detail: `${garbled.length} passages with unreadable characters or run-together text, e.g. ${garbled[0].url}` });
  const p = context.businessProfile;
  const hasHours = !!p?.openingHours || /When we can be reached/.test(p?.contactText || "");
  for (const [topic, ok, what] of [["phone", !!p?.primaryPhone || !!p?.alternatePhones?.length, "phone number"], ["email", !!p?.primaryEmail || !!p?.alternateEmails?.length, "e-mail address"], ["address", !!p?.primaryAddress, "address"], ["hours", hasHours, "opening hours or when customers can call"]] as const) {
    items.push({ kind: "data", topic, status: ok ? "ok" : "missing", detail: ok ? `${what} found` : `no ${what} found on the site` });
  }
  return items;
}

/** The standard questions through the assistant itself (three at a time). */
export async function questionChecks(probe: (q: string) => Promise<ProbeResult>, language: "pl" | "en"): Promise<AuditItem[]> {
  const one = async (q: (typeof QUESTIONS)[number]): Promise<AuditItem> => {
    const question = q[language];
    let r: ProbeResult | null = null, error = "";
    for (let attempt = 0; attempt < 2 && !r; attempt++) r = await probe(question).catch((e) => { error = (e as Error).message; return null; });
    if (!r) return { kind: "question", topic: q.topic, status: "missing", failed: true, detail: `the test question failed to run: ${error.slice(0, 160)}`, question };
    if (r.route === "collect") return { kind: "question", topic: q.topic, status: "ok", detail: "started the order / inquiry form", question, reply: r.reply.slice(0, 600) };
    // By what the reply gives: the facts asked (ok), some of them (partial), or none (missing).
    const a = await jevAsk({ question, reply: r.reply }, {
      gives: { type: "noul", instructions: "Does `reply` give the information `question` asks for - concrete facts about the business that answer it (not only that it is not available, a request for details, or a pointer to contact the business)?" },
      some: { type: "noul", instructions: "Does `reply` give at least some concrete facts about the business that bear on `question`, even if not everything asked?" },
    }, 4000).catch(() => null);
    const nl = (k: string) => ((a?.[k] as JevNoulAnswer | undefined)?.noul ?? NaN);
    const status: AuditStatus = Number.isNaN(nl("gives"))
      ? (r.behaviour.includes("noInfo") || r.behaviour.includes("network") ? "missing" : r.behaviour.includes("partial") ? "partial" : "ok")
      : nl("gives") >= 0.5 ? "ok" : nl("some") >= 0.5 ? "partial" : "missing";
    return { kind: "question", topic: q.topic, status, detail: status === "ok" ? "answered" : status === "partial" ? "only partly answered from the site" : "not answered from the site", question, reply: r.reply.slice(0, 600) };
  };
  const out: AuditItem[] = new Array(QUESTIONS.length);
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => { while (next < QUESTIONS.length) { const k = next++; out[k] = await one(QUESTIONS[k]); } }));
  return out;
}

export async function auditKnowledge(tenantId: string, context: WebsiteContext, catalog: KnowledgeCatalog | null, probe: (q: string) => Promise<ProbeResult>): Promise<AuditReport> {
  const language = siteLanguage(context, catalog);
  const items = [...dataChecks(context, catalog), ...(await questionChecks(probe, language))];
  const summary = { ok: 0, partial: 0, missing: 0 } as Record<AuditStatus, number>;
  for (const i of items) summary[i.status]++;
  return { tenantId, at: new Date().toISOString(), language, items, summary };
}
