/**
 * Twilio ConversationRelay <-> Whisp sales-pitch voice bot (Polish), with SMS lead capture.
 *
 * Twilio handles Polish STT + TTS + turn-taking; this WebSocket only exchanges text.
 * Knowledge is fixed (no RAG -> low latency): a fast model answers from a system prompt.
 * When the caller is interested, the model emits a hidden [SMS] tag — we already have the
 * caller's number (we dialed them), so we fire a demo-link SMS automatically instead of the
 * fragile "dictate your phone number" flow. The tag is stripped from what's spoken.
 *
 * Env: VOICE_LLM_MODEL, OPENROUTER_API_KEY, TWILIO_* (for the SMS), VOICE_DEMO_SMS.
 */
import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";

const SMS_TAG = "[SMS]";

const WHISP_SYSTEM = `Jesteś głosowym asystentem dzwoniącym w imieniu firmy Whisp do właścicieli małych i średnich firm w Polsce. Prowadzisz naturalną, szybką rozmowę telefoniczną po polsku.

NAJWAŻNIEJSZE KORZYŚCI — przekazuj jasno (zwłaszcza, że to ZA DARMO):
- Na start jest CAŁKOWICIE ZA DARMO.
- Whisp zamienia stronę internetową firmy w inteligentnego czata — jak ChatGPT, ale wyłącznie o tej firmie.
- Czat odpowiada klientom przez całą dobę, więc klienci od razu się orientują i chętniej zostają klientami.
- Automatyzacje zdejmują z firmy część pracy: najczęstsze pytania, zbieranie zapytań, kierowanie do właściwej osoby.
- Wdrożenie to jedna linijka kodu; pomagamy, zajmuje kilka minut.

ZASADY ROZMOWY:
- Mów po polsku, bardzo krótko i naturalnie — jedno, maksymalnie dwa krótkie zdania na turę. Bez monologów.
- NIE pytaj o numer telefonu — już go mamy, bo to my dzwonimy.
- Gdy rozmówca jest zainteresowany demem, prosi o link, mówi "tak"/"wyślij"/"poproszę", albo chce więcej informacji: powiedz krótko i ciepło, że właśnie wysyłasz mu SMS-em link do darmowego, gotowego dema, i NA SAMYM KOŃCU swojej wypowiedzi dopisz dokładnie znacznik ${SMS_TAG}. Ten znacznik jest niewidoczny i nie jest czytany. Wyślij SMS tylko raz w rozmowie.
- Jeśli czegoś nie wiesz lub pytanie nie dotyczy Whisp, powiedz krótko, że dośle informacje albo połączy z Jakubem — nie zmyślaj.
- Bez markdownu, bez wypunktowań, bez czytania adresów internetowych na głos.`;

function stripMd(s: string): string {
  return s
    .replace(/\*\*|__/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-•]\s+/gm, "");
}

async function streamPitchReply(messages: { role: string; content: string }[], onToken: (d: string) => void): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { const m = "Przepraszam, asystent nie jest jeszcze skonfigurowany."; onToken(m); return m; }
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.VOICE_LLM_MODEL || "openai/gpt-4o-mini",
      messages: [{ role: "system", content: WHISP_SYSTEM }, ...messages],
      stream: true,
      max_tokens: 130, // short, conversational turns
      temperature: 0.6,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok || !r.body) { const m = "Przepraszam, mam teraz problem techniczny. Proszę spróbować za chwilę."; onToken(m); return m; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return full;
      try { const d = JSON.parse(data)?.choices?.[0]?.delta?.content || ""; if (d) { full += d; onToken(d); } } catch { /* keepalive */ }
    }
  }
  return full;
}

// Fire the demo-link SMS to the caller (we already have their number — we dialed them).
async function sendDemoSms(to: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !tok || !from || !to) return false;
  const body = process.env.VOICE_DEMO_SMS || "Cześć! Tu Whisp. Oto link do darmowego dema chatbota AI dla Twojej firmy: https://whisp.so — odezwiemy się, żeby pomóc z wdrożeniem. Jakub";
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch { return false; }
}

interface Session { callSid: string; prospect: string; messages: { role: string; content: string }[]; turn: number; smsSent: boolean; }

export function attachVoiceRelayWS(server: Server, _tenantManager?: any): void {
  const wss = new WebSocketServer({ server, path: "/api/voice/relay" });

  wss.on("connection", (ws: WebSocket) => {
    const session: Session = { callSid: "", prospect: "", messages: [], turn: 0, smsSent: false };

    ws.on("message", (raw: any) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "setup") {
        session.callSid = msg.callSid || "";
        session.prospect = String(msg.customParameters?.prospect || msg.to || "").trim();
        console.log(`[voice-relay] setup call=${session.callSid.slice(0, 10)} prospect=${session.prospect}`);
        return;
      }
      if (msg.type === "interrupt") { session.turn++; return; }
      if (msg.type === "dtmf") {
        const t = String(msg.digit || "") === "1" ? "Tak" : String(msg.digit || "") === "2" ? "Nie" : "";
        if (!t) return;
        msg = { type: "prompt", voicePrompt: t };
      }
      if (msg.type !== "prompt") return;

      const text = (msg.voicePrompt || "").trim();
      if (!text) return;
      const myTurn = ++session.turn;
      session.messages.push({ role: "user", content: text });
      console.log(`[voice-relay] caller: "${text.slice(0, 90)}"`);

      (async () => {
        let ended = false;
        const endTurn = () => { if (ended || myTurn !== session.turn) return; ended = true; ws.send(JSON.stringify({ type: "text", token: "", last: true })); };

        // Stream to TTS while hiding the [SMS] tag (which may straddle deltas) and detecting it.
        let pending = "", wantSms = false, spokenLen = 0;
        const KEEP = SMS_TAG.length - 1;
        const flush = (final: boolean) => {
          let i: number;
          while ((i = pending.indexOf(SMS_TAG)) >= 0) { wantSms = true; pending = pending.slice(0, i) + pending.slice(i + SMS_TAG.length); }
          let out = "";
          if (final) { out = pending; pending = ""; }
          else if (pending.length > KEEP) { out = pending.slice(0, pending.length - KEEP); pending = pending.slice(pending.length - KEEP); }
          if (!out || ended || myTurn !== session.turn) return;
          const clean = stripMd(out);
          if (clean) { spokenLen += clean.length; ws.send(JSON.stringify({ type: "text", token: clean, last: false })); }
        };

        try {
          const fullRaw = await streamPitchReply(session.messages, (delta) => {
            if (ended || myTurn !== session.turn) return;
            pending += delta;
            flush(false);
            if (spokenLen > 450) endTurn();
          });
          flush(true);
          session.messages.push({ role: "assistant", content: (fullRaw || "").split(SMS_TAG).join("").trim() });
          endTurn();
          if (wantSms && !session.smsSent && session.prospect) {
            session.smsSent = true;
            const ok = await sendDemoSms(session.prospect);
            console.log(`[voice-relay] demo SMS to ${session.prospect}: ${ok ? "sent" : "FAILED"}`);
          }
        } catch (e: any) {
          console.error(`[voice-relay] error: ${e?.message || e}`);
          if (myTurn === session.turn && !ended) ws.send(JSON.stringify({ type: "text", token: "Przepraszam, mam teraz problem techniczny. Proszę spróbować za chwilę.", last: true }));
        }
      })();
    });

    ws.on("close", () => console.log(`[voice-relay] closed call=${session.callSid.slice(0, 10)}`));
    ws.on("error", (e: any) => console.error(`[voice-relay] ws error: ${e?.message || e}`));
  });

  console.log("[voice-relay] ConversationRelay WebSocket (Whisp pitch + SMS capture) attached at /api/voice/relay");
}
