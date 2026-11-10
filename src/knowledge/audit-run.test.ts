/**
 * The knowledge audit saves its report and writes nothing to the unanswered-questions list (D1 unknown_questions,
 * real SQL on in-memory SQLite).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as cs from "../storage/conversation-store.js";
import { runAndSaveAudit } from "./audit-run.js";
import { SELF_TEST_QUESTIONS, type AuditItem, type AuditReport } from "./audit.js";

let mem: Database.Database;
beforeEach(() => {
  mem = new Database(":memory:");
  mem.exec("CREATE TABLE unknown_questions (id TEXT PRIMARY KEY, tenant_id TEXT, question TEXT, created_at TEXT);");
  cs.__setQuery(async (sql: string, params: any[] = []) => {
    const stmt = mem.prepare(sql);
    if (/^\s*select/i.test(sql)) return stmt.all(...params) as any[];
    stmt.run(...params);
    return [];
  });
});
afterEach(() => { cs.__setQuery(null); mem.close(); });

describe("runAndSaveAudit", () => {
  it("saves the report and logs no unanswered questions", async () => {
    // Every test question not answered (the old code logged each of them as a customer's question).
    const items: AuditItem[] = SELF_TEST_QUESTIONS.slice(0, 16).filter((_, k) => k % 2 === 0)
      .map((question, k) => ({ kind: "question", topic: `t${k}`, status: k % 2 ? "partial" : "missing", detail: "", question, reply: "" }));
    expect(items.length).toBe(8);
    const report: AuditReport = { tenantId: "geo_test", at: "2026-11-10T00:00:00Z", language: "pl", items, summary: { ok: 0, partial: 0, missing: 8 } };
    const saved: { key: string; body: string }[] = [];
    const out = await runAndSaveAudit("geo_test", async () => report, async (key, body) => { saved.push({ key, body }); return true; });
    expect(out).toBe(report);
    expect(saved.map((s) => s.key)).toEqual(["tenants/geo_test/knowledge-audit.json"]);
    expect(JSON.parse(saved[0].body).items.length).toBe(8);
    const n = mem.prepare("SELECT COUNT(*) AS n FROM unknown_questions").get() as { n: number };
    expect(n.n).toBe(0);
    expect(items.every((i) => SELF_TEST_QUESTIONS.includes(i.question!))).toBe(true);
  });
});
