/**
 * Every conversation is a project (conversation@1): created on the first message of a chat session,
 * it keeps the turn log (what was asked, how it was handled, what was answered), the repository and
 * the memory. Most turns are answered from the business's knowledge; when a message needs real work
 * - calculations, comparing options, a plan, a list, a table or document - the system decides so
 * (Jev) and the project agent does it in the project's sandbox (src/projects/agent.ts). The reply
 * then arrives in the same chat when the agent is done (the widget polls /api/chat/agent).
 */
import { createProject, findOpenProject, addEvent, getProject, setMemory, claimMemory } from "./store.js";
import { writeFile, readFile } from "./repo.js";
import { agentEnabled, agentStatus, type AgentRunState } from "./agent.js";
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
Plik dla klienta tylko wtedy, gdy wynik jest czymś do zachowania (zestawienie wielu pozycji, porównanie, plan) - zapisz go w ${CUSTOMER_DIR}/ (CSV, MD lub TXT) i wspomnij o nim w odpowiedzi; krótka odpowiedź nie potrzebuje pliku.
Pytania do firmy - tylko w ${BUSINESS_QUESTIONS}, nigdy w odpowiedzi dla klienta.
Nie obiecuj klientowi niczego na później („uzupełnię, gdy…”, „firma się odezwie”) - napisz, czego brakuje i co klient może zrobić.`;

/**
 * Starts the agent on the conversation's latest message. `knowledge` = passages from the business's
 * own site that retrieval found for the message (public data, given to the agent unmasked).
 */
export async function startConversationAgent(projectId: string, transcript: { role: string; content: string }[], knowledge: string[]): Promise<{ runId: string } | { error: string }> {
  const last = [...transcript].reverse().find((m) => m.role === "user")?.content || "";
  const lines = transcript.slice(-20).map((m) => `**${m.role === "user" ? "Klient" : "Asystent"}:** ${m.content}`);
  // The previous reply moves to the history, so a run that writes none cannot re-deliver it.
  const prev = await readFile(projectId, "odpowiedz.txt").catch(() => null);
  // Independent writes, all at once (each is a storage + database call).
  await Promise.all([
    writeFile(projectId, "rozmowa.md", `# Rozmowa\n\n${lines.join("\n\n")}\n`, "md", "chat"),
    writeFile(projectId, "request.txt", last, "txt", "customer"),
    prev && prev.trim() ? writeFile(projectId, `historia/odpowiedz-${Date.now()}.txt`, prev, "txt", "system") : null,
    writeFile(projectId, "odpowiedz.txt", "", "txt", "system"),
    writeFile(projectId, BUSINESS_QUESTIONS, "", "md", "system"),
    knowledge.length ? writeFile(projectId, `${KNOWLEDGE_DIR}/strona.md`, `# Informacje z witryny firmy (do tej wiadomości)\n\n${knowledge.join("\n\n---\n\n")}\n`, "md", "system") : null,
    setMemory(projectId, { baseInstruction: INSTRUCTION, networkAsked: false, networkContinued: false, subRequests: [] }),
  ]);
  const { planAndRun } = await import("./plan.js");
  return planAndRun(projectId, INSTRUCTION, "chat");
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
// A result left waiting for the owner (reviewLateMs): where it will appear; no promise of when.
export const REVIEW_LATE: Record<string, string> = {
  pl: "Firma jeszcze nie zatwierdziła tej odpowiedzi. Gdy to zrobi, pojawi się ona tutaj i pod tym linkiem: {link} (a jeśli zostawiłeś e-mail - wyślę ją też na niego). Nie musisz czekać na tej stronie.",
  en: "The business hasn't approved this reply yet. Once it does, it will appear here and at this link: {link} (and by email, if you left one). You don't have to wait on this page.",
  uk: "Компанія ще не затвердила цю відповідь. Щойно вона це зробить, відповідь з'явиться тут і за цим посиланням: {link} (а якщо ви залишили e-mail - надішлю її і туди). Не потрібно чекати на цій сторінці.",
  fr: "L'entreprise n'a pas encore validé cette réponse. Dès qu'elle l'aura fait, elle s'affichera ici et à ce lien : {link} (et par e-mail, si vous en avez laissé un). Inutile d'attendre sur cette page.",
  de: "Das Unternehmen hat diese Antwort noch nicht freigegeben. Sobald es das tut, erscheint sie hier und unter diesem Link: {link} (und per E-Mail, falls Sie eine angegeben haben). Sie müssen nicht auf dieser Seite warten.",
};
// Nothing was recorded for the business here: say so, promise nothing.
export const COULD_NOT: Record<string, string> = {
  pl: "Niestety nie udało mi się tego teraz przygotować. Spróbuj zapytać jeszcze raz albo skontaktuj się z firmą bezpośrednio.",
  en: "Sorry, I couldn't prepare this right now. Please try asking again or contact the business directly.",
  uk: "На жаль, зараз не вдалося це підготувати. Спробуйте запитати ще раз або зв'яжіться з компанією безпосередньо.",
  fr: "Désolé, je n'ai pas pu préparer cela pour le moment. Réessayez ou contactez directement l'entreprise.",
  de: "Leider konnte ich das gerade nicht vorbereiten. Bitte fragen Sie noch einmal oder wenden Sie sich direkt an das Unternehmen.",
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
  const { planAndRun } = await import("./plan.js");
  const base = String((await getProject(projectId))?.memory.baseInstruction || INSTRUCTION);
  void planAndRun(projectId, base, "business", `Firma przejrzała poprzednią wersję (uwagi_firmy.md) i prosi o zmiany - mają pierwszeństwo:\n${note}`).then(async (r) => {
    if ("error" in r) await setMemory(projectId, { agentRun: { runId: `failed-${at}`, status: "failed", error: r.error, startedAt: new Date(at).toISOString(), attempt: 1, model: "", instruction: "" } });
  }).catch(() => {});
}

// The customer can leave their email to get the result when it is ready (with consent, per project).
// The customer's own page for a request: whisp.so/p/<token> shows its status and, when ready, the
// result (only what the customer may see). Unguessable, one per project.
export async function customerLink(projectId: string): Promise<string> {
  const { d1Query } = await import("../storage/conversation-store.js");
  await d1Query("CREATE TABLE IF NOT EXISTS customer_links (token TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)");
  const found = (await d1Query("SELECT token FROM customer_links WHERE project_id = ?", [projectId]))[0];
  if (found) return found.token as string;
  // Letters and digits only: a token ending in "_" or "-" lost that character in links (markdown, SMS
  // apps and e-mail linkifiers treat it as trailing punctuation), so the page said the link had expired.
  const { randomBytes } = await import("crypto");
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const token = [...randomBytes(24)].map((b) => ALPHA[b % 62]).join("");
  await d1Query("INSERT OR IGNORE INTO customer_links (token, project_id, created_at) VALUES (?, ?, ?)", [token, projectId, new Date().toISOString()]);
  return ((await d1Query("SELECT token FROM customer_links WHERE project_id = ?", [projectId]))[0]?.token as string) || token;
}

export async function projectByLink(token: string): Promise<string | null> {
  if (!token || token.length > 64) return null;
  const { d1Query } = await import("../storage/conversation-store.js");
  // Older tokens could end in "_" / "-", which links often drop: accept the link without it.
  const r = (await d1Query("SELECT project_id FROM customer_links WHERE token IN (?, ?, ?) LIMIT 1", [token, `${token}_`, `${token}-`]).catch(() => []))[0];
  return r ? (r.project_id as string) : null;
}

export const LINK_TEXT: Record<string, string> = {
  pl: "Nie musisz czekać na tej stronie - wynik pojawi się też tutaj:",
  en: "You don't have to wait on this page - the result will also appear here:",
  uk: "Не потрібно чекати на цій сторінці - результат з'явиться також тут:",
  fr: "Inutile d'attendre sur cette page - le résultat s'affichera aussi ici :",
  de: "Sie müssen nicht auf dieser Seite warten - das Ergebnis erscheint auch hier:",
};

/** The chat's button to the customer's status page (a new tab, live updates, the notification choice). */
export const OPEN_STATUS: Record<string, { button: string; hint: string; names: Record<string, string> }> = {
  pl: { button: "Otwórz status zapytania", hint: "Otworzy się w nowej karcie i będzie się aktualizować na bieżąco. Tam wybierzesz, jak mamy Cię powiadomić: {channels}.", names: { sms: "SMS", whatsapp: "WhatsApp", telegram: "Telegram", email: "e-mail" } },
  en: { button: "Open the status of your request", hint: "It opens in a new tab and updates live. There you choose how we notify you: {channels}.", names: { sms: "SMS", whatsapp: "WhatsApp", telegram: "Telegram", email: "e-mail" } },
  uk: { button: "Відкрити статус запиту", hint: "Відкриється в новій вкладці й оновлюватиметься наживо. Там ви оберете, як вас повідомити: {channels}.", names: { sms: "SMS", whatsapp: "WhatsApp", telegram: "Telegram", email: "e-mail" } },
  fr: { button: "Ouvrir le suivi de votre demande", hint: "Il s'ouvre dans un nouvel onglet et se met à jour en direct. Vous y choisissez comment être prévenu : {channels}.", names: { sms: "SMS", whatsapp: "WhatsApp", telegram: "Telegram", email: "e-mail" } },
  de: { button: "Status Ihrer Anfrage öffnen", hint: "Er öffnet sich in einem neuen Tab und aktualisiert sich live. Dort wählen Sie, wie wir Sie benachrichtigen: {channels}.", names: { sms: "SMS", whatsapp: "WhatsApp", telegram: "Telegram", email: "E-Mail" } },
};

export const NOTIFY: Record<string, { prompt: string; consent: string; button: string; saved: string; invalid: string }> = {
  pl: { prompt: "Nie musisz czekać - wyślę wynik na e-mail:", consent: "Zgadzam się, aby {brand} wysłał mi wynik tego zapytania na podany e-mail.", button: "Wyślij mi wynik", saved: "Dziękuję - wynik wyślę na {email}.", invalid: "Sprawdź adres e-mail." },
  en: { prompt: "No need to wait - I can email you the result:", consent: "I agree that {brand} emails me the result of this request.", button: "Email me the result", saved: "Thanks - I'll send the result to {email}.", invalid: "Please check the email address." },
  uk: { prompt: "Не потрібно чекати - надішлю результат на e-mail:", consent: "Я погоджуюся, щоб {brand} надіслав мені результат цього запиту на вказаний e-mail.", button: "Надіслати результат", saved: "Дякую - результат надішлю на {email}.", invalid: "Перевірте адресу e-mail." },
  fr: { prompt: "Inutile d'attendre - je peux vous envoyer le résultat par e-mail :", consent: "J'accepte que {brand} m'envoie le résultat de cette demande par e-mail.", button: "M'envoyer le résultat", saved: "Merci - j'enverrai le résultat à {email}.", invalid: "Vérifiez l'adresse e-mail." },
  de: { prompt: "Sie müssen nicht warten - ich sende Ihnen das Ergebnis per E-Mail:", consent: "Ich bin einverstanden, dass {brand} mir das Ergebnis dieser Anfrage per E-Mail sendet.", button: "Ergebnis senden", saved: "Danke - ich sende das Ergebnis an {email}.", invalid: "Bitte prüfen Sie die E-Mail-Adresse." },
};

/** The customer's email for this project's result, with the consent they gave (recorded). */
export async function setCustomerContact(projectId: string, tenantId: string, email: string, lang: string, consentText: string): Promise<void> {
  await setCustomerChannel(projectId, tenantId, "email", email, lang, consentText);
}

/** One more way to reach the customer about this request (e-mail, SMS, WhatsApp, Telegram), with their consent recorded. */
export async function setCustomerChannel(projectId: string, tenantId: string, channel: "email" | "sms" | "whatsapp" | "telegram", value: string, lang: string, consentText: string): Promise<void> {
  const { recordConsent } = await import("./store.js");
  const key = channel === "sms" ? "phone" : channel === "telegram" ? "telegramChatId" : channel;
  await recordConsent(projectId, { toTenantId: tenantId, fields: [key], text: consentText });
  const p = await getProject(projectId);
  const prev = (p?.memory.customerContact as Record<string, unknown> | undefined) || {};
  await setMemory(projectId, { customerContact: { ...prev, [key]: value, lang, at: new Date().toISOString() } });
}

/**
 * Server-side delivery (the customer may have left): once the result is ready - sent automatically or
 * decided by the owner - it is logged into the conversation and emailed if the customer asked for that.
 * Idempotent: agentDelivery delivers each run once.
 */
export async function deliverNow(projectId: string): Promise<void> {
  const p = await getProject(projectId);
  if (!p || p.type !== CONVERSATION) return;
  const { logMessage } = await import("../storage/conversation-store.js");
  await agentDelivery(projectId, async (message) => {
    await logMessage(p.initiatorTenantId, p.customerSession, "assistant", message, { flowInvoked: "project-agent" }).catch(() => {});
  }, async (message, files, status) => {
    const contact = p.memory.customerContact as (import("./notify-channels.js").CustomerContact) | undefined;
    if (!contact || status === "review") return;
    // SMS / WhatsApp / Telegram: a short "it's ready" with the status page link.
    if (contact.phone || contact.whatsapp || contact.telegramChatId) {
      const { getTenant } = await import("../multi-tenant/d1-registry.js");
      const t = getTenant(p.initiatorTenantId);
      const token = await customerLink(projectId).catch(() => "");
      const { sendResultReady } = await import("./notify-channels.js");
      const sent = await sendResultReady(contact, { brand: t?.settings?.siteCard?.brand || t?.brandName || t?.domain || "", link: token ? `${process.env.BASE_URL || "https://whisp.so"}/p/${token}` : "" }).catch((e) => ({ error: String((e as Error).message).slice(0, 200) }));
      await addEvent(projectId, { kind: "result_messaged", actor: "system", data: sent }).catch(() => {});
    }
    if (!contact.email) return;
    // Any failure is recorded (a missing email key used to fail silently).
    let sendResultEmail: typeof import("../multi-tenant/email.js").sendResultEmail;
    try { ({ sendResultEmail } = await import("../multi-tenant/email.js")); }
    catch (e) {
      await addEvent(projectId, { kind: "result_emailed", actor: "system", data: { sent: false, error: String((e as Error).message).slice(0, 200) } }).catch(() => {});
      return;
    }
    const { getTenant } = await import("../multi-tenant/d1-registry.js");
    const t = getTenant(p.initiatorTenantId);
    // The customer's files, attached (CSV with a BOM so Excel opens Polish characters correctly).
    const { readFileBuffer } = await import("./repo.js");
    const attachments: { name: string; content: Buffer }[] = [];
    for (const f of files.slice(0, 10)) {
      let buf = await readFileBuffer(projectId, f).catch(() => null);
      if (!buf) continue;
      if (f.toLowerCase().endsWith(".csv") && !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)) buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
      attachments.push({ name: f.split("/").pop() || f, content: buf });
    }
    const sent = await sendResultEmail(contact.email, { brand: t?.settings?.siteCard?.brand || t?.brandName || t?.domain || "", replyTo: t?.email || "", lang: contact.lang, message, files: attachments, site: t?.siteUrl || "" }).catch(() => false);
    await addEvent(projectId, { kind: "result_emailed", actor: "system", data: { sent, files: files.length } }).catch(() => {});
  });
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
  const p = await getProject(projectId);
  // A business that has not joined has no owner to wait for - until it steps in on its invite page.
  if (p?.memory.listed && !p.memory.ownerLoop) return false;
  if (reviewMode(tenantId) === "approve" || run.needsOwner) return true;
  // Quantities only (no prices, no commitments - the owner's decision 2026-10-22): delivered as is;
  // questions for the business stay in the project for the owner, but don't hold the customer up.
  if (p?.memory.pureCalc) return false;
  // A result that failed a check (but exists) is the owner's call, not a dead end for the customer.
  if (run.status === "failed" && !run.runId.startsWith("failed-") && ((await readFile(projectId, "odpowiedz.txt").catch(() => null)) || "").trim()) return true;
  // Once the owner has stepped in (answered questions, asked for changes), new versions come back to them.
  if (p?.memory.ownerLoop) return true;
  return (await businessQuestions(projectId, run)).length > 0;
}

export async function onRunFinished(projectId: string): Promise<void> {
  const p = await getProject(projectId);
  const s = p?.memory.agentRun as AgentRunState | undefined;
  if (!p || !s || (s.status !== "done" && s.status !== "failed")) return;
  const net = await import("./network.js");
  if (p.type === CONVERSATION) {
    // Requests to other businesses first: the result waits for their answers.
    if ((s.files || []).includes(net.REQUESTS_FILE) && p.memory.networkChecked !== s.runId) {
      const asked = await net.askBusinesses(projectId, (p.memory.businessSlugs as Record<string, string>) || {}).catch((e) => { console.warn(`[network] ${projectId}: ${(e as Error).message}`); return false; });
      await setMemory(projectId, { networkChecked: s.runId });
      if (asked) return;
    }
  } else if (p.type !== net.BUSINESS_REQUEST) return;
  const files = (s.files || []).filter((f) => f.startsWith(`${CUSTOMER_DIR}/`));
  const draft = s.status === "done" ? ((await readFile(projectId, "odpowiedz.txt")) || "").trim() : "";
  if (await ownerFirst(projectId, p.initiatorTenantId, s)) {
    // The owner sees whatever the agent wrote, also when a check failed (the page shows which).
    const forOwner = draft || (s.runId.startsWith("failed-") ? "" : ((await readFile(projectId, "odpowiedz.txt").catch(() => null)) || "").trim());
    if (!(await reviewForRun(projectId, s.runId))) await openReview(projectId, p.initiatorTenantId, s.runId, forOwner, files);
    return;
  }
  // A business answering another business's request without review: the answer goes straight back.
  // Part of it left without a price: the owner (of a business that has joined) is asked for one too.
  if (p.type === net.BUSINESS_REQUEST) {
    if (draft && !p.memory.listed && !p.memory.ownerQuote && (await net.leavesUnpriced(String(p.memory.question || ""), draft))) {
      await net.askOwnerForQuote(projectId, s.runId, draft).catch((e) => console.warn(`[network] ${projectId}: owner not asked for a quote: ${(e as Error).message}`));
    }
    await net.settle(projectId, draft, draft ? "answered" : "no_answer");
  }
  // The customer's result, also when nobody is on the page.
  else await deliverNow(projectId).catch((e) => console.warn(`[conversation] ${projectId}: delivery: ${(e as Error).message}`));
}

export async function agentDelivery(projectId: string, onDeliver: (message: string) => Promise<void>, onFinal?: (message: string, files: string[], status: string) => Promise<void>): Promise<AgentDelivery> {
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
  // Waiting for other businesses (or about to ask them): not ready for the customer yet.
  const net = await import("./network.js");
  const now = await getProject(projectId);
  if ((s.files || []).includes(net.REQUESTS_FILE) && now?.memory.networkChecked !== s.runId) return { status: "running", projectId };
  if (now && net.waitingOnBusinesses(now.memory)) { await net.checkDeadlines(projectId); return { status: "running", projectId }; }
  if (now?.memory.networkContinued && Number(now.memory.agentPending) > Date.parse(s.startedAt)) return { status: "running", projectId };
  const p = await getProject(projectId);
  const delivered = (p?.memory.delivered as string | undefined) === s.runId;
  let files = (s.files || []).filter((f) => f.startsWith(`${CUSTOMER_DIR}/`));
  const draft = s.status === "done" ? ((await readFile(projectId, "odpowiedz.txt")) || "").trim() : "";
  let message = draft;
  // The business approves first (its choice): the customer is told it is being checked; the result
  // goes out once the owner decides.
  const tenantId = p?.initiatorTenantId || "";
  if (tenantId && (await ownerFirst(projectId, tenantId, s))) {
    const forOwner = draft || (s.runId.startsWith("failed-") ? "" : ((await readFile(projectId, "odpowiedz.txt").catch(() => null)) || "").trim());
    const rv = (await reviewForRun(projectId, s.runId)) || (await openReview(projectId, tenantId, s.runId, forOwner, files));
    if (rv.status === "pending" || rv.status === "changes_requested") {
      const lang = await replyLanguage(projectId);
      const text = await wordNotice(projectId, s.runId, "reviewing", lang, REVIEWING[lang] || REVIEWING.en, "The result is ready, but the business checks it before it reaches the customer; it will appear in this chat once approved.");
      if ((p?.memory.reviewNotified as string | undefined) !== s.runId && (await claimMemory(projectId, "reviewNotified", s.runId))) {
        await onDeliver(text).catch(() => {});
      }
      // Waiting too long: the customer hears so once - where the result will appear, and that an email
      // follows if they left one. Nothing is promised about when the owner decides.
      const { reviewLateMs } = await import("./review.js");
      if (rv.status === "pending" && Date.now() - Date.parse(rv.createdAt) > reviewLateMs()) {
        const link = `${process.env.BASE_URL || "https://whisp.so"}/p/${await customerLink(projectId).catch(() => "")}`;
        const late = await wordNotice(projectId, s.runId, "late", lang, (REVIEW_LATE[lang] || REVIEW_LATE.en).replace("{link}", link), `The business has not approved the result yet. Once it does, it will appear in this chat and at this link: ${link} (and by e-mail if the customer left one). They don't have to wait on the page. Promise nothing about when.`);
        if ((p?.memory.reviewLate as string | undefined) !== s.runId && (await claimMemory(projectId, "reviewLate", s.runId))) {
          await onDeliver(late).catch(() => {});
        }
        return { status: "review", message: late, projectId };
      }
      return { status: "review", message: text, projectId };
    }
    if (rv.status === "approved") message = (rv.final || rv.draft || draft).trim();
    else { message = rv.final.trim(); files = []; }
  }
  if (!message) { const l = await replyLanguage(projectId); message = await wordNotice(projectId, s.runId, "couldnot", l, COULD_NOT[l] || COULD_NOT.en, "We could not prepare the result this time. Suggest asking again or contacting the business directly. Promise nothing."); }
  if (!delivered && (await claimMemory(projectId, "delivered", s.runId))) {
    await setMemory(projectId, { ownerLoop: false });
    await onDeliver(message).catch(() => {});
    if (onFinal) await onFinal(message, files, "final").catch(() => {});
    await addEvent(projectId, { kind: "delivered", actor: "chat", data: { runId: s.runId, status: s.status, files } }).catch(() => {});
  }
  // Done when the customer gets real content: the agent's reply, or the owner's approved / own text.
  const ownerText = message !== draft && message !== (COULD_NOT[await replyLanguage(projectId)] || COULD_NOT.en);
  return { status: (s.status === "done" && !!draft) || ownerText ? "done" : "failed", message, files, projectId };
}

/**
 * A notice to the customer about their calculation, worded by the model once per run (kept in the
 * project); the fixed text only if the model can't be reached.
 */
async function wordNotice(projectId: string, runId: string, kind: string, lang: string, fixed: string, what: string): Promise<string> {
  const p = await getProject(projectId);
  if (!p) return fixed;
  const key = `notice_${kind}`;
  const kept = p.memory[key] as { runId: string; text: string } | undefined;
  if (kept?.runId === runId && kept.text) return kept.text;
  const names: Record<string, string> = { pl: "Polish", en: "English", uk: "Ukrainian", fr: "French", de: "German" };
  let text = "";
  try {
    const { OpenRouterProvider } = await import("../llm/openrouter-provider.js");
    text = (await new OpenRouterProvider().chat([
      { role: "system", content: `You are the website chat assistant of a business, speaking as "we". Write one short chat message (one or two sentences) to the customer: ${what} Write it in ${names[lang] || "the customer's language"}, naturally, no greeting.` },
      { role: "user", content: "Write the message." },
    ], { maxTokens: 160, temperature: 0.4 })).content.trim();
  } catch {}
  if (!text) return fixed;
  await setMemory(projectId, { [key]: { runId, text } }).catch(() => {});
  return text;
}

async function replyLanguage(projectId: string): Promise<string> {
  const req = (await readFile(projectId, "request.txt").catch(() => null)) || "";
  const a = await jevAsk({ text: req.slice(0, 1000) }, { lang: { type: "choice", instructions: "Which language is `text` written in?", criteria: { pl: "Polish", en: "English", uk: "Ukrainian", fr: "French", de: "German", other: "another language" } } }, 4000);
  return ((a?.lang as any)?.choice as string) || "pl";
}
