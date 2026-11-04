/**
 * ownerFirst (conversation.ts): a result waits for the owner only when the business has one - a set
 * password or a stored subscription (2026-11-04 eval: calculations on demos nobody had claimed were held
 * for approval and never arrived). The injected "D1" is an in-memory better-sqlite3 DB (D1 is SQLite):
 * the real project store and registry SQL, no network, no mocks.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as registry from "../multi-tenant/d1-registry.js";
import * as cs from "../storage/conversation-store.js";
import { hashPassword } from "../multi-tenant/d1-auth.js";
import { createProject } from "./store.js";
import { ownerFirst, CONVERSATION } from "./conversation.js";
import { BUSINESS_REQUEST } from "./network.js";
import type { AgentRunState } from "./agent.js";

let mem: Database.Database;
// Injected D1 query: statements that return rows (SELECT, ... RETURNING) give them back.
function makeQuery(db: Database.Database) {
  return async (sql: string, params: any[] = []): Promise<any[]> => {
    const stmt = db.prepare(sql);
    if (stmt.reader) return stmt.all(...params) as any[];
    stmt.run(...params);
    return [];
  };
}

// One database for the file: the project store creates its tables once per process.
beforeAll(async () => {
  mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, domain TEXT NOT NULL UNIQUE, site_url TEXT NOT NULL,
      brand_name TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_scraped_at TEXT, pages_count INTEGER DEFAULT 0, chunks_count INTEGER DEFAULT 0,
      qdrant_collection TEXT NOT NULL, settings_json TEXT DEFAULT '{}',
      owner_password_hash TEXT, api_key TEXT, setup_token TEXT);
  `);
  const q = makeQuery(mem);
  registry.__setQuery(q);
  cs.__setQuery(q);
  await registry.hydrateRegistry();
});
afterAll(() => {
  registry.__setQuery(null);
  cs.__setQuery(null);
  mem.close();
});
afterEach(() => {
  delete process.env.AGENT_REVIEW_FORCE;
  delete process.env.AGENT_OWNER_FORCE;
});

const run = (over: Partial<AgentRunState> = {}): AgentRunState =>
  ({ runId: "run-1", model: "", instruction: "", status: "done", startedAt: new Date().toISOString(), attempt: 1, ...over });
const conversation = async (tenantId: string, memory: Record<string, unknown> = {}) =>
  (await createProject(CONVERSATION, { customerSession: `s-${tenantId}-${Math.random()}`, initiatorTenantId: tenantId, memory })).id;

describe("ownerFirst: nothing waits for an owner who does not exist", () => {
  it("a demo nobody has claimed: no reason holds the customer's result", async () => {
    registry.createTenant("claim@whisp.so", "https://demo.pl");
    // Every reason that holds a result for an owner: approve stored (only an admin could have), a reply that
    // may speak to the business, a failed check with a draft, a rework asked through an old review link.
    registry.updateTenant("demo_pl", { settings: { agentReview: "approve" } });
    const pid = await conversation("demo_pl", { ownerLoop: true });
    expect(await ownerFirst(pid, "demo_pl", run({ needsOwner: true }))).toBe(false);
    expect(await ownerFirst(pid, "demo_pl", run({ status: "failed" }))).toBe(false);
    // A member business nobody has claimed, asked by another business: its answer goes straight back.
    registry.createTenant("biuro@member.pl", "https://member.pl");
    const sub = (await createProject(BUSINESS_REQUEST, { customerSession: `project:${pid}`, initiatorTenantId: "member_pl", memory: { parentId: pid } })).id;
    expect(await ownerFirst(sub, "member_pl", run({ needsOwner: true }))).toBe(false);
  });

  it("once claimed, the business's own choice and reasons apply", async () => {
    registry.createTenant("owner@claimed.pl", "https://claimed.pl");
    registry.updateTenant("claimed_pl", { settings: { agentReview: "approve" } });
    const pid = await conversation("claimed_pl");
    expect(await ownerFirst(pid, "claimed_pl", run())).toBe(false);
    registry.updateTenant("claimed_pl", { ownerPasswordHash: hashPassword("s3cret-pass") });
    expect(await ownerFirst(pid, "claimed_pl", run())).toBe(true); // approve mode

    // A subscriber without a password, in auto mode.
    registry.createTenant("payer@firma.pl", "https://firma.pl");
    registry.updateTenant("firma_pl", { settings: { stripeSubscription: "sub_1" } });
    const own = await conversation("firma_pl");
    expect(await ownerFirst(own, "firma_pl", run({ needsOwner: true }))).toBe(true);
    // Quantities only: delivered as is (the owner's rule of 2026-10-22, unchanged).
    const calc = await conversation("firma_pl", { pureCalc: true });
    expect(await ownerFirst(calc, "firma_pl", run())).toBe(false);
  });

  it("a business that has not joined keeps its rule: held only once it has stepped in", async () => {
    registry.createTenant("biuro@listed.pl", "https://listed.pl");
    const sub = (await createProject(BUSINESS_REQUEST, { customerSession: "project:prj_x", initiatorTenantId: "listed_pl", memory: { parentId: "prj_x", listed: true } })).id;
    expect(await ownerFirst(sub, "listed_pl", run({ needsOwner: true }))).toBe(false);
    const stepped = (await createProject(BUSINESS_REQUEST, { customerSession: "project:prj_y", initiatorTenantId: "listed_pl", memory: { parentId: "prj_y", listed: true, ownerLoop: true } })).id;
    expect(await ownerFirst(stepped, "listed_pl", run())).toBe(true);
  });

  it("live-test knobs: an owner present (AGENT_OWNER_FORCE) or approve (AGENT_REVIEW_FORCE)", async () => {
    registry.createTenant("claim@whisp.so", "https://forced.pl");
    const pid = await conversation("forced_pl");
    process.env.AGENT_OWNER_FORCE = "forced_pl";
    expect(await ownerFirst(pid, "forced_pl", run())).toBe(false); // auto, nothing to ask
    expect(await ownerFirst(pid, "forced_pl", run({ needsOwner: true }))).toBe(true);
    delete process.env.AGENT_OWNER_FORCE;
    process.env.AGENT_REVIEW_FORCE = "forced_pl";
    expect(await ownerFirst(pid, "forced_pl", run())).toBe(true);
  });
});
