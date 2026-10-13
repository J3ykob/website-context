import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChatMessage } from "../src/llm/chat.js";
import type { TenantManager } from "../src/multi-tenant/tenant-manager.js";

// Live: a customer of Rentbud (network "warszawa-budowlanka") asks for a project that spans several
// businesses. The agent prices what the offers settle, asks the other businesses for the rest; each
// answers inside its own project under its own settings:
//   OSTAP (scaffolding, no prices in its offer)  - approves first: the test acts as its owner and answers;
//   BUDOMAT ŁAZY (concrete)                      - sends automatically: its agent answers from its site;
//   Perfekt Dach (roofing)                       - approves first, owner never answers: deadline -> to be quoted.
// The customer gets one final result; no customer personal data reaches the other businesses.
const live = process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET && process.env.JEV_API_KEY && process.env.CF_API_TOKEN && process.env.OPENROUTER_API_KEY ? describe : describe.skip;
const TENANT = "www_rentbud_pl";
const OSTAP = "www_ostap_pl", ROOF = "www_dachywarszawa_pl", CONCRETE = "beton_lazy_pl";
const session = `test-net-${Date.now()}`;
let tm: TenantManager;
let M: any;

beforeAll(async () => {
  if (!process.env.PROJECT_AGENT_URL || !process.env.CF_API_TOKEN) return;
  const [store, repo, conv, review, cs, reg, tmm, agent] = await Promise.all([import("../src/projects/store.js"), import("../src/projects/repo.js"), import("../src/projects/conversation.js"), import("../src/projects/review.js"), import("../src/storage/conversation-store.js"), import("../src/multi-tenant/d1-registry.js"), import("../src/multi-tenant/tenant-manager.js"), import("../src/projects/agent.js")]);
  M = { store, repo, conv, review, d1Query: cs.d1Query, numbersIn: agent.numbersIn };
  await reg.hydrateRegistry();
  tm = new tmm.TenantManager();
  process.env.AGENT_REVIEW_FORCE = `${OSTAP},${ROOF}`; // this process only, never the businesses' settings
  process.env.NETWORK_ANSWER_DEADLINE_MS = String(6 * 60_000);
}, 60_000);

afterAll(async () => {
  delete process.env.AGENT_REVIEW_FORCE;
  if (process.env.KEEP_PROJECTS || !M) return;
  const { deleteFromR2 } = await import("../src/storage/r2.js");
  const ids = (await M.d1Query("SELECT id FROM projects WHERE customer_session = ?", [session])).map((r: any) => r.id);
  for (const id of [...ids]) for (const r of await M.d1Query("SELECT id FROM projects WHERE customer_session = ?", [`project:${id}`])) ids.push(r.id);
  for (const id of ids) {
    for (const f of await M.repo.listFiles(id).catch(() => [])) await deleteFromR2(`projects/${id}/${f.path}`).catch(() => {});
    for (const t of ["project_events", "project_participants", "project_consents", "project_files", "project_requirements", "project_reviews"]) await M.d1Query(`DELETE FROM ${t} WHERE project_id = ?`, [id]);
    await M.d1Query("DELETE FROM projects WHERE id = ?", [id]);
  }
}, 180_000);

const REQUEST = "Dzień dobry, nazywam się Tomasz Wiśniewski, tel. 604 555 321. Remontuję dom jednorodzinny (budynek 8 m wysokości). Potrzebuję: (1) wymiany pokrycia dachu na blachodachówkę, ok. 120 m2 dachu; (2) rusztowania elewacyjnego wokół domu, ok. 150 m2, na 3 tygodnie razem z montażem i demontażem; (3) zsypu na gruz na całą wysokość budynku na 3 tygodnie; (4) betonu na wylewkę pod taras, 3 m3 z dowozem. Przygotuj mi zestawienie kosztów całości.";

live("a project across businesses of one network", () => {
  it("asks the other businesses, each answers under its own settings, the customer gets one result", async () => {
    const chat = await tm.getChatForTenant(TENANT);
    const w = await chat.chat([{ role: "user", content: REQUEST } as ChatMessage], session);
    expect(w.project?.agent?.status).toBe("running");
    const pid = w.project!.id;
    const delivered: string[] = [];
    let ostapAnswered = false;
    const end = Date.now() + 40 * 60_000;
    let d: any;
    for (;;) {
      d = await M.conv.agentDelivery(pid, async (m: string) => { delivered.push(m); });
      if (d.status === "done" || d.status === "failed") break;
      // Act as OSTAP's owner once its review is open (the roofing owner never answers).
      const subs = ((await M.store.getProject(pid))?.memory.subRequests || []) as any[];
      const ostap = subs.find((s) => s.tenantId === OSTAP);
      if (ostap && !ostapAnswered) {
        const run = (await M.store.getProject(ostap.id))?.memory.agentRun;
        const rv = run ? await M.review.reviewForRun(ostap.id, run.runId) : null;
        if (rv?.status === "pending") {
          console.log(`[ostap request]\n${await M.repo.readFile(ostap.id, "request.txt")}\n[ostap draft]\n${rv.draft}`);
          await M.review.decide(rv.token, "approved", { final: "Rusztowanie elewacyjne (system Plettac): 12 zł za m2 za tydzień. Montaż i demontaż: 15 zł za m2 (jednorazowo). Termin montażu do uzgodnienia." });
          const { settle } = await import("../src/projects/network.js"); // what POST /api/review does after approval
          await settle(ostap.id, "Rusztowanie elewacyjne (system Plettac): 12 zł za m2 za tydzień. Montaż i demontaż: 15 zł za m2 (jednorazowo). Termin montażu do uzgodnienia.", "answered");
          ostapAnswered = true;
        }
      }
      // Rentbud's owner (the business the customer talks to) approves when its review opens: it reviews
      // because the agent had a question for it, or because a business answered through its owner.
      const prun = (await M.store.getProject(pid))?.memory.agentRun;
      const prv = prun && d.status === "review" ? await M.review.reviewForRun(pid, prun.runId) : null;
      if (prv?.status === "pending") await M.review.decide(prv.token, "approved", {});
      if (Date.now() > end) throw new Error("no result");
      await new Promise((ok) => setTimeout(ok, 15_000));
    }
    const p = (await M.store.projectDetail(pid))!;
    const subs = (p.project.memory.subRequests || []) as any[];
    console.log(`[subs] ${JSON.stringify(subs.map((s) => ({ t: s.tenantId, status: s.status, q: s.question })), null, 1)}`);
    console.log(`[final] ${d.status}\n${d.message}\nfiles: ${JSON.stringify(d.files)}`);
    for (const e of p.events.filter((x: any) => x.kind.startsWith("business"))) console.log(`[event] ${e.kind} ${JSON.stringify(e.data).slice(0, 400)}`);

    expect(d.status).toBe("done");
    expect(subs.some((s) => s.tenantId === OSTAP && s.status === "answered")).toBe(true);
    // The scaffolding price came from OSTAP's owner: 150 m2 x 12 zł x 3 weeks + 150 x 15 = 7650 zł.
    expect(M.numbersIn(d.message).some((n: number) => Math.abs(n - 7650) < 0.5)).toBe(true);
    // No customer personal data went to any business.
    for (const s of subs) {
      const req = (await M.repo.readFile(s.id, "request.txt")) || "";
      expect(req).not.toContain("Wiśniewski");
      expect(req).not.toContain("604 555 321");
    }
    // The customer only got the "working" message and the final result - nothing from the businesses' side.
    expect(delivered[delivered.length - 1]).toBe(d.message);
  }, 45 * 60_000);
});
