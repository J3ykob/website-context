/**
 * ownerFirst and agentDelivery (conversation.ts), the review e-mail and the late-review sweep (review.ts):
 * a result waits for the owner only when the business has one - a set password or a stored subscription
 * (2026-11-04 eval: calculations on demos nobody had claimed were held for approval and never arrived) -
 * and what the customer gets instead. The injected "D1" is an in-memory better-sqlite3 DB (D1 is SQLite):
 * the real project store, review and registry SQL. Nothing leaves the process: storage (R2), e-mail,
 * SMS / Telegram, Jev, the model and the agent are in-process stand-ins, and fetch is refused.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

// What would have been sent, by recipient.
const sent = vi.hoisted(() => ({ review: [] as string[], quote: [] as string[], result: [] as { to: string; message: string; files: string[] }[] }));
const jev = vi.hoisted(() => ({ answer: null as Record<string, unknown> | null })); // null = Jev unreachable
vi.hoisted(() => vi.stubGlobal("fetch", async () => { throw new Error("no network in unit tests"); }));
vi.mock("../storage/r2.js", () => {
  const files = new Map<string, Buffer>();
  return {
    uploadToR2: async (key: string, data: Buffer | string) => { files.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data)); return true; },
    downloadFromR2: async (key: string) => files.get(key) || null,
    deleteFromR2: async (key: string) => files.delete(key),
  };
});
vi.mock("../multi-tenant/email.js", () => ({
  sendReviewEmail: async (to: string) => { sent.review.push(to); },
  sendOwnerQuoteEmail: async (to: string) => { sent.quote.push(to); return true; },
  sendResultEmail: async (to: string, r: { message: string; files: { name: string }[] }) => { sent.result.push({ to, message: r.message, files: r.files.map((f) => f.name) }); return true; },
  sendNetworkInviteEmail: async () => false,
  sendCustomerOfferEmail: async () => false,
}));
vi.mock("./notify-channels.js", async (original) => ({ ...(await original<typeof import("./notify-channels.js")>()), sendResultReady: async () => ({}), sendNewOffer: async () => ({}) }));
vi.mock("../llm/jev.js", async (original) => ({ ...(await original<typeof import("../llm/jev.js")>()), jevAsk: async () => jev.answer }));
vi.mock("../llm/openrouter-provider.js", () => ({ OpenRouterProvider: class { async chat() { return { content: "WORDED NOTICE" }; } } }));
vi.mock("./plan.js", () => ({ planAndRun: async () => ({ error: "no agent in unit tests" }) }));

import * as registry from "../multi-tenant/d1-registry.js";
import * as cs from "../storage/conversation-store.js";
import { hashPassword } from "../multi-tenant/d1-auth.js";
import { createProject, getProject, setMemory, projectDetail } from "./store.js";
import { writeFile } from "./repo.js";
import { ownerFirst, agentDelivery, onRunFinished, CONVERSATION } from "./conversation.js";
import { openReview, decide, reviewForRun, reviewsForProject, remindLateReviews } from "./review.js";
import { BUSINESS_REQUEST } from "./network.js";
import { checkOutcome, type AgentRunState } from "./agent.js";

let mem: Database.Database;
// Once, just before the first statement it matches: something else happening at that moment (a decision on
// a review link, a D1 read that fails).
let before: { match: (sql: string, params: any[]) => boolean; run: () => Promise<void> } | null = null;
// Injected D1 query: statements that return rows (SELECT, ... RETURNING) give them back.
function makeQuery(db: Database.Database) {
  return async (sql: string, params: any[] = []): Promise<any[]> => {
    if (before?.match(sql, params)) { const b = before; before = null; await b.run(); }
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
    CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, session_id TEXT, role TEXT,
      content TEXT, domain TEXT, created_at TEXT, flow_invoked TEXT, intent_id TEXT);
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
  vi.unstubAllGlobals();
});
afterEach(() => {
  delete process.env.AGENT_REVIEW_FORCE;
  delete process.env.AGENT_OWNER_FORCE;
  before = null;
});

const run = (over: Partial<AgentRunState> = {}): AgentRunState =>
  ({ runId: "run-1", model: "", instruction: "", status: "done", startedAt: new Date().toISOString(), attempt: 1, ...over });
const conversation = async (tenantId: string, memory: Record<string, unknown> = {}) =>
  (await createProject(CONVERSATION, { customerSession: `s-${tenantId}-${Math.random()}`, initiatorTenantId: tenantId, memory })).id;

const SHEET = "dla_klienta/kosztorys.csv";
const DRAFT = "Wylewka anhydrytowa na 60 m2: 4 200 zł netto, szczegóły w kosztorys.csv.";
// A finished run of a customer's conversation: the agent's reply and a cost sheet for the customer.
async function finished(tenantId: string, over: Partial<AgentRunState> = {}, memory: Record<string, unknown> = {}) {
  const pid = await conversation(tenantId, memory);
  await writeFile(pid, "odpowiedz.txt", DRAFT, "txt", "agent");
  await writeFile(pid, SHEET, "pozycja;cena\nwylewka 60 m2;4200\n", "csv", "agent");
  const s = run({ runId: `run-${pid}`, files: ["odpowiedz.txt", SHEET], ...over });
  await setMemory(pid, { agentRun: s });
  return { pid, runId: s.runId };
}
// What the customer's chat or status page gets (those routes pass only the chat log: no server delivery).
async function poll(pid: string) {
  const chat: string[] = [];
  const d = await agentDelivery(pid, async (m) => { chat.push(m); });
  return { status: d.status, message: d.message, files: d.files, chat };
}
const contact = (email: string) => ({ email, lang: "pl", at: new Date().toISOString() });
const emailsTo = (to: string) => sent.result.filter((r) => r.to === to);
const kinds = async (id: string) => ((await projectDetail(id))?.events || []).map((e) => e.kind);

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

describe("agentDelivery: what the customer gets", () => {
  it("a run that failed its checks: the worded notice alone, without its files; an owned business reviews it", async () => {
    registry.createTenant("demo@failed.pl", "https://failed.pl");
    const demo = await finished("failed_pl", { status: "failed" }, { customerContact: contact("klient@failed.example") });
    // The run's end on the server (agent.ts collect -> onRunFinished): the chat log and the e-mail the
    // customer chose - "could not prepare" without the blocked cost sheet, as an attachment or a link.
    await onRunFinished(demo.pid);
    expect(emailsTo("klient@failed.example")).toEqual([{ to: "klient@failed.example", message: "WORDED NOTICE", files: [] }]);
    expect(await poll(demo.pid)).toMatchObject({ message: "WORDED NOTICE", files: [], chat: [] });
    expect(await reviewForRun(demo.pid, demo.runId)).toBeNull();

    registry.createTenant("owner@failedowned.pl", "https://failedowned.pl");
    registry.updateTenant("failedowned_pl", { ownerPasswordHash: hashPassword("s3cret-pass") });
    const owned = await finished("failedowned_pl", { status: "failed" });
    expect((await poll(owned.pid)).status).toBe("review");
    expect((await reviewForRun(owned.pid, owned.runId))?.status).toBe("pending");
    expect(sent.review).toContain("owner@failedowned.pl");
  });

  it("a decision made on a review link stands on a demo: approved with edits, declined with an own message", async () => {
    registry.createTenant("demo@decided.pl", "https://decided.pl");
    // Reviews opened before demos stopped holding results (their e-mail went to the demo's address then).
    const a = await finished("decided_pl", { needsOwner: true });
    const ra = await openReview(a.pid, "decided_pl", a.runId, DRAFT, [SHEET]);
    const b = await finished("decided_pl", { needsOwner: true });
    const rb = await openReview(b.pid, "decided_pl", b.runId, DRAFT, [SHEET]);
    expect(sent.review).not.toContain("demo@decided.pl"); // nobody to e-mail on a demo
    await decide(ra.token, "approved", { final: "EDITED BY THE REVIEWER" });
    await decide(rb.token, "declined", { final: "THE REVIEWER'S OWN MESSAGE" });
    expect(await poll(a.pid)).toMatchObject({ status: "done", message: "EDITED BY THE REVIEWER", files: [SHEET] });
    // Not the declined draft and its files: the reviewer's own message.
    expect(await poll(b.pid)).toMatchObject({ status: "done", message: "THE REVIEWER'S OWN MESSAGE", files: [] });
  });

  it("a result held before is released once, by the customer's own poll; its review is closed", async () => {
    registry.createTenant("demo@released.pl", "https://released.pl");
    const h = await finished("released_pl");
    const rv = await openReview(h.pid, "released_pl", h.runId, DRAFT, [SHEET]);
    expect(await poll(h.pid)).toEqual({ status: "done", message: DRAFT, files: [SHEET], chat: [DRAFT] });
    expect((await reviewForRun(h.pid, h.runId))?.status).toBe("released");
    // The old link answers "already decided": an own message would be dropped (the result is out) and
    // "ask for changes" would send a second, reworked result.
    expect(await decide(rv.token, "declined", { final: "too late" })).toBeNull();
    expect(await kinds(h.pid)).toEqual(expect.arrayContaining(["review_released", "delivered"]));
    expect((await poll(h.pid)).chat).toEqual([]); // delivered once
  });

  it("a decision taken on the link while a held result goes out: that decision is what the customer gets", async () => {
    registry.createTenant("demo@race.pl", "https://race.pl");
    const r = await finished("race_pl");
    const rv = await openReview(r.pid, "race_pl", r.runId, DRAFT, [SHEET]);
    // The reviewer declines with an own message after the poll read the review, before it is closed.
    before = { match: (sql) => sql.includes("status = 'released'"), run: async () => { await decide(rv.token, "declined", { final: "THE REVIEWER'S OWN MESSAGE" }); } };
    expect(await poll(r.pid)).toEqual({ status: "done", message: "THE REVIEWER'S OWN MESSAGE", files: [], chat: ["THE REVIEWER'S OWN MESSAGE"] });
    expect(before).toBeNull(); // the decision did land in between
    expect((await reviewForRun(r.pid, r.runId))?.status).toBe("declined");
  });

  it("a reply flagged as speaking to the business, held before: could not prepare, as no one reviewed it", async () => {
    registry.createTenant("demo@flagged.pl", "https://flagged.pl");
    const f = await finished("flagged_pl", { needsOwner: true });
    await openReview(f.pid, "flagged_pl", f.runId, DRAFT, [SHEET]);
    // Not the flagged draft as written (the owner's decision 2026-11-04: a flagged reply on a demo gets
    // one repair pass, then "could not prepare" - a run flagged before that had no repair pass).
    expect(await poll(f.pid)).toMatchObject({ message: "WORDED NOTICE", files: [], chat: ["WORDED NOTICE"] });
    expect((await reviewForRun(f.pid, f.runId))?.status).toBe("released");
  });

  it("a demo claimed after its result went out: the delivered result does not go back into review", async () => {
    registry.createTenant("demo@claimedlater.pl", "https://claimedlater.pl");
    registry.updateTenant("claimedlater_pl", { settings: { agentReview: "approve" } }); // an admin's choice: applies once claimed
    const c = await finished("claimedlater_pl");
    expect((await poll(c.pid)).status).toBe("done");
    registry.updateTenant("claimedlater_pl", { ownerPasswordHash: hashPassword("s3cret-pass") });
    expect(await poll(c.pid)).toEqual({ status: "done", message: DRAFT, files: [SHEET], chat: [] });
    expect(await reviewsForProject(c.pid)).toEqual([]);
    expect(sent.review).not.toContain("demo@claimedlater.pl");
    // The next result waits for the new owner, who is e-mailed.
    const next = await finished("claimedlater_pl");
    expect((await poll(next.pid)).status).toBe("review");
    expect(sent.review).toContain("demo@claimedlater.pl");
  });
});

describe("the review e-mail and the late-review sweep", () => {
  it("no review e-mail to a demo's address; a business that has not joined still gets one once it stepped in", async () => {
    registry.createTenant("demo@nomail.pl", "https://nomail.pl");
    const d = await finished("nomail_pl");
    await openReview(d.pid, "nomail_pl", d.runId, DRAFT, [SHEET]);
    expect(sent.review).not.toContain("demo@nomail.pl");
    registry.createTenant("biuro@steppedin.pl", "https://steppedin.pl");
    const sub = (await createProject(BUSINESS_REQUEST, { customerSession: "project:prj_z", initiatorTenantId: "steppedin_pl", memory: { parentId: "prj_z", listed: true, ownerLoop: true } })).id;
    await openReview(sub, "steppedin_pl", "run-z", "Odpowiedź z publicznych danych firmy.", []);
    expect(sent.review).toContain("biuro@steppedin.pl");
  });

  it("a demo's held result is released once - no review_late, no e-mail to its address; an owner is reminded once", async () => {
    process.env.AGENT_REVIEW_LATE_MIN = "0.0001"; // "late" after 6 ms, for this test only
    try {
      registry.createTenant("demo@sweep.pl", "https://sweep.pl");
      const h = await finished("sweep_pl", {}, { customerContact: contact("klient@sweep.example") });
      await openReview(h.pid, "sweep_pl", h.runId, DRAFT, [SHEET]);
      registry.createTenant("owner@sweepowned.pl", "https://sweepowned.pl");
      registry.updateTenant("sweepowned_pl", { ownerPasswordHash: hashPassword("s3cret-pass"), settings: { agentReview: "approve" } });
      const o = await finished("sweepowned_pl");
      await openReview(o.pid, "sweepowned_pl", o.runId, DRAFT, [SHEET]);
      const ownerEmails = sent.review.filter((x) => x === "owner@sweepowned.pl").length;
      await new Promise((ok) => setTimeout(ok, 20));
      await remindLateReviews();
      await remindLateReviews(); // each review once

      const hd = (await projectDetail(h.pid))!;
      expect(hd.project.memory.delivered).toBe(h.runId);
      expect(hd.events.filter((e) => e.kind === "delivered").length).toBe(1);
      expect(hd.events.map((e) => e.kind)).not.toContain("review_late");
      expect(hd.project.memory.reviewLate).toBeUndefined();
      expect((await reviewForRun(h.pid, h.runId))?.status).toBe("released");
      expect(sent.review).not.toContain("demo@sweep.pl");
      expect(emailsTo("klient@sweep.example").length).toBe(1);
      // A business with an owner: reminded once, the customer told it is late, nothing delivered.
      const od = (await projectDetail(o.pid))!;
      expect(od.events.filter((e) => e.kind === "review_late").length).toBe(1);
      expect(od.project.memory.delivered).toBeUndefined();
      expect(sent.review.filter((x) => x === "owner@sweepowned.pl").length).toBe(ownerEmails + 1);
    } finally {
      delete process.env.AGENT_REVIEW_LATE_MIN;
    }
  });

  // A request to another business of the network: its own project, answered from its data.
  async function memberAnswer(member: string, memory: Record<string, unknown> = {}) {
    if (!registry.getTenant("netasker_pl")) registry.createTenant("demo@netasker.pl", "https://netasker.pl");
    const parent = await conversation("netasker_pl", { networkContinued: true }); // no continuation run here
    const sub = (await createProject(BUSINESS_REQUEST, { customerSession: `project:${parent}`, initiatorTenantId: member, memory: { parentId: parent, question: "Ile kosztuje wylewka 60 m2?", ...memory } })).id;
    await writeFile(sub, "odpowiedz.txt", "Wylewka 60 m2: 4 200 zł netto.", "txt", "agent");
    const runId = `run-${sub}`;
    await setMemory(sub, { agentRun: run({ runId, files: ["odpowiedz.txt"] }) });
    await setMemory(parent, { subRequests: [{ id: sub, tenantId: member, label: member, question: "?", status: memory.settled || "waiting", at: new Date().toISOString() }] });
    return { parent, sub, runId };
  }

  it("a member business nobody has claimed: its held answer goes back to the asking business once, no e-mail", async () => {
    process.env.AGENT_REVIEW_LATE_MIN = "0.0001";
    try {
      registry.createTenant("biuro@heldmember.pl", "https://heldmember.pl");
      const m = await memberAnswer("heldmember_pl");
      await openReview(m.sub, "heldmember_pl", m.runId, "Wylewka 60 m2: 4 200 zł netto.", []); // held before 2026-11-04
      await new Promise((ok) => setTimeout(ok, 20));
      await remindLateReviews();
      await remindLateReviews();
      expect((await getProject(m.sub))?.memory.settled).toBe("answered");
      expect(((await getProject(m.parent))?.memory.subRequests as any[])[0].status).toBe("answered");
      expect((await kinds(m.parent)).filter((k) => k === "business_answered").length).toBe(1);
      expect((await reviewForRun(m.sub, m.runId))?.status).toBe("released");
      expect(await kinds(m.sub)).not.toContain("review_late");
      expect([...sent.review, ...sent.quote]).not.toContain("biuro@heldmember.pl");
    } finally {
      delete process.env.AGENT_REVIEW_LATE_MIN;
    }
  });

  it("a business that has not joined: its invite page is never taken for a demo's held result, also when its project can't be read", async () => {
    process.env.AGENT_REVIEW_LATE_MIN = "0.0001";
    try {
      registry.createTenant("biuro@invited.pl", "https://invited.pl");
      // Answered from its public data and settled at once; the invite page is a review opened without an e-mail (invite.ts).
      const m = await memberAnswer("invited_pl", { listed: true, settled: "answered" });
      const rv = await openReview(m.sub, "invited_pl", m.runId, "Wylewka 60 m2: 4 200 zł netto.", [], false);
      await new Promise((ok) => setTimeout(ok, 20));
      const remindedAt = () => (mem.prepare("SELECT reminded_at FROM project_reviews WHERE token = ?").get(rv.token) as any).reminded_at;
      // The sweep's read of the project fails (a D1 timeout): left for the next sweep, nothing decided.
      before = { match: (sql, params) => sql.startsWith("SELECT * FROM projects WHERE id = ?") && params[0] === m.sub, run: async () => { throw new Error("D1 timeout"); } };
      await remindLateReviews();
      expect(before).toBeNull();
      expect(remindedAt()).toBeNull();
      // Read: an invite, not a result the customer waits for - claimed once and left as it is.
      await remindLateReviews();
      expect(remindedAt()).not.toBeNull();
      expect((await reviewForRun(m.sub, m.runId))?.status).toBe("pending");
      // Never the assistant's answer recorded as the business's own confirmation.
      expect(await kinds(m.parent)).not.toContain("business_confirmed");
      expect((await getProject(m.sub))?.memory.confirmedAt).toBeUndefined();
    } finally {
      delete process.env.AGENT_REVIEW_LATE_MIN;
    }
  });
});

describe("checkOutcome: a reply flagged as speaking to the business", () => {
  // Two failed checks: the customer-only check and one of the planner's own criteria (never fails a run).
  const flagged = { failed: 2, customerOnlyFailed: true, specFailed: 1 };
  it("a customer's result on a demo nobody has claimed: a failed check - the repair pass, then could not prepare", () => {
    expect(checkOutcome(flagged, true, false)).toEqual({ hard: 1, needsOwner: false });
  });
  it("a customer's result of a business with an owner: not a failed run, the owner sees it first", () => {
    expect(checkOutcome(flagged, true, true)).toEqual({ hard: 0, needsOwner: true });
  });
  it("an answer to another business's request: unchanged, whoever owns the business", () => {
    expect(checkOutcome(flagged, false, false)).toEqual({ hard: 0, needsOwner: true });
    expect(checkOutcome(flagged, false, true)).toEqual({ hard: 0, needsOwner: true });
  });
  it("other checks and no verification", () => {
    expect(checkOutcome({ failed: 1, customerOnlyFailed: false, specFailed: 0 }, true, false)).toEqual({ hard: 1, needsOwner: false });
    expect(checkOutcome(null, true, true)).toEqual({ hard: 0, needsOwner: false });
  });
});

describe("a member business whose answer leaves part unpriced", () => {
  it("only one with an owner is asked for the price by e-mail; a demo's part stays to be quoted", async () => {
    jev.answer = { unpriced: { type: "noul", noul: 1 } };
    try {
      registry.createTenant("demo@asker.pl", "https://asker.pl");
      registry.createTenant("biuro@unclaimedmember.pl", "https://unclaimedmember.pl");
      registry.createTenant("biuro@ownedmember.pl", "https://ownedmember.pl");
      registry.updateTenant("ownedmember_pl", { ownerPasswordHash: hashPassword("s3cret-pass") });
      const parent = await conversation("asker_pl", { networkContinued: true }); // no continuation run here
      const subs: Record<string, string> = {};
      for (const member of ["unclaimedmember_pl", "ownedmember_pl"]) {
        const sub = (await createProject(BUSINESS_REQUEST, { customerSession: `project:${parent}`, initiatorTenantId: member, memory: { parentId: parent, question: "Ile kosztuje wylewka 60 m2 z dowozem?" } })).id;
        await writeFile(sub, "odpowiedz.txt", "Wylewka 60 m2: 4 200 zł; dowóz wymaga indywidualnej wyceny.", "txt", "agent");
        await setMemory(sub, { agentRun: run({ runId: `run-${sub}`, files: ["odpowiedz.txt"] }) });
        subs[member] = sub;
      }
      await setMemory(parent, { subRequests: Object.entries(subs).map(([tenantId, id]) => ({ id, tenantId, label: tenantId, question: "?", status: "waiting", at: new Date().toISOString() })) });
      for (const sub of Object.values(subs)) await onRunFinished(sub);
      expect(await kinds(subs.unclaimedmember_pl)).not.toContain("owner_quote_asked");
      expect(sent.quote).not.toContain("biuro@unclaimedmember.pl");
      expect((await getProject(subs.unclaimedmember_pl))?.memory.settled).toBe("answered");
      expect(await kinds(subs.ownedmember_pl)).toContain("owner_quote_asked");
      expect(sent.quote).toContain("biuro@ownedmember.pl");
    } finally {
      jev.answer = null;
    }
  });
});

describe("a calculation that runs too long: the knowledge reply kept when it started (chat.ts releaseReply)", () => {
  const KEPT = "Z naszego cennika: zagęszczarka 100 kg - 120 zł za dobę, 24 zł za godzinę.";
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  it("goes out once after AGENT_RELEASE_MS while the run goes on; the result follows as usual", async () => {
    registry.createTenant("demo@late.pl", "https://late.pl");
    const pid = await conversation("late_pl", { releaseText: { at: Date.now() - 1000, text: KEPT } });
    await setMemory(pid, { agentRun: run({ runId: `run-${pid}`, status: "running", startedAt: minutesAgo(1) }) });
    expect(await poll(pid)).toMatchObject({ status: "running", chat: [] });
    await setMemory(pid, { agentRun: run({ runId: `run-${pid}`, status: "running", startedAt: minutesAgo(4) }) });
    expect(await poll(pid)).toMatchObject({ status: "released", message: KEPT, chat: [KEPT] });
    expect(await poll(pid)).toMatchObject({ status: "released", message: KEPT, chat: [] }); // once into the conversation
    await writeFile(pid, "odpowiedz.txt", DRAFT, "txt", "agent");
    await setMemory(pid, { agentRun: run({ runId: `run-${pid}`, status: "done", files: ["odpowiedz.txt"] }) });
    expect(await poll(pid)).toMatchObject({ status: "done", message: DRAFT, chat: [DRAFT] });
  });

  it("nothing kept: the wait goes on as before", async () => {
    registry.createTenant("demo@nokept.pl", "https://nokept.pl");
    const pid = await conversation("nokept_pl");
    await setMemory(pid, { agentRun: run({ runId: `run-${pid}`, status: "running", startedAt: minutesAgo(10) }) });
    expect(await poll(pid)).toMatchObject({ status: "running", chat: [] });
  });

  it("a run that fails: the kept reply instead of could not prepare - and nothing more when it went out already", async () => {
    registry.createTenant("demo@lost.pl", "https://lost.pl");
    const a = await conversation("lost_pl", { releaseText: { at: Date.now(), text: KEPT } });
    await setMemory(a, { agentRun: run({ runId: `run-${a}`, status: "failed" }) });
    expect(await poll(a)).toMatchObject({ status: "failed", message: KEPT, files: [], chat: [KEPT] });
    const b = await conversation("lost_pl", { releaseText: { at: 123, text: KEPT }, released: "123" });
    await setMemory(b, { agentRun: run({ runId: `run-${b}`, status: "failed" }) });
    expect(await poll(b)).toMatchObject({ status: "failed", message: KEPT, chat: [] });
    expect(await agentDelivery(b, async () => {})).toMatchObject({ released: true });
  });
});
