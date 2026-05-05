import { randomUUID } from "crypto";

export interface ConversationEntry {
  id: string;
  tenantId: string;
  sessionId: string;
  timestamp: string;
  userMessage: string;
  botResponse: string;
  flowInvoked: string | null;
  navigatedTo: string | null;
  hadToolCall: boolean;
}

export interface UnknownQuestionEntry {
  id: string;
  tenantId: string;
  question: string;
  timestamp: string;
}

const QDRANT_HOST = process.env.QDRANT_HOST || "152.53.243.28";
const QDRANT_PORT = process.env.QDRANT_PORT || "6333";
const BASE = `http://${QDRANT_HOST}:${QDRANT_PORT}`;

async function ensureCollection(name: string) {
  const check = await fetch(`${BASE}/collections/${name}`);
  if (check.status === 404) {
    await fetch(`${BASE}/collections/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vectors: { size: 1, distance: "Cosine" } }),
    });
  }
}

function collectionName(tenantId: string, type: string) {
  return `wctx_${tenantId.replace(/\./g, "_")}_${type}`;
}

export async function logConversation(tenantId: string, entry: Omit<ConversationEntry, "id" | "tenantId">) {
  const col = collectionName(tenantId, "convos");
  await ensureCollection(col);

  const id = randomUUID();
  await fetch(`${BASE}/collections/${col}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      points: [{
        id,
        vector: [0], // dummy vector — we only use payload
        payload: { ...entry, tenantId, id },
      }],
    }),
  });
}

export async function getConversations(tenantId: string, limit = 50): Promise<ConversationEntry[]> {
  const col = collectionName(tenantId, "convos");
  try {
    const res = await fetch(`${BASE}/collections/${col}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit,
        with_payload: true,
        order_by: { key: "timestamp", direction: "desc" },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { result: { points: { payload: ConversationEntry }[] } };
    return data.result.points.map((p) => p.payload);
  } catch {
    // Fallback: scroll without ordering (older Qdrant versions)
    try {
      const res = await fetch(`${BASE}/collections/${col}/points/scroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit, with_payload: true }),
      });
      if (!res.ok) return [];
      const data = await res.json() as { result: { points: { payload: ConversationEntry }[] } };
      return data.result.points
        .map((p) => p.payload)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    } catch { return []; }
  }
}

export async function getConversationStats(tenantId: string) {
  const convos = await getConversations(tenantId, 1000);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const totalToday = convos.filter((c) => new Date(c.timestamp) >= todayStart).length;
  const flowsExecuted = convos.filter((c) => c.flowInvoked).length;

  return {
    totalConversations: convos.length,
    totalToday,
    flowsExecuted,
  };
}

export async function logUnknownQuestion(tenantId: string, question: string) {
  const col = collectionName(tenantId, "gaps");
  await ensureCollection(col);

  await fetch(`${BASE}/collections/${col}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      points: [{
        id: randomUUID(),
        vector: [0],
        payload: { tenantId, question, timestamp: new Date().toISOString() },
      }],
    }),
  });
}

export async function getUnknownQuestions(tenantId: string): Promise<UnknownQuestionEntry[]> {
  const col = collectionName(tenantId, "gaps");
  try {
    const res = await fetch(`${BASE}/collections/${col}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 200, with_payload: true }),
    });
    if (!res.ok) return [];
    const data = await res.json() as { result: { points: { payload: UnknownQuestionEntry }[] } };
    // Deduplicate
    const seen = new Set<string>();
    return data.result.points
      .map((p) => p.payload)
      .filter((q) => { const k = q.question?.toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  } catch { return []; }
}

export async function clearUnknownQuestions(tenantId: string) {
  const col = collectionName(tenantId, "gaps");
  try {
    await fetch(`${BASE}/collections/${col}`, { method: "DELETE" });
  } catch {}
}
