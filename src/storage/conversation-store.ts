/**
 * Conversation + gaps store — backed by Cloudflare D1 (was Qdrant).
 *
 * Messages live in D1 `chat_messages` (id, tenant_id, session_id, role, content,
 * domain, created_at, flow_invoked); gaps in D1 `unknown_questions`. A "conversation"
 * is a session (grouped by session_id). Analytics fields the old Qdrant payload
 * carried (intent, wordCount, hasQuestion) are DERIVED on read — no extra columns.
 * The D1 query is injectable (__setQuery) so tests run real SQL against in-memory
 * SQLite (no network, no mocks).
 */

const CF_ACCOUNT_ID = "98e447c9e14d384e1b7e6f4d42c39ad2";
const D1_DATABASE_ID = process.env.D1_DATABASE_ID || "0dec9229-fea2-4343-bf87-d36ac3205979";
const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;

type QueryFn = (sql: string, params?: any[]) => Promise<any[]>;
const realQuery: QueryFn = async (sql, params = []) => {
  const { getCfToken } = await import("./cf-auth.js"); // lazy: avoid R2 boot-throw in tests
  const resp = await fetch(D1_BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${getCfToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  if (!resp.ok) throw new Error(`D1 query failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as any;
  return data.result?.[0]?.results || [];
};
let query: QueryFn = realQuery;
/** Test seam: inject a fake D1 query. */
export function __setQuery(fn: QueryFn | null): void {
  query = fn || realQuery;
}

// ─── Types (stable; consumers import these) ──────────────────────────────────
export interface MessageRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  messageIndex: number;
  isFirstMessage: boolean;
  isEntryMessage: boolean;
  wordCount: number;
  hasQuestion: boolean;
  flowInvoked?: string | null;
  navigatedTo?: string | null;
  hadToolCall?: boolean;
  intent?: string | null;
  topic?: string | null;
  sentiment?: "positive" | "negative" | "neutral" | null;
}

export interface ConversationSummary {
  conversationId: string;
  sessionId: string;
  tenantId: string;
  startedAt: string;
  lastMessageAt: string;
  messageCount: number;
  userMessageCount: number;
  firstUserMessage: string;
  flowsInvoked: string[];
  resolved: boolean;
}

export interface UnknownQuestionEntry {
  id: string;
  tenantId: string;
  question: string;
  timestamp: string;
}

function classifyIntent(content: string, role: string): string {
  if (role !== "user") return "response";
  const lower = content.toLowerCase();
  if (/^(hi|hello|hey|cześć|hej|dzień dobry|siema)[\s!.,]*/i.test(lower)) return "greeting";
  if (lower.includes("?")) return "question";
  if (/want to|need to|can you|please|could you|fill|submit|send|contact|order|book/i.test(lower)) return "action_request";
  if (/not work|broken|error|problem|issue|bad|wrong|terrible/i.test(lower)) return "complaint";
  if (/thank|great|awesome|perfect|love|excellent|super|świetne|dzięki/i.test(lower)) return "praise";
  return "statement";
}

function rowToRecord(r: any): MessageRecord {
  const content = r.content || "";
  return {
    id: String(r.id),
    tenantId: r.tenant_id,
    sessionId: r.session_id,
    conversationId: r.session_id, // a session == a conversation
    role: r.role,
    content,
    timestamp: r.created_at,
    messageIndex: 0,
    isFirstMessage: false,
    isEntryMessage: false,
    wordCount: content.split(/\s+/).filter(Boolean).length,
    hasQuestion: content.includes("?"),
    flowInvoked: r.flow_invoked || null,
    navigatedTo: null,
    hadToolCall: !!r.flow_invoked,
    intent: classifyIntent(content, r.role),
    topic: null,
    sentiment: null,
  };
}

// ─── Write (single D1 writer for chat messages) ──────────────────────────────
export async function logMessage(
  tenantId: string,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  meta: { flowInvoked?: string | null; navigatedTo?: string | null; hadToolCall?: boolean; sourcePages?: string[]; domain?: string } = {}
): Promise<void> {
  try {
    // id is INTEGER PRIMARY KEY AUTOINCREMENT — do NOT supply it. Passing a UUID
    // string here (pre-fix) failed the datatype check on every insert, and the
    // catch below silently swallowed it: conversation logging was dead fleet-wide
    // from 2026-06-05 until this fix (only unknown_questions kept logging).
    await query(
      "INSERT INTO chat_messages (tenant_id, session_id, role, content, domain, created_at, flow_invoked) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [tenantId, sessionId, role, content, meta.domain || null, new Date().toISOString(), meta.flowInvoked || null]
    );
  } catch (e: any) {
    // Never break chat — but surface it so a silent logging failure can't hide
    // for weeks again.
    console.error(`[logMessage] insert failed (${tenantId}): ${String(e?.message || e).slice(0, 160)}`);
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────
export async function getMessages(tenantId: string, options: {
  limit?: number; role?: "user" | "assistant"; firstOnly?: boolean; sessionId?: string;
} = {}): Promise<MessageRecord[]> {
  const limit = options.limit || 100;
  let sql = "SELECT id, tenant_id, session_id, role, content, created_at, flow_invoked FROM chat_messages WHERE tenant_id = ?";
  const params: any[] = [tenantId];
  if (options.role) { sql += " AND role = ?"; params.push(options.role); }
  if (options.sessionId) { sql += " AND session_id = ?"; params.push(options.sessionId); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(options.firstOnly ? limit * 10 : limit);

  let recs: MessageRecord[];
  try { recs = (await query(sql, params)).map(rowToRecord); } catch { return []; }

  if (options.firstOnly) {
    // First message per session (earliest). Walk ascending, keep first seen per session.
    const seen = new Set<string>();
    const out: MessageRecord[] = [];
    for (const r of recs.slice().sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))) {
      if (!seen.has(r.sessionId)) { seen.add(r.sessionId); r.isFirstMessage = true; out.push(r); }
    }
    return out.slice(0, limit);
  }
  return recs; // already DESC by created_at
}

export async function getConversations(tenantId: string, limit = 50): Promise<any[]> {
  const messages = await getMessages(tenantId, { limit: limit * 5 });
  const convos = new Map<string, MessageRecord[]>();
  for (const msg of messages) {
    if (!convos.has(msg.sessionId)) convos.set(msg.sessionId, []);
    convos.get(msg.sessionId)!.push(msg);
  }
  return Array.from(convos.entries())
    .map(([sessionId, msgs]) => {
      msgs.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
      const userMsgs = msgs.filter((m) => m.role === "user");
      return {
        conversationId: sessionId,
        sessionId,
        timestamp: msgs[0].timestamp,
        userMessage: userMsgs[0]?.content || "",
        botResponse: msgs.find((m) => m.role === "assistant")?.content || "",
        messageCount: msgs.length,
        flowInvoked: msgs.find((m) => m.flowInvoked)?.flowInvoked || null,
        navigatedTo: null,
        hadToolCall: msgs.some((m) => m.hadToolCall),
      };
    })
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, limit);
}

export async function getConversationStats(tenantId: string) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  try {
    const rows = await query(
      `SELECT COUNT(DISTINCT session_id) AS sessions,
              COUNT(*) AS msgs,
              COUNT(DISTINCT CASE WHEN created_at >= ? THEN session_id END) AS today_sessions,
              COUNT(CASE WHEN flow_invoked IS NOT NULL THEN 1 END) AS flows
       FROM chat_messages WHERE tenant_id = ?`,
      [todayStart.toISOString(), tenantId]
    );
    const r = rows[0] || {};
    return {
      totalConversations: Number(r.sessions || 0),
      totalToday: Number(r.today_sessions || 0),
      totalMessages: Number(r.msgs || 0),
      flowsExecuted: Number(r.flows || 0),
    };
  } catch {
    return { totalConversations: 0, totalToday: 0, totalMessages: 0, flowsExecuted: 0 };
  }
}

export async function getFirstMessages(tenantId: string, limit = 50): Promise<MessageRecord[]> {
  return getMessages(tenantId, { role: "user", firstOnly: true, limit });
}

export async function getIntentBreakdown(tenantId: string): Promise<Record<string, number>> {
  const messages = await getMessages(tenantId, { role: "user", limit: 1000 });
  const counts: Record<string, number> = {};
  for (const msg of messages) counts[msg.intent || "unknown"] = (counts[msg.intent || "unknown"] || 0) + 1;
  return counts;
}

export async function getTopQuestions(tenantId: string, limit = 20): Promise<string[]> {
  const messages = await getMessages(tenantId, { role: "user", limit: 500 });
  return messages.filter((m) => m.hasQuestion).map((m) => m.content).slice(0, limit);
}

// ─── Gaps (unknown questions) ────────────────────────────────────────────────
export async function logUnknownQuestion(tenantId: string, question: string): Promise<void> {
  try {
    const id = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.round(Math.random() * 1e9)}`);
    await query(
      "INSERT INTO unknown_questions (id, tenant_id, question, created_at) VALUES (?, ?, ?, ?)",
      [id, tenantId, question, new Date().toISOString()]
    );
  } catch { /* never breaks chat */ }
}

export async function getUnknownQuestions(tenantId: string): Promise<UnknownQuestionEntry[]> {
  try {
    const rows = await query(
      "SELECT id, tenant_id, question, created_at FROM unknown_questions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200",
      [tenantId]
    );
    const seen = new Set<string>();
    return rows
      .map((r: any) => ({ id: String(r.id), tenantId: r.tenant_id, question: r.question, timestamp: r.created_at }))
      .filter((q: UnknownQuestionEntry) => { const k = q.question?.toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  } catch { return []; }
}

export async function clearUnknownQuestions(tenantId: string): Promise<void> {
  try { await query("DELETE FROM unknown_questions WHERE tenant_id = ?", [tenantId]); } catch { /* ignore */ }
}
