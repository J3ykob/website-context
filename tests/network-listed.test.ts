import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChatMessage } from "../src/llm/chat.js";
import type { TenantManager } from "../src/multi-tenant/tenant-manager.js";

// Live: a business that has not joined the network (OSTAP, treated as listed for this process only).
// A Rentbud customer asks for something partly OSTAP's: the agent asks OSTAP, OSTAP's part is answered
// from its public data at once (no owner to wait for) and marked as not confirmed; the customer gets the
// result; then OSTAP is invited (the invite with its full text is recorded; no email is sent without the
// email key) and, acting as OSTAP on its link, confirms with a correction - which lands in Rentbud's project.
const live = process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET && process.env.JEV_API_KEY && process.env.CF_API_TOKEN && process.env.OPENROUTER_API_KEY ? describe : describe.skip;
const TENANT = "www_rentbud_pl";
const OSTAP = "www_ostap_pl";
const session = `test-listed-${Date.now()}`;
let tm: TenantManager;
let M: any;

beforeAll(async () => {
  if (!process.env.PROJECT_AGENT_URL || !process.env.CF_API_TOKEN) return;
  const [store, repo, conv, review, cs, reg, tmm] = await Promise.all([import("../src/projects/store.js"), import("../src/projects/repo.js"), import("../src/projects/conversation.js"), import("../src/projects/review.js"), import("../src/storage/conversation-store.js"), import("../src/multi-tenant/d1-registry.js"), import("../src/multi-tenant/tenant-manager.js")]);
  M = { store, repo, conv, review, d1Query: cs.d1Query };
  await reg.hydrateRegistry();
  tm = new tmm.TenantManager();
  process.env.NETWORK_LISTED_FORCE = OSTAP; // this process only, never the business's settings
  process.env.NETWORK_ANSWER_DEADLINE_MS = String(10 * 60_000); // a member asked too, whose owner never answers
}, 60_000);

afterAll(async () => {
  delete process.env.NETWORK_LISTED_FORCE;
  if (process.env.KEEP_PROJECTS || !M) return;
  const { deleteFromR2 } = await import("../src/storage/r2.js");
  const ids = (await M.d1Query("SELECT id FROM projects WHERE customer_session = ?", [session])).map((r: any) => r.id);
  for (const id of [...ids]) for (const r of await M.d1Query("SELECT id FROM projects WHERE customer_session = ?", [`project:${id}`])) ids.push(r.id);
  for (const id of ids) {
    for (const f of await M.repo.listFiles(id).catch(() => [])) await deleteFromR2(`projects/${id}/${f.path}`).catch(() => {});
    for (const t of ["project_events", "project_participants", "project_consents", "project_files", "project_requirements", "project_reviews", "customer_links", "network_invites"]) await M.d1Query(`DELETE FROM ${t} WHERE project_id = ?`, [id]).catch(() => {});
    await M.d1Query("DELETE FROM projects WHERE id = ?", [id]);
  }
  await M.d1Query("DELETE FROM chat_messages WHERE session_id = ?", [session]).catch(() => {});
}, 180_000);

live("a business that has not joined the network", () => {
  it("is answered from its public data, the customer does not wait, then it is invited and confirms", async () => {
    const chat = await tm.getChatForTenant(TENANT);
    const w = await chat.chat([{ role: "user", content: "Dzień dobry, potrzebuję rusztowania fasadowego na dom (ok. 120 m2) na 2 tygodnie z montażem, i do tego zagęszczarki 130 kg na 2 doby. Ile to wszystko kosztuje?" } as ChatMessage], session);
    expect(w.project?.agent?.status).toBe("running");
    const pid = w.project!.id;
    let d: any;
    for (const end = Date.now() + 45 * 60_000; ;) {
      d = await M.conv.agentDelivery(pid, async () => {});
      if (d.status === "done" || d.status === "failed") break;
      const run = (await M.store.getProject(pid))?.memory.agentRun;
      const rv = run && d.status === "review" ? await M.review.reviewForRun(pid, run.runId) : null;
      if (rv?.status === "pending") await M.review.decide(rv.token, "approved", {}); // Rentbud's owner (approve mode)
      if (Date.now() > end) throw new Error("no result");
      await new Promise((ok) => setTimeout(ok, 15_000));
    }
    const p = (await M.store.getProject(pid))!;
    const subs = (p.memory.subRequests || []) as any[];
    const ostap = subs.find((s) => s.tenantId === OSTAP);
    console.log(`[final] ${d.status}\n${d.message}\n[subs] ${JSON.stringify(subs)}`);
    expect(d.status).toBe("done");
    expect(ostap?.status).toBe("answered");
    // OSTAP's part came from its public data, said so in the answer it gave back.
    const back = (await M.repo.listFiles(pid)).filter((f: any) => f.path.startsWith("odpowiedzi_firm/"));
    const answer = await M.repo.readFile(pid, back[0].path);
    expect(answer).toContain("nie dołączyła do sieci");
    // The invite: recorded with its full text and the link; the link opens in "listed" mode.
    for (let k = 0; k < 20; k++) { if ((await M.store.projectDetail(ostap.id))?.events.some((e: any) => e.kind === "business_invited")) break; await new Promise((ok) => setTimeout(ok, 3000)); }
    const inv = (await M.store.projectDetail(ostap.id))!.events.find((e: any) => e.kind === "business_invited");
    console.log(`[invite] ${JSON.stringify(inv?.data)}`);
    expect(inv?.data.text).toContain("Rentbud");
    expect(inv?.data.text).toContain("/review/");
    const token = String(inv!.data.link).split("/review/")[1];
    const rv = await M.review.reviewByToken(token);
    expect(rv?.status).toBe("pending");
    // Acting as OSTAP: confirm with a correction (what POST /api/review does for a business request).
    const correction = "Rusztowanie fasadowe: 10 zł za m2 za tydzień, montaż i demontaż 14 zł za m2.";
    await M.review.decide(token, "approved", { final: correction });
    const { settle } = await import("../src/projects/network.js");
    await settle(ostap.id, correction, "answered");
    const after = await M.store.projectDetail(pid);
    expect(after.events.some((e: any) => e.kind === "business_confirmed" && String(e.data.answer).includes("10 zł"))).toBe(true);
  }, 60 * 60_000);
});
