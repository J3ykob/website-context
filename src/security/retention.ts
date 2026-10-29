/**
 * Retention promised in the privacy policy (public/polityka-prywatnosci.html), run daily:
 * - chat messages older than CHAT_RETENTION_DAYS (365);
 * - projects (requests, their files, events, reviews, links) once expired AND without activity for
 *   30 days - a request still being worked on is never removed. At most 50 projects per run.
 */
import { d1Query } from "../storage/conversation-store.js";

export async function runRetention(): Promise<{ messages: number; projects: number }> {
  const days = Number(process.env.CHAT_RETENTION_DAYS) || 365;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const m = await d1Query("DELETE FROM chat_messages WHERE created_at < ? RETURNING id", [cutoff]).catch(() => [] as any[]);
  const now = new Date().toISOString(), idle = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const due = (await d1Query("SELECT id FROM projects WHERE expires_at IS NOT NULL AND expires_at < ? AND updated_at < ? LIMIT 50", [now, idle]).catch(() => [] as any[])).map((r: any) => String(r.id));
  const { listFiles } = await import("../projects/repo.js");
  const { deleteFromR2 } = await import("../storage/r2.js");
  for (const id of due) {
    for (const f of await listFiles(id).catch(() => [])) await deleteFromR2(`projects/${id}/${f.path}`).catch(() => {});
    for (const t of ["project_events", "project_participants", "project_consents", "project_files", "project_requirements", "project_reviews", "customer_links", "network_invites"]) await d1Query(`DELETE FROM ${t} WHERE project_id = ?`, [id]).catch(() => {});
    await d1Query("DELETE FROM projects WHERE id = ?", [id]).catch(() => {});
  }
  if (m.length || due.length) console.log(`[retention] removed ${m.length} chat messages older than ${days} days, ${due.length} expired projects`);
  return { messages: m.length, projects: due.length };
}
