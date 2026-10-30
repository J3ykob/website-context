/**
 * Every decision a model makes for us (Jev's typed questions, stored need splits), with its inputs and
 * answers: the training data for our own decision model (a small multilingual cross-encoder distilled
 * from these - the owner's plan 2026-10-30) and the record to check it against. D1 table `decisions`,
 * written in batches every 10 s, never blocking a chat; DECISION_LOG=0 turns it off. Kept like chats
 * (src/security/retention.ts: CHAT_RETENTION_DAYS) - inputs contain customers' messages.
 */
import { d1Query } from "../storage/conversation-store.js";

interface Row { at: string; kind: string; model: string; tenant: string; input: string; output: string }
const queue: Row[] = [];
let ready: Promise<void> | null = null;
const schema = () => (ready ||= d1Query("CREATE TABLE IF NOT EXISTS decisions (at TEXT NOT NULL, kind TEXT NOT NULL, model TEXT, tenant TEXT, input TEXT NOT NULL, output TEXT NOT NULL)")
  .then(() => d1Query("CREATE INDEX IF NOT EXISTS decisions_at ON decisions (at)")).then(() => undefined).catch((e) => { ready = null; throw e; }));

export function logDecision(kind: string, model: string, input: unknown, output: unknown, tenant = ""): void {
  if (process.env.DECISION_LOG === "0" || process.env.VITEST) return;
  queue.push({ at: new Date().toISOString(), kind, model, tenant, input: JSON.stringify(input).slice(0, 12000), output: JSON.stringify(output).slice(0, 4000) });
  if (queue.length > 5000) queue.splice(0, queue.length - 5000); // D1 down: keep the newest
}

async function flush(): Promise<void> {
  if (!queue.length) return;
  const batch = queue.splice(0, 50);
  try {
    await schema();
    const sql = `INSERT INTO decisions (at, kind, model, tenant, input, output) VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?)").join(", ")}`;
    await d1Query(sql, batch.flatMap((r) => [r.at, r.kind, r.model, r.tenant, r.input, r.output]));
  } catch { queue.unshift(...batch); }
}
setInterval(() => { void flush(); }, 10_000).unref();
