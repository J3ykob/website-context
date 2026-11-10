/**
 * Which "Worth adding" hints the owner has already acted on (tenants/<id>/audit-addressed.json).
 * The panel's hint button opens the add-knowledge window with the hint's key ("<kind>.<topic>"); once the owner
 * saves knowledge from it, the key is stored with the time. A hint counts as handled only when that time is
 * after the report's own time - a new audit (a new site read) brings the hint back if it still applies.
 * Structure only: keys are checked against our own list, no text is read.
 */
import { AUDIT_HINT_KEYS } from "./audit-questions.js";

export type AddressedHints = Record<string, string>;

export function isHintKey(key: unknown): key is string {
  return typeof key === "string" && AUDIT_HINT_KEYS.includes(key);
}

/** Reads the stored file; anything malformed or with unknown keys is dropped. */
export function parseAddressed(raw: string | null | undefined): AddressedHints {
  if (!raw) return {};
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return {}; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: AddressedHints = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (isHintKey(k) && typeof v === "string" && !isNaN(Date.parse(v))) out[k] = v;
  }
  return out;
}

export function markAddressed(current: AddressedHints, key: string, at: string): AddressedHints {
  if (!isHintKey(key)) throw new Error("unknown hint key");
  return { ...current, [key]: at };
}

/** The keys handled after the report was made (no report time: none - the hint list itself is missing then). */
export function addressedSince(addressed: AddressedHints, reportAt: string | undefined): string[] {
  const since = reportAt ? Date.parse(reportAt) : NaN;
  if (isNaN(since)) return [];
  return Object.keys(addressed).filter((k) => Date.parse(addressed[k]) > since).sort();
}

/** GET /api/dashboard/knowledge-audit: the stored report plus the keys handled since it was made.
 * No report (or an unreadable one): no items - the panel hides the section. */
export function auditView(reportRaw: string | null | undefined, addressedRaw: string | null | undefined): Record<string, unknown> & { items: unknown[]; addressed: string[] } {
  let report: any = null;
  try { report = reportRaw ? JSON.parse(reportRaw) : null; } catch { report = null; }
  if (!report || typeof report !== "object" || !Array.isArray(report.items)) return { items: [], addressed: [] };
  return { ...report, addressed: addressedSince(parseAddressed(addressedRaw), report.at) };
}
