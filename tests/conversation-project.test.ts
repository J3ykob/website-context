import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChatMessage } from "../src/llm/chat.js";
import type { TenantManager } from "../src/multi-tenant/tenant-manager.js";

// Modules that need prod credentials at import time are loaded only for a live run.
let M: {
  findOpenProject: typeof import("../src/projects/store.js").findOpenProject;
  projectDetail: typeof import("../src/projects/store.js").projectDetail;
  listFiles: typeof import("../src/projects/repo.js").listFiles;
  agentDelivery: typeof import("../src/projects/conversation.js").agentDelivery;
  CONVERSATION: string;
  numbersIn: typeof import("../src/projects/agent.js").numbersIn;
  d1Query: typeof import("../src/storage/conversation-store.js").d1Query;
};

// Live, end to end through the tenant's real chat (Rentbud): every conversation is a project; the
// system routes each turn - knowledge, the fast estimate, or the project agent (sandbox) for work on
// data - and the agent's reply arrives in the same conversation. Standard languages: PL, EN, UK, FR.
const live = process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET && process.env.JEV_API_KEY && process.env.CF_API_TOKEN && process.env.OPENROUTER_API_KEY ? describe : describe.skip;
const TENANT = "www_rentbud_pl";
const run = `t${Date.now()}`;
const sessions: string[] = [];
let tm: TenantManager;

beforeAll(async () => {
  if (!process.env.PROJECT_AGENT_URL || !process.env.CF_API_TOKEN) return;
  const [store, repo, conv, agent, cs, reg, tmm] = await Promise.all([import("../src/projects/store.js"), import("../src/projects/repo.js"), import("../src/projects/conversation.js"), import("../src/projects/agent.js"), import("../src/storage/conversation-store.js"), import("../src/multi-tenant/d1-registry.js"), import("../src/multi-tenant/tenant-manager.js")]);
  M = { findOpenProject: store.findOpenProject, projectDetail: store.projectDetail, listFiles: repo.listFiles, agentDelivery: conv.agentDelivery, CONVERSATION: conv.CONVERSATION, numbersIn: agent.numbersIn, d1Query: cs.d1Query };
  await reg.hydrateRegistry();
  tm = new tmm.TenantManager();
}, 60_000);
afterAll(async () => {
  if (process.env.KEEP_PROJECTS || !M) return;
  const { d1Query, listFiles } = M;
  const { deleteFromR2 } = await import("../src/storage/r2.js");
  for (const s of sessions) {
    for (const p of await d1Query("SELECT id FROM projects WHERE customer_session = ?", [s])) {
      for (const f of await listFiles(p.id).catch(() => [])) await deleteFromR2(`projects/${p.id}/${f.path}`).catch(() => {});
      for (const t of ["project_events", "project_participants", "project_consents", "project_files", "project_requirements", "project_reviews", "customer_links"]) await d1Query(`DELETE FROM ${t} WHERE project_id = ?`, [p.id]);
      await d1Query("DELETE FROM projects WHERE id = ?", [p.id]);
    }
  }
}, 120_000);

async function turn(session: string, history: ChatMessage[], text: string) {
  const chat = await tm.getChatForTenant(TENANT);
  history.push({ role: "user", content: text });
  const r = await chat.chat(history, session);
  history.push({ role: "assistant", content: r.message });
  return r;
}

// afterRun: the previous run - a later question waits for a run after it (the old one stays "done" until
// the next run is recorded as started).
async function waitDelivery(projectId: string, afterRun?: string) {
  const end = Date.now() + 15 * 60 * 1000;
  for (;;) {
    const d = await M.agentDelivery(projectId, async () => {});
    const runId = ((await M.projectDetail(projectId))?.project.memory.agentRun as any)?.runId;
    if (d.status !== "running" && (afterRun === undefined || (runId && runId !== afterRun))) return d;
    if (Date.now() > end) throw new Error("agent did not finish");
    await new Promise((ok) => setTimeout(ok, 10_000));
  }
}

const WORK: { lang: string; text: string }[] = [
  { lang: "Polish", text: "Mam 500 zł i potrzebuję zagęszczarki na 2 dni. Która najcięższa (nie ubijak) zmieści się w budżecie? Porównaj mi wszystkie, które się mieszczą." },
  { lang: "English", text: "I have a budget of 500 PLN and need a plate compactor for 2 days. Which is the heaviest one (not a rammer) that fits the budget? Compare all that fit." },
  { lang: "Ukrainian", text: "У мене бюджет 500 злотих, потрібна віброплита на 2 дні. Яка найважча (не трамбувальник) вкладається в бюджет? Порівняйте всі, що вкладаються." },
  { lang: "French", text: "J'ai un budget de 500 PLN et j'ai besoin d'une plaque vibrante pour 2 jours. Quelle est la plus lourde (pas un pilonneur) qui rentre dans le budget ? Comparez toutes celles qui rentrent." },
];

live("every conversation is a project; the system routes each turn", () => {
  it("knowledge turn, then work for the agent, then a price question (agent too) - one project", async () => {
    const session = `test-conv-${run}-pl`;
    sessions.push(session);
    const history: ChatMessage[] = [];

    const k = await turn(session, history, "Jakie macie godziny otwarcia?");
    expect(k.project?.agent).toBeUndefined();

    const w = await turn(session, history, WORK[0].text);
    expect(w.project?.agent?.status).toBe("running");
    const projectId = w.project!.id;
    const d = await waitDelivery(projectId);
    console.log(`[Polish] ${d.status}\n${d.message}\nfiles: ${d.files?.join(", ")}`);
    expect(d.status).toBe("done");
    expect(d.message).toContain("280");

    // A price question is work for the agent too (same project).
    const firstRun = ((await M.projectDetail(projectId))!.project.memory.agentRun as any).runId;
    const e = await turn(session, history, "A ile wyjdzie zagęszczarka 90 kg na 3 dni i betoniarka 150 litrów na 5 godzin?");
    expect(e.project?.id).toBe(projectId);
    console.log(`[Polish estimate turn] ${JSON.stringify({ message: e.message, project: e.project })}`);
    const de = await waitDelivery(projectId, firstRun);
    console.log(`[Polish estimate] ${de.status}\n${de.message}`);
    // 90 kg x 3 days = 330 zł, mixer 5 h = 80 zł: the total or both prices.
    const nums = M.numbersIn(de.message);
    const has = (v: number) => nums.some((n: number) => Math.abs(n - v) < 0.005);
    expect(has(410) || (has(330) && has(80))).toBe(true);

    await new Promise((ok) => setTimeout(ok, 3000)); // turn records are fire-and-forget
    const open = await M.findOpenProject(session, M.CONVERSATION);
    expect(open?.id).toBe(projectId);
    const routes = (await M.projectDetail(projectId))!.events.filter((x) => x.kind === "turn").map((x) => x.data.route);
    expect(routes).toEqual(["knowledge", "agent", "agent"]);
  }, 20 * 60 * 1000);

  for (const c of WORK.slice(1)) {
    it(`work in ${c.lang}`, async () => {
      const session = `test-conv-${run}-${c.lang}`;
      sessions.push(session);
      const w = await turn(session, [], c.text);
      expect(w.project?.agent?.status).toBe("running");
      const d = await waitDelivery(w.project!.id);
      console.log(`[${c.lang}] ${d.status}\n${w.message}\n${d.message}`);
      expect(d.status).toBe("done");
      expect(d.message).toContain("280");
    }, 20 * 60 * 1000);
  }
});

live("the business approves before the customer gets the result", () => {
  it("held for review -> owner asks for changes -> reworked -> owner edits and approves -> customer gets it", async () => {
    const review = await import("../src/projects/review.js");
    // Approve mode for this process only (never the business's real setting).
    process.env.AGENT_REVIEW_FORCE = TENANT;
    const session = `test-conv-${run}-review`;
    sessions.push(session);
    const w = await turn(session, [], WORK[0].text);
    expect(w.project?.agent?.status).toBe("running");
    const pid = w.project!.id;

    const delivered: string[] = [];
    const poll = async (want: string) => {
      const end = Date.now() + 15 * 60 * 1000;
      for (;;) {
        const d = await M.agentDelivery(pid, async (m) => { delivered.push(m); });
        if (d.status === want) return d;
        if (d.status !== "running" && d.status !== "review") throw new Error(`unexpected ${d.status}`);
        if (Date.now() > end) throw new Error(`no ${want}`);
        await new Promise((ok) => setTimeout(ok, 10_000));
      }
    };
    const first = await poll("review");
    expect(delivered.length).toBe(1); // "the business is checking it" - once
    const run1 = ((await M.projectDetail(pid))!.project.memory.agentRun as any).runId;
    const rv1 = (await review.reviewForRun(pid, run1))!;
    expect(rv1.status).toBe("pending");
    expect(rv1.draft).toContain("280");
    console.log(`[review] draft 1:\n${rv1.draft}`);

    const { reworkWithGuidance } = await import("../src/projects/conversation.js");
    expect(await review.decide(rv1.token, "changes_requested", { note: "Dolicz do każdej opcji transport w obie strony: 150 zł." })).not.toBeNull();
    await reworkWithGuidance(pid, "Dolicz do każdej opcji transport w obie strony: 150 zł.");
    // Nobody polls from the chat now: the review must open as soon as the rework finishes.
    const { agentStatus } = await import("../src/projects/agent.js");
    await new Promise((ok) => setTimeout(ok, 15_000));
    for (let i = 0; i < 90; i++) {
      const st = await agentStatus(pid);
      if (st && (st.status === "done" || st.status === "failed") && !st.runId.startsWith(run1)) break;
      await new Promise((ok) => setTimeout(ok, 10_000));
    }
    const reworked = ((await M.projectDetail(pid))!.project.memory.agentRun as any).runId;
    expect(await review.reviewForRun(pid, reworked)).not.toBeNull();
    await poll("review");
    const run2 = ((await M.projectDetail(pid))!.project.memory.agentRun as any).runId;
    expect(run2).not.toBe(run1);
    const rv2 = (await review.reviewForRun(pid, run2))!;
    console.log(`[review] draft 2:\n${rv2.draft}`);
    expect(rv2.draft).toContain("150");

    const edited = rv2.draft + "\n\nZapraszamy - Rentbud (test)";
    expect(await review.decide(rv2.token, "approved", { final: edited })).not.toBeNull();
    const done = await poll("done");
    expect(done.message).toBe(edited.trim());
    expect(delivered[delivered.length - 1]).toBe(edited.trim());
    void first;
    delete process.env.AGENT_REVIEW_FORCE;
  }, 40 * 60 * 1000);
});

// Since 2026-11-04 (src/network/coverage.ts) a calculation of the business's own products that are not all priced is
// answered in the chat with a quote request to its own team - no background run, no other business. This request (the
// compactor priced, its delivery - an add-on of it - without a price) went to the agent before, which asked the owner
// for the delivery price; the owner's questions now come up in runs with a part another business has
// (network-project.test.ts: Rentbud's owner reviews when the agent has a question for it).
live("our own products without a price for every part stay in the chat", () => {
  it("answers in the chat: no background run, no other business", async () => {
    const session = `test-conv-${run}-own-unpriced`;
    sessions.push(session);
    const w = await turn(session, [], "Robię podjazd z kostki, ok. 60 m2, podbudowę będę zagęszczał przez 2 dni. Dobierz mi odpowiednią zagęszczarkę i policz cały koszt razem z dowozem i odbiorem na Ursynów.");
    console.log(`[own, delivery unpriced] ${w.message}`);
    expect(w.project?.agent).toBeUndefined();
    expect(w.partners).toBeUndefined();
    await new Promise((ok) => setTimeout(ok, 3000)); // turn records are fire-and-forget
    const open = await M.findOpenProject(session, M.CONVERSATION);
    const routes = open ? (await M.projectDetail(open.id))!.events.filter((x) => x.kind === "turn").map((x) => x.data.route) : [];
    expect(routes).not.toContain("agent");
    expect(routes).not.toContain("network");
  }, 5 * 60 * 1000);
});
