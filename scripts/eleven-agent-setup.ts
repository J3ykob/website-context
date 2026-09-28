/**
 * Create (or update) the ElevenLabs agent for the Whisp Polish pitch bot.
 *
 * ElevenLabs does STT (Scribe realtime), turn-taking and TTS; the brain is our custom-LLM
 * endpoint (src/voice/eleven-llm.ts). Calls stay on our Twilio number ("register call" mode).
 *
 *   ELEVENLABS_API_KEY=... ELEVEN_LLM_SECRET=<>=24 chars> BASE_URL=https://whisp.so \
 *     npx tsx scripts/eleven-agent-setup.ts [--agent <agent_id>]
 *
 * Prints the agent id -> set ELEVEN_AGENT_ID (+ ELEVENLABS_API_KEY, ELEVEN_LLM_SECRET) on the server.
 */
const API = "https://api.elevenlabs.io/v1/convai";
const key = process.env.ELEVENLABS_API_KEY || "";
const secretValue = process.env.ELEVEN_LLM_SECRET || "";
const base = (process.env.BASE_URL || "https://whisp.so").replace(/\/+$/, "");
const agentArg = process.argv.indexOf("--agent");
const existingAgent = agentArg > 0 ? process.argv[agentArg + 1] : process.env.ELEVEN_AGENT_ID || "";

if (!key || secretValue.length < 24) {
  console.error("Need ELEVENLABS_API_KEY and ELEVEN_LLM_SECRET (>= 24 chars; generate: openssl rand -hex 24).");
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

// The bearer ElevenLabs sends to our endpoint, stored as a workspace secret.
const secret = await call("POST", "/secrets", { type: "new", name: `whisp-voice-llm-${Date.now().toString(36)}`, value: secretValue });
console.log(`secret stored: ${secret.secret_id}`);

const conversation_config = {
  agent: {
    language: "pl",
    first_message: "Dzień dobry! Tu asystent AI firmy Whisp. Dzwonię dosłownie na minutkę w sprawie czatu na {{greeting_target}}. Czy to dobry moment?",
    dynamic_variables: {
      dynamic_variable_placeholders: { company: "", business: "", prospect: "", call_sid: "", greeting_target: "Waszą stronę internetową" },
    },
    prompt: {
      // Not a prompt: per-call context for our endpoint, which parses it (the real prompt lives in code).
      prompt: 'WHISP_CTX {"conversation_id":"{{system__conversation_id}}","company":"{{company}}","business":"{{business}}","prospect":"{{prospect}}","call_sid":"{{call_sid}}"}',
      llm: "custom-llm",
      custom_llm: { url: `${base}/api/voice/eleven/v1`, model_id: "whisp-voice", api_key: { secret_id: secret.secret_id } },
      built_in_tools: {
        end_call: { name: "end_call", type: "system", params: { system_tool_type: "end_call" }, description: "", pre_tool_speech: "off" },
      },
    },
  },
  // Booking vocabulary the role-play depends on: Scribe misheard "przyszły tydzień" as "trzy tygodnie".
  asr: {
    provider: "scribe_realtime", user_input_audio_format: "ulaw_8000",
    keywords: ["Whisp", "przyszły tydzień", "przyszłym tygodniu", "jutro", "pojutrze", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "po południu", "rano", "szesnasta", "wizyta", "termin"],
  },
  tts: {
    model_id: "eleven_v4_turbo", // v4 Turbo (2026-09-28): ~150ms to first speech, Polish; not available via Twilio ConversationRelay
    voice_id: "pNInz6obpgDQGcFmaJgB", // "Adam", male - same as the ConversationRelay default
    agent_output_audio_format: "ulaw_8000",
    speed: 1.05,
    stability: 0.3,
    similarity_boost: 0.8,
  },
  turn: {
    turn_model: "turn_v3",
    turn_eagerness: "eager",
    // Starts our LLM during silence before the turn is certain; eleven-llm.ts ignores the side
    // effects of requests that ElevenLabs then discards.
    speculative_turn: true,
    // Polish backchannels must not cut the agent off (exact, case-insensitive match).
    interruption_ignore_terms: ["mhm", "mhmm", "aha", "yhm", "no", "okej", "ok", "jasne", "rozumiem", "tak tak"],
  },
  conversation: { max_duration_seconds: 300 },
};

const agent = existingAgent
  ? await call("PATCH", `/agents/${existingAgent}`, { conversation_config })
  : await call("POST", "/agents/create", { name: "Whisp PL pitch (custom LLM)", conversation_config });
const agentId = existingAgent || agent.agent_id;
console.log(`agent ${existingAgent ? "updated" : "created"}: ${agentId}`);
console.log(`custom LLM URL: ${base}/api/voice/eleven/v1`);
console.log(`\nServer env: ELEVEN_AGENT_ID=${agentId}  (+ ELEVENLABS_API_KEY, ELEVEN_LLM_SECRET)`);
console.log(`Twilio call webhook: ${base}/api/voice/eleven-twiml?company=<name>&business=<short description>`);
