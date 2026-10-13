/**
 * The business as the gatekeeper of the agent's work. A business chooses (settings.agentReview):
 *   "auto"    - results go to the customer after the automatic checks (default);
 *   "approve" - each result waits for the owner, who gets an email with a review link (no login):
 *               approve, edit the text, ask for changes (the agent reworks it with the owner's guidance
 *               and it comes back for review), or decline with their own message.
 * Businesses never browse projects: they get the outputs, and step in where they want to.
 */
import { randomBytes } from "crypto";
import { d1Query } from "../storage/conversation-store.js";
import { addEvent, getProject } from "./store.js";
import { getTenant } from "../multi-tenant/d1-registry.js";

export type ReviewMode = "auto" | "approve";
export type ReviewStatus = "pending" | "approved" | "declined" | "changes_requested";
export interface Review {
  token: string; projectId: string; tenantId: string; runId: string; status: ReviewStatus;
  draft: string; final: string; note: string; createdAt: string; decidedAt: string | null;
}

const REVIEW_TTL_DAYS = 14;

let ready: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  ready ||= (async () => {
    await d1Query("CREATE TABLE IF NOT EXISTS project_reviews (token TEXT PRIMARY KEY, project_id TEXT NOT NULL, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '', final TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, decided_at TEXT)");
    await d1Query("CREATE UNIQUE INDEX IF NOT EXISTS project_reviews_run ON project_reviews (project_id, run_id)");
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

const row = (r: any): Review => ({
  token: r.token, projectId: r.project_id, tenantId: r.tenant_id, runId: r.run_id, status: r.status,
  draft: r.draft || "", final: r.final || "", note: r.note || "", createdAt: r.created_at, decidedAt: r.decided_at || null,
});

export function reviewMode(tenantId: string): ReviewMode {
  // AGENT_REVIEW_FORCE: tenant ids in approve mode regardless of settings (live tests only; never set
  // in production), so a test never changes a real business's setting.
  if ((process.env.AGENT_REVIEW_FORCE || "").split(",").includes(tenantId)) return "approve";
  return getTenant(tenantId)?.settings?.agentReview === "approve" ? "approve" : "auto";
}

export async function reviewForRun(projectId: string, runId: string): Promise<Review | null> {
  await ensureSchema();
  const r = (await d1Query("SELECT * FROM project_reviews WHERE project_id = ? AND run_id = ? ORDER BY created_at DESC LIMIT 1", [projectId, runId]))[0];
  return r ? row(r) : null;
}

export async function reviewsForProject(projectId: string): Promise<Review[]> {
  await ensureSchema();
  return (await d1Query("SELECT * FROM project_reviews WHERE project_id = ? ORDER BY created_at", [projectId])).map(row);
}

export interface TimelineEntry { at: string; who: "customer" | "assistant" | "owner" | "business"; kind: string; text: string }

/**
 * The project's history for the owner: the customer's messages and the assistant's replies, every
 * version the assistant prepared for review, and every decision and note of the owner - in order, so
 * the owner can always trace back what was asked, proposed, changed and sent.
 */
export async function timeline(projectId: string): Promise<TimelineEntry[]> {
  const { projectDetail } = await import("./store.js");
  const { readFile } = await import("./repo.js");
  const [d, reviews] = await Promise.all([projectDetail(projectId), reviewsForProject(projectId)]);
  const out: TimelineEntry[] = [];
  for (const e of d?.events || []) {
    if (e.kind !== "turn") continue;
    if (e.data.user) out.push({ at: e.at, who: "customer", kind: "message", text: String(e.data.user) });
    if (e.data.assistant) out.push({ at: e.at, who: "assistant", kind: "reply", text: String(e.data.assistant) });
  }
  // Exchanges with other businesses of the network (asked by the assistant, their answers).
  const { businessLabel } = await import("./network.js");
  for (const e of d?.events || []) {
    if (e.kind === "business_asked") out.push({ at: e.at, who: "assistant", kind: "business_asked", text: `Zapytanie do firmy ${businessLabel(String(e.data.to))}:\n\n${e.data.question}` });
    if (e.kind === "business_answered") out.push({ at: e.at, who: "business", kind: String(e.data.status), text: `${businessLabel(e.actor)}${e.data.status === "answered" ? "" : " (brak odpowiedzi w terminie)"}:\n\n${e.data.answer}` });
  }
  // A project started outside the chat has no turns: its request stands for the customer.
  if (!out.length && d) {
    const req = await readFile(projectId, "request.txt").catch(() => null);
    if (req) out.push({ at: d.project.createdAt, who: "customer", kind: "message", text: req });
  }
  reviews.forEach((r, k) => {
    out.push({ at: r.createdAt, who: "assistant", kind: "draft", text: `Wersja ${k + 1} do akceptacji:\n\n${r.draft || "(brak odpowiedzi)"}` });
    if (!r.decidedAt) return;
    const text = r.status === "changes_requested" ? `Prośba o zmiany:\n\n${r.note}`
      : r.status === "declined" ? `Własna odpowiedź wysłana klientowi:\n\n${r.final}`
      : r.final.trim() && r.final.trim() !== r.draft.trim() ? `Zaakceptowano z poprawkami i wysłano klientowi:\n\n${r.final}`
      : "Zaakceptowano i wysłano klientowi bez zmian.";
    out.push({ at: r.decidedAt, who: "owner", kind: r.status, text });
  });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export async function reviewByToken(token: string): Promise<Review | null> {
  if (!token || token.length > 100) return null;
  await ensureSchema();
  const r = (await d1Query("SELECT * FROM project_reviews WHERE token = ?", [token]))[0];
  if (!r) return null;
  const rv = row(r);
  return Date.now() - Date.parse(rv.createdAt) < REVIEW_TTL_DAYS * 86400_000 ? rv : null;
}

/** A result to review: recorded once per run, and the owner is told (email with the review link). */
export async function openReview(projectId: string, tenantId: string, runId: string, draft: string, files: string[]): Promise<Review> {
  await ensureSchema();
  const token = randomBytes(24).toString("base64url");
  const at = new Date().toISOString();
  const inserted = await d1Query("INSERT OR IGNORE INTO project_reviews (token, project_id, tenant_id, run_id, status, draft, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?) RETURNING token", [token, projectId, tenantId, runId, draft, at]);
  if (!inserted.length) return (await reviewForRun(projectId, runId))!; // another poll opened it
  await addEvent(projectId, { kind: "review_requested", actor: "system", data: { runId, files } });
  const t = getTenant(tenantId);
  const project = await getProject(projectId);
  // The email never blocks the review itself (the link also works from a later email or the log).
  if (t?.email) try {
    const { sendReviewEmail } = await import("../multi-tenant/email.js");
    const { readFile } = await import("./repo.js");
    const base = process.env.BASE_URL || "https://whisp.so";
    const request = ((await readFile(projectId, "request.txt").catch(() => null)) || String(project?.title || "")).slice(0, 600);
    const { businessQuestions } = await import("./conversation.js");
    const run = project?.memory.agentRun as any;
    const questions = run?.runId === runId ? await businessQuestions(projectId, run).catch(() => []) : [];
    await sendReviewEmail(t.email, t.settings?.siteCard?.brand || t.brandName || t.domain, { request, draft, files, questions, link: `${base}/review/${token}` });
  } catch (e) {
    console.warn(`[review] ${projectId}: owner not emailed (${(e as Error).message})`);
  }
  return { token, projectId, tenantId, runId, status: "pending", draft, final: "", note: "", createdAt: at, decidedAt: null };
}

export async function decide(token: string, status: Exclude<ReviewStatus, "pending">, fields: { final?: string; note?: string }): Promise<Review | null> {
  await ensureSchema();
  const rows = await d1Query("UPDATE project_reviews SET status = ?, final = ?, note = ?, decided_at = ? WHERE token = ? AND status = 'pending' RETURNING *",
    [status, (fields.final || "").slice(0, 20000), (fields.note || "").slice(0, 4000), new Date().toISOString(), token]);
  const r = rows[0] ? row(rows[0]) : null;
  if (r) await addEvent(r.projectId, { kind: "review_decided", actor: r.tenantId, data: { runId: r.runId, status, note: r.note.slice(0, 500), edited: status === "approved" && r.final.trim() !== r.draft.trim() } });
  return r;
}
