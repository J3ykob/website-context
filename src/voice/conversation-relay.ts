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

const WHISP_SYSTEM = `Jesteś głosowym asystentem dzwoniącym w imieniu firmy Whisp do właścicieli małych i średnich firm w Polsce. Prowadzisz rozmowę telefoniczną.

CZYM JEST WHISP: inteligentny widget czatu AI. Czyta stronę internetową firmy i odpowiada jej klientom na pytania przez całą dobę, po polsku, jak ChatGPT — ale wyłącznie o tej konkretnej firmie (oferta, godziny, ceny, kontakt). Instalacja to wklejenie jednej linijki kodu na stronę (pomagamy, zajmuje kilka minut). Pierwsze firmy dostają widget za darmo. Korzyści: mniej powtarzalnych pytań, obsługa klienta 24/7, więcej zapytań zamienionych w klientów.

ZASADY:
- Mów PO POLSKU, krótko i naturalnie — maksymalnie jedno, dwa zdania na turę. To rozmowa, nie monolog.
- Bądź ciepły, konkretny i lekko entuzjastyczny, nigdy nachalny.
- Po krótkim przedstawieniu zapytaj, czy rozmówca ma pytania, i odpowiadaj na nie zwięźle.
- Jeśli rozmówca jest zainteresowany, zaproponuj wysłanie SMS-em linku do darmowego, gotowego dema zrobionego dla jego strony.
- Jeśli czegoś nie wiesz lub pytanie nie dotyczy Whisp, powiedz krótko, że dośle informacje albo połączy z Jakubem — nie zmyślaj.
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
