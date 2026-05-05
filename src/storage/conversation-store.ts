import { randomUUID } from "crypto";

const QDRANT_HOST = process.env.QDRANT_HOST || "152.53.243.28";
const QDRANT_PORT = process.env.QDRANT_PORT || "6333";
const BASE = `http://${QDRANT_HOST}:${QDRANT_PORT}`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MessageRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  messageIndex: number; // 0 = first message in conversation, 1 = second, etc.

  // Analytics metadata
  isFirstMessage: boolean; // true for the very first user message in a session
  isEntryMessage: boolean; // true for first user message in each conversation
  wordCount: number;
  hasQuestion: boolean; // contains "?"
  language?: string;

  // Context about what happened
  flowInvoked?: string | null;
  navigatedTo?: string | null;
  hadToolCall?: boolean;
  sourcePages?: string[]; // which pages were used as context for this response

  // For future sentiment analysis
  sentiment?: "positive" | "negative" | "neutral" | null;
  intent?: string | null; // "question", "action_request", "complaint", "praise", "greeting", etc.
  topic?: string | null; // extracted topic: "pricing", "shipping", "contact", "product", etc.
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
  resolved: boolean; // did the conversation end positively?
}

export interface UnknownQuestionEntry {
  id: string;
  tenantId: string;
  question: string;
  timestamp: string;
}

// ─── Collection helpers ─────────────────────────────────────────────────────

const ensuredCollections = new Set<string>();

async function ensureCollection(name: string) {
  if (ensuredCollections.has(name)) return;
  try {
    const check = await fetch(`${BASE}/collections/${name}`);
    if (check.status === 404) {
      await fetch(`${BASE}/collections/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vectors: { size: 1, distance: "Cosine" } }),
      });
    }
    ensuredCollections.add(name);
  } catch {}
}

function col(tenantId: string, type: string) {
  return `wctx_${tenantId.replace(/[^a-zA-Z0-9_]/g, "_")}_${type}`;
}

// ─── Message-level logging ──────────────────────────────────────────────────

// Track session state for analytics
const sessionState = new Map<string, { messageCount: number; conversationId: string; isFirstSession: boolean }>();

export async function logMessage(
  tenantId: string,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  meta: {
    flowInvoked?: string | null;
    navigatedTo?: string | null;
    hadToolCall?: boolean;
    sourcePages?: string[];
  } = {}
) {
  const collection = col(tenantId, "messages");
  await ensureCollection(collection);

  // Get/create session state
  const stateKey = `${tenantId}:${sessionId}`;
  let state = sessionState.get(stateKey);
  if (!state) {
    state = {
      messageCount: 0,
      conversationId: randomUUID(),
      isFirstSession: true,
    };
    sessionState.set(stateKey, state);
  }

  const messageIndex = state.messageCount;
  state.messageCount++;

  const isFirstMessage = messageIndex === 0 && role === "user";
  const isEntryMessage = role === "user" && (messageIndex === 0 || messageIndex === 1);

  const record: MessageRecord = {
    id: randomUUID(),
    tenantId,
    sessionId,
    conversationId: state.conversationId,
    role,
    content,
    timestamp: new Date().toISOString(),
    messageIndex,
    isFirstMessage,
    isEntryMessage,
    wordCount: content.split(/\s+/).filter(Boolean).length,
    hasQuestion: content.includes("?"),
    flowInvoked: meta.flowInvoked || null,
    navigatedTo: meta.navigatedTo || null,
    hadToolCall: meta.hadToolCall || false,
    sourcePages: meta.sourcePages,
    sentiment: null,
    intent: classifyIntent(content, role),
    topic: null,
  };

  try {
    await fetch(`${BASE}/collections/${collection}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [{
          id: record.id,
          vector: [0],
          payload: record,
        }],
      }),
    });
  } catch {}
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

// ─── Query functions ────────────────────────────────────────────────────────

export async function getMessages(tenantId: string, options: {
  limit?: number;
  role?: "user" | "assistant";
  firstOnly?: boolean; // only first messages per session
  sessionId?: string;
} = {}): Promise<MessageRecord[]> {
  const collection = col(tenantId, "messages");
  const limit = options.limit || 100;

  const filter: any = { must: [] };
  if (options.role) filter.must.push({ key: "role", match: { value: options.role } });
  if (options.firstOnly) filter.must.push({ key: "isFirstMessage", match: { value: true } });
  if (options.sessionId) filter.must.push({ key: "sessionId", match: { value: options.sessionId } });

  try {
    const res = await fetch(`${BASE}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit,
        with_payload: true,
        filter: filter.must.length > 0 ? filter : undefined,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { result: { points: { payload: MessageRecord }[] } };
    return data.result.points
      .map((p) => p.payload)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  } catch { return []; }
}

export async function getConversations(tenantId: string, limit = 50): Promise<any[]> {
  // Get recent messages and group by conversationId
  const messages = await getMessages(tenantId, { limit: limit * 5 });

  const convos = new Map<string, MessageRecord[]>();
  for (const msg of messages) {
    const key = msg.conversationId || msg.sessionId;
    if (!convos.has(key)) convos.set(key, []);
    convos.get(key)!.push(msg);
  }

  return Array.from(convos.entries())
    .map(([id, msgs]) => {
      msgs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      const userMsgs = msgs.filter((m) => m.role === "user");
      const lastMsg = msgs[msgs.length - 1];
      return {
        conversationId: id,
        sessionId: msgs[0].sessionId,
        timestamp: msgs[0].timestamp,
        userMessage: userMsgs[0]?.content || "",
        botResponse: msgs.find((m) => m.role === "assistant")?.content || "",
        messageCount: msgs.length,
        flowInvoked: msgs.find((m) => m.flowInvoked)?.flowInvoked || null,
        navigatedTo: msgs.find((m) => m.navigatedTo)?.navigatedTo || null,
        hadToolCall: msgs.some((m) => m.hadToolCall),
      };
    })
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

export async function getConversationStats(tenantId: string) {
  const messages = await getMessages(tenantId, { limit: 5000 });
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayMsgs = messages.filter((m) => new Date(m.timestamp) >= todayStart);
  const sessions = new Set(messages.map((m) => m.sessionId));
  const todaySessions = new Set(todayMsgs.map((m) => m.sessionId));

  return {
    totalConversations: sessions.size,
    totalToday: todaySessions.size,
    totalMessages: messages.length,
    flowsExecuted: messages.filter((m) => m.flowInvoked).length,
  };
}

// ─── Analytics queries ──────────────────────────────────────────────────────

export async function getFirstMessages(tenantId: string, limit = 50): Promise<MessageRecord[]> {
  return getMessages(tenantId, { role: "user", firstOnly: true, limit });
}

export async function getIntentBreakdown(tenantId: string): Promise<Record<string, number>> {
  const messages = await getMessages(tenantId, { role: "user", limit: 1000 });
  const counts: Record<string, number> = {};
  for (const msg of messages) {
    const intent = msg.intent || "unknown";
    counts[intent] = (counts[intent] || 0) + 1;
  }
  return counts;
}

export async function getTopQuestions(tenantId: string, limit = 20): Promise<string[]> {
  const messages = await getMessages(tenantId, { role: "user", limit: 500 });
  return messages
    .filter((m) => m.hasQuestion)
    .map((m) => m.content)
    .slice(0, limit);
}

// ─── Unknown questions ──────────────────────────────────────────────────────

export async function logUnknownQuestion(tenantId: string, question: string) {
  const collection = col(tenantId, "gaps");
  await ensureCollection(collection);

  await fetch(`${BASE}/collections/${collection}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      points: [{
        id: randomUUID(),
        vector: [0],
        payload: { tenantId, question, timestamp: new Date().toISOString() },
      }],
    }),
  }).catch(() => {});
}

export async function getUnknownQuestions(tenantId: string): Promise<UnknownQuestionEntry[]> {
  const collection = col(tenantId, "gaps");
  try {
    const res = await fetch(`${BASE}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 200, with_payload: true }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { result: { points: { payload: UnknownQuestionEntry }[] } };
    const seen = new Set<string>();
    return data.result.points
      .map((p) => p.payload)
      .filter((q) => { const k = q.question?.toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  } catch { return []; }
}

export async function clearUnknownQuestions(tenantId: string) {
  try { await fetch(`${BASE}/collections/${col(tenantId, "gaps")}`, { method: "DELETE" }); } catch {}
}
