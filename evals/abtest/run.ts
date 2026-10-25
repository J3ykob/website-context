/**
 * A/B run of the reply pipeline on production: every case is played on both variants ("" = current,
 * "packs" = dynamic context, header x-test-variant), turn by turn like the widget (streamed), with
 * background calculation results awaited. Records replies, first-token / total times and the turn's
 * LLM/Jev usage. Judging is separate (blind, by independent reviewers).
 *
 *   ADMIN_SECRET=... npx tsx evals/abtest/run.ts --cases dir/with/cases-*.json --out results.json [--parallel 4] [--only id1,id2]
 *
 * Sessions are "reval-ab-<run>-<variant>-<case>" (removed by the routing eval's cleanup, or --cleanup).
 * Order cases never confirm (their last turn declines), so no inquiry is sent.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const BASE = arg("--base") || "https://whisp.so";
const ADMIN = process.env.ADMIN_SECRET || "";
const DIR = arg("--cases")!;
const OUT = arg("--out") || "ab-results.json";
const PAR = Number(arg("--parallel") || 4);
const ONLY = arg("--only")?.split(",");
const VARIANTS = (arg("--variants") || ",packs").split(",");
const RUN = `reval-ab-${Date.now().toString(36)}`;
if (!ADMIN || !DIR) { console.error("ADMIN_SECRET and --cases are required"); process.exit(1); }

interface Case { id: string; tenant: string; category: string; language: string; turns: string[]; ground_truth: string; good_reply: string; sources: string[] }
const cases: Case[] = readdirSync(DIR).filter((f) => /^cases-.*\.json$/.test(f)).flatMap((f) => JSON.parse(readFileSync(join(DIR, f), "utf-8")))
  .filter((c: Case) => !ONLY || ONLY.includes(c.id));

async function streamTurn(variant: string, tenant: string, session: string, messages: { role: string; content: string }[]) {
  const t0 = Date.now();
  let first = 0, done: any = null;
  const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Secret": ADMIN, ...(variant ? { "x-test-variant": variant } : {}) }, body: JSON.stringify({ tenantId: tenant, sessionId: session, messages, stream: true }) }).catch(() => null);
  if (!r || !r.ok || !r.body) return { first: 0, total: Date.now() - t0, done: { error: `HTTP ${r?.status}`, message: "" } };
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch (e) { return { first: first || Date.now() - t0, total: Date.now() - t0, done: done || { error: `stream: ${(e as Error).message}`, message: "" } }; }
    const { value, done: end } = chunk;
    if (end) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split("\n\n"); buf = events.pop() || "";
    for (const e of events) {
      const line = e.trim(); if (!line.startsWith("data:")) continue;
      let d: any; try { d = JSON.parse(line.slice(5)); } catch { continue; }
      if (typeof d.delta === "string" && d.delta && !first) first = Date.now() - t0;
      if (d.done || d.error) done = d;
    }
  }
  return { first: first || Date.now() - t0, total: Date.now() - t0, done: done || { error: "no done event", message: "" } };
}

async function agentResult(tenant: string, session: string, projectId: string, t0: number) {
  for (;;) {
    const r = await fetch(`${BASE}/api/chat/agent?tenantId=${tenant}&sessionId=${session}&projectId=${projectId}`).then((x) => x.json()).catch(() => null) as any;
    const settled = r && r.status !== "running" && !(r.status === "none" && Date.now() - t0 < 45000);
    if (settled) return { status: r.status as string, message: String(r.message || ""), ms: Date.now() - t0 };
    if (Date.now() - t0 > 240000) return { status: "timeout", message: "", ms: Date.now() - t0 };
    await new Promise((s) => setTimeout(s, 8000));
  }
}

async function play(c: Case, variant: string) {
  const session = `${RUN}-${variant || "base"}-${c.id}`;
  const history: { role: string; content: string }[] = [];
  const turns: any[] = [];
  for (const user of c.turns) {
    history.push({ role: "user", content: user });
    const s = await streamTurn(variant, c.tenant, session, history);
    let reply = String(s.done.message || s.done.error || "");
    let total = s.total, agent: string | undefined;
    if (s.done.project?.agent) {
      const a = await agentResult(c.tenant, session, s.done.project.id, Date.now() - s.total);
      agent = a.status; total = a.ms; if (a.message) reply = `${reply}\n\n${a.message}`;
    }
    const tr = s.done.trace || {};
    turns.push({ user, reply, firstMs: s.first, totalMs: total, agent, error: s.done.error || null, route: tr.route, llm: tr.llmCalls, llmIn: tr.llmIn, llmOut: tr.llmOut, jev: tr.jevCalls });
    history.push({ role: "assistant", content: reply });
  }
  return { id: c.id, variant: variant || "base", turns };
}

// Results are saved after every conversation; --resume keeps the error-free ones already in --out.
const prior: any[] = process.argv.includes("--resume") && existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf-8")).results || []).filter((x: any) => !x.turns.some((t: any) => t.error)) : [];
const doneKeys = new Set(prior.map((x: any) => `${x.variant}|${x.id}`));
const jobs = cases.flatMap((c) => VARIANTS.map((v) => ({ c, v }))).filter(({ c, v }) => !doneKeys.has(`${v || "base"}|${c.id}`));
const results: any[] = [...prior];
const save = () => writeFileSync(OUT, JSON.stringify({ run: RUN, at: new Date().toISOString(), cases, results }, null, 1));
let next = 0;
await Promise.all(Array.from({ length: PAR }, async () => {
  while (next < jobs.length) {
    const { c, v } = jobs[next++];
    const r = await play(c, v).catch((e) => ({ id: c.id, variant: v || "base", turns: [{ user: c.turns[0], reply: "", error: `runner: ${(e as Error).message}` }] }));
    results.push(r);
    save();
    const t = r.turns[r.turns.length - 1];
    console.log(`${r.variant.padEnd(5)} ${c.id.padEnd(12)} ${r.turns.map((x: any) => `${(x.totalMs / 1000).toFixed(1)}s`).join(" ")} llm ${r.turns.map((x: any) => x.llm ?? "?").join("/")}${t.error ? ` ERROR ${t.error}` : ""}`);
  }
}));
save();
console.log(`\n${results.length} runs -> ${OUT}`);
if (process.argv.includes("--cleanup")) {
  const D1 = "0dec9229-fea2-4343-bf87-d36ac3205979";
  for (const sql of [
    `DELETE FROM project_events WHERE project_id IN (SELECT id FROM projects WHERE customer_session LIKE '${RUN}%')`,
    `DELETE FROM projects WHERE customer_session IN (SELECT 'project:' || id FROM projects WHERE customer_session LIKE '${RUN}%')`,
    `DELETE FROM projects WHERE customer_session LIKE '${RUN}%'`,
    `DELETE FROM chat_messages WHERE session_id LIKE '${RUN}%'`,
  ]) { try { execSync(`npx wrangler d1 execute ${D1} --remote --command "${sql}"`, { stdio: "ignore" }); } catch {} }
  console.log("cleaned up");
}
