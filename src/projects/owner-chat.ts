/**
 * The owner's chat on the review page: the owner talks to an assistant about the result waiting for
 * approval. It answers from the project (spec, draft, files, businesses' answers) and acts through a few
 * tools, each validated by code:
 *   read_file       a project file (truncated) - context is fetched on demand, never preloaded
 *   edit_reply      replace the text for the customer (the draft shown on the page)
 *   request_changes amend the spec with the owner's instruction -> the agent reworks -> new version
 *   answer_questions the owner's answers to the agent's questions -> same as request_changes
 * Sending to the customer is never a tool: it stays the owner's button click on the page.
 *
 * Token budget: a short system prompt, a compact state block (spec summary, draft excerpt, file list,
 * businesses, questions) and the last turns only; tool results are truncated.
 */
import { getProject, setMemory, addEvent } from "./store.js";
import { listFiles, readFile } from "./repo.js";
import type { Review } from "./review.js";
import type { Spec } from "./plan.js";

const MODEL = () => process.env.OWNER_CHAT_MODEL || "qwen/qwen3-235b-a22b-2507";
const MAX_TURNS = 12;        // turns of history sent to the model
const MAX_TOOL_ROUNDS = 4;
const FILE_LIMIT = 6000;

export interface ChatTurn { role: "owner" | "assistant"; text: string; at: string }
export interface ChatResult { reply: string; draft?: string; rework?: boolean; turns: ChatTurn[]; tokens: { prompt: number; completion: number }; tools: string[] }

const SYSTEM = `Jesteś asystentem właściciela firmy na stronie akceptacji. Asystent firmy (agent) przygotował odpowiedź dla klienta
według specyfikacji; właściciel ją sprawdza, zanim trafi do klienta.
Twoje zadania: wyjaśniać wynik (skąd liczby, które firmy co podały), poprawiać tekst dla klienta na prośbę właściciela,
przekazywać agentowi zmiany i odpowiedzi właściciela.
Zasady:
- Odpowiadaj krótko, po polsku, rzeczowo. Fakty tylko z projektu - gdy czegoś nie wiesz, użyj read_file albo powiedz, że tego nie ma.
- edit_reply: tylko gdy właściciel prosi o zmianę treści, którą da się zrobić bez nowych obliczeń; przekaż cały nowy tekst.
- request_changes: gdy zmiana wymaga nowych obliczeń, danych lub plików (np. dolicz transport, inny model, inny okres).
- answer_questions: gdy właściciel odpowiada na pytania agenta.
- Nie wysyłasz niczego klientowi - robi to właściciel przyciskiem "Wyślij klientowi". Gdy właściciel chce wysłać, powiedz mu o przycisku.
- Nie wymyślaj cen, terminów ani warunków, ani cech ceny (netto/brutto, rabaty), których nie ma w plikach.`;

const TOOLS = [
  { type: "function", function: { name: "read_file", description: "Read a project file (truncated).", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "edit_reply", description: "Replace the whole text for the customer.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  { type: "function", function: { name: "request_changes", description: "Send the owner's change to the agent (new spec version, the agent reworks the result).", parameters: { type: "object", properties: { change: { type: "string", description: "the owner's instruction, complete and specific" } }, required: ["change"] } } },
  { type: "function", function: { name: "answer_questions", description: "Send the owner's answers to the agent's questions (the agent reworks the result).", parameters: { type: "object", properties: { answers: { type: "array", items: { type: "object", properties: { question: { type: "string" }, answer: { type: "string" } }, required: ["question", "answer"] } } }, required: ["answers"] } } },
];

async function stateBlock(rv: Review, draft: string): Promise<string> {
  const p = await getProject(rv.projectId);
  const spec = p?.memory.plan as Spec | undefined;
  const files = (await listFiles(rv.projectId)).filter((f) => !f.path.startsWith("historia/") && !f.path.startsWith("plan/")).map((f) => `${f.path} (${f.size} B)`);
  const subs = ((p?.memory.subRequests as any[]) || []).map((s) => `${s.label}: ${s.status}`);
  const { businessQuestions } = await import("./conversation.js");
  const run = p?.memory.agentRun as any;
  const questions = run?.runId === rv.runId ? await businessQuestions(rv.projectId, run).catch(() => []) : [];
  return [
    spec ? `SPEC v${spec.version}: ${spec.goal}\nWyniki: ${spec.outputs.map((o) => o.path).join(", ")}` : "",
    `TEKST DLA KLIENTA (obecny):\n${draft.slice(0, 2500)}`,
    questions.length ? `PYTANIA AGENTA DO WŁAŚCICIELA:\n${questions.map((q, k) => `${k + 1}. ${q}`).join("\n")}` : "",
    subs.length ? `FIRMY Z SIECI: ${subs.join("; ")}` : "",
    `PLIKI: ${files.join(", ")}`,
  ].filter(Boolean).join("\n\n");
}

async function call(messages: any[], usage: { prompt: number; completion: number }): Promise<any> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL(), temperature: 0, max_tokens: 900, tools: TOOLS, tool_choice: "auto", messages }),
  });
  if (!r.ok) throw new Error(`owner chat ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as any;
  usage.prompt += Number(j.usage?.prompt_tokens) || 0;
  usage.completion += Number(j.usage?.completion_tokens) || 0;
  return j.choices?.[0]?.message;
}

/** One owner message: the assistant's reply, after any tool calls. Only while the review is pending. */
export async function ownerChat(rv: Review, message: string): Promise<ChatResult> {
  const p = await getProject(rv.projectId);
  const turns = ((p?.memory.ownerChat as ChatTurn[]) || []).slice(-40);
  let draft = String(p?.memory.ownerDraft && (p.memory.ownerDraft as any).runId === rv.runId ? (p.memory.ownerDraft as any).text : rv.draft);
  const at = () => new Date().toISOString();
  turns.push({ role: "owner", text: message.slice(0, 4000), at: at() });
  const messages: any[] = [
    { role: "system", content: `${SYSTEM}\n\n${await stateBlock(rv, draft)}` },
    ...turns.slice(-MAX_TURNS).map((t) => ({ role: t.role === "owner" ? "user" : "assistant", content: t.text })),
  ];
  let reply = "";
  let rework: { change: string } | null = null;
  let edited = false;
  const usage = { prompt: 0, completion: 0 };
  const used: string[] = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const m = await call(messages, usage);
    const calls = (m?.tool_calls || []) as any[];
    if (!calls.length || round === MAX_TOOL_ROUNDS) { reply = String(m?.content || "").trim(); break; }
    messages.push({ role: "assistant", content: m.content || "", tool_calls: calls });
    for (const c of calls) {
      let args: any = {};
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch { /* invalid JSON -> error below */ }
      const name = c.function?.name;
      used.push(String(name));
      let out: string;
      if (name === "read_file" && typeof args.path === "string") {
        const t = await readFile(rv.projectId, args.path).catch(() => null);
        out = t === null ? "Nie ma takiego pliku." : t.slice(0, FILE_LIMIT) + (t.length > FILE_LIMIT ? "\n[...obcięte]" : "");
      } else if (name === "edit_reply" && typeof args.text === "string" && args.text.trim().length > 10) {
        draft = args.text.trim().slice(0, 20000);
        edited = true;
        out = "Tekst zmieniony (właściciel widzi go na stronie).";
      } else if (name === "request_changes" && typeof args.change === "string" && args.change.trim().length > 5 && !rework) {
        rework = { change: args.change.trim().slice(0, 3000) };
        out = "Przekazano agentowi; nowa wersja przyjdzie do akceptacji.";
      } else if (name === "answer_questions" && Array.isArray(args.answers) && args.answers.length && !rework) {
        const lines = args.answers.filter((a: any) => a?.answer).map((a: any) => `Pytanie: ${String(a.question).slice(0, 500)}\nOdpowiedź firmy: ${String(a.answer).slice(0, 2000)}`);
        if (lines.length) { rework = { change: lines.join("\n\n") }; out = "Odpowiedzi przekazane agentowi; nowa wersja przyjdzie do akceptacji."; }
        else out = "Brak odpowiedzi do przekazania.";
      } else out = `Niepoprawne wywołanie ${name} - sprawdź argumenty.`;
      messages.push({ role: "tool", tool_call_id: c.id, content: out });
    }
  }
  if (!reply) reply = rework ? "Przekazałem to agentowi - nowa wersja przyjdzie do akceptacji." : edited ? "Zmieniłem tekst dla klienta." : "OK.";
  turns.push({ role: "assistant", text: reply, at: at() });
  await setMemory(rv.projectId, { ownerChat: turns.slice(-60), ...(edited ? { ownerDraft: { runId: rv.runId, text: draft } } : {}) });
  await addEvent(rv.projectId, { kind: "owner_chat", actor: rv.tenantId, data: { owner: message.slice(0, 2000), assistant: reply.slice(0, 2000), edited, rework: rework?.change.slice(0, 1000), tools: used, tokens: usage } });
  if (rework) {
    const { decide } = await import("./review.js");
    const { reworkWithGuidance } = await import("./conversation.js");
    if (await decide(rv.token, "changes_requested", { note: rework.change })) await reworkWithGuidance(rv.projectId, rework.change);
  }
  return { reply, ...(edited ? { draft } : {}), ...(rework ? { rework: true } : {}), turns, tokens: usage, tools: used };
}
