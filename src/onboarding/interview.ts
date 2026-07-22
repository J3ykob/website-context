/**
 * Interview-based onboarding — builds a tenant's knowledge base by INTERVIEWING
 * the owner, for businesses that have no scrapable website (FB-only, phone-only,
 * or zero online presence). The owner is the source of truth; we ask instead of
 * scrape. An LLM runs an adaptive one-question-at-a-time interview, then
 * synthesizes the transcript into clean, retrievable KB chunks.
 */
import { OpenRouterProvider } from "../llm/openrouter-provider.js";

export interface InterviewTurn { role: "assistant" | "user"; content: string }
export interface KBChunk { title: string; content: string }

// Core topics a useful bot needs. The LLM adapts wording to the business type;
// this is only the coverage checklist it works through.
const TOPICS = [
  "what the business does — the products or services it offers",
  "opening hours / when it's available",
  "location and/or the area it serves",
  "how customers reach it or book — phone, email, messenger",
  "prices or price ranges (even rough)",
  "the questions customers ask most often, and the answers",
];

const MAX_QUESTIONS = 8;   // hard cap so the interview always ends
const MIN_ANSWERS = 4;     // never finish before this many real answers

function userAnswerCount(t: InterviewTurn[]): number {
  return t.filter((x) => x.role === "user" && x.content.trim().length > 0).length;
}

function transcriptText(t: InterviewTurn[]): string {
  return t.map((x) => `${x.role === "assistant" ? "You" : "Owner"}: ${x.content}`).join("\n");
}

/**
 * Decide the next single question, or that the interview is complete.
 * Returns { done: true } when the core topics are covered (or the cap is hit).
 */
export async function nextInterviewQuestion(
  businessName: string, transcript: InterviewTurn[]
): Promise<{ question?: string; done: boolean }> {
  const answers = userAnswerCount(transcript);
  if (answers >= MAX_QUESTIONS) return { done: true };

  const provider = new OpenRouterProvider();
  const system =
    "You onboard a small business that has NO website by interviewing its owner, so their AI assistant can answer customers. " +
    "You must learn, across the whole interview: " + TOPICS.join("; ") + ". " +
    "Rules: ask exactly ONE short, warm, concrete question per turn. Adapt to the business type revealed by earlier answers. " +
    "Reply in the SAME language as the owner's answers (default Polish if unknown). Do NOT number questions, do NOT preamble. " +
    "Prefer to FINISH as soon as you have the essentials (offering, hours, location, contact, prices) — do not pad with nice-to-have questions. " +
    "When the core topics are covered, reply with the single token DONE and nothing else.";
  const prompt =
    `Business name: ${businessName}\n\n` +
    (transcript.length ? `Interview so far:\n${transcriptText(transcript)}\n\n` : `The interview has not started yet.\n\n`) +
    (answers < MIN_ANSWERS
      ? `Ask your next single question (never DONE yet — too little covered):`
      : `Either ask your next single question, or reply DONE if the core topics are covered:`);

  let raw = "";
  try {
    const r = await provider.chat(
      [ { role: "system", content: system }, { role: "user", content: prompt } ],
      { maxTokens: 120, temperature: 0.5 }
    );
    raw = (r.content || "").trim();
  } catch {
    // On failure, ask a safe generic question rather than dead-ending.
    return { question: "Opowiedz proszę, czym dokładnie zajmuje się Twoja firma i co oferujesz klientom?", done: false };
  }

  if (answers >= MIN_ANSWERS && /^done\b/i.test(raw)) return { done: true };
  // Strip an accidental leading "DONE" if the model both finished and asked.
  const q = raw.replace(/^done[\s:.-]*/i, "").trim();
  if (!q) return { done: true };
  return { question: q.slice(0, 400), done: false };
}

export interface SynthesisResult {
  chunks: KBChunk[];        // KB fact blocks (embedded + stored)
  tagline: string;          // short line for the micro-site
  suggestions: string[];    // example customer questions for the micro-site
}

/**
 * Turn the finished interview into (a) clean KB chunks — titled fact blocks in the
 * business's own "we/us" voice — and (b) a small website card (tagline + suggested
 * questions) for the auto-generated micro-site. One LLM call.
 */
export async function synthesizeKB(businessName: string, transcript: InterviewTurn[]): Promise<SynthesisResult> {
  const provider = new OpenRouterProvider();
  const system =
    "You convert an onboarding interview into an AI assistant's knowledge base AND a short website card. " +
    "Output STRICT JSON only: {\"tagline\":\"...\",\"suggestions\":[\"...\"],\"chunks\":[{\"title\":\"...\",\"content\":\"...\"}]}. " +
    "chunks: self-contained fact blocks the assistant retrieves to answer customers, in the business's OWN voice (we/our/us), same language as the interview (default Polish), covering what they offer, hours, location/area, contact & booking, pricing, and common Q&A. 4-10 chunks, 1-4 sentences each, short titles. Do NOT invent facts the owner did not give. " +
    "This business has NO separate website — NEVER write 'check our website', 'see our page', 'na naszej stronie', 'sprawdź na stronie' or any reference to a website / online page / link; state each fact directly or point to the phone number. For anything that changes daily (e.g. a daily special), say to call. " +
    "tagline: one short catchy line (max 8 words) in the business's language. " +
    "suggestions: 3-4 short example questions a customer might ask, in the business's language.";
  const prompt =
    `Business name: ${businessName}\n\nInterview:\n${transcriptText(transcript)}\n\nReturn the JSON now.`;

  let content = "";
  try {
    const r = await provider.chat(
      [ { role: "system", content: system }, { role: "user", content: prompt } ],
      { maxTokens: 1800, temperature: 0.3 }
    );
    content = r.content || "";
  } catch { return { chunks: [], tagline: "", suggestions: [] }; }

  const parsed = extractJson(content);
  const chunks = (Array.isArray(parsed?.chunks) ? parsed.chunks : [])
    .map((c: any) => ({ title: String(c?.title || "").trim().slice(0, 120), content: String(c?.content || "").trim().slice(0, 2000) }))
    .filter((c: KBChunk) => c.content.length > 10)
    .slice(0, 12);
  const tagline = String(parsed?.tagline || "").trim().slice(0, 80);
  const suggestions = (Array.isArray(parsed?.suggestions) ? parsed.suggestions : [])
    .map((s: any) => String(s).trim()).filter(Boolean).slice(0, 4);
  return { chunks, tagline, suggestions };
}

function extractJson(text: string): any {
  if (!text) return null;
  const t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}
