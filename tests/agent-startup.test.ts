import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Measures where the agent's startup time goes, from the customer's message to the agent's first step.
// Two runs: a cold one (containers asleep) and a warm one right after.
const live = process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET && process.env.CF_API_TOKEN && process.env.OPENROUTER_API_KEY ? describe : describe.skip;
const TENANT = "www_rentbud_pl";
const sessions: string[] = [];
let M: any, tm: any;

beforeAll(async () => {
  if (!process.env.PROJECT_AGENT_URL || !process.env.CF_API_TOKEN) return;
  const [store, repo, agent, cs, reg, tmm] = await Promise.all([import("../src/projects/store.js"), import("../src/projects/repo.js"), import("../src/projects/agent.js"), import("../src/storage/conversation-store.js"), import("../src/multi-tenant/d1-registry.js"), import("../src/multi-tenant/tenant-manager.js")]);
  M = { store, repo, agent, d1Query: cs.d1Query };
  await reg.hydrateRegistry();
  tm = new tmm.TenantManager();
}, 60_000);

afterAll(async () => {
  if (!M) return;
  const { deleteFromR2 } = await import("../src/storage/r2.js");
  for (const s of sessions) for (const r of await M.d1Query("SELECT id FROM projects WHERE customer_session = ?", [s])) {
    for (const f of await M.repo.listFiles(r.id)) await deleteFromR2(`projects/${r.id}/${f.path}`).catch(() => {});
    for (const t of ["project_events", "project_participants", "project_consents", "project_files", "project_requirements", "project_reviews", "customer_links"]) await M.d1Query(`DELETE FROM ${t} WHERE project_id = ?`, [r.id]);
    await M.d1Query("DELETE FROM projects WHERE id = ?", [r.id]);
  }
}, 120_000);

async function measure(label: string) {
  const session = `test-startup-${label}-${Date.now()}`;
  sessions.push(session);
  const chat = await tm.getChatForTenant(TENANT);
  const t0 = Date.now();
  const w = await chat.chat([{ role: "user", content: "Mam 500 zł i potrzebuję zagęszczarki na 2 dni. Która najcięższa (nie ubijak) zmieści się w budżecie? Porównaj wszystkie, które się mieszczą." }], session);
  const replyMs = Date.now() - t0;
  expect(w.project?.agent?.status).toBe("running");
  const pid = w.project!.id;
  let started: any = null, finished: any = null;
  for (let i = 0; i < 120 && !finished; i++) {
    await new Promise((ok) => setTimeout(ok, 5000));
    await M.agent.agentStatus(pid).catch(() => null);
    const ev = (await M.store.projectDetail(pid))!.events;
    started = ev.find((e: any) => e.kind === "agent_started") || started;
    finished = ev.find((e: any) => e.kind === "agent_finished");
  }
  const startedAt = started ? Date.parse(started.at) - t0 : -1;
  console.log(`[${label}] reply ${replyMs} ms | agent started +${startedAt} ms | ${JSON.stringify(started?.data.timing)} | runner first step ${finished?.data.timing?.firstStepMs} ms | finished +${finished ? Date.parse(finished.at) - t0 : -1} ms`);
  return { started, finished };
}

live("agent startup time", () => {
  it("cold and warm", async () => {
    await measure("cold");
    await measure("warm");
  }, 30 * 60_000);
});
