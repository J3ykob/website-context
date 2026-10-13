import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Live: a customer asks for work, leaves an email (with consent) and leaves - nothing polls the chat.
// The result must still be delivered on the server: logged in the conversation and emailed.
const live = process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET && process.env.JEV_API_KEY && process.env.CF_API_TOKEN && process.env.OPENROUTER_API_KEY ? describe : describe.skip;
const TENANT = "www_rentbud_pl";
const session = `test-notify-${Date.now()}`;
const EMAIL = process.env.NOTIFY_TEST_EMAIL || "kubalol7982@gmail.com";
let M: any, tm: any;

beforeAll(async () => {
  if (!process.env.PROJECT_AGENT_URL || !process.env.CF_API_TOKEN) return;
  const [store, repo, conv, cs, reg, tmm] = await Promise.all([import("../src/projects/store.js"), import("../src/projects/repo.js"), import("../src/projects/conversation.js"), import("../src/storage/conversation-store.js"), import("../src/multi-tenant/d1-registry.js"), import("../src/multi-tenant/tenant-manager.js")]);
  M = { store, repo, conv, d1Query: cs.d1Query };
  await reg.hydrateRegistry();
  tm = new tmm.TenantManager();
}, 60_000);

afterAll(async () => {
  if (process.env.KEEP_PROJECTS || !M) return;
  const { deleteFromR2 } = await import("../src/storage/r2.js");
  for (const r of await M.d1Query("SELECT id FROM projects WHERE customer_session = ?", [session])) {
    for (const f of await M.repo.listFiles(r.id)) await deleteFromR2(`projects/${r.id}/${f.path}`).catch(() => {});
    for (const t of ["project_events", "project_participants", "project_consents", "project_files", "project_requirements", "project_reviews"]) await M.d1Query(`DELETE FROM ${t} WHERE project_id = ?`, [r.id]);
    await M.d1Query("DELETE FROM projects WHERE id = ?", [r.id]);
  }
  await M.d1Query("DELETE FROM chat_messages WHERE session_id = ?", [session]);
}, 120_000);

live("the customer gets the result after leaving the page", () => {
  it("email with consent -> result delivered and emailed with nobody polling", async () => {
    const chat = await tm.getChatForTenant(TENANT);
    const w = await chat.chat([{ role: "user", content: "Mam 500 zł i potrzebuję zagęszczarki na 2 dni. Która najcięższa (nie ubijak) zmieści się w budżecie? Porównaj wszystkie, które się mieszczą." }], session);
    expect(w.project?.agent?.status).toBe("running");
    expect(w.project?.notify?.consent).toContain("Rentbud");
    const pid = w.project!.id;
    await M.conv.setCustomerContact(pid, TENANT, EMAIL, "pl", w.project!.notify!.consent);
    // Nobody polls from here: the server must finish and deliver on its own.
    const end = Date.now() + 20 * 60_000;
    let ev: any = null;
    while (!ev && Date.now() < end) {
      await new Promise((ok) => setTimeout(ok, 15_000));
      ev = (await M.store.projectDetail(pid))!.events.find((e: any) => e.kind === "result_emailed");
    }
    const d = await M.store.projectDetail(pid);
    console.log(`[events] ${d.events.map((e: any) => e.kind).join(", ")}`);
    console.log(`[consents] ${JSON.stringify(d.consents)}`);
    expect(ev).toBeTruthy();
    expect(d.consents.length).toBe(1);
    expect(ev.data.sent).toBe(!!process.env.RESEND_API_KEY);
    const logged = await M.d1Query("SELECT content FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", [session]);
    console.log(`[logged] ${logged[0]?.content}`);
    expect(String(logged[0]?.content || "")).toContain("280");
  }, 25 * 60_000);
});
