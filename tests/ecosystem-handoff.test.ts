import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { __setQuery } from "../src/storage/conversation-store.js";
import { createHandoffs, getHandoff, markHandoffOpened, TOKEN_RE } from "../src/ecosystem/handoff.js";

// Minimal in-memory stand-in for the three statements handoff.ts runs.
const rows = new Map<string, any>();
__setQuery(async (sql, p = []) => {
  if (sql.startsWith("CREATE")) return [];
  if (sql.startsWith("INSERT INTO handoffs")) {
    const [token, from_tenant, from_label, to_tenant, transcript, need, created_at, expires_at] = p;
    rows.set(token, { token, from_tenant, from_label, to_tenant, transcript, need, created_at, expires_at, opens: 0, opened_at: null });
    return [];
  }
  if (sql.startsWith("SELECT * FROM handoffs")) { const r = rows.get(p[0]); return r && r.expires_at > p[1] ? [r] : []; }
  if (sql.startsWith("UPDATE handoffs")) { const r = rows.get(p[1]); if (r) { r.opens++; r.opened_at ??= p[0]; } return []; }
  if (sql.startsWith("DELETE FROM handoffs")) { for (const [k, r] of rows) if (r.expires_at < p[0]) rows.delete(k); return []; }
  throw new Error("unexpected SQL: " + sql);
});
afterAll(() => __setQuery(null));

const FROM = { tenantId: "marsan_pl", label: "MARSAN" };
const T = [{ role: "user" as const, content: "Do you have waterproof concrete?" }, { role: "assistant" as const, content: "We checked with businesses we work with..." }];

describe("hand-off links", () => {
  beforeEach(() => rows.clear());

  it("creates one unguessable token per recommended business", async () => {
    const links = await createHandoffs(FROM, [{ tenantId: "beton_lazy_pl" }, { tenantId: "bostabeton_pl" }], T, "Do you have waterproof concrete?");
    expect(Object.keys(links).sort()).toEqual(["beton_lazy_pl", "bostabeton_pl"]);
    expect(links.beton_lazy_pl).not.toBe(links.bostabeton_pl);
    for (const tok of Object.values(links)) {
      expect(tok).toMatch(TOKEN_RE);
      expect(tok).not.toContain("marsan");
    }
  });

  it("gives the destination bot the conversation and the customer's need", async () => {
    const links = await createHandoffs(FROM, [{ tenantId: "beton_lazy_pl" }], T, "Do you have waterproof concrete?");
    const h = await getHandoff(links.beton_lazy_pl);
    expect(h).toMatchObject({ fromTenant: "marsan_pl", fromLabel: "MARSAN", toTenant: "beton_lazy_pl", need: "Do you have waterproof concrete?" });
    expect(h?.transcript).toEqual(T);
  });

  it("keeps only the last turns, trimmed", async () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `m${i} ` + "x".repeat(3000) }));
    const links = await createHandoffs(FROM, [{ tenantId: "beton_lazy_pl" }], long, "need");
    const h = await getHandoff(links.beton_lazy_pl);
    expect(h?.transcript).toHaveLength(8);
    expect(h?.transcript[0].content.startsWith("m4 ")).toBe(true);
    expect(h?.transcript[0].content.length).toBe(1500);
  });

  it("rejects malformed, unknown and expired tokens", async () => {
    expect(await getHandoff("../etc/passwd")).toBeNull();
    expect(await getHandoff("a".repeat(24))).toBeNull();
    const links = await createHandoffs(FROM, [{ tenantId: "beton_lazy_pl" }], T, "need");
    rows.get(links.beton_lazy_pl).expires_at = "2000-01-01T00:00:00.000Z";
    expect(await getHandoff(links.beton_lazy_pl)).toBeNull();
  });

  it("records the click-through", async () => {
    const links = await createHandoffs(FROM, [{ tenantId: "beton_lazy_pl" }], T, "need");
    await markHandoffOpened(links.beton_lazy_pl);
    await markHandoffOpened(links.beton_lazy_pl);
    expect(rows.get(links.beton_lazy_pl).opens).toBe(2);
    expect(rows.get(links.beton_lazy_pl).opened_at).toBeTruthy();
  });
});
