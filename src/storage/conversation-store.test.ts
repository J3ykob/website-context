/**
 * conversation-store (D1) tests. Injected "D1" = in-memory better-sqlite3 (D1 is
 * SQLite) → real SQL, deterministic, no network, no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as cs from "./conversation-store.js";
import { SELF_TEST_QUESTIONS } from "../knowledge/audit.js";

let mem: Database.Database;
function makeQuery(db: Database.Database) {
  return async (sql: string, params: any[] = []): Promise<any[]> => {
    const stmt = db.prepare(sql);
    if (/^\s*(select|pragma)/i.test(sql)) return stmt.all(...params) as any[];
    stmt.run(...params);
    return [];
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const T = "acme_co_uk";

beforeEach(() => {
  mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, tenant_id TEXT, session_id TEXT, role TEXT,
      content TEXT, domain TEXT, created_at TEXT, flow_invoked TEXT, intent_id TEXT);
    CREATE TABLE unknown_questions (id TEXT PRIMARY KEY, tenant_id TEXT, question TEXT, created_at TEXT);
  `);
  cs.__setQuery(makeQuery(mem));
});
afterEach(() => { cs.__setQuery(null); mem.close(); });

describe("conversation-store (D1) messages", () => {
  it("logMessage writes to chat_messages and getMessages reads it back", async () => {
    await cs.logMessage(T, "s1", "user", "What are your hours?");
    await cs.logMessage(T, "s1", "assistant", "We are open 9-5.", { flowInvoked: null, domain: "acme.co.uk" });
    await flush();
    const all = await cs.getMessages(T, {});
    expect(all.length).toBe(2);
    const userMsg = all.find((m) => m.role === "user")!;
    expect(userMsg.content).toBe("What are your hours?");
    expect(userMsg.hasQuestion).toBe(true);
    expect(userMsg.intent).toBe("question");
    expect(userMsg.conversationId).toBe("s1");
    // role filter
    expect((await cs.getMessages(T, { role: "user" })).every((m) => m.role === "user")).toBe(true);
    // session filter
    expect((await cs.getMessages(T, { sessionId: "s1" })).length).toBe(2);
  });

  it("tenant isolation", async () => {
    await cs.logMessage(T, "s1", "user", "hi");
    await cs.logMessage("other_com", "s2", "user", "yo");
    await flush();
    expect((await cs.getMessages(T, {})).length).toBe(1);
  });

  it("getConversations groups by session, newest first", async () => {
    await cs.logMessage(T, "sA", "user", "first session q?");
    await cs.logMessage(T, "sA", "assistant", "ans A");
    await cs.logMessage(T, "sB", "user", "second session q?");
    await flush();
    const convos = await cs.getConversations(T);
    expect(convos.length).toBe(2);
    expect(convos[0].userMessage).toBeTruthy();
    const sA = convos.find((c) => c.sessionId === "sA")!;
    expect(sA.botResponse).toBe("ans A");
    expect(sA.messageCount).toBe(2);
  });

  it("getConversationStats counts sessions, messages, today, flows", async () => {
    await cs.logMessage(T, "s1", "user", "q1?");
    await cs.logMessage(T, "s1", "assistant", "a1", { flowInvoked: "flow-book" });
    await cs.logMessage(T, "s2", "user", "q2?");
    await flush();
    const s = await cs.getConversationStats(T);
    expect(s.totalConversations).toBe(2);
    expect(s.totalMessages).toBe(3);
    expect(s.totalToday).toBe(2); // all just inserted
    expect(s.flowsExecuted).toBe(1);
  });

  it("getFirstMessages returns one (first) user message per session", async () => {
    await cs.logMessage(T, "s1", "user", "first?");
    await new Promise((r) => setTimeout(r, 5));
    await cs.logMessage(T, "s1", "user", "second?");
    await cs.logMessage(T, "s2", "user", "other session?");
    await flush();
    const firsts = await cs.getFirstMessages(T);
    expect(firsts.length).toBe(2); // one per session
    expect(firsts.every((m) => m.isFirstMessage)).toBe(true);
    expect(firsts.find((m) => m.sessionId === "s1")!.content).toBe("first?");
  });

  it("getIntentBreakdown + getTopQuestions derive from content", async () => {
    await cs.logMessage(T, "s1", "user", "hello there");
    await cs.logMessage(T, "s1", "user", "what is the price?");
    await cs.logMessage(T, "s2", "user", "can you book me a table");
    await flush();
    const intents = await cs.getIntentBreakdown(T);
    expect(intents.greeting).toBe(1);
    expect(intents.question).toBe(1);
    expect(intents.action_request).toBe(1);
    const top = await cs.getTopQuestions(T);
    expect(top).toContain("what is the price?");
    expect(top).not.toContain("hello there");
  });
});

describe("conversation-store (D1) gaps", () => {
  it("logUnknownQuestion -> getUnknownQuestions (dedup) -> clear", async () => {
    await cs.logUnknownQuestion(T, "Do you ship to Canada?");
    await cs.logUnknownQuestion(T, "do you ship to canada?"); // dup (case-insensitive)
    await cs.logUnknownQuestion(T, "What is your VAT number?");
    await flush();
    const gaps = await cs.getUnknownQuestions(T);
    expect(gaps.length).toBe(2); // deduped
    expect(gaps.some((g) => g.question === "What is your VAT number?")).toBe(true);
    await cs.clearUnknownQuestions(T);
    await flush();
    expect((await cs.getUnknownQuestions(T)).length).toBe(0);
  });

  it("rows the knowledge audit's test questions left are not listed or counted; the rows stay", async () => {
    expect(SELF_TEST_QUESTIONS.length).toBe(16); // 8 questions, pl + en
    for (const q of SELF_TEST_QUESTIONS) await cs.logUnknownQuestion(T, q);
    await cs.logUnknownQuestion(T, "Czy robicie dachy płaskie?");
    // Only an exact copy of our own text is a test row: a customer's own wording of a similar question stays.
    await cs.logUnknownQuestion(T, "jak mogę się z wami skontaktować?");
    const gaps = await cs.getUnknownQuestions(T);
    expect(gaps.map((g) => g.question).sort()).toEqual(["Czy robicie dachy płaskie?", "jak mogę się z wami skontaktować?"]);
    const kept = mem.prepare("SELECT COUNT(*) AS n FROM unknown_questions WHERE tenant_id = ?").get(T) as { n: number };
    expect(kept.n).toBe(18); // legacy rows are not deleted
  });

  it("gaps are tenant-scoped", async () => {
    await cs.logUnknownQuestion(T, "q for acme");
    await cs.logUnknownQuestion("other_com", "q for other");
    await flush();
    expect((await cs.getUnknownQuestions(T)).length).toBe(1);
  });
});
