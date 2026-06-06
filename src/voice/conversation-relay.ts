/**
 * Twilio ConversationRelay <-> Whisp sales-pitch voice bot (Polish).
 *
 * Twilio handles Polish STT + TTS + turn-taking; this WebSocket only exchanges text.
 * Unlike the web widget (which does per-turn RAG retrieval -> ~2s/turn latency), the
 * pitch bot's knowledge is FIXED, so it answers straight from a system prompt with a
 * fast model and short replies. That removes the retrieval round-trip and is what makes
 * it feel snappy on a call. It pitches Whisp to a business owner and answers questions
 * about the product, offering to SMS a demo link.
 *
 * Env: VOICE_LLM_MODEL (default a fast model), OPENROUTER_API_KEY.
 */
import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";

const WHISP_SYSTEM = `Jesteś głosowym asystentem dzwoniącym w imieniu firmy Whisp do właścicieli małych i średnich firm w Polsce. Prowadzisz naturalną rozmowę telefoniczną po polsku.

NAJWAŻNIEJSZE KORZYŚCI — przekazuj je jasno i podkreślaj (zwłaszcza, że to ZA DARMO):
- Na start jest CAŁKOWICIE ZA DARMO.
- Whisp zamienia stronę internetową firmy w inteligentnego czata — jak ChatGPT, ale wyłącznie o tej firmie.
- Czat odpowiada klientom na pytania przez całą dobę, więc klienci od razu się orientują (oferta, ceny, godziny, kontakt) i chętniej zostają klientami.
- Do tego dochodzą automatyzacje, które zdejmują z firmy część pracy — najczęstsze pytania, zbieranie zapytań, kierowanie do właściwej osoby.
- Wdrożenie to jedna linijka kodu na stronie; pomagamy, zajmuje kilka minut.

ZASADY:
- Mów po polsku, ciepło i naturalnie. W ODPOWIEDZIACH na pytania bądź zwięzły — jedno, dwa zdania.
- Odpowiadaj na pytania o Whisp i przekonuj korzyściami z listy wyżej; zawsze podkreśl, że start jest darmowy.
- Jeśli rozmówca jest zainteresowany, zaproponuj wysłanie SMS-em linku do darmowego, gotowego dema zrobionego dla jego strony.
- Jeśli czegoś nie wiesz lub pytanie nie dotyczy Whisp, powiedz krótko, że doślesz informacje albo połączysz z Jakubem — nie zmyślaj.
- Bez markdownu, bez wypunktowań, bez czytania adresów internetowych na głos.`;

function stripMd(s: string): string {
  return s
    .replace(/\*\*|__/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-•]\s+/gm, "");
}

// Fast, retrieval-free streaming completion (OpenRouter). Streams deltas to onToken.
async function streamPitchReply(messages: { role: string; content: string }[], onToken: (d: string) => void): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { const m = "Przepraszam, asystent nie jest jeszcze skonfigurowany."; onToken(m); return m; }
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.VOICE_LLM_MODEL || "openai/gpt-4o-mini", // fast TTFT + solid Polish (verified on OpenRouter)
      messages: [{ role: "system", content: WHISP_SYSTEM }, ...messages],
      stream: true,
      max_tokens: 180,
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
      try { const d = JSON.parse(data)?.choices?.[0]?.delta?.content || ""; if (d) { full += d; onToken(d); } } catch { /* keepalive / partial */ }
    }
  }
  return full;
}

interface Session { callSid: string; messages: { role: string; content: string }[]; turn: number; }

export function attachVoiceRelayWS(server: Server, _tenantManager?: any): void {
  const wss = new WebSocketServer({ server, path: "/api/voice/relay" });

  wss.on("connection", (ws: WebSocket) => {
    const session: Session = { callSid: "", messages: [], turn: 0 };

    ws.on("message", (raw: any) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "setup") {
        session.callSid = msg.callSid || "";
        console.log(`[voice-relay] setup call=${session.callSid.slice(0, 10)}`);
        return;
      }
      if (msg.type === "interrupt") { session.turn++; return; } // caller barged in
      // Keypad fallback for ultra-short answers STT may miss: 1 = Tak, 2 = Nie.
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
        try {
          let spoken = "";
          const full = await streamPitchReply(session.messages, (delta) => {
            if (ended || myTurn !== session.turn) return;
            const clean = stripMd(delta);
            if (!clean) return;
            spoken += clean;
            ws.send(JSON.stringify({ type: "text", token: clean, last: false }));
            if (spoken.length > 400) endTurn(); // keep it phone-short
          });
          session.messages.push({ role: "assistant", content: full || spoken });
          endTurn();
        } catch (e: any) {
          console.error(`[voice-relay] error: ${e?.message || e}`);
          if (myTurn === session.turn && !ended) ws.send(JSON.stringify({ type: "text", token: "Przepraszam, mam teraz problem techniczny. Proszę spróbować za chwilę.", last: true }));
        }
      })();
    });

    ws.on("close", () => console.log(`[voice-relay] closed call=${session.callSid.slice(0, 10)}`));
    ws.on("error", (e: any) => console.error(`[voice-relay] ws error: ${e?.message || e}`));
  });

  console.log("[voice-relay] ConversationRelay WebSocket (Whisp pitch) attached at /api/voice/relay");
}
