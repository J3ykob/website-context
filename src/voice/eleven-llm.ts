/**
 * ElevenLabs Agents <-> Whisp "custom LLM" endpoint (OpenAI Chat Completions, SSE).
 *
 * ElevenLabs runs the call audio: Scribe STT, its own turn-taking model, TTS voices. For every
 * caller turn it POSTs the conversation here and speaks whatever we stream back. The brain is
 * the same as the ConversationRelay bot (conversation-relay.ts): the role-play pitch prompt,
 * Llama on Groq with a hedged fallback, Jev confirming actions. Actions:
 *   [SMS]      -> we text the demo link ourselves (Twilio REST)
 *   [TRANSFER] -> we redirect the call ourselves (register-call mode has no ElevenLabs transfer)
 *   [KONIEC]   -> an `end_call` tool call, which ElevenLabs executes
 *
 * Per-call context (company, description, numbers, conversation id) comes from the agent's
 * system prompt, set to `WHISP_CTX {json with {{dynamic_variables}}}`, or from
 * elevenlabs_extra_body. Their system prompt is otherwise ignored - ours is the source of truth.
 *
 * Env: ELEVEN_LLM_SECRET (bearer ElevenLabs sends), OPENROUTER_API_KEY, JEV_API_KEY, TWILIO_*.
 */
import type { Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import {
  whispSystem, raceReply, stripMd, sendDemoSms, transferCall,
  SMS_TAG, TRANSFER_TAG, END_TAG, SCENE_TAG, SCENE_CALLER_TURNS, type Business,
} from "./conversation-relay.js";
import { classifyTurn, confirmAction, smsAcceptedWithoutTag } from "./turn-classifier.js";
import { ttsClean } from "./tts-sanitize.js";

type Msg = { role: string; content: string };

interface Ctx { conversationId: string; company: string; business: string; prospect: string; callSid: string }

/** Per-conversation state. ElevenLabs calls us more than once per caller turn (speculative_turn
 * starts a reply during silence and may discard it), so counters advance only when the number of
 * caller messages grows, and a scene step-out is pinned to that caller turn: the final request for
 * the turn must get the hint too, not just the discarded speculative one. */
interface Conv { userTurns: number; sceneTurns: number; stepOutAtUserTurn: number; smsSent: boolean; transferred: boolean; lastSeen: number }
const convs = new Map<string, Conv>();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [k, v] of convs) if (v.lastSeen < cutoff) convs.delete(k);
}, 5 * 60_000).unref();

const CTX_PREFIX = "WHISP_CTX";

// Stepping out of the role-play is scripted, not generated: with only a hint the model still kept
// playing reception in 1 of 4 test runs ("…jaki jest numer rejestracyjny?"). The model writes one
// sentence - it sees whether the caller booked or got confused - and the pitch is appended by code.
const STEP_OUT_HINT = "TERAZ kończysz scenkę. Odpowiedz TYLKO jednym krótkim zdaniem, nic więcej: jeśli rozmówca jako klient o coś poprosił albo wybrał termin - potwierdź DOKŁADNIE to jako recepcja („Jasne, [jego termin], zapisuję.”); jeśli jest zdezorientowany, pyta, o co chodzi, albo nie gra - powiedz tylko: „Spokojnie, to była krótka scenka pokazowa.”.";
const PITCH = "Tak może obsługiwać Twoich klientów Whisp: asystent na Twojej stronie, który sam odpowiada i umawia, o każdej porze. Wysłać Ci SMS-em link do darmowego dema?";
const stepOutTail = (firstSentence: string) =>
  /scenk/i.test(firstSentence) ? ` ${PITCH}` : ` I tu przerywam. Brzmi dobrze? ${PITCH}`;

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("");
  return "";
}

function readCtx(body: any, messages: Msg[]): Ctx {
  // ElevenLabs wraps the agent prompt in its own boilerplate ("Task description: You are an AI
  // agent…"), so the marker sits mid-text (offset ~1400 in a live request), not at the start.
  let raw: any = {};
  for (const m of messages) {
    if (m.role !== "system") continue;
    const at = m.content.indexOf(CTX_PREFIX);
    if (at < 0) continue;
    const open = m.content.indexOf("{", at);
    // Values are sanitised of quotes, so the object ends at the first "}" that parses.
    for (let close = m.content.indexOf("}", open); open >= 0 && close > open; close = m.content.indexOf("}", close + 1)) {
      try { raw = JSON.parse(m.content.slice(open, close + 1)); break; } catch { /* keep looking */ }
    }
    break;
  }
  const extra = body?.elevenlabs_extra_body && typeof body.elevenlabs_extra_body === "object" ? body.elevenlabs_extra_body : {};
  const pick = (k: string) => {
    const v = String(extra[k] ?? raw[k] ?? "").trim();
    return v.startsWith("{{") ? "" : v; // an unset dynamic variable stays as its literal template
  };
  return {
    conversationId: pick("conversation_id") || String(body?.user_id || ""),
    company: pick("company").slice(0, 80),
    business: pick("business").slice(0, 300),
    prospect: pick("prospect"),
    callSid: pick("call_sid"),
  };
}

function authorized(req: Request): boolean {
  const secret = process.env.ELEVEN_LLM_SECRET || "";
  if (secret.length < 24) return false; // fail closed, like /api/admin
  const got = Buffer.from((req.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

const q = (s: string, n = 110) => JSON.stringify(s.replace(/\s+/g, " ").trim().slice(0, n));

export async function elevenChatCompletions(req: Request, res: Response): Promise<void> {
  if (!authorized(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const t0 = Date.now();
  const all: Msg[] = (Array.isArray(req.body?.messages) ? req.body.messages : [])
    .map((m: any) => ({ role: String(m?.role || ""), content: text(m?.content) }));
  const ctx = readCtx(req.body, all);
  if (process.env.VOICE_ELEVEN_DEBUG) {
    console.log(`[voice-eleven] DEBUG keys=${Object.keys(req.body || {}).join(",")} roles=${all.map((m) => m.role).join(",")} extra=${JSON.stringify(req.body?.elevenlabs_extra_body ?? null).slice(0, 200)}`);
    for (const m of all.filter((x) => x.role === "system")) console.log(`[voice-eleven] DEBUG system(${m.content.length}) head=${JSON.stringify(m.content.slice(0, 160))} ctxAt=${m.content.indexOf(CTX_PREFIX)}`);
  }
  // Without a conversation id there is no safe key: state is per-request, never shared - a common
  // "anon" key would let concurrent calls advance each other's role-play.
  // Key: ElevenLabs' conversation id, else the Twilio CallSid we pass ourselves (the simulation API
  // leaves {{system__conversation_id}} unsubstituted, so it can't be relied on alone).
  const stableId = ctx.conversationId || ctx.callSid;
  const convKey = stableId || "no-id";
  const conv = (stableId && convs.get(convKey)) || { userTurns: 0, sceneTurns: -1, stepOutAtUserTurn: -1, smsSent: false, transferred: false, lastSeen: 0 };
  conv.lastSeen = Date.now();
  if (stableId) convs.set(convKey, conv);
  const tag = `[voice-eleven] conv=${convKey.slice(-8)}`;

  // Only the dialogue goes to our model; ElevenLabs' system prompt / tool results are dropped.
  const dialogue: Msg[] = all
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  const userCount = dialogue.filter((m) => m.role === "user").length;
  const newTurn = userCount > conv.userTurns;
  conv.userTurns = Math.max(conv.userTurns, userCount);
  const lastUser = [...dialogue].reverse().find((m) => m.role === "user")?.content || "";
  const lastIdx = dialogue.map((m) => m.role).lastIndexOf("user");
  const agentLast = [...dialogue.slice(0, lastIdx)].reverse().find((m) => m.role === "assistant")?.content || "";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const send = (delta: Record<string, unknown>, finish: string | null = null) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "whisp-voice", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  const done = () => { res.write("data: [DONE]\n\n"); res.end(); };
  // A speculative request ElevenLabs discarded closes early. Its reply is never spoken, so it
  // must never send the SMS or transfer the call.
  let abandoned = false;
  res.on("close", () => { if (!res.writableEnded) abandoned = true; });

  // Nothing new from the caller (e.g. a follow-up call after our end_call tool): say nothing.
  if (!lastUser) { send({}, "stop"); done(); return; }

  const biz: Business | null = ctx.company || ctx.business ? { company: ctx.company, business: ctx.business } : null;
  if (newTurn && conv.sceneTurns >= 0 && ++conv.sceneTurns === SCENE_CALLER_TURNS) {
    conv.stepOutAtUserTurn = userCount;
    conv.sceneTurns = 99; // step out once; never re-enter
    console.log(`${tag} scene: telling the model to step out of the role-play`);
  }
  const stepOut = conv.stepOutAtUserTurn === userCount;
  const messages: Msg[] = stepOut ? [...dialogue, { role: "system", content: STEP_OUT_HINT }] : dialogue;
  console.log(`${tag} caller=${q(lastUser)}${newTurn ? "" : " (repeat request)"}`);

  const intentP = classifyTurn(agentLast, lastUser); // parallel; consulted only for actions

  // Stream text as it arrives; hold back only an unclosed "[..." (tags can straddle deltas).
  let pending = "", spoken = "", ttft = 0;
  let wantSms = false, wantTransfer = false, wantEnd = false, sceneStart = false;
  const flush = (final: boolean) => {
    let i: number;
    const strip = (t: string, on: () => void) => { while ((i = pending.indexOf(t)) >= 0) { on(); pending = pending.slice(0, i) + pending.slice(i + t.length); } };
    strip(SMS_TAG, () => { wantSms = true; });
    strip(TRANSFER_TAG, () => { wantTransfer = true; });
    strip(END_TAG, () => { wantEnd = true; });
    strip(SCENE_TAG, () => { sceneStart = true; });
    const k = pending.lastIndexOf("[");
    const hold = !final && k >= 0 && pending.indexOf("]", k) === -1 && pending.length - k <= 24;
    const out = hold ? pending.slice(0, k) : pending;
    pending = hold ? pending.slice(k) : "";
    const clean = ttsClean(stripMd(out));
    if (clean) {
      if (!ttft) ttft = Date.now() - t0;
      spoken += clean;
      send({ content: clean });
    }
  };

  try {
    // Step-out turn: pass the model's first sentence through, then the scripted pitch; the rest of
    // the model's output is dropped.
    let first = "", cut = false;
    const onToken = (d: string) => {
      if (cut) return;
      if (!stepOut) { pending += d; flush(false); return; }
      const already = first.length; // chars of the first sentence already streamed
      first += d;
      const m = first.match(/^[\s\S]{8,}?[.!?…](?=\s|$)/);
      if (m) { cut = true; pending += m[0].slice(already) + stepOutTail(m[0]); flush(false); }
      else { pending += d; flush(false); }
    };
    const reply = await raceReply(messages, onToken, whispSystem("llm", biz));
    if (!reply.ok && !reply.text) { pending += "Przepraszam, mam teraz problem techniczny. Proszę spróbować za chwilę."; }
    else if (stepOut && !cut) { pending += stepOutTail(first); }
    flush(true);
    if (sceneStart && conv.sceneTurns < 0) conv.sceneTurns = 0;
    console.log(`${tag} ttft=${ttft || -1}ms total=${Date.now() - t0}ms llm=${reply.provider}${reply.hedged ? "(hedge)" : ""} bot=${q(spoken, 160)}`);

    const intent = await intentP;
    if (abandoned) { console.log(`${tag} request abandoned by ElevenLabs (speculative) - no actions`); return; }
    // A reply that ends in a question is waiting for an answer: never hang up on it.
    const asksBack = /\?\s*$/.test(spoken);
    const endOk = wantEnd && !asksBack && confirmAction(intent, "end");
    const acts: string[] = [];
    const smsByJev = !wantSms && smsAcceptedWithoutTag(intent, agentLast);
    if (wantSms) acts.push(`sms-tag->${confirmAction(intent, "sms") ? "ok" : "BLOCKED"}`);
    if (smsByJev) acts.push("sms-by-jev(no tag)");
    if (wantTransfer) acts.push(`transfer-tag->${confirmAction(intent, "human") ? "ok" : "BLOCKED"}`);
    if (wantEnd) acts.push(`end-tag->${endOk ? "ok" : asksBack ? "BLOCKED(bot asked a question)" : "BLOCKED(jev)"}`);
    console.log(`${tag} ${intent ? `jev=${intent.intent}(${intent.intentConfidence.toFixed(2)}) sms=${intent.wantsSms.toFixed(2)} human=${intent.wantsHuman.toFixed(2)} @${intent.ms}ms` : "jev=none"}${acts.length ? " " + acts.join(" ") : ""}`);

    if (((wantSms && confirmAction(intent, "sms")) || smsByJev) && !conv.smsSent && ctx.prospect) {
      conv.smsSent = true;
      sendDemoSms(ctx.prospect).then((ok) => console.log(`${tag} demo SMS to ${ctx.prospect}: ${ok ? "sent" : "FAILED"}`));
    }
    if (wantTransfer && confirmAction(intent, "human") && !conv.transferred && ctx.callSid) {
      conv.transferred = true;
      const human = process.env.VOICE_FORWARD_TO || "";
      // let "łączę z Jakubem" play before the redirect ends the ElevenLabs stream
      setTimeout(() => { transferCall(ctx.callSid, human).then((ok) => console.log(`${tag} handoff ${ok ? "redirected" : "FAILED"}`)); }, 3500);
    } else if (endOk) {
      // ElevenLabs executes end_call after finishing the goodbye it is already speaking.
      send({ tool_calls: [{ index: 0, id: `call_end_${Date.now().toString(36)}`, type: "function", function: { name: "end_call", arguments: JSON.stringify({ reason: "Rozmowa zakończona" }) } }] });
      send({}, "tool_calls");
      done();
      return;
    }
    send({}, "stop");
    done();
  } catch (e: any) {
    console.error(`${tag} error: ${e?.message || e}`);
    if (!res.writableEnded) { send({ content: "Przepraszam, mam teraz problem techniczny." }, "stop"); done(); }
  }
}

/**
 * Twilio voice webhook for calls handled by the ElevenLabs agent ("register call" mode: our
 * Twilio number and account, ElevenLabs returns the TwiML that connects the audio).
 * Query: company, business (contact-database context). Env: ELEVENLABS_API_KEY, ELEVEN_AGENT_ID.
 */
export async function elevenRegisterTwiml(req: Request, res: Response): Promise<void> {
  const key = process.env.ELEVENLABS_API_KEY, agent = process.env.ELEVEN_AGENT_ID;
  const clean = (v: unknown, n: number) => String(v ?? "").replace(/["\\\u0000-\u001f]/g, " ").trim().slice(0, n);
  const to = clean(req.body?.To || req.body?.Called, 32), from = clean(req.body?.From || req.body?.Caller, 32);
  const company = clean(req.query.company, 80);
  const vars = {
    company,
    // first_message: "…w sprawie czatu na {{greeting_target}}. Czy to dobry moment?"
    greeting_target: company ? `stronę ${company}` : "Waszą stronę internetową",
    business: clean(req.query.business, 300),
    prospect: to, // outbound: we dialled them, so To is the prospect's number
    call_sid: clean(req.body?.CallSid, 64),
  };
  const fail = () => { res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say language="pl-PL">Przepraszamy, wystąpił problem techniczny.</Say><Hangup/></Response>`); };
  if (!key || !agent) { console.error("[voice-eleven] ELEVENLABS_API_KEY / ELEVEN_AGENT_ID not set"); fail(); return; }
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/convai/twilio/register-call", {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agent, from_number: from, to_number: to, direction: "outbound", conversation_initiation_client_data: { dynamic_variables: vars } }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.text();
    if (!r.ok) { console.error(`[voice-eleven] register-call HTTP ${r.status}: ${body.slice(0, 200)}`); fail(); return; }
    // The API returns the TwiML itself (or a JSON-encoded string of it).
    const twiml = body.trimStart().startsWith("<") ? body : JSON.parse(body);
    console.log(`[voice-eleven] registered call=${vars.call_sid.slice(2, 10)} company=${q(vars.company, 40)}`);
    res.type("text/xml").send(twiml);
  } catch (e: any) {
    console.error(`[voice-eleven] register-call failed: ${e?.message || e}`);
    fail();
  }
}
