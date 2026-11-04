// Removes eval / probe data (customer sessions "reval-%"): projects (and their sub-projects), their files in R2, events,
// reviews, links, and the chat log rows. Usage: tsx cleanup-reval.mts [--dry]
const dry = process.argv.includes("--dry");
const { d1Query } = await import("../../src/storage/conversation-store.ts");
const { deleteFromR2 } = await import("../../src/storage/r2.ts");
const repo = await import("../../src/projects/repo.ts");
const ids: string[] = (await d1Query("SELECT id FROM projects WHERE customer_session LIKE 'reval-%'", [])).map((r: any) => r.id);
for (const id of [...ids]) for (const r of await d1Query("SELECT id FROM projects WHERE customer_session = ?", [`project:${id}`])) ids.push(r.id);
console.log(`${ids.length} projects${dry ? " (dry run)" : ""}`);
let files = 0, n = 0;
for (const id of ids) {
  const fl = await repo.listFiles(id).catch(() => []);
  files += fl.length;
  if (!dry) {
    for (const f of fl) await deleteFromR2(`projects/${id}/${f.path}`).catch(() => {});
    for (const t of ["project_events", "project_participants", "project_consents", "project_files", "project_requirements", "project_reviews", "customer_links", "network_invites"]) await d1Query(`DELETE FROM ${t} WHERE project_id = ?`, [id]).catch(() => {});
    await d1Query("DELETE FROM projects WHERE id = ?", [id]);
  }
  if (++n % 50 === 0) console.log(`${n}/${ids.length}`);
}
const msgs = (await d1Query("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id LIKE 'reval-%'", []))[0]?.n;
if (!dry) await d1Query("DELETE FROM chat_messages WHERE session_id LIKE 'reval-%'", []);
console.log(`files ${files}, chat rows ${msgs}${dry ? " (not deleted)" : " deleted"}`);
process.exit(0);
