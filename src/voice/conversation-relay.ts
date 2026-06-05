/**
 * Twilio ConversationRelay <-> tenant-chat bridge: a live Polish voice bot.
 *
 * Twilio handles Polish STT + TTS + turn-taking; this WebSocket only exchanges text.
 * Each caller utterance ("prompt") is run through the EXISTING per-tenant chatbot
 * (getChatForTenant -> chat.chatStream) and streamed back as ConversationRelay "text"
 * token frames, so the phone bot reuses the same retrieval/brain as the web widget.
 *
 * Wiring (in scripts/serve-multi-tenant.ts):
 *   - a /api/voice/relay-twiml route returns <Connect><ConversationRelay url="wss://.../api/voice/relay" .../>
 *   - const server = app.listen(...); attachVoiceRelayWS(server, tenantManager);
 *
 * Env: VOICE_BOT_TENANT (default tenant whose content the bot answers from).
 */
import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";

// The web brain defaults to long, markdown answers; a phone caller needs 1-2 spoken
// sentences. This steers brevity; a hard length cap below is the backstop.
const VOICE_SYSTEM =
  "Rozmawiasz przez telefon jako asystent głosowy. Odpowiadaj BARDZO krótko — jedno, maksymalnie dwa zdania — naturalną, mówioną polszczyzną. Bez markdownu, bez wypunktowań, bez emoji, bez czytania linków. Jeśli nie znasz odpowiedzi, krótko zaproponuj wysłanie SMS-a z linkiem do dema.";

function stripMd(s: string): string {
  return s
    .replace(/\*\*|__/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-•]\s+/gm, "");
}

interface Session { tenantId: string; callSid: string; messages: { role: string; content: string }[]; turn: number; }

export function attachVoiceRelayWS(server: Server, tenantManager: any): void {
  const wss = new WebSocketServer({ server, path: "/api/voice/relay" });

  wss.on("connection", (ws: WebSocket) => {
    const session: Session = { tenantId: process.env.VOICE_BOT_TENANT || "", callSid: "", messages: [], turn: 0 };

    ws.on("message", (raw: any) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "setup") {
        session.callSid = msg.callSid || "";
        session.tenantId = ((msg.customParameters?.tenantId || session.tenantId || "") as string).trim();
        console.log(`[voice-relay] setup call=${session.callSid.slice(0, 10)} tenant=${session.tenantId}`);
        return;
      }
      // Caller started talking over the bot — invalidate the in-flight turn so we stop
      // forwarding its remaining tokens (Twilio already stopped the TTS playback).
      if (msg.type === "interrupt") { session.turn++; return; }
      if (msg.type !== "prompt") return;

      const text = (msg.voicePrompt || "").trim();
      if (!text) return;
      const myTurn = ++session.turn;
      session.messages.push({ role: "user", content: text });
      console.log(`[voice-relay] caller: "${text.slice(0, 80)}"`);

      (async () => {
        let ended = false;
        const endTurn = () => {
          if (ended || myTurn !== session.turn) return;
          ended = true;
          ws.send(JSON.stringify({ type: "text", token: "", last: true }));
        };
        try {
          if (!session.tenantId) {
            ws.send(JSON.stringify({ type: "text", token: "Przepraszam, asystent nie jest jeszcze skonfigurowany.", last: true }));
            return;
          }
          const chat = await tenantManager.getChatForTenant(session.tenantId);
          const llmMessages = [{ role: "system", content: VOICE_SYSTEM }, ...session.messages];
          let spoken = "";
          const resp = await chat.chatStream(llmMessages, session.callSid || session.tenantId, (delta: string) => {
            if (ended || myTurn !== session.turn) return; // interrupted or already capped
            const clean = stripMd(delta);
            if (!clean) return;
            spoken += clean;
            ws.send(JSON.stringify({ type: "text", token: clean, last: false }));
            if (spoken.length > 450) endTurn(); // keep it phone-short; ignore the rest of the stream
          });
          session.messages.push({ role: "assistant", content: resp?.message || spoken });
          endTurn();
        } catch (e: any) {
          console.error(`[voice-relay] error: ${e?.message || e}`);
          if (myTurn === session.turn && !ended) {
            ws.send(JSON.stringify({ type: "text", token: "Przepraszam, mam teraz problem techniczny. Proszę spróbować za chwilę.", last: true }));
          }
        }
      })();
    });

    ws.on("close", () => console.log(`[voice-relay] closed call=${session.callSid.slice(0, 10)}`));
    ws.on("error", (e: any) => console.error(`[voice-relay] ws error: ${e?.message || e}`));
  });

  console.log("[voice-relay] ConversationRelay WebSocket attached at /api/voice/relay");
}
