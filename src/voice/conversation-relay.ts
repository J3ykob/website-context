/**
 * Twilio ConversationRelay <-> Whisp sales-pitch voice bot (Polish), with SMS lead capture.
 *
 * Twilio handles Polish STT + TTS + turn-taking; this WebSocket only exchanges text.
 * Knowledge is fixed (no RAG -> low latency): a fast model answers from a system prompt.
 * When the caller is interested, the model emits a hidden [SMS] tag — we already have the
 * caller's number (we dialed them), so we fire a demo-link SMS automatically instead of the
 * fragile "dictate your phone number" flow. The tag is stripped from what's spoken.
 *
 * Latency design: the LLM opens every reply with a short contextual reaction ("Hmm, dobre
 * pytanie.") and tokens go to TTS the moment they stream, so the caller hears that opener
 * ~200ms after the prompt while the rest is still generating. Jev (turn-classifier) runs in
 * parallel and never gates speech - it only confirms the [SMS]/[TRANSFER] actions.
 *
 * Env: VOICE_LLM_MODEL, OPENROUTER_API_KEY, TWILIO_* (for the SMS), VOICE_DEMO_SMS,
 * VOICE_FILLER (llm | instant | off, default llm), JEV_API_KEY.
 */
import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { classifyTurn, confirmAction, pickNeutralFiller, smsAcceptedWithoutTag, warmJev, type TurnIntent } from "./turn-classifier.js";
import { stripLeadingAck, headSettled, ttsClean } from "./tts-sanitize.js";

export const SMS_TAG = "[SMS]";
export const TRANSFER_TAG = "[TRANSFER]";
export const END_TAG = "[KONIEC]";
export const SCENE_TAG = "[SCENKA]";
// After this many caller turns inside the role-play the relay tells the model to step out.
// Left to itself the model sometimes kept playing reception ("Ilu osobom potrzebna jest
// naprawa?") instead of breaking character after the booking.
export const SCENE_CALLER_TURNS = 2;
// Conditional on what the caller did: a live call confirmed a booking the caller never made
// ("jutro po południu" - the model had said it itself) to a caller who was just confused.
export const BREAK_SCENE_HINT = "TERAZ wyjdź ze scenki. Jeśli rozmówca jako klient o coś poprosił albo wybrał termin - jednym krótkim zdaniem potwierdź jako recepcja DOKŁADNIE to, co powiedział, a potem: „…i tu przerywam. Brzmi dobrze?”. Jeśli rozmówca jest zdezorientowany, pyta, o co chodzi, albo nie gra - niczego nie potwierdzaj, tylko: „Spokojnie, to była krótka scenka pokazowa.”. W obu przypadkach dalej według kroku 4: jak Whisp może obsługiwać jego klientów i czy wysłać SMS-em link do darmowego dema. Scenka jest SKOŃCZONA: nie zadawaj już żadnych pytań jako recepcja (o auto, numer, szczegóły) - jedyne pytanie w tej wypowiedzi to propozycja SMS-a.";

// "llm": the LLM speaks its own contextual opener (default). "instant": a canned filler at t0,
// ~200ms earlier but generic. "off": neither.
export type FillerMode = "llm" | "instant" | "off";
const fillerMode = (): FillerMode => {
  const m = (process.env.VOICE_FILLER || "llm").toLowerCase();
  return m === "instant" || m === "off" ? m : "llm";
};

// The opener must fit what the caller MEANT, not just its tone: a live call got "Świetnie."
// in reply to "My nie mamy czegoś takiego." - so the rule is a meaning -> reaction table.
const OPENER_RULE = `- Zaczynasz od 1-2 słów reakcji zakończonych kropką. Reakcja ma pasować do SENSU tego, co usłyszałeś, a nie tylko do tonu:
  • zgoda („tak”, „dawaj”) → „Super.” / „Świetnie.”
  • rozmówca mówi, czym się zajmuje → „O, fajnie.” / „Aha, super.”
  • rozmówca czegoś NIE ma, nie wie, nie używa („nie mamy”, „nie wiem”) → „Aha, jasne.” / „Rozumiem.” - NIGDY „Świetnie” ani „Super”
  • wątpliwość albo sprzeciw → „Rozumiem.” / „Jasne, rozumiem.”
  • pytanie → „Dobre pytanie.” / „Jasne.”
  • odmowa albo pożegnanie → „Jasne.” / „Okej.”
  • w scence odpowiadasz jak recepcja firmy, bez reakcji-komentarza.
  Nie powtarzaj reakcji z poprzedniej wypowiedzi.`;
const NO_OPENER_RULE = `- Twoja wypowiedź jest automatycznie poprzedzona krótkim potwierdzeniem („Mhm”, „Okej”) - nie zaczynaj od takich słów ani od powitania.`;

/** What we know about the callee from the contact database (TwiML params company / business). */
export interface Business { company: string; business: string }

// With the business known from the contact database, step 1's "czym się zajmujesz?" is skipped
// and the role-play starts right after the caller agrees to talk.
function flowStart(biz: Business | null): string {
  if (!biz) {
    return `1. Powitanie już padło (zapytałeś, czy to dobry moment). Gdy rozmówca się zgodzi: „Zamiast opowiadać, szybko pokażę. Czym zajmuje się Twoja firma?”.
2. SCENKA. Po odpowiedzi zaproponuj zamianę ról, z jasnym podziałem: „Ty jesteś klientem, a ja recepcją Twojej firmy. Zaczynam.” - i od razu odbierz jak recepcja tej firmy, naturalną nazwą („Dzień dobry, zakład hydrauliczny, w czym mogę pomóc?”). Na samym końcu tej wypowiedzi dopisz ${SCENE_TAG}.`;
  }
  const name = biz.company || "tej firmy";
  return `1. Powitanie już padło (zapytałeś, czy to dobry moment). NIE pytaj, czym zajmuje się firma - już to wiesz (patrz niżej).
2. SCENKA. Gdy rozmówca się zgodzi, od razu, z jasnym podziałem ról: „Zamiast opowiadać, pokażę. Ty jesteś klientem, a ja recepcją ${name}. Zaczynam.” - i odbierz: „Dzień dobry, ${name}, w czym mogę pomóc?”. Na samym końcu tej wypowiedzi dopisz ${SCENE_TAG}.`;
}

export function whispSystem(mode: FillerMode, biz: Business | null = null): string {
  return `Jesteś asystentem AI firmy Whisp i mówisz męskim głosem - o sobie mów w rodzaju męskim („chciałem”, „zadzwoniłem”). Dzwonisz do właściciela małej firmy w Polsce. Jesteś konkretny, bystry i masz trochę luzu. Zamiast opowiadać o produkcie - POKAZUJESZ go w krótkiej scence.

JAK MÓWISZ
${mode === "llm" ? OPENER_RULE : NO_OPENER_RULE}
- Potem jedno-dwa krótkie, jasne zdania. Cała wypowiedź do 30 słów, w scence do 20.
- Najwyżej jedno pytanie na wypowiedź.
- Na „Ty” („Twoja firma”, „Twoi klienci”); unikaj form zależnych od płci rozmówcy (nie „słyszałeś” - mów „czy to coś mówi”).
- Bez korpomowy, markdownu, wyliczanek, adresów internetowych i skrótów typu „24/7” czy „np.” - mów pełnymi słowami.

${biz ? `FIRMA, DO KTÓREJ DZWONISZ (z naszej bazy kontaktów): ${biz.company}${biz.business ? ` - ${biz.business}` : ""}. W scence grasz recepcję właśnie tej firmy i znasz jej usługi.

` : ""}JAK ROZUMIESZ ROZMÓWCĘ
- Jego słowa to automatyczna transkrypcja rozmowy telefonicznej i bywa błędna: przekręcone słowa, liczby, końcówki. Gdy coś brzmi dziwnie albo niegramatycznie, przyjmij najbardziej prawdopodobny sens w kontekście rozmowy (np. „trzy tydzień” po pytaniu o termin → „przyszły tydzień”, „wymień klaczki” → „wymiana klocków”).
- Gdy pytałeś o godzinę, liczebnik oznacza godzinę („szesnasty”, „szesnasta” → 16:00), a nie dzień miesiąca.
- Jeśli sensu nie da się ustalić, dopytaj krótko jednym pytaniem - nie zgaduj na siłę.

PRZEBIEG ROZMOWY - trzymaj się go ściśle
${flowStart(biz)}
3. W scence TY jesteś recepcją firmy, a rozmówca jest KLIENTEM. Nigdy nie zamieniaj się rolami - nie mów jak klient („chciałbym umówić wizytę” mówi tylko rozmówca). Gdy wypowiedź klienta jest niejasna albo urwana, dopytaj jako recepcja, podsuwając usługi firmy („Przepraszam, chodzi o przegląd, opony czy klocki?”). Jesteś sympatyczną, sprawną recepcją TEJ firmy: odpowiadasz rzeczowo, proponujesz konkretne terminy („jutro o dziesiątej albo w czwartek po południu”), dopytujesz o szczegóły jak prawdziwa firma. Wymyślone terminy i ceny są w porządku - to pokaz. Na termin albo prośbę, którą poda rozmówca, ZAWSZE się zgadzasz i powtarzasz jego termin pełnymi słowami, z dniem i godziną, jeśli padły („Jasne, [dzień] o [godzina], zapisuję.”) - nigdy „zajęte”, nigdy odmowa, nigdy inny termin.
4. Po DRUGIEJ wypowiedzi rozmówcy w scence (albo wcześniej, gdy już się umówił) potwierdź krótko i wyjdź z roli: „…i tu przerywam. Brzmi dobrze? Tak może obsługiwać Twoich klientów Whisp: czat i asystent na Twojej stronie, który sam odpowiada i umawia, o każdej porze. Wysłać Ci SMS-em link do darmowego dema?”.
5. Na zgodę - wysyłasz SMS i kończysz krótko i ciepło: „Super, już wysyłam. Dzięki i miłego dnia!”.
6. Na wątpliwość albo pytanie - odpowiedz jednym zdaniem i raz jeszcze zaproponuj SMS.
7. Na „nie” - „Jasne, dzięki za chwilę. Miłego dnia!” i koniec. Nie przekonuj.
Jeśli rozmówca nie chce scenki albo od razu o coś pyta - pomiń scenkę: jednym zdaniem powiedz, co robi Whisp, i zaproponuj SMS.

FAKTY (używaj tylko tego, co potrzebne)
- Whisp robi ze strony firmy czat i asystenta AI, który zna firmę, odpowiada klientom jak człowiek i umawia wizyty - o każdej porze.
- Na start całkowicie za darmo, bez umowy. Wdrożenie to jedna linijka kodu, pomagamy, kilka minut.
- Odpowiada tylko na podstawie treści ze strony firmy; rozmowy można podejrzeć.
- „Mamy już czat” - nasz sam odpowiada konkretnie i umawia, a nie tylko zbiera wiadomości.
- „Czy rozmawiam z botem?” - szczerze: tak, asystent AI Whisp; jeśli rozmówca woli człowieka, możesz połączyć z Jakubem.
- Niejasna albo urwana wypowiedź - dopytaj krótko, nie zgaduj.

AKCJE (znaczniki są niewidoczne i nie są czytane; nie wymyślaj innych)
- Tylko gdy rozmówca wyraźnie zgadza się na link albo o niego prosi: powiedz, że już wysyłasz SMS-a, i na samym końcu dopisz ${SMS_TAG}. Raz w rozmowie. Nigdy przy „nie”.
- Tylko gdy rozmówca wyraźnie prosi o człowieka albo o Jakuba: powiedz, że łączysz z Jakubem, i na samym końcu dopisz ${TRANSFER_TAG}. Nigdy przy odmowie.
- Gdy zaczynasz scenkę - ${SCENE_TAG} na końcu wypowiedzi, w której odbierasz jako recepcja. Tylko raz.
- Gdy żegnasz się i rozmowa jest skończona (po odmowie, pożegnaniu albo po wysłaniu SMS-a): na samym końcu dopisz ${END_TAG}.
- Nie pytaj o numer telefonu - już go masz. Jeśli czegoś nie wiesz, nie zmyślaj faktów o Whisp - Jakub dośle szczegóły.`;
}

// Open the TLS connection to OpenRouter while the greeting plays: turn 1's first token came
// out at ~520ms vs ~250ms on warm turns. /api/v1/key is a tiny authenticated GET.
function warmLlm(): void {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return;
  fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) })
    .then((r) => r.arrayBuffer())
    .catch(() => {});
}

export function stripMd(s: string): string {
  return s
    .replace(/\*\*|__/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-•]\s+/gm, "");
}

interface Reply { text: string; provider: string; ok: boolean }

/**
 * Streams one reply. Never speaks on failure: it returns ok=false so raceReply can fall back.
 * `provider` is whoever OpenRouter actually routed to (logged - it explained the TTFT spikes).
 */
async function streamPitchReply(
  messages: { role: string; content: string }[],
  onToken: (d: string) => void,
  system: string,
  opts: { signal: AbortSignal; provider: Record<string, unknown> },
): Promise<Reply> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { text: "", provider: "no-key", ok: false };
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      // Llama 3.3 70B on Groq: ~200ms time-to-first-token vs ~900ms for gpt-4o-mini, and TTFT
      // IS the pause the caller hears. Not the widget's qwen3-30b: in a 21-prompt test qwen put
      // the [SMS] tag on 11 ordinary questions (would text anyone who asks the price); llama 0/21.
      model: process.env.VOICE_LLM_MODEL || "meta-llama/llama-3.3-70b-instruct",
      provider: opts.provider,
      messages: [{ role: "system", content: system }, ...messages],
      stream: true,
      max_tokens: 140, // opener + up to ~35 words
      temperature: 0.7,
    }),
    signal: AbortSignal.any([opts.signal, AbortSignal.timeout(30000)]),
  });
  if (!r.ok || !r.body) return { text: "", provider: `HTTP ${r.status}`, ok: false };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", full = "", provider = "?";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return { text: full, provider, ok: true };
      try {
        const j = JSON.parse(data);
        if (j?.provider) provider = j.provider;
        const d = j?.choices?.[0]?.delta?.content || "";
        if (d) { full += d; onToken(d); }
      } catch { /* keepalive */ }
    }
  }
  return { text: full, provider, ok: true };
}

// Groq only (fails fast instead of silently landing on a slow host); the hedge goes to the
// fastest non-Groq host. Measured TTFT for this model: Groq p50 199ms / max 311ms; DeepInfra -
// where OpenRouter fell back when Groq hiccuped - p50 747ms, max 4524ms (a 3.5s live pause).
const PRIMARY_PROVIDER = { order: ["groq"], allow_fallbacks: false };
const HEDGE_PROVIDER = { ignore: ["groq"], sort: "latency" };

/**
 * Hedged LLM call: if the primary has produced no token after VOICE_LLM_HEDGE_MS (default
 * 700ms) - or fails outright - a second request starts on another host. The first to stream
 * wins and the loser is aborted. Runs never reject (an unhandled rejection kills Node).
 */
export async function raceReply(
  messages: { role: string; content: string }[],
  onToken: (d: string) => void,
  system: string,
): Promise<Reply & { hedged: boolean }> {
  const hedgeMs = Number(process.env.VOICE_LLM_HEDGE_MS) || 700;
  let winner = -1;
  const acs = [new AbortController(), new AbortController()];
  const runs: (Promise<Reply | null> | undefined)[] = [];
  const start = (i: 0 | 1): Promise<Reply | null> => {
    if (!runs[i]) {
      runs[i] = streamPitchReply(messages, (d) => {
        if (winner < 0) { winner = i; acs[1 - i].abort(); }
        if (winner === i) onToken(d);
      }, system, { signal: acs[i].signal, provider: i === 0 ? PRIMARY_PROVIDER : HEDGE_PROVIDER })
        .catch((e): Reply | null => (acs[i].signal.aborted ? null : { text: "", provider: `error:${e?.message || e}`, ok: false }));
    }
    return runs[i]!;
  };
  const timer = setTimeout(() => { if (winner < 0) start(1); }, hedgeMs);
  try {
    const a = await start(0);
    if (winner === 0 && a) return { ...a, hedged: false };
    // Primary lost the race, failed, or streamed nothing: take the hedge (starts now if needed).
    const b = await start(1);
    if (b?.ok) return { ...b, hedged: true };
    return { ...(a ?? b ?? { text: "", provider: "?", ok: false }), hedged: !!b };
  } finally {
    clearTimeout(timer);
  }
}

// Fire the demo-link SMS to the caller (we already have their number — we dialed them).
export async function sendDemoSms(to: string): Promise<boolean> {
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

// Warm handoff: redirect the in-progress call to a human (ends ConversationRelay, dials them).
export async function transferCall(callSid: string, to: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok || !callSid || !to) return false;
  const callerId = process.env.TWILIO_FROM_NUMBER || to;
  const twiml = `<Response><Dial callerId="${callerId}" timeout="30">${to}</Dial></Response>`;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Twiml: twiml }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch { return false; }
}

interface Session {
  callSid: string; prospect: string; messages: { role: string; content: string }[];
  turn: number; smsSent: boolean; transferred: boolean; interrupts: number; lastFiller: string;
  // speaker-events timing: the silence the caller actually hears = caller stops -> bot voice.
  clientOffAt: number; agentSpeaking: boolean;
  endAfterSpeech: boolean; ended: boolean;
  /** -1 = no role-play yet; else caller turns since the model started it ([SCENKA]). */
  sceneTurns: number;
  biz: Business | null;
}

const q = (s: string, n = 110) => JSON.stringify(s.replace(/\s+/g, " ").trim().slice(0, n));

export function attachVoiceRelayWS(server: Server, _tenantManager?: any): void {
  const wss = new WebSocketServer({ server, path: "/api/voice/relay" });

  wss.on("connection", (ws: WebSocket) => {
    const session: Session = {
      callSid: "", prospect: "", messages: [], turn: 0, smsSent: false, transferred: false,
      interrupts: 0, lastFiller: "", clientOffAt: 0, agentSpeaking: false, endAfterSpeech: false, ended: false, sceneTurns: -1, biz: null,
    };
    const tag = () => `[voice-relay] call=${session.callSid.slice(2, 10)}`;
    const endCall = (why: string) => {
      if (session.ended || !session.endAfterSpeech) return;
      session.ended = true;
      console.log(`${tag()} hanging up after goodbye (${why})`);
      ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reasonCode: "goodbye" }) }));
    };

    ws.on("message", (raw: any) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "setup") {
        session.callSid = msg.callSid || "";
        session.prospect = String(msg.customParameters?.prospect || msg.to || "").trim();
        // The TwiML greeting is spoken by Twilio, not us - put it in history so the model
        // knows the call is already open and does not greet a second time.
        const greeting = String(msg.customParameters?.greeting || "").trim();
        if (greeting) session.messages.push({ role: "assistant", content: greeting });
        // Contact-database context: lets the bot skip "czym się zajmujesz?" and role-play the
        // callee's own business straight away. Clipped - it lands in every turn's system prompt.
        const company = String(msg.customParameters?.company || "").trim().slice(0, 80);
        const business = String(msg.customParameters?.business || "").trim().slice(0, 300);
        if (company || business) session.biz = { company, business };
        console.log(`${tag()} setup prospect=${session.prospect} filler=${fillerMode()} jev=${process.env.JEV_API_KEY ? "on" : "off"}${session.biz ? ` biz=${q(session.biz.company, 40)}` : ""}`);
        // The greeting plays for ~3s - plenty to finish both TLS handshakes before turn 1.
        warmJev();
        warmLlm();
        return;
      }
      if (msg.type === "interrupt") {
        session.turn++; session.interrupts++;
        // Rising interrupt counts on short calls = backchannel/noise still cutting the agent off.
        console.log(`${tag()} interrupt #${session.interrupts} (turn=${session.turn}) heard=${q(String(msg.utteranceUntilInterrupt || ""), 60)}`);
        return;
      }
      if (msg.type === "info") {
        // speaker-events: {"type":"info","name":"agentSpeaking"|"clientSpeaking","value":"on"|"off"}
        const now = Date.now();
        if (msg.name === "clientSpeaking" && msg.value === "off") session.clientOffAt = now;
        if (msg.name === "agentSpeaking") {
          const on = msg.value === "on";
          if (on && !session.agentSpeaking && session.clientOffAt) {
            // Caller-perceived pause: Twilio endpointing + STT + our LLM + TTS, end to end.
            console.log(`${tag()} pause=${now - session.clientOffAt}ms (caller stopped -> bot voice)`);
            session.clientOffAt = 0;
          }
          session.agentSpeaking = on;
          if (!on) endCall("goodbye spoken");
        }
        return;
      }
      if (msg.type === "dtmf") {
        const t = String(msg.digit || "") === "1" ? "Tak" : String(msg.digit || "") === "2" ? "Nie" : "";
        if (!t) return;
        msg = { type: "prompt", voicePrompt: t };
      }
      if (msg.type !== "prompt") {
        console.log(`${tag()} evt=${msg.type} ${JSON.stringify(msg).slice(0, 140)}`);
        return;
      }

      const text = (msg.voicePrompt || "").trim();
      if (!text) return;
      const myTurn = ++session.turn;
      session.endAfterSpeech = false; // the caller spoke again - they are not done
      // Jev reads the caller in context: "tak" after "wysłać link?" is a request, not small talk.
      const agentLast = [...session.messages].reverse().find((m) => m.role === "assistant")?.content || "";
      session.messages.push({ role: "user", content: text });
      console.log(`${tag()} turn=${myTurn} caller=${q(text)}`);

      (async () => {
        const mode = fillerMode();
        let ended = false;
        // Turn latency: t0 = finalized caller prompt; ttft = first reply text out to TTS.
        // Twilio's endpointing + STT sit upstream of t0 - see the pause= line for the total.
        const t0 = Date.now();
        let ttftMs = 0, filler = "", provider = "?";
        let pending = "", wantSms = false, wantTransfer = false, wantEnd = false, sceneStart = false, spokenLen = 0, spoken = "";
        const endTurn = () => {
          if (ended || myTurn !== session.turn) return;
          ended = true;
          ws.send(JSON.stringify({ type: "text", token: "", last: true }));
          console.log(`${tag()} turn=${myTurn} ttft=${ttftMs || -1}ms total=${Date.now() - t0}ms llm=${provider}${filler ? ` filler=${q(filler)}` : ""} bot=${q(spoken, 160)}`);
        };

        // Stream to TTS the moment text arrives. Only an unclosed "[..." is held back: our tags
        // may straddle deltas, and the model also invents its own ("[KONIEC]" in testing), which
        // ttsClean then drops instead of TTS reading them out. Capped so a stray "[" can't stall.
        const heldBracket = (s: string) => { const k = s.lastIndexOf("["); return k >= 0 && s.indexOf("]", k) === -1 && s.length - k <= 24 ? k : -1; };
        const flush = (final: boolean) => {
          let i: number;
          while ((i = pending.indexOf(SMS_TAG)) >= 0) { wantSms = true; pending = pending.slice(0, i) + pending.slice(i + SMS_TAG.length); }
          while ((i = pending.indexOf(TRANSFER_TAG)) >= 0) { wantTransfer = true; pending = pending.slice(0, i) + pending.slice(i + TRANSFER_TAG.length); }
          while ((i = pending.indexOf(END_TAG)) >= 0) { wantEnd = true; pending = pending.slice(0, i) + pending.slice(i + END_TAG.length); }
          while ((i = pending.indexOf(SCENE_TAG)) >= 0) { sceneStart = true; pending = pending.slice(0, i) + pending.slice(i + SCENE_TAG.length); }
          let out: string;
          const k = heldBracket(pending);
          if (final || k === -1) { out = pending; pending = ""; }
          else { out = pending.slice(0, k); pending = pending.slice(k); }
          if (!out || ended || myTurn !== session.turn) return;
          const clean = ttsClean(stripMd(out));
          if (clean) {
            if (!ttftMs) ttftMs = Date.now() - t0;
            spokenLen += clean.length;
            spoken += clean;
            ws.send(JSON.stringify({ type: "text", token: clean, last: false }));
          }
        };

        // "instant" mode only: hold the reply's first ~24 chars to strip an acknowledgement
        // that would duplicate the canned filler ("Okej. Okej, ..."). "llm" mode streams raw.
        let headDone = mode !== "instant", head = "";
        const feed = (delta: string, final = false) => {
          if (ended || myTurn !== session.turn) return;
          if (!headDone) {
            head += delta;
            if (!final && !headSettled(head)) return;
            headDone = true;
            delta = stripLeadingAck(head);
            head = "";
          }
          pending += delta;
          flush(final);
          if (spokenLen > 450) endTurn();
        };

        // Intent check runs alongside the LLM; it is only consulted for actions, after the reply.
        const intentP: Promise<TurnIntent | null> = classifyTurn(agentLast, text);

        try {
          if (mode === "instant") {
            filler = pickNeutralFiller(session.lastFiller);
            session.lastFiller = filler;
            spoken = filler + " ";
            ws.send(JSON.stringify({ type: "text", token: filler + " ", last: false }));
          }
          let llmMessages = session.messages;
          if (session.sceneTurns >= 0 && ++session.sceneTurns === SCENE_CALLER_TURNS) {
            llmMessages = [...session.messages, { role: "system", content: BREAK_SCENE_HINT }];
            session.sceneTurns = 99; // step out once; never re-enter
            console.log(`${tag()} turn=${myTurn} scene: telling the model to step out of the role-play`);
          }
          const reply = await raceReply(llmMessages, (d) => feed(d), whispSystem(mode, session.biz));
          provider = reply.provider + (reply.hedged ? "(hedge)" : "");
          if (!reply.ok && !reply.text) feed("Przepraszam, mam teraz problem techniczny. Proszę spróbować za chwilę.");
          feed("", true);
          flush(true);
          const said = [SMS_TAG, TRANSFER_TAG, END_TAG, SCENE_TAG].reduce((t, tg) => t.split(tg).join(""), reply.text).trim();
          if (sceneStart && session.sceneTurns < 0) session.sceneTurns = 0; // caller turns in the role-play start counting now
          session.messages.push({ role: "assistant", content: mode === "instant" ? stripLeadingAck(said) : said });
          endTurn();

          // A turn the caller barged into was never fully heard - never act on its tags.
          if (!ended) { console.log(`${tag()} turn=${myTurn} superseded - actions skipped`); return; }
          const intent = await intentP; // bounded by VOICE_JEV_TIMEOUT_MS; usually already done
          const iLog = intent
            ? `jev=${intent.intent}(${intent.intentConfidence.toFixed(2)}) sms=${intent.wantsSms.toFixed(2)} human=${intent.wantsHuman.toFixed(2)} @${intent.ms}ms`
            : "jev=none";
          // The model once tagged [KONIEC] onto "…Wysłać Ci link do darmowego dema?" - hanging up
          // right after asking. A reply that ends in a question is waiting for an answer: never end.
          const asksBack = /\?\s*$/.test(said);
          const endOk = wantEnd && !asksBack && confirmAction(intent, "end");
          const acts: string[] = [];
          const smsByJev = !wantSms && smsAcceptedWithoutTag(intent, agentLast);
          if (wantSms) acts.push(`sms-tag->${confirmAction(intent, "sms") ? "ok" : "BLOCKED"}`);
          if (smsByJev) acts.push("sms-by-jev(no tag)");
          if (wantTransfer) acts.push(`transfer-tag->${confirmAction(intent, "human") ? "ok" : "BLOCKED"}`);
          if (wantEnd) acts.push(`end-tag->${endOk ? "ok" : asksBack ? "BLOCKED(bot asked a question)" : "BLOCKED(jev)"}`);
          console.log(`${tag()} turn=${myTurn} ${iLog}${acts.length ? " " + acts.join(" ") : ""}`);

          if (((wantSms && confirmAction(intent, "sms")) || smsByJev) && !session.smsSent && session.prospect) {
            session.smsSent = true;
            const ok = await sendDemoSms(session.prospect);
            console.log(`${tag()} demo SMS to ${session.prospect}: ${ok ? "sent" : "FAILED"}`);
          }
          if (wantTransfer && confirmAction(intent, "human") && !session.transferred && session.callSid) {
            session.transferred = true;
            const human = process.env.VOICE_FORWARD_TO || "";
            console.log(`${tag()} handoff to ${human || "(VOICE_FORWARD_TO unset)"} in ~3.5s`);
            // let the "łączę z Jakubem" TTS finish before the redirect supersedes the relay
            setTimeout(() => { transferCall(session.callSid, human).then((ok) => console.log(`${tag()} handoff ${ok ? "redirected" : "FAILED"}`)); }, 3500);
          }
          // Hang up after the goodbye instead of leaving a dead line open. Never while a transfer
          // is pending (the redirect needs the call alive). "end" returns control to the TwiML,
          // which has nothing after <Connect>, so the call ends - sent once the goodbye has been
          // spoken (agentSpeaking off), with a timer in case that event never comes.
          if (endOk && !(wantTransfer && session.transferred)) {
            session.endAfterSpeech = true;
            setTimeout(() => endCall("timer"), 8000);
          }
        } catch (e: any) {
          console.error(`${tag()} error: ${e?.message || e}`);
          if (myTurn === session.turn && !ended) ws.send(JSON.stringify({ type: "text", token: "Przepraszam, mam teraz problem techniczny. Proszę spróbować za chwilę.", last: true }));
        }
      })();
    });

    ws.on("close", () => console.log(`${tag()} closed (turns=${session.turn} interrupts=${session.interrupts} sms=${session.smsSent} transfer=${session.transferred})`));
    ws.on("error", (e: any) => console.error(`${tag()} ws error: ${e?.message || e}`));
  });

  console.log("[voice-relay] ConversationRelay WebSocket (Whisp pitch + SMS capture) attached at /api/voice/relay");
}
