import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ChatMessage } from "../src/llm/chat.js";
import type { TenantManager } from "../src/multi-tenant/tenant-manager.js";

// Live: a business that has joined the network (Perfekt Dach, treated as a member for this process only)
// answers automatically but leaves its part unpriced (its gutters are "price on request"). Its owner is
// asked for the price (review page + email), the customer does not wait - the result gives the priced
// part and says the rest comes on the status page - and the owner's price then reaches the customer as
// a new offer (status page, chat log).
const live = process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET && process.env.JEV_API_KEY && process.env.CF_API_TOKEN && process.env.OPENROUTER_API_KEY ? describe : describe.skip;
const TENANT = "www_rentbud_pl";
const DACH = "www_dachywarszawa_pl";
const session = `test-ownerquote-${Date.now()}`;
let tm: TenantManager;
let M: any;

beforeAll(async () => {
  if (!process.env.PROJECT_AGENT_URL || !process.env.CF_API_TOKEN) return;
  const [store, repo, conv, review, cs, reg, tmm] = await Promise.all([import("../src/projects/store.js"), import("../src/projects/repo.js"), import("../src/projects/conversation.js"), import("../src/projects/review.js"), import("../src/storage/conversation-store.js"), import("../src/multi-tenant/d1-registry.js"), import("../src/multi-tenant/tenant-manager.js")]);
  M = { store, repo, conv, review, d1Query: cs.d1Query };
  await reg.hydrateRegistry();
  tm = new tmm.TenantManager();
  process.env.NETWORK_MEMBER_FORCE = DACH; // this process only, never the business's settings
}, 60_000);

afterAll(async () => {
  delete process.env.NETWORK_MEMBER_FORCE;
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

live("a member business whose answer leaves a part unpriced", () => {
  it("asks its owner for the price, the customer gets the rest now and the owner's price later", async () => {
    const chat = await tm.getChatForTenant(TENANT);
    const w = await chat.chat([{ role: "user", content: "Dzień dobry, potrzebuję wymienić rynny na domu 10x12 m, a do tego zagęszczarkę 130 kg na 2 doby do podjazdu. Ile to wszystko wyjdzie?" } as ChatMessage], session);
    expect(w.project?.agent?.status).toBe("running");
    const pid = w.project!.id;
    let d: any;
    for (const end = Date.now() + 45 * 60_000; ;) {
      d = await M.conv.agentDelivery(pid, async () => {});
      if (d.status === "done" || d.status === "failed") break;
      const run = (await M.store.getProject(pid))?.memory.agentRun;
      const rv = run && d.status === "review" ? await M.review.reviewForRun(pid, run.runId) : null;
      if (rv?.status === "pending") await M.review.decide(rv.token, "approved", {}); // Rentbud's owner, if it reviews
      if (Date.now() > end) throw new Error("no result");
      await new Promise((ok) => setTimeout(ok, 15_000));
    }
    const p = (await M.store.getProject(pid))!;
    const subs = (p.memory.subRequests || []) as any[];
    const dach = subs.find((s) => s.tenantId === DACH);
    console.log(`[final] ${d.status}\n${d.message}\n[subs] ${JSON.stringify(subs)}`);
    expect(d.status).toBe("done");
    expect(dach?.status).toBe("answered");
    // Perfekt Dach's owner was asked for the price; its review page waits for them.
    const sub = (await M.store.getProject(dach.id))!;
    const asked = (await M.store.projectDetail(dach.id))!.events.find((e: any) => e.kind === "owner_quote_asked");
    console.log(`[dach answer] ${await M.repo.readFile(dach.id, "odpowiedz.txt")}\n[asked] ${JSON.stringify(asked?.data)}`);
    expect(sub.memory.ownerQuote).toBe("asked");
    expect(dach.ownerAsked).toBe(true);
    const rv = await M.review.reviewForRun(dach.id, sub.memory.agentRun.runId);
    expect(rv?.status).toBe("pending");
    // Acting as Perfekt Dach's owner: the price (what POST /api/review does for a business request).
    const price = "Wymiana rynien PCV z montażem: 95 zł za metr bieżący, dom 10x12 m - ok. 44 mb, czyli ok. 4180 zł brutto.";
    await M.review.decide(rv.token, "approved", { final: price });
    const { settle } = await import("../src/projects/network.js");
    await settle(dach.id, price, "answered");
    const after = (await M.store.getProject(pid))!;
    const offers = (after.memory.businessOffers || []) as any[];
    console.log(`[offers] ${JSON.stringify(offers)}`);
    expect(offers.some((o) => o.tenantId === DACH && o.text.includes("95 zł"))).toBe(true);
    expect((await M.store.getProject(dach.id))!.memory.ownerQuote).toBe("answered");
    const logged = await M.d1Query("SELECT content FROM chat_messages WHERE session_id = ? AND content LIKE '%95 zł%'", [session]);
    expect(logged.length).toBeGreaterThan(0);
  }, 60 * 60_000);
});
