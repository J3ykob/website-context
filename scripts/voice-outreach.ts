#!/usr/bin/env tsx
/**
 * Voice outreach — call businesses from a CSV and play a recorded pitch.
 *
 * For each lead with a phone number, places a Twilio call that fetches
 * {BASE_URL}/api/voice/twiml (served by scripts/serve-multi-tenant.ts), which
 * <Play>s public/voice/<audio> and hangs up. The recording itself asks the
 * prospect to call back or text the campaign number. Outcomes are recorded to
 * data/voice-campaign-log.json so leads are never called twice.
 *
 * Safeguards: business-hours window (Europe/Warsaw), suppression/do-not-call
 * list (pulled from the server, where STOP replies land), pacing, and a --limit
 * cap. Compliance with PL/EU automated-calling rules is the caller's responsibility.
 *
 * Setup — a Twilio account + a Polish (+48) Voice+SMS number. Env (e.g. ~/.gtm-os/.env):
 *   TWILIO_ACCOUNT_SID   ACxxxx…
 *   TWILIO_AUTH_TOKEN    …
 *   TWILIO_FROM_NUMBER   +48…           (the campaign number / caller ID)
 *   BASE_URL             https://whisp.so   (default)
 *   ADMIN_SECRET         …                  (to fetch the suppression list)
 *
 * Usage:
 *   source ~/.gtm-os/.env && npx tsx scripts/voice-outreach.ts --input data/leads/list.csv [options]
 *
 * Options:
 *   --input <csv>     CSV with a phone column (required). Optional: name/company.
 *   --dry-run         Resolve + filter leads and print who would be called; place no calls.
 *   --limit <n>       Cap the number of calls this run (default: no cap).
 *   --delay <sec>     Seconds between calls (default: 8).
 *   --audio <file>    Recording under public/voice/ to play (default: whisp-pitch-pl.mp3).
 *   --force           Bypass the business-hours guard.
 *   --no-poll         Skip the end-of-run Twilio status poll.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");
const LOG_PATH = resolve(DATA_DIR, "voice-campaign-log.json");
const LOCAL_SUPPRESSION_PATH = resolve(DATA_DIR, "voice-suppression.json");

// --- Config ---
const SID = process.env.TWILIO_ACCOUNT_SID || "";
const TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const FROM = process.env.TWILIO_FROM_NUMBER || "";
const BASE_URL = (process.env.BASE_URL || "https://whisp.so").replace(/\/$/, "");
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

// --- Args ---
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}
const INPUT = arg("--input");
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const POLL = !process.argv.includes("--no-poll");
const RECORD = !process.argv.includes("--no-record");
const LIMIT = parseInt(arg("--limit", "0") || "0");
const DELAY_SEC = Math.max(1, parseInt(arg("--delay", "8") || "8"));
const AUDIO = (arg("--audio", "whisp-pitch-pl.wav") || "whisp-pitch-pl.wav").replace(/[^a-zA-Z0-9._-]/g, "");

if (!INPUT) { console.error("Error: --input <csv> is required"); process.exit(1); }
if (!existsSync(INPUT)) { console.error(`Error: input not found: ${INPUT}`); process.exit(1); }
if (!DRY_RUN && (!SID || !TOKEN || !FROM)) {
  console.error("Error: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are required for live calls.");
  console.error("Set them in your env (e.g. ~/.gtm-os/.env) or use --dry-run.");
  process.exit(1);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const authHeader = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");

// --- Campaign log (keyed by E.164 number) ---
interface CallRecord { calledAt: string; callSid?: string; status?: string; answeredBy?: string; duration?: number; price?: number; company?: string; }
let log: Record<string, CallRecord> = {};
try { log = JSON.parse(readFileSync(LOG_PATH, "utf-8")); } catch {}
function saveLog() { writeFileSync(LOG_PATH, JSON.stringify(log, null, 2)); }
function alreadyCalled(num: string): boolean { return !!log[num]?.callSid; }

// --- CSV parsing (quote-aware; handles commas inside quoted fields) ---
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = ""; let row: string[] = []; let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o: Record<string, string> = {};
    headers.forEach((h, idx) => { o[h] = (r[idx] ?? "").trim(); });
    return o;
  });
}

const PHONE_KEYS = ["phone", "telefon", "mobile", "tel", "number", "phone_number"];
const NAME_KEYS = ["company", "name", "business", "firma"];
function pick(row: Record<string, string>, keys: string[]): string {
  for (const k of Object.keys(row)) { if (keys.includes(k.toLowerCase())) { if (row[k]) return row[k]; } }
  return "";
}

// Normalize to E.164, assuming Poland (+48) for bare 9-digit national numbers.
function toE164(raw: string): string | null {
  if (!raw) return null;
  const hadIntl = /^\s*(\+|00)/.test(raw);
  let s = raw.replace(/[^\d]/g, "");
  if (s.startsWith("00")) s = s.slice(2);
  if (!hadIntl) {
    if (s.length === 9) s = "48" + s;                 // bare PL national number
    else if (s.length === 11 && s.startsWith("48")) { /* already PL country code */ }
    else if (s.length === 10 && s.startsWith("0")) s = "48" + s.slice(1); // 0-prefixed national
  }
  if (s.length < 8 || s.length > 15) return null;
  return "+" + s;
}

// --- Business-hours guard (Mon–Fri 09:00–17:00 Europe/Warsaw) ---
function withinBusinessHours(): { ok: boolean; warsaw: string } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const warsaw = `${parts.weekday} ${parts.hour}:${parts.minute}`;
  const hour = parseInt(parts.hour);
  const isWeekday = !["Sat", "Sun"].includes(parts.weekday);
  return { ok: isWeekday && hour >= 9 && hour < 17, warsaw };
}

async function fetchSuppression(): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const r = await fetch(`${BASE_URL}/api/voice/suppression`, { headers: { "X-Admin-Secret": ADMIN_SECRET }, signal: AbortSignal.timeout(10000) });
    if (r.ok) (await r.json() as string[]).forEach(n => set.add(n.trim()));
    else console.warn(`  (suppression fetch returned ${r.status} — proceeding with local list only)`);
  } catch { console.warn("  (could not reach suppression endpoint — proceeding with local list only)"); }
  if (existsSync(LOCAL_SUPPRESSION_PATH)) {
    try { (JSON.parse(readFileSync(LOCAL_SUPPRESSION_PATH, "utf-8")) as string[]).forEach(n => set.add(n.trim())); } catch {}
  }
  return set;
}

async function placeCall(to: string): Promise<{ sid?: string; status?: string; error?: string }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`;
  // Inline TwiML (Twiml=, not Url=): Twilio runs it the instant the call is answered instead
  // of a round-trip to fetch /api/voice/twiml — removes ~1s of dead air. No answering-machine
  // detection either (AMD added several more seconds before the recording).
  const twiml = `<Response><Play>${BASE_URL}/voice/${AUDIO}</Play></Response>`;
  const body = new URLSearchParams({
    To: to,
    From: FROM,
    Twiml: twiml,
    StatusCallback: `${BASE_URL}/api/voice/status`,
  });
  body.append("StatusCallbackEvent", "completed");
  if (RECORD) {
    // Record both legs on separate channels: ch1 = our pitch, ch2 = the prospect.
    // Lets us transcribe the prospect's side to learn what lands / what they object to.
    body.append("Record", "true");
    body.append("RecordingChannels", "dual");
    body.append("RecordingTrack", "both");
  }
  try {
    const r = await fetch(url, { method: "POST", headers: { Authorization: authHeader, "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(20000) });
    const j: any = await r.json();
    if (!r.ok) return { error: j?.message || `HTTP ${r.status}` };
    return { sid: j.sid, status: j.status };
  } catch (e: any) { return { error: e?.message || "request failed" }; }
}

async function pollOutcome(sid: string): Promise<{ status?: string; answeredBy?: string; duration?: number; price?: number }> {
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls/${sid}.json`, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return {};
    const j: any = await r.json();
    // Twilio reports price as a negative string (cost), and only a little AFTER the call ends.
    const price = j.price != null && j.price !== "" ? Math.abs(parseFloat(j.price)) : undefined;
    return { status: j.status, answeredBy: j.answered_by || undefined, duration: j.duration ? parseInt(j.duration) : undefined, price };
  } catch { return {}; }
}

async function main() {
  console.log(`\nVoice outreach — ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Input: ${INPUT}`);
  console.log(`Recording: ${BASE_URL}/voice/${AUDIO}`);
  if (!DRY_RUN) console.log(`From: ${FROM}   Pace: 1 call / ${DELAY_SEC}s${LIMIT ? `   Limit: ${LIMIT}` : ""}`);

  // Business-hours guard
  const bh = withinBusinessHours();
  console.log(`Warsaw time: ${bh.warsaw}  (business hours Mon–Fri 09:00–17:00)`);
  if (!bh.ok && !DRY_RUN && !FORCE) {
    console.error("Outside business hours — refusing to dial. Re-run during 09:00–17:00 Warsaw, or pass --force.");
    process.exit(1);
  }

  const rows = parseCsv(readFileSync(INPUT, "utf-8"));
  console.log(`Parsed ${rows.length} rows.`);

  const suppression = await fetchSuppression();
  console.log(`Suppression list: ${suppression.size} number(s).`);

  // Build the call list, deduping and counting skips.
  const seen = new Set<string>();
  const skip = { noPhone: 0, invalid: 0, duplicate: 0, suppressed: 0, alreadyCalled: 0 };
  const queue: { to: string; company: string }[] = [];
  for (const row of rows) {
    const rawPhone = pick(row, PHONE_KEYS);
    if (!rawPhone) { skip.noPhone++; continue; }
    const to = toE164(rawPhone);
    if (!to) { skip.invalid++; console.log(`  ! invalid number skipped: "${rawPhone}"`); continue; }
    if (seen.has(to)) { skip.duplicate++; continue; }
    seen.add(to);
    if (suppression.has(to)) { skip.suppressed++; continue; }
    if (alreadyCalled(to)) { skip.alreadyCalled++; continue; }
    queue.push({ to, company: pick(row, NAME_KEYS) });
  }

  const callList = LIMIT > 0 ? queue.slice(0, LIMIT) : queue;
  console.log(`\nTo call: ${callList.length}${LIMIT && queue.length > LIMIT ? ` (capped from ${queue.length})` : ""}`);
  console.log(`Skipped: no-phone ${skip.noPhone}, invalid ${skip.invalid}, duplicate ${skip.duplicate}, suppressed ${skip.suppressed}, already-called ${skip.alreadyCalled}\n`);

  if (DRY_RUN) {
    callList.forEach((c, i) => console.log(`  [${i + 1}] ${c.to}${c.company ? `  (${c.company})` : ""}`));
    console.log(`\n[DRY RUN] Would place ${callList.length} call(s). No calls made.`);
    return;
  }
  if (!callList.length) { console.log("Nothing to call."); return; }

  const placed: { to: string; sid: string }[] = [];
  let ok = 0, failed = 0;
  for (let i = 0; i < callList.length; i++) {
    const { to, company } = callList[i];
    process.stdout.write(`[${i + 1}/${callList.length}] ${to}${company ? ` (${company})` : ""} … `);
    const r = await placeCall(to);
    if (r.sid) {
      log[to] = { calledAt: new Date().toISOString(), callSid: r.sid, status: r.status, company: company || undefined };
      saveLog();
      placed.push({ to, sid: r.sid });
      ok++;
      console.log(`queued (${r.sid.slice(0, 10)})`);
    } else {
      failed++;
      console.log(`FAILED: ${r.error}`);
    }
    if (i < callList.length - 1) await sleep(DELAY_SEC * 1000);
  }

  console.log(`\nPlaced: ${ok}   Failed: ${failed}`);

  // Poll Twilio for final per-call outcomes, retrying each call until it reaches a
  // terminal state (a 40s recording outlasts a single poll). Up to ~3 min total.
  if (POLL && placed.length) {
    // Poll each call until Twilio reports a final price (which populates a little AFTER the
    // call ends), so we can total the spend. Caps at ~3.5 min.
    const pending = new Map(placed.map(p => [p.sid, p.to]));
    console.log(`\nPolling outcomes + cost for ${pending.size} call(s)…`);
    for (let round = 0; round < 14 && pending.size; round++) {
      await sleep(15000);
      for (const [sid, to] of [...pending]) {
        const o = await pollOutcome(sid);
        if (o.status) log[to] = { ...log[to], status: o.status, answeredBy: o.answeredBy, duration: o.duration, price: o.price ?? log[to]?.price };
        if (o.price != null) pending.delete(sid);
      }
      saveLog();
    }
    const tally: Record<string, number> = {};
    for (const { to } of placed) { const s = log[to]?.status || "unknown"; tally[s] = (tally[s] || 0) + 1; }
    console.log("Outcomes:", Object.entries(tally).map(([k, v]) => `${k}=${v}`).join("  "));
    const runCost = placed.reduce((s, p) => s + (log[p.to]?.price || 0), 0);
    const totalCost = Object.values(log).reduce((s, e) => s + (e.price || 0), 0);
    const priced = placed.filter(p => log[p.to]?.price != null).length;
    console.log(`Cost this run: $${runCost.toFixed(4)} USD  (${priced}/${placed.length} priced${pending.size ? `, ${pending.size} still computing` : ""})`);
    console.log(`Cumulative logged cost: $${totalCost.toFixed(4)} USD across ${Object.values(log).filter(e => e.price != null).length} priced calls`);
  }
}

main().catch(e => { console.error("Fatal:", e?.message || e); process.exit(1); });
