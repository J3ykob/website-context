/**
 * Routing eval runner (docs/routing-fixes-plan.md). Plays evals/routing/cases.json
 * against a live server the way the widget does (streaming /api/chat, full
 * history, one session per case), reads the admin trace (route, LLM/Jev calls,
 * time), waits for background agent results, checks expectations with code
 * rules + an LLM judge (Workers AI), writes a report, and deletes everything the
 * run created (chat messages, projects, hand-off links).
 *
 *   ADMIN_SECRET=... npx tsx evals/routing/run.ts [--only K1,X2] [--base https://whisp.so] [--out file.json]
 *
 * Needs ADMIN_SECRET (trace) and a logged-in wrangler (judge + cleanup).
 */
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const BASE = arg("--base") || "https://whisp.so";
const ONLY = arg("--only")?.split(",");
const OUT = arg("--out") || resolve(HERE, `results-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`);
const ADMIN = process.env.ADMIN_SECRET || "";
if (!ADMIN) throw new Error("ADMIN_SECRET is required");
const RUN = `reval-${Date.now().toString(36)}`;
const RUN_START = new Date().toISOString();
const ACCT = "98e447c9e14d384e1b7e6f4d42c39ad2";
const D1 = "0dec9229-fea2-4343-bf87-d36ac3205979";
const CF_TOKEN = execSync("npx wrangler auth token", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n").pop()!;
const JUDGE = "@cf/moonshotai/kimi-k2.6";

interface Turn { user: string; route: string[]; network?: string[]; lang?: string; handoff?: boolean; must?: string[]; mustNot?: string[]; judge: string; maxFirstMs?: number; maxTotalMs?: number; maxLlm?: number; async?: boolean; noReview?: boolean }
interface Case { id: string; tenant: string; turns: Turn[] }
const spec = JSON.parse(readFileSync(resolve(HERE, "cases.json"), "utf-8")) as { defaults: Partial<Turn>; cases: Case[] };
const D = spec.defaults;

async function cf(path: string, body: unknown, tries = 5): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d: any = r ? await r.json().catch(() => null) : null;
    if (d?.success) return d;
    if (i >= tries - 1) return d;
    await new Promise((s) => setTimeout(s, 4000 * (i + 1)));
  }
}
const d1 = (sql: string, params: unknown[] = []) => cf(`d1/database/${D1}/query`, { sql, params });

async function streamTurn(tenant: string, session: string, messages: { role: string; content: string }[]) {
  const t0 = Date.now();
  let first = 0, done: any = null, live = "";
  const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Secret": ADMIN }, body: JSON.stringify({ tenantId: tenant, sessionId: session, messages, stream: true }) });
  if (!r.ok || !r.body) return { first: 0, total: Date.now() - t0, done: { error: `HTTP ${r.status}`, message: "" }, live };
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split("\n\n"); buf = events.pop() || "";
    for (const e of events) {
      const line = e.trim(); if (!line.startsWith("data:")) continue;
      const d = JSON.parse(line.slice(5));
      if (typeof d.delta === "string") { if (!first) first = Date.now() - t0; live += d.delta; }
      if (d.done || d.error) done = d;
    }
  }
  return { first: first || Date.now() - t0, total: Date.now() - t0, done: done || { error: "no done event", message: "" }, live };
}

// A background agent result: poll until it is no longer running.
async function agentResult(tenant: string, session: string, projectId: string, limitMs: number, t0: number) {
  for (;;) {
    const r = await fetch(`${BASE}/api/chat/agent?tenantId=${tenant}&sessionId=${session}&projectId=${projectId}`).then((x) => x.json()).catch(() => null) as any;
    // "none" right after the start: the run is not registered yet.
    const settled = r && r.status !== "running" && !(r.status === "none" && Date.now() - t0 < 45000);
    if (settled) return { status: r.status as string, message: String(r.message || ""), ms: Date.now() - t0 };
    if (Date.now() - t0 > limitMs + 60000) return { status: "timeout", message: "", ms: Date.now() - t0 };
    await new Promise((s) => setTimeout(s, 8000));
  }
}

const CYR = /[а-яіїєґ]/gi;
// The reply's language: script and diacritics first (short replies have no stopwords), then stopwords.
function langOf(t: string): string {
  const letters = (t.match(/\p{L}/gu) || []).length || 1;
  if ((t.match(CYR) || []).length / letters > 0.3) return "uk";
  const n = (re: RegExp) => (t.match(re) || []).length;
  const s: Record<string, number> = {
    pl: n(/[ąćęłńóśźż]/gi) * 2 + n(/\b(się|jest|nie|czy|oraz|możesz|nasz|nasza|nas|prosimy|jesteśmy|oferujemy|mamy|dla|lub|że|jak|dzień)\b/gi),
    en: n(/\b(the|we|and|you|our|is|are|for|with|please|can|your|i|it|to)\b/gi),
    fr: n(/[àâçèêëîïôûùœ]/gi) * 2 + n(/\b(le|la|les|nous|vous|est|pour|avec|des|une|notre|votre|merci|commande)\b/gi),
  };
  const top = Object.entries(s).sort((a, b) => b[1] - a[1])[0];
  return top[1] > 0 ? top[0] : "?";
}

async function judge(c: Case, history: { role: string; content: string }[], t: Turn, reply: string): Promise<{ ok: boolean; note: string }> {
  const prompt =
    `You grade one reply of a business's website chat assistant (business id: ${c.tenant}).\n` +
    `Conversation so far:\n${history.slice(0, -1).map((m) => `${m.role}: ${m.content.slice(0, 600)}`).join("\n") || "(start)"}\n` +
    `Visitor: ${t.user}\nAssistant reply:\n"""${reply.slice(0, 3000)}"""\n\n` +
    `A correct reply: ${t.judge}${t.handoff ? " It must offer to pass the question to the business (the owner/team)." : ""}\n` +
    `General rules: no invented facts about the business (prices, stock, phone numbers), no promise that someone will follow up unless a request was actually recorded, no total computed from missing prices.\n` +
    `Answer JSON only: {"ok": true|false, "note": "short reason"}`;
  const d = await cf(`ai/run/${JUDGE}`, { messages: [{ role: "user", content: prompt }], max_tokens: 300, temperature: 0, chat_template_kwargs: { enable_thinking: false, thinking: false } });
  const text = String(d?.result?.choices?.[0]?.message?.content ?? d?.result?.response ?? "");
  const m = text.match(/\{[\s\S]*\}/);
  try { const j = JSON.parse(m ? m[0] : ""); return { ok: !!j.ok, note: String(j.note || "") }; } catch { return { ok: false, note: `judge failed: ${text.slice(0, 120)}` }; }
}

const results: any[] = [];
const CONCURRENCY = Number(arg("--parallel") || 4);
async function runCase(c: Case): Promise<void> {
  const session = `${RUN}-${c.id}`;
  const history: { role: string; content: string }[] = [];
  const lines: string[] = [];
  for (const [i, t0] of c.turns.entries()) {
    const t: Turn = { ...D, ...t0, mustNot: [...(D.mustNot || []), ...(t0.mustNot || [])] } as Turn;
    history.push({ role: "user", content: t.user });
    const s = await streamTurn(c.tenant, session, history);
    let reply = String(s.done.message || "");
    const trace = s.done.trace || {};
    let total = s.total, asyncStatus: string | undefined;
    if (s.done.project?.agent) {
      const a = await agentResult(c.tenant, session, s.done.project.id, t.maxTotalMs || 180000, Date.now() - s.total);
      asyncStatus = a.status; total = a.ms; if (a.message) reply = `${reply}\n\n${a.message}`;
    }
    history.push({ role: "assistant", content: reply });
    const fails: string[] = [];
    const route = trace.route || "?";
    if (!t.route.includes(route)) fails.push(`route ${route} not in [${t.route}]`);
    const partners: string[] = (s.done.partners || []).map((p: any) => p.tenantId);
    if (t.network) {
      if (t.network.length === 0 && partners.length) fails.push(`unexpected network [${partners}]`);
      for (const p of t.network) if (!partners.includes(p)) fails.push(`missing partner ${p}`);
    }
    if (t.lang && langOf(reply) !== t.lang) fails.push(`language ${langOf(reply)} != ${t.lang}`);
    for (const re of t.must || []) if (!new RegExp(re, "i").test(reply)) fails.push(`missing /${re}/`);
    for (const re of t.mustNot || []) if (new RegExp(re, "i").test(reply)) fails.push(`contains /${re}/`);
    if (s.first > (t.maxFirstMs || 6000) && !s.done.project?.agent) fails.push(`first ${s.first}ms > ${t.maxFirstMs}`);
    if (total > (t.maxTotalMs || 15000)) fails.push(`total ${total}ms > ${t.maxTotalMs}`);
    if (typeof trace.llmCalls === "number" && trace.llmCalls > (t.maxLlm || 3)) fails.push(`llm ${trace.llmCalls} > ${t.maxLlm}`);
    if (t.noReview && asyncStatus === "review") fails.push("waits for owner review");
    if (asyncStatus === "timeout") fails.push("agent timeout");
    if (s.done.error) fails.push(`error ${s.done.error}`);
    const j = await judge(c, history, t, reply);
    if (!j.ok) fails.push(`judge: ${j.note}`);
    const row = { id: `${c.id}.${i + 1}`, tenant: c.tenant, user: t.user, route, partners, firstMs: s.first, totalMs: total, llm: trace.llmCalls, jev: trace.jevCalls, asyncStatus, pass: fails.length === 0, fails, judgeNote: j.note, reply: reply.slice(0, 1500) };
    results.push(row);
    lines.push(`${row.pass ? "PASS" : "FAIL"} ${row.id.padEnd(5)} ${route.padEnd(9)} first ${(s.first / 1000).toFixed(1)}s total ${(total / 1000).toFixed(1)}s llm ${trace.llmCalls ?? "?"} jev ${trace.jevCalls ?? "?"}${asyncStatus ? ` agent=${asyncStatus}` : ""} | ${t.user.slice(0, 48)}${fails.length ? `\n      - ${fails.join("\n      - ")}` : ""}`);
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log(lines.join("\n"));
}
const queue = spec.cases.filter((x) => !ONLY || ONLY.includes(x.id));
let next = 0;
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (next < queue.length) { const c = queue[next++]; await runCase(c).catch((e) => console.log(`ERROR ${c.id}: ${(e as Error).message}`)); }
}));
results.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

const pass = results.filter((r) => r.pass).length;
const byRoute: Record<string, number[]> = {};
for (const r of results) (byRoute[r.route] ||= []).push(r.totalMs);
console.log(`\n${pass}/${results.length} turns passed; cases fully passed: ${new Set(results.map((r) => r.id.split(".")[0])).size - new Set(results.filter((r) => !r.pass).map((r) => r.id.split(".")[0])).size}/${new Set(results.map((r) => r.id.split(".")[0])).size}`);
console.log("median total ms by route:", Object.fromEntries(Object.entries(byRoute).map(([k, v]) => [k, v.sort((a, b) => a - b)[Math.floor(v.length / 2)]])));
try { writeFileSync(OUT, JSON.stringify({ run: RUN, base: BASE, at: new Date().toISOString(), pass, total: results.length, results }, null, 1));
console.log(`report: ${OUT}`); } catch (e) { console.error(`could not write report: ${(e as Error).message}`); }

// Clean up everything eval runs created (also leftovers of an aborted earlier run).
const like = `reval-%`;
const projIds = `SELECT id FROM projects WHERE customer_session LIKE ?`;
for (const t of ["project_events", "project_participants", "project_consents", "project_files", "project_requirements", "project_reviews"]) await d1(`DELETE FROM ${t} WHERE project_id IN (${projIds})`, [like]);
await d1(`DELETE FROM projects WHERE customer_session LIKE ?`, [like]);
await d1(`DELETE FROM chat_messages WHERE session_id LIKE ?`, [like]);
await d1(`DELETE FROM handoffs WHERE created_at >= ? AND need IN (${spec.cases.flatMap((c) => c.turns.map(() => "?")).join(",")})`, [RUN_START, ...spec.cases.flatMap((c) => c.turns.map((t) => t.user))]);
console.log("cleaned up run data");
