#!/usr/bin/env tsx
/**
 * Fetch (and optionally transcribe) Twilio call recordings for the voice campaign.
 *
 * Recording is enabled at dial time by voice-outreach.ts (dual-channel: ch1 = our pitch,
 * ch2 = the prospect). This script pulls each call's recording into data/voice-recordings/
 * and, with --transcribe, runs local Whisper (mlx-whisper, Polish) on the PROSPECT's channel
 * so you can read what they said and tune the pitch. Transcripts are written back into
 * data/voice-campaign-log.json.
 *
 * Usage:
 *   source ~/.gtm-os/.env && npx tsx scripts/voice-recordings.ts [--transcribe] [--sid CAxxxx] [--limit N]
 *
 * Whisper: installed in ~/.whisper-venv (override the binary with MLX_WHISPER_BIN, or the
 * model with WHISPER_MODEL). Nothing leaves your machine; no cloud API.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { execFileSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");
const LOG_PATH = resolve(DATA_DIR, "voice-campaign-log.json");
const REC_DIR = resolve(DATA_DIR, "voice-recordings");

const SID = process.env.TWILIO_ACCOUNT_SID || "";
const TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
if (!SID || !TOKEN) { console.error("TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN required"); process.exit(1); }
const authHeader = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");

const TRANSCRIBE = process.argv.includes("--transcribe");
const WHISPER_BIN = process.env.MLX_WHISPER_BIN || resolve(homedir(), ".whisper-venv/bin/mlx_whisper");
const WHISPER_MODEL = process.env.WHISPER_MODEL || "mlx-community/whisper-large-v3-turbo";
function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : undefined; }
const ONLY_SID = arg("--sid");
const LIMIT = parseInt(arg("--limit", "0") || "0");

interface CallRecord { callSid?: string; company?: string; status?: string; duration?: number; recordingSid?: string; recordingFile?: string; transcript?: string; [k: string]: any; }
let log: Record<string, CallRecord> = {};
try { log = JSON.parse(readFileSync(LOG_PATH, "utf-8")); } catch {}
function saveLog() { writeFileSync(LOG_PATH, JSON.stringify(log, null, 2)); }
if (!existsSync(REC_DIR)) mkdirSync(REC_DIR, { recursive: true });

const safe = (s: string) => (s || "rec").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);

async function recordingsForCall(callSid: string): Promise<any[]> {
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings.json?CallSid=${callSid}`, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return [];
  return ((await r.json()) as any).recordings || [];
}
async function download(url: string, dest: string): Promise<boolean> {
  const r = await fetch(url, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) return false;
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return true;
}

// Transcribe the prospect's channel (ch2). Falls back to the full mix if the recording
// isn't dual-channel. Returns the transcript text, or null on failure.
function transcribe(mp3Path: string): string | null {
  // Twilio dual-channel: channel 1 (ffmpeg c0) = audio Twilio RECEIVES = the prospect;
  // channel 2 (c1) = audio Twilio PLAYS = our pitch. We want the prospect → c0.
  // Use a dot-free stem so mlx-whisper's output .txt path is predictable.
  const stem = basename(mp3Path).replace(/\.[^.]+$/, "").replace(/\./g, "_") + "_prospect";
  const wav = resolve(REC_DIR, stem + ".wav");
  try {
    try {
      execFileSync("ffmpeg", ["-y", "-i", mp3Path, "-af", "pan=mono|c0=c0", "-ar", "16000", "-ac", "1", wav], { stdio: "ignore" });
    } catch {
      execFileSync("ffmpeg", ["-y", "-i", mp3Path, "-ar", "16000", "-ac", "1", wav], { stdio: "ignore" });
    }
    if (!existsSync(WHISPER_BIN)) { console.error(`    whisper not found at ${WHISPER_BIN} (set MLX_WHISPER_BIN)`); return null; }
    // HF_HUB_OFFLINE=1: the model is cached after first use; without this mlx-whisper hangs
    // on a Hugging Face network check. Set HF_HUB_OFFLINE=0 once if you need a new model.
    execFileSync(WHISPER_BIN, [wav, "--model", WHISPER_MODEL, "--language", "pl", "--output-dir", REC_DIR, "--output-format", "txt"], { stdio: "ignore", timeout: 300000, env: { ...process.env, HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? "1" } });
    const txt = resolve(REC_DIR, stem + ".txt");
    return existsSync(txt) ? readFileSync(txt, "utf-8").trim() : null;
  } catch (e: any) { console.error("    transcribe error:", e?.message || e); return null; }
}

async function main() {
  let entries = Object.entries(log).filter(([, e]) => e.callSid && (!ONLY_SID || e.callSid === ONLY_SID));
  if (LIMIT > 0) entries = entries.slice(0, LIMIT);
  console.log(`Recordings for ${entries.length} call(s).  transcribe=${TRANSCRIBE}${TRANSCRIBE ? `  model=${WHISPER_MODEL}` : ""}\n`);
  let got = 0;
  for (const [num, e] of entries) {
    const recs = await recordingsForCall(e.callSid!);
    if (!recs.length) { console.log(`  ${e.company || num}: no recording yet (Twilio still processing, or not recorded)`); continue; }
    const rec = recs[0];
    e.recordingSid = rec.sid;
    const dest = resolve(REC_DIR, `${safe(e.company || num)}-${rec.sid}.mp3`);
    const ok = await download(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/${rec.sid}.mp3`, dest);
    if (ok) { e.recordingFile = dest; got++; }
    let line = `  ${(e.company || num).padEnd(26)} ${String(rec.duration || e.duration || "?") + "s"}  ${ok ? basename(dest) : "DOWNLOAD FAILED"}`;
    if (ok && TRANSCRIBE) {
      const t = transcribe(dest);
      if (t !== null) { e.transcript = t; line += `\n      prospect: "${t || "(no speech detected)"}"`; }
    }
    console.log(line);
    saveLog();
  }
  console.log(`\nDownloaded ${got} recording(s) to ${REC_DIR}`);
  if (TRANSCRIBE) console.log("Transcripts saved into data/voice-campaign-log.json (transcript field).");
}
main().catch(e => { console.error("Fatal:", e?.message || e); process.exit(1); });
