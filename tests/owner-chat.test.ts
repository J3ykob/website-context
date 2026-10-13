import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Live: a planned agent run (spec -> sandbox -> verification against the spec), the owner's review, and
// the owner's chat: a question (read-only), an edit of the text, and a change that amends the spec and
// sends the work back to the agent.
const live = process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET && process.env.JEV_API_KEY && process.env.CF_API_TOKEN && process.env.OPENROUTER_API_KEY ? describe : describe.skip;
const TENANT = "www_rentbud_pl";
const session = `test-chat-${Date.now()}`;
let M: any;

beforeAll(async () => {
  if (!process.env.PROJECT_AGENT_URL || !process.env.CF_API_TOKEN) return;
  const [store, repo, plan, review, chat, conv, agent, cs, reg] = await Promise.all([import("../src/projects/store.js"), import("../src/projects/repo.js"), import("../src/projects/plan.js"), import("../src/projects/review.js"), import("../src/projects/owner-chat.js"), import("../src/projects/conversation.js"), import("../src/projects/agent.js"), import("../src/storage/conversation-store.js"), import("../src/multi-tenant/d1-registry.js")]);
  M = { store, repo, plan, review, chat, conv, agent, d1Query: cs.d1Query };
  await reg.hydrateRegistry();
  process.env.AGENT_REVIEW_FORCE = TENANT;
}, 60_000);

afterAll(async () => {
  delete process.env.AGENT_REVIEW_FORCE;
  if (process.env.KEEP_PROJECTS || !M) return;
  const { deleteFromR2 } = await import("../src/storage/r2.js");
  for (const r of await M.d1Query("SELECT id FROM projects WHERE customer_session = ?", [session])) {
    for (const f of await M.repo.listFiles(r.id)) await deleteFromR2(`projects/${r.id}/${f.path}`).catch(() => {});
    for (const t of ["project_events", "project_participants", "project_consents", "project_files", "project_requirements", "project_reviews"]) await M.d1Query(`DELETE FROM ${t} WHERE project_id = ?`, [r.id]);
    await M.d1Query("DELETE FROM projects WHERE id = ?", [r.id]);
  }
}, 120_000);

async function pendingReview(pid: string, notRun?: string) {
  const end = Date.now() + 15 * 60_000;
  for (;;) {
    const s = await M.agent.agentStatus(pid);
    if (s && (s.status === "done" || s.status === "failed") && s.runId !== notRun) {
      const rv = await M.review.reviewForRun(pid, s.runId);
      if (rv) return { rv, run: s };
    }
    if (Date.now() > end) throw new Error("no review");
    await new Promise((ok) => setTimeout(ok, 10_000));
  }
}

live("planned work and the owner's chat", () => {
  it("spec -> run -> review -> chat: question, edit, change (spec v2) -> rework", async () => {
    const p = await M.store.createProject("conversation@1", { customerSession: session, initiatorTenantId: TENANT, title: "chat test" });
    const req = "Robię podjazd z kostki, ok. 60 m2, podbudowę będę zagęszczał przez 2 dni. Dobierz mi odpowiednią zagęszczarkę i policz koszt, pokaż też tańszą alternatywę.";
    await M.conv.startConversationAgent(p.id, [{ role: "user", content: req }], []);
    const spec1 = (await M.store.getProject(p.id)).memory.plan;
    console.log(`[spec v1] ${JSON.stringify(spec1)}`);
    expect(spec1?.version).toBeGreaterThanOrEqual(1);
    expect(spec1.outputs.some((o: any) => o.path === "odpowiedz.txt")).toBe(true);
    const { rv, run } = await pendingReview(p.id);
    const reqs = await M.repo.listRequirements(p.id);
    console.log(`[draft]\n${rv.draft}\n[checks] ${reqs.map((q: any) => `${q.id}:${q.status}`).join(" ")}`);
    expect(reqs.filter((q: any) => q.id.startsWith("spec-")).length).toBe(spec1.acceptance.length);

    const q = await M.chat.ownerChat(rv, "Skąd jest cena w tej odpowiedzi i jak ją policzono?");
    console.log(`[chat 1] tools=${q.tools} tokens=${JSON.stringify(q.tokens)}\n${q.reply}`);
    expect(q.rework).toBeFalsy();
    expect(q.draft).toBeUndefined();

    const e = await M.chat.ownerChat(rv, "Dopisz na końcu tekstu dla klienta zdanie: Zapraszamy do odbioru w naszej wypożyczalni.");
    console.log(`[chat 2] tools=${e.tools} tokens=${JSON.stringify(e.tokens)}\n${e.reply}`);
    expect(e.draft).toContain("Zapraszamy do odbioru");

    const c = await M.chat.ownerChat(rv, "Dolicz transport w obie strony: 150 zł.");
    console.log(`[chat 3] tools=${c.tools} tokens=${JSON.stringify(c.tokens)}\n${c.reply}`);
    expect(c.rework).toBe(true);
    // Re-planning runs in the background: wait for the version that carries the owner's change.
    const before = (await M.store.getProject(p.id)).memory.plan.version;
    let spec2: any = null;
    for (let i = 0; i < 30 && !spec2; i++) {
      await new Promise((ok) => setTimeout(ok, 5_000));
      const s2 = (await M.store.getProject(p.id)).memory.plan;
      if (s2.version > before || (s2.basis || "").includes("150")) spec2 = s2;
    }
    console.log(`[spec after change] ${JSON.stringify(spec2)}`);
    expect(spec2?.basis || "").toContain("150");
    const second = await pendingReview(p.id, run.runId);
    console.log(`[draft 2]\n${second.rv.draft}`);
    expect(second.rv.draft).toContain("150");
    const tl = await M.review.timeline(p.id);
    expect(tl.filter((x: any) => x.kind === "chat" && x.who === "owner").length).toBe(3);
  }, 40 * 60_000);
});
