import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChatMessage } from "../src/llm/chat.js";
import type { TenantManager } from "../src/multi-tenant/tenant-manager.js";

// Live, one case: a demo nobody has claimed (no password, no subscription) gets its calculation without
// anyone approving it. bostabeton-2 from the judged eval (evals/judged/cases/cases-concrete.json): in
// iteration 4 its third turn started the agent and the result stayed "being approved" for an owner who
// does not exist. Now it arrives (or "could not prepare"), no review waits for anyone, nobody is e-mailed.
// Nothing leaves this process by e-mail, SMS, WhatsApp or Telegram: their keys are removed before any
// module loads (email.ts reads its key on import; every caller imports it lazily and catches the failure).
// The live-test review knobs go too: a forced tenant would hold its result. Run before the deploy, once Q1
// shows the tenant still unclaimed. About $0.03 (OpenRouter + Jev).
for (const k of ["RESEND_API_KEY", "REVIEW_EMAIL_APPROVED", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "TWILIO_WHATSAPP_FROM", "TELEGRAM_BOT_TOKEN", "AGENT_REVIEW_FORCE", "AGENT_OWNER_FORCE"]) delete process.env[k];

const live = process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET && process.env.JEV_API_KEY && process.env.CF_API_TOKEN && process.env.OPENROUTER_API_KEY ? describe : describe.skip;
const TENANT = "bostabeton_pl";
const TURNS = [
  "Hi! we're renovating an old pre-war flat in Mokotow, new floors with underfloor heating. what screed do you have for that and how thin can it go? the old ceiling cant take much weight",
  "and can the same stuff go in the bathroom with a walk-in shower?",
  "ok, rough price? its about 60m2",
];
const session = `test-demo-${Date.now()}`;
let tm: TenantManager;
let M: any;

beforeAll(async () => {
  if (!process.env.PROJECT_AGENT_URL || !process.env.CF_API_TOKEN) return;
  const [store, repo, conv, review, cs, reg, tmm, net, jev] = await Promise.all([import("../src/projects/store.js"), import("../src/projects/repo.js"), import("../src/projects/conversation.js"), import("../src/projects/review.js"), import("../src/storage/conversation-store.js"), import("../src/multi-tenant/d1-registry.js"), import("../src/multi-tenant/tenant-manager.js"), import("../src/projects/network.js"), import("../src/llm/jev.js")]);
  M = { store, repo, conv, review, reg, net, jevAsk: jev.jevAsk, d1Query: cs.d1Query };
  await reg.hydrateRegistry();
  tm = new tmm.TenantManager();
}, 60_000);

// Everything the case made: the conversation's project, the requests it sent to other businesses, their
// reviews and invites, the chat log - so the sweep of the code still on Render finds nothing.
afterAll(async () => {
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

live("a demo nobody has claimed", () => {
  it("gets its calculation without anyone approving it, and nobody is e-mailed", async () => {
    // The case only means something on an unclaimed demo; a member with an owner could hold its part.
    expect(M.reg.hasOwnerAccount(TENANT), `${TENANT} has an owner account - pick another unclaimed demo`).toBe(false);
    expect(M.review.reviewMode(TENANT)).toBe("auto"); // the start notice gets calcStarted, not calcReviewed
    const owned = (await M.net.networkMembers(TENANT)).filter((m: any) => m.tenantId !== TENANT && M.reg.hasOwnerAccount(m.tenantId)).map((m: any) => m.tenantId);
    expect(owned, "network members with an owner could hold their part for review").toEqual([]);

    const chat = await tm.getChatForTenant(TENANT);
    const history: ChatMessage[] = [];
    const runs: string[] = [];
    for (const [k, text] of TURNS.entries()) {
      history.push({ role: "user", content: text });
      const r = await chat.chat(history, session);
      history.push({ role: "assistant", content: r.message });
      console.log(`[T${k + 1}] ${JSON.stringify({ project: r.project?.id, agent: r.project?.agent?.status })}\n${r.message}`);
      if (k === TURNS.length - 1) {
        expect(r.project?.agent?.status, `T3 did not start the agent: ${r.message}`).toBe("running");
        // Text -> structure by Jev: the notice must not tell the customer that the business checks it first.
        const a: any = await M.jevAsk({ notice: r.message }, { checks: { type: "noul", instructions: "`notice` is a chat message to a customer whose calculation has just been started. Does it say or imply that the business will check or approve the result before the customer gets it?" } }, 8000);
        console.log(`[T3 notice] P(the business checks it first) = ${a?.checks?.noul}`);
        expect(a?.checks?.noul).toBeLessThan(0.5);
      }
      if (r.project?.agent?.status !== "running") continue;
      // The run this turn started is delivered (or fails) - never held for an owner.
      const pid = r.project.id;
      const statuses: string[] = [];
      const t0 = Date.now();
      let d: any;
      for (const end = Date.now() + 15 * 60_000; ;) {
        d = await M.conv.agentDelivery(pid, async () => {});
        statuses.push(d.status);
        const runId = (await M.store.getProject(pid))?.memory.agentRun?.runId;
        if ((d.status === "done" || d.status === "failed") && runId && !runs.includes(runId)) break;
        expect(d.status, "held for an owner who does not exist").not.toBe("review");
        if (Date.now() > end) throw new Error(`no result in 15 min: ${statuses.slice(-5).join(", ")}`);
        await new Promise((ok) => setTimeout(ok, 10_000));
      }
      const p = (await M.store.projectDetail(pid))!;
      const run = p.project.memory.agentRun;
      runs.push(run.runId);
      console.log(`[T${k + 1} result] ${d.status} after ${Math.round((Date.now() - t0) / 1000)} s (run ${run.status}, needsOwner ${run.needsOwner})\n${d.message}\nfiles: ${JSON.stringify(d.files)}`);
      expect(await M.review.reviewForRun(pid, run.runId)).toBeNull();
      // Delivered once into the conversation (by the server or this poll, whichever came first). When the
      // server's own delivery took it, its event follows the claim by a few writes: read again briefly.
      expect(p.project.memory.delivered).toBe(run.runId);
      const deliveredOf = (events: any[]) => events.filter((e: any) => e.kind === "delivered" && e.data.runId === run.runId);
      let events = p.events;
      for (let i = 0; i < 10 && !deliveredOf(events).length; i++) {
        await new Promise((ok) => setTimeout(ok, 3000));
        events = (await M.store.projectDetail(pid))!.events;
      }
      expect(deliveredOf(events).length).toBe(1);
      expect(p.project.memory.reviewNotified).toBeUndefined(); // REVIEWING never sent
      expect(p.project.memory.reviewLate).toBeUndefined(); // REVIEW_LATE never sent
      // Nothing waited for an owner: neither the project nor a member it asked opened a review or asked an
      // owner for a price. A business that has not joined (listed) still gets its invite page - a review row
      // opened without an e-mail (invite.ts) - and, with the e-mail key removed above, no invite e-mail.
      for (const id of [pid, ...((p.project.memory.subRequests || []) as any[]).map((s) => s.id)]) {
        const log = (await M.store.projectDetail(id))?.events || [];
        console.log(`[events ${id}] ${log.map((e: any) => e.kind).join(", ")}`);
        expect(log.filter((e: any) => ["review_late", "owner_quote_asked"].includes(e.kind))).toEqual([]);
        const reviews = await M.review.reviewsForProject(id);
        if (!(await M.store.getProject(id))?.memory.listed) {
          expect(log.filter((e: any) => e.kind === "review_requested")).toEqual([]);
          expect(reviews).toEqual([]);
          continue;
        }
        const invites = await M.d1Query("SELECT token, emailed FROM network_invites WHERE project_id = ?", [id]).catch(() => []);
        for (const rv of reviews) expect(invites.some((x: any) => x.token === rv.token), `listed ${id}: review ${rv.token} is not its invite`).toBe(true);
        expect(invites.filter((x: any) => Number(x.emailed) !== 0)).toEqual([]);
      }
    }
    expect(runs.length).toBeGreaterThan(0);
  }, 40 * 60_000);
});
