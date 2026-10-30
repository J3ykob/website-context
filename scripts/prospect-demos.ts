/**
 * Demo bots for prospects: one per website, ready to show, checked before anyone sees them.
 * Never contacts the prospects: the business is registered under YOUR e-mail (DEMO_EMAIL), so the only
 * e-mail sent is the "bot ready" note to you. Nothing else goes out.
 *
 * For each website: register + read up to 150 pages (/api/onboard-demo, the self-serve path) -> wait until
 * it is read -> knowledge audit (the bot answers standard customer questions, graded) -> report with
 * the demo link and what to fix before showing it.
 *
 * Usage:
 *   ADMIN_SECRET=... npx tsx scripts/prospect-demos.ts sites.txt        (one website per line, # comments)
 *   ADMIN_SECRET=... npx tsx scripts/prospect-demos.ts https://a.pl https://b.pl
 *   options: --report=demos.md (default prospect-demos-<date>.md), --wait=40 (minutes), --rescrape (read again)
 *   env: DEMO_EMAIL (default kubalol7982@gmail.com), BASE_URL (default https://whisp.so)
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const BASE = (process.env.BASE_URL || "https://whisp.so").replace(/\/+$/, "");
const ADMIN = process.env.ADMIN_SECRET || "";
const EMAIL = process.env.DEMO_EMAIL || "kubalol7982@gmail.com";
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const WAIT_MIN = Number(arg("wait")) || 40;
const RESCRAPE = process.argv.includes("--rescrape");
const REPORT = arg("report") || `prospect-demos-${new Date().toISOString().slice(0, 10)}.md`;
if (!ADMIN) { console.error("ADMIN_SECRET is required"); process.exit(1); }

// Websites from a file and/or the arguments.
const inputs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const sites = [...new Set(inputs.flatMap((a) => (existsSync(a) ? readFileSync(a, "utf8").split("\n") : [a]))
  .map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
  .map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`)))];
if (!sites.length) { console.error("No websites given (a file with one per line, or URLs as arguments)."); process.exit(1); }

const headers = { "Content-Type": "application/json", "X-Admin-Secret": ADMIN };
const api = async (path: string, init?: RequestInit): Promise<any> => {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers || {}) }, signal: AbortSignal.timeout(120_000) });
      const body = await r.json().catch(() => ({}));
      return { http: r.status, ...body }; // `status` is the business's (the API's own field), never the HTTP code
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((ok) => setTimeout(ok, 5000 * attempt)); // the network drops now and then
    }
  }
};
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

interface Row { site: string; tenantId?: string; status: string; pages?: number; audit?: { ok: number; partial: number; missing: number }; warnings: string[] }
const rows: Row[] = sites.map((site) => ({ site, status: "new", warnings: [] }));

// 1. Register (or find) each business; read it (again with --rescrape).
for (const row of rows) {
  const r = await api("/api/onboard-demo", { method: "POST", body: JSON.stringify({ siteUrl: row.site, email: EMAIL }) }).catch((e) => ({ http: 0, error: String(e) }));
  if (!r.tenantId) { row.status = "error"; row.warnings.push(`could not register: ${r.error || `HTTP ${r.http}`}`); continue; }
  row.tenantId = r.tenantId;
  if (RESCRAPE && r.ready) await api(`/api/admin/rescrape/${encodeURIComponent(r.tenantId)}?maxPages=150`, { method: "POST" });
  row.status = r.ready && !RESCRAPE ? "active" : "reading";
  console.log(`${row.site} -> ${row.tenantId} (${row.status})`);
}

// 2. Wait until every site is read (the server reads them one after another).
const until = Date.now() + WAIT_MIN * 60_000;
for (;;) {
  for (const row of rows.filter((r) => r.tenantId)) {
    const s = await api(`/api/tenants/${encodeURIComponent(row.tenantId!)}/status`).catch(() => null);
    // A server restart answers 502 for a moment: keep the last known state and ask again.
    if (s?.http === 200 && s.status) { row.status = s.status; row.pages = s.pagesCount; }
  }
  const waiting = rows.filter((r) => r.tenantId && ["pending", "queued", "scraping", "reading"].includes(r.status));
  if (!waiting.length || Date.now() > until) break;
  console.log(`${new Date().toISOString().slice(11, 19)} still reading: ${waiting.map((r) => r.tenantId).join(", ")}`);
  await sleep(30_000);
}

// 3. Check each ready bot: the knowledge audit asks it standard customer questions and grades the answers.
for (const row of rows.filter((r) => r.tenantId)) {
  if (row.status !== "active") { row.warnings.push(row.status === "scraping" || row.status === "pending" ? `still being read after ${WAIT_MIN} min - run again later` : `site status "${row.status}"`); continue; }
  if ((row.pages || 0) <= 1) row.warnings.push("only 1 page read - the site may block our servers (a bot check) or be a one-page app: open the demo before showing it, try --rescrape");
  else if ((row.pages || 0) < 5) row.warnings.push(`only ${row.pages} pages read - check the demo knows the offer`);
  // The audit asks the bot standard customer questions (contact, area, hours, prices, quote, payment, ...).
  // Judged by what a visitor gets - the questions, not the audit's data checks (an address written in a
  // sentence is answered although no "official address" was extracted). Topics a business may simply not
  // have (warranty for a café) are listed, not counted against it; a failing contact answer is.
  const a = await api(`/api/admin/audit/${encodeURIComponent(row.tenantId!)}`, { method: "POST" }).catch(() => null);
  const qs: { topic: string; status: string }[] = (Array.isArray(a?.items) ? a.items : []).filter((i: any) => i.kind === "question");
  if (qs.length) {
    const n = (st: string) => qs.filter((i) => i.status === st).length;
    row.audit = { ok: n("ok"), partial: n("partial"), missing: n("missing") };
    if (qs.some((i) => i.topic === "contact" && i.status !== "ok")) row.warnings.push("the bot does not give the contact details properly - check before showing");
    const gaps = qs.filter((i) => i.status !== "ok").map((i) => `${i.topic}${i.status === "partial" ? " (partly)" : ""}`);
    if (gaps.length) row.warnings.push(`no full answer on the site for: ${gaps.join(", ")} (fine if the business does not publish it)`);
  } else row.warnings.push("knowledge audit unavailable");
}

// 4. Report.
const line = (r: Row) => `| ${r.site} | ${r.tenantId ? `[demo](${BASE}/demo/${r.tenantId})` : "-"} | ${r.status} | ${r.pages ?? "-"} | ${r.audit ? `${r.audit.ok} ok / ${r.audit.partial} partial / ${r.audit.missing} missing` : "-"} | ${r.warnings.join("; ") || "ready"} |`;
const report = `# Prospect demos - ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC

Demo links show each business its own chat. Nothing was sent to the businesses; "bot ready" notes went to ${EMAIL}.

| Website | Demo | Status | Pages read | Customer questions answered | Notes |
|---|---|---|---|---|---|
${rows.map(line).join("\n")}
`;
writeFileSync(REPORT, report);
console.log(`\n${report}\nReport saved: ${REPORT}`);
