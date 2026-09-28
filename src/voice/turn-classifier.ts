/**
 * Per-turn intent check for the voice bot via TypeSafe Jev (System One). Runs in PARALLEL
 * with the LLM and never gates speech - the LLM's own opener is spoken as soon as it
 * streams. Jev's job is the decisions that must not be wrong: the LLM's [SMS] / [TRANSFER] /
 * [KONIEC] tags are only acted on when Jev agrees with what the caller actually said. In a live test
 * call the LLM put [TRANSFER] on "Nie, dobra, nie, nie... nie link" - Jev had it as a plain
 * short refusal (0.94).
 *
 * Returns null on missing key, error or timeout; the relay then trusts the LLM's tags alone
 * (the pre-Jev behaviour), so a Jev outage never blocks a real request.
 * Env: JEV_API_KEY + JEV_MODEL (shared with the web chat), VOICE_JEV_TIMEOUT_MS (default 1500).
 */

import { jevAsk, type JevQuestion } from "../llm/jev.js";

/** What the caller's utterance does in the conversation - drives action gating, call ending, logs. */
export type CallerIntent =
  | "zgoda"          // yes / sure / let's go / agrees to what the agent proposed
  | "odmowa"         // not interested / no thanks / refuses
  | "pozegnanie"     // goodbye, wrapping up
  | "obiekcja"       // doubt or objection: already have one, no time, too expensive, don't trust AI
  | "pytanie"        // asks about the product, price, how it works, who is calling
  | "info_o_firmie"  // tells what their business does or how they work
  | "scenka"         // speaks as a customer inside the demo role-play (booking, asking the "business")
  | "czlowiek"       // wants a human / Jakub
  | "niejasne";      // garbled, cut off, ambiguous

/** Intents after which the caller wants the call to go on - an LLM [KONIEC] tag is ignored. */
const KEEP_TALKING: CallerIntent[] = ["pytanie", "obiekcja", "info_o_firmie", "scenka", "czlowiek", "niejasne"];

export interface TurnIntent {
  intent: CallerIntent;
  intentConfidence: number;
  /** P(caller asks for, or agrees to receive, the demo link by SMS). */
  wantsSms: number;
  /** P(caller explicitly asks to talk to a human / Jakub). */
  wantsHuman: number;
  ms: number;
}

const QUESTIONS: Record<string, JevQuestion> = {
  intent: {
    type: "choice",
    instructions: "What does the caller's LAST utterance (`caller`) do in this Polish sales phone call, given what the agent just said (`agent_last`)? The agent may be running a role-play in which the caller pretends to be a customer of their own business.",
    criteria: {
      zgoda: "Says yes or agrees to what the agent just proposed (e.g. 'tak', 'dawaj', 'jasne', 'okej, wyślij').",
      odmowa: "Not interested, says no to the offer, asks not to be called, refuses.",
      pozegnanie: "Says goodbye or clearly wraps up the call.",
      obiekcja: "Raises a doubt or objection: already has a chat, no time, too expensive, does not trust AI, 'we do not need it'.",
      pytanie: "Asks a question about the product, the price, how it works, or who is calling.",
      info_o_firmie: "Tells what their business does or how it works (answering the agent's question about the company).",
      scenka: "Speaks as a CUSTOMER inside the role-play: books a visit, asks the 'business' about services, dates or prices.",
      czlowiek: "Asks to speak with a human or with Jakub.",
      niejasne: "Garbled, cut off or ambiguous - the meaning cannot be determined.",
    },
  },
  wants_sms: {
    type: "noul",
    instructions: "Does the caller (`caller`) ask for, or clearly agree to receive, a link / demo / information by SMS? Consider `agent_last`: a plain 'tak' right after the agent offered to send a link counts as agreeing.",
    criteria: {
      true: "Explicit request or clear consent to be sent the link/demo/SMS.",
      false: "Refusal, hesitation, a question, small talk, or consent to something else. Any 'nie' about the link is false.",
    },
  },
  wants_human: {
    type: "noul",
    instructions: "Does the caller (`caller`) explicitly ask to be connected to or speak with a human / a person / Jakub right now?",
    criteria: {
      true: "An explicit request to talk to a real person now.",
      false: "Anything else, including refusals, 'no', questions about the product, or ending the call.",
    },
  },
};

export async function classifyTurn(agentLast: string, caller: string): Promise<TurnIntent | null> {
  const t0 = Date.now();
  const a = await jevAsk(
    { agent_last: agentLast.slice(-600), caller: caller.slice(0, 500) },
    QUESTIONS,
    Number(process.env.VOICE_JEV_TIMEOUT_MS) || 1500,
  );
  const it = a?.intent, sms = a?.wants_sms, human = a?.wants_human;
  if (it?.type !== "choice" || sms?.type !== "noul" || human?.type !== "noul") return null;
  return {
    intent: it.choice as CallerIntent,
    intentConfidence: it.confidence ?? 0,
    wantsSms: sms.noul,
    wantsHuman: human.noul,
    ms: Date.now() - t0,
  };
}

/** Act on an LLM action tag? Jev must agree; with Jev unavailable the LLM's tag stands. */
export function confirmAction(intent: TurnIntent | null, kind: "sms" | "human" | "end"): boolean {
  if (!intent) return true;
  if (kind === "end") return !(KEEP_TALKING.includes(intent.intent) && intent.intentConfidence >= 0.5);
  return (kind === "sms" ? intent.wantsSms : intent.wantsHuman) >= 0.5;
}

/**
 * Send the demo SMS even without the LLM's [SMS] tag when Jev is sure the caller just accepted an
 * SMS offer: in a simulated call the bot said "Super, już wysyłam" but forgot the tag (Jev: 0.99),
 * so the promised SMS would silently never have gone out.
 */
export function smsAcceptedWithoutTag(intent: TurnIntent | null, agentLast: string): boolean {
  return !!intent && intent.wantsSms >= 0.9 && /\bSMS/i.test(agentLast);
}

// VOICE_FILLER=instant: a canned sound spoken at t0, before the LLM's first token (~0ms vs
// ~200ms for the LLM's own opener). Default mode ("llm") speaks the LLM's contextual opener.
const NEUTRAL = ["Mhm.", "Okej.", "Jasne.", "Aha."];

/** A neutral filler that never repeats `last`. */
export function pickNeutralFiller(last: string, rand: () => number = Math.random): string {
  const fresh = NEUTRAL.filter((f) => f !== last);
  return fresh[Math.floor(rand() * fresh.length)];
}

/**
 * Open the TLS connection to TypeSafe at call setup, so turn 1 does not pay the handshake
 * (it blew the budget in testing). GET /v1/models costs no tokens; undici pools the socket.
 */
export function warmJev(): void {
  const key = process.env.JEV_API_KEY;
  if (!key) return;
  fetch("https://api.typesafe.ai/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) })
    .then((r) => r.arrayBuffer())
    .catch(() => {});
}
