/**
 * Every conversation is a project (conversation@1): created on the first message of a chat session,
 * it keeps the turn log (what was asked, how it was handled, what was answered), the repository and
 * the memory. Most turns are answered from the business's knowledge; when a message needs real work
 * - calculations, comparing options, a plan, a list, a table or document - the system decides so
 * (Jev) and the project agent does it in the project's sandbox (src/projects/agent.ts). The reply
 * then arrives in the same chat when the agent is done (the widget polls /api/chat/agent).
 */
import { createProject, findOpenProject, addEvent, getProject, setMemory } from "./store.js";
import { writeFile, readFile, listFiles } from "./repo.js";
import { agentEnabled, startAgentRun, agentStatus, type AgentRunState } from "./agent.js";
import { jevAsk } from "../llm/jev.js";
import { reviewMode, reviewForRun, openReview } from "./review.js";
import { BUSINESS_QUESTIONS } from "./agent.js";

export const CONVERSATION = "conversation@1";
const TTL_HOURS = 30 * 24;
export const CUSTOMER_DIR = "dla_klienta";
export const KNOWLEDGE_DIR = "wiedza";

// sessionKey -> projectId, so a turn costs no D1 read once the project is known.
const known = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

/** The conversation's project (created on first use). Null when D1 is unavailable - chat never waits on it. */
export function conversationProject(tenantId: string, sessionKey: string, firstMessage: string): Promise<string | null> {
  const key = `${tenantId}:${sessionKey}`;
  const hit = known.get(key);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(key);
  if (!p) {
    p = (async () => {
      const open = await findOpenProject(sessionKey, CONVERSATION);
      const project = open && open.initiatorTenantId === tenantId ? open
        : await createProject(CONVERSATION, { customerSession: sessionKey, initiatorTenantId: tenantId, title: firstMessage.slice(0, 120), ttlHours: TTL_HOURS });
      if (known.size > 20_000) known.clear();
      known.set(key, project.id);
      return project.id;
    })().catch((e) => {
      console.warn(`[conversation] ${tenantId}: no project (${(e as Error).message})`);
      return null;
    }).finally(() => pending.delete(key));
    pending.set(key, p);
  }
  return p;
}

export type Route = "knowledge" | "flow" | "collect" | "estimate" | "agent" | "network" | "refusal";

/** One turn in the project's log (fire and forget). */
export function recordTurn(projectId: string | null, turn: { user: string; assistant: string; route: Route; data?: Record<string, unknown> }): void {
  if (!projectId) return;
  addEvent(projectId, { kind: "turn", actor: "chat", data: { route: turn.route, user: turn.user.slice(0, 2000), assistant: turn.assistant.slice(0, 4000), ...(turn.data || {}) } })
    .catch((e) => console.warn(`[conversation] ${projectId}: turn not recorded (${(e as Error).message})`));
}

export type TurnKind = "estimate" | "work" | "other";
const kindMemo = new Map<string, { at: number; kind: TurnKind }>();
/**
 * How the latest message should be handled, in one Jev choice: pricing a given list (the fast estimate
 * path), work on data (the project agent), or anything else (knowledge). `estimateAvailable` /
 * `agentAvailable`: what this business has; an unavailable kind is never chosen. Memoized per message.
 */
export async function turnKind(message: string, previousReply: string, estimateAvailable: boolean, agentAvailable = agentEnabled()): Promise<TurnKind> {
  if ((!estimateAvailable && !agentAvailable) || message.trim().length < 8) return "other";
  const key = `${estimateAvailable}${agentAvailable}\n${previousReply.slice(-300)}\n${message}`;
  const hit = kindMemo.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.kind;
  const criteria: Record<string, string> = {
    estimate: "It asks what a specific set of products or services it names would cost - each item with its quantity, rental period or job size: pricing exactly what the customer listed.",
    work: "It asks for work with data beyond pricing a list it names: choosing the best option under conditions (budget, dates, size, weight), comparing alternatives, working out how much or how many is needed, planning or scheduling, or preparing a list, table, plan or document.",
    other: "Anything else: a question that one fact or one passage of the business's information answers (prices of one item, opening hours, what is offered, how something works), a greeting, or small talk.",
  };
  if (!estimateAvailable) delete criteria.estimate;
  if (!agentAvailable) delete criteria.work;
  const a = await jevAsk({ previous_assistant_reply: previousReply.slice(-1500), message }, {
    kind: { type: "choice", instructions: "Which kind of request is `message` (the customer's latest message in a chat with a business)?", criteria },
  }, 4000);
  const ans = a?.kind as { choice?: string; probabilities?: Record<string, number> } | undefined;
  // A clear decision only; when unsure, the ordinary answer.
  const kind = (ans?.choice && (ans.probabilities?.[ans.choice] ?? 0) >= 0.6 ? ans.choice : "other") as TurnKind;
  if (kindMemo.size > 500) kindMemo.clear();
  kindMemo.set(key, { at: Date.now(), kind });
  return kind;
}

const INSTRUCTION = `Klient w tej rozmowie (rozmowa.md; jego ostatnia wiadomość: request.txt) prosi o coś, co wymaga pracy na danych.
Wykonaj to na podstawie danych projektu: oferty firm w cenniki/, informacje z witryny firmy w ${KNOWLEDGE_DIR}/, wcześniejsze pliki projektu.
Odpowiedź dla klienta zapisz w odpowiedz.txt - w języku klienta, jako wiadomość w czacie (bez nagłówków e-maila i podpisu).
Pliki dla klienta (tabele, listy, zestawienia, plany) zapisz w katalogu ${CUSTOMER_DIR}/ (CSV, MD lub TXT) i wspomnij o nich w odpowiedzi.
Pytania do firmy - tylko w ${BUSINESS_QUESTIONS}, nigdy w odpowiedzi dla klienta.`;

/**
 * Starts the agent on the conversation's latest message. `knowledge` = passages from the business's
 * own site that retrieval found for the message (public data, given to the agent unmasked).
 */
export async function startConversationAgent(projectId: string, transcript: { role: string; content: string }[], knowledge: string[]): Promise<AgentRunState | { error: string }> {
  const last = [...transcript].reverse().find((m) => m.role === "user")?.content || "";
  const lines = transcript.slice(-20).map((m) => `**${m.role === "user" ? "Klient" : "Asystent"}:** ${m.content}`);
  await writeFile(projectId, "rozmowa.md", `# Rozmowa\n\n${lines.join("\n\n")}\n`, "md", "chat");
  await writeFile(projectId, "request.txt", last, "txt", "customer");
  // The previous reply moves to the history, so a run that writes none cannot re-deliver it.
  const prev = await readFile(projectId, "odpowiedz.txt").catch(() => null);
  if (prev && prev.trim()) await writeFile(projectId, `historia/odpowiedz-${Date.now()}.txt`, prev, "txt", "system");
  await writeFile(projectId, "odpowiedz.txt", "", "txt", "system");
  await writeFile(projectId, BUSINESS_QUESTIONS, "", "md", "system");
  if (knowledge.length) await writeFile(projectId, `${KNOWLEDGE_DIR}/strona.md`, `# Informacje z witryny firmy (do tej wiadomości)\n\n${knowledge.join("\n\n---\n\n")}\n`, "md", "system");
  return startAgentRun(projectId, INSTRUCTION, "chat");
}

// What the visitor sees while the agent works, and when it could not finish (by language).
export const WORKING: Record<string, string> = {
  pl: "Przygotowuję to dla Ciebie - to zajmie chwilę (zwykle do 2-3 minut). Wynik pojawi się tutaj.",
  en: "I'm working on this for you - it takes a moment (usually up to 2-3 minutes). The result will appear here.",
  uk: "Готую це для вас - це займе трохи часу (зазвичай до 2-3 хвилин). Результат з'явиться тут.",
  fr: "Je m'en occupe - cela prend un instant (en général 2 à 3 minutes). Le résultat s'affichera ici.",
  de: "Ich bereite das für Sie vor - das dauert einen Moment (meist bis zu 2-3 Minuten). Das Ergebnis erscheint hier.",
};
export const BUSY: Record<string, string> = {
  pl: "Wciąż pracuję nad Twoją poprzednią prośbą - wynik pojawi się tutaj. Tę wiadomość uwzględnię zaraz potem.",
  en: "I'm still working on your previous request - the result will appear here. I'll take this message into account right after.",
  uk: "Я ще працюю над вашим попереднім запитом - результат з'явиться тут. Це повідомлення врахую одразу після.",
  fr: "Je travaille encore sur votre demande précédente - le résultat s'affichera ici. Je tiendrai compte de ce message juste après.",
  de: "Ich arbeite noch an Ihrer vorherigen Anfrage - das Ergebnis erscheint hier. Diese Nachricht berücksichtige ich direkt danach.",
};
export const REVIEWING: Record<string, string> = {
  pl: "Gotowe - firma jeszcze to sprawdza, zanim do Ciebie trafi. Odpowiedź pojawi się tutaj, gdy tylko ją zatwierdzi.",
  en: "Done - the business is checking it before it reaches you. The reply will appear here as soon as they approve it.",
  uk: "Готово - компанія ще перевіряє це, перш ніж надіслати вам. Відповідь з'явиться тут, щойно її затвердять.",
  fr: "C'est prêt - l'entreprise le vérifie avant de vous l'envoyer. La réponse s'affichera ici dès qu'elle l'aura validée.",
  de: "Fertig - das Unternehmen prüft es noch, bevor Sie es erhalten. Die Antwort erscheint hier, sobald es freigegeben ist.",
};
export const COULD_NOT: Record<string, string> = {
  pl: "Niestety nie udało mi się tego teraz przygotować. Zapisałem Twoje zapytanie - firma odpowie na nie bezpośrednio.",
  en: "Sorry, I couldn't prepare this right now. Your request is saved and the business will get back to you directly.",
  uk: "На жаль, зараз не вдалося це підготувати. Ваш запит збережено - компанія відповість вам безпосередньо.",
  fr: "Désolé, je n'ai pas pu préparer cela pour le moment. Votre demande est enregistrée et l'entreprise vous répondra directement.",
  de: "Leider konnte ich das gerade nicht vorbereiten. Ihre Anfrage ist gespeichert - das Unternehmen meldet sich direkt bei Ihnen.",
};

/**
 * Starts the agent in the background (masking + sandbox start can take tens of seconds on a cold start;
 * the visitor gets the "working on it" reply at once). A start that fails becomes a failed run, which
 * the widget then reports.
 */
export async function beginConversationAgent(projectId: string, transcript: { role: string; content: string }[], knowledge: string[]): Promise<"started" | "busy"> {
  const p = await getProject(projectId);
  const cur = p?.memory.agentRun as AgentRunState | undefined;
  const pendingAt = Number(p?.memory.agentPending) || 0;
  if ((cur && (cur.status === "running" || cur.status === "collecting") && Date.now() - Date.parse(cur.startedAt) < 20 * 60_000)
    || (pendingAt && Date.now() - pendingAt < 4 * 60_000 && (!cur || Date.parse(cur.startedAt) < pendingAt - 1000))) return "busy";
  const at = Date.now();
  await setMemory(projectId, { agentPending: at });
  void startConversationAgent(projectId, transcript, knowledge).then(async (r) => {
    if ("error" in r) {
      console.warn(`[conversation] ${projectId}: agent did not start: ${r.error}`);
      await setMemory(projectId, { agentRun: { runId: `failed-${at}`, status: "failed", error: r.error, startedAt: new Date(at).toISOString(), attempt: 1, model: "", instruction: "" } });
    }
  }).catch(async (e) => {
    console.warn(`[conversation] ${projectId}: agent start error: ${(e as Error).message}`);
    await setMemory(projectId, { agentRun: { runId: `failed-${at}`, status: "failed", error: String((e as Error).message), startedAt: new Date(at).toISOString(), attempt: 1, model: "", instruction: "" } }).catch(() => {});
  });
  return "started";
}

/**
 * The owner asked for changes (review): the agent reworks the result with their guidance, and the new
 * version comes back for review. Runs in the background like any agent turn.
 */
export async function reworkWithGuidance(projectId: string, note: string): Promise<void> {
  // A new version: the owner reviews it again (no auto-send of reworked results).
  const at = Date.now();
  await setMemory(projectId, { agentPending: at, ownerLoop: true });
  const previous = ((await readFile(projectId, "odpowiedz.txt").catch(() => null)) || "").trim();
  await writeFile(projectId, "uwagi_firmy.md", `# Uwagi firmy do poprzedniej wersji\n\n${note}\n\n## Poprzednia wersja odpowiedzi\n\n${previous || "(brak)"}\n`, "md", "business");
  if (previous) await writeFile(projectId, `historia/odpowiedz-${at}.txt`, previous, "txt", "system");
  await writeFile(projectId, "odpowiedz.txt", "", "txt", "system");
  await writeFile(projectId, BUSINESS_QUESTIONS, "", "md", "system");
  const instruction = `${INSTRUCTION}\n\nFirma przejrzała poprzednią wersję i prosi o zmiany: uwzględnij uwagi z uwagi_firmy.md (tam też poprzednia wersja odpowiedzi). Uwagi firmy mają pierwszeństwo.`;
  void startAgentRun(projectId, instruction, "business").then(async (r) => {
    if ("error" in r) await setMemory(projectId, { agentRun: { runId: `failed-${at}`, status: "failed", error: r.error, startedAt: new Date(at).toISOString(), attempt: 1, model: "", instruction: "" } });
  }).catch(() => {});
}

export interface AgentDelivery { status: "none" | "running" | "review" | "done" | "failed"; message?: string; files?: string[]; projectId: string }

/**
 * For the visitor's widget: the agent's result once ready - the text for the customer and the files
 * prepared for them. Delivered once into the conversation log (onDeliver).
 */
/**
 * Called when an agent run has finished (src/projects/agent.ts): a business that approves first gets
 * the review right away - not only when the customer's chat next checks in (the customer may have
 * left; a reworked version has no customer waiting at all).
 */
/**
 * The agent's open questions for the business from this run - only those the result really depends on:
 * Jev keeps a question when the customer's request needs its answer and the project data does not
 * have it (the agent tends to add generic ones: availability, transport nobody asked about).
 * Decided once per run and kept in the project's memory.
 */
export async function businessQuestions(projectId: string, run?: AgentRunState): Promise<string[]> {
  if (run && !(run.files || []).includes(BUSINESS_QUESTIONS)) return [];
  const p = await getProject(projectId);
  const kept = p?.memory.businessQuestions as { runId: string; questions: string[] } | undefined;
  if (run && kept?.runId === run.runId) return kept.questions;
  const t = (await readFile(projectId, BUSINESS_QUESTIONS).catch(() => null)) || "";
  const raw = t.split("\n").map((l) => { let x = l.trim(); while (x.startsWith("-") || x.startsWith("*") || x.startsWith("#")) x = x.slice(1).trim(); return x; }).filter((l) => l.length > 3).slice(0, 10);
  let questions = raw;
  if (raw.length) {
    const [conversation, request] = await Promise.all([readFile(projectId, "rozmowa.md").catch(() => null), readFile(projectId, "request.txt").catch(() => null)]);
    // Asked as a fact about the conversation: did the customer raise what the question is about?
    const qs: Record<string, { type: "noul"; instructions: string }> = {};
    raw.forEach((q, k) => {
      qs[`q${k}`] = { type: "noul", instructions: `Question for the business: "${q}". Did the customer, in \`conversation\`, mention or ask about the specific thing this question is about? It counts only if the customer brought it up: a question about delivery counts only if the customer mentioned delivery; about availability or dates only if the customer gave dates or asked about availability; about a price detail only if the customer asked about that detail.` };
    });
    const a = await jevAsk({ conversation: (conversation || "").slice(-3000) || (request || "").slice(0, 1500) }, qs, 8000);
    if (a) questions = raw.filter((_, k) => (((a as any)[`q${k}`]?.noul as number) ?? 1) >= 0.5);
  }
  if (run) await setMemory(projectId, { businessQuestions: { runId: run.runId, questions } }).catch(() => {});
  return questions;
}

/** The owner reviews first when the business chose so, or whenever the agent has questions for it. */
async function ownerFirst(projectId: string, tenantId: string, run: AgentRunState): Promise<boolean> {
  if (reviewMode(tenantId) === "approve" || run.needsOwner) return true;
  // Once the owner has stepped in (answered questions, asked for changes), new versions come back to them.
  const p = await getProject(projectId);
  if (p?.memory.ownerLoop) return true;
  return (await businessQuestions(projectId, run)).length > 0;
}

export async function onRunFinished(projectId: string): Promise<void> {
  const p = await getProject(projectId);
  const s = p?.memory.agentRun as AgentRunState | undefined;
  if (!p || p.type !== CONVERSATION || !s || (s.status !== "done" && s.status !== "failed")) return;
  if (!(await ownerFirst(projectId, p.initiatorTenantId, s)) || (await reviewForRun(projectId, s.runId))) return;
  const files = (s.files || []).filter((f) => f.startsWith(`${CUSTOMER_DIR}/`));
  const draft = s.status === "done" ? ((await readFile(projectId, "odpowiedz.txt")) || "").trim() : "";
  await openReview(projectId, p.initiatorTenantId, s.runId, draft, files);
}

export async function agentDelivery(projectId: string, onDeliver: (message: string) => Promise<void>): Promise<AgentDelivery> {
  const before = await getProject(projectId);
  if (!before) return { status: "none", projectId };
  const pendingAt = Number(before.memory.agentPending) || 0;
  const run = before.memory.agentRun as AgentRunState | undefined;
  // Started in the background and not registered yet: still starting (a few minutes at most).
  if (pendingAt && (!run || Date.parse(run.startedAt) < pendingAt - 1000)) {
    if (Date.now() - pendingAt < 4 * 60_000) return { status: "running", projectId };
  }
  const s = run && run.runId.startsWith("failed-") ? run : await agentStatus(projectId);
  if (!s) return { status: "none", projectId };
  if (s.status === "running" || s.status === "collecting") return { status: "running", projectId };
  const p = await getProject(projectId);
  const delivered = (p?.memory.delivered as string | undefined) === s.runId;
  let files = (s.files || []).filter((f) => f.startsWith(`${CUSTOMER_DIR}/`));
  const draft = s.status === "done" ? ((await readFile(projectId, "odpowiedz.txt")) || "").trim() : "";
  let message = draft;
  // The business approves first (its choice): the customer is told it is being checked; the result
  // goes out once the owner decides.
  const tenantId = p?.initiatorTenantId || "";
  if (tenantId && (await ownerFirst(projectId, tenantId, s))) {
    const rv = (await reviewForRun(projectId, s.runId)) || (await openReview(projectId, tenantId, s.runId, draft, files));
    if (rv.status === "pending" || rv.status === "changes_requested") {
      const lang = await replyLanguage(projectId);
      const text = REVIEWING[lang] || REVIEWING.en;
      if ((p?.memory.reviewNotified as string | undefined) !== s.runId) {
        await setMemory(projectId, { reviewNotified: s.runId });
        await onDeliver(text).catch(() => {});
      }
      return { status: "review", message: text, projectId };
    }
    if (rv.status === "approved") message = (rv.final || draft).trim();
    else { message = rv.final.trim(); files = []; }
  }
  if (!message) message = COULD_NOT[await replyLanguage(projectId)] || COULD_NOT.en;
  if (!delivered) {
    await setMemory(projectId, { delivered: s.runId, ownerLoop: false });
    await onDeliver(message).catch(() => {});
    await addEvent(projectId, { kind: "delivered", actor: "chat", data: { runId: s.runId, status: s.status, files } }).catch(() => {});
  }
  return { status: s.status === "done" || message !== draft ? "done" : "failed", message, files, projectId };
}

async function replyLanguage(projectId: string): Promise<string> {
  const req = (await readFile(projectId, "request.txt").catch(() => null)) || "";
  const a = await jevAsk({ text: req.slice(0, 1000) }, { lang: { type: "choice", instructions: "Which language is `text` written in?", criteria: { pl: "Polish", en: "English", uk: "Ukrainian", fr: "French", de: "German", other: "another language" } } }, 4000);
  return ((a?.lang as any)?.choice as string) || "pl";
}
