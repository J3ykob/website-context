import type { EmbeddingProvider, VectorStore } from "../embeddings/types.js";
import { searchContext } from "../embeddings/pipeline.js";
import type { WebsiteContext, FlowDefinition } from "../context/types.js";
import { renderOfficialInfo } from "../context/business-profile.js";
import { VLLMProvider, type VLLMConfig } from "./vllm-provider.js";
import { OpenRouterProvider, type OpenRouterConfig } from "./openrouter-provider.js";
import {
  ClaudeCLIProvider,
  type ClaudeCLIConfig,
  type GenerateWithToolsResult,
} from "./claude-cli-provider.js";
import type { MCPServerConfig } from "../mcp/server.js";
import {
  startFlowSession,
  processUserInput,
  type FlowSession,
  type ConversationResponse,
} from "../flows/conversation.js";
import { validateInput } from "../security/input-guard.js";
import type { EcosystemMatch } from "../ecosystem/ask.js";
import { route as routeMessage, type Route as TurnRoute } from "./router.js";
import { guessLang } from "./lang.js";
import { buildPackIndex, candidatePacks, scorePacks, renderPacks, renderState, BEHAVIOUR, behaviourName, type Pack, type PackIndex, type PackState } from "./packs.js";
import { isQuestionFlow } from "../flows/collect-store.js";
import { setMemory as setProjectMemory } from "../projects/store.js";
import { type OfferLang, jevPassageRelevance, jevPickOption, jevEnabled, splitStatements, jevUnsupportedStatements, jevAsk, type JevNoulAnswer } from "./jev.js";
import { retrieveFromCatalog, lexicalSnippets, type KnowledgeCatalog, type CatalogChunk } from "../knowledge/catalog.js";
import { buildLinkIndex, guardLinks, type LinkIndex } from "./link-guard.js";
import { findOfferItems, matchItems, type ItemMatch } from "../offer/search.js";
import { coverage, type Coverage } from "../network/coverage.js";
import { agentEnabled } from "../projects/agent.js";
import { conversationProject, recordTurn, beginConversationAgent, WORKING, BUSY, NOTIFY, CONVERSATION, type Route } from "../projects/conversation.js";
import { renderItem, type OfferItem } from "../offer/store.js";
import { collectTurn, startSession, missingLabels, type CollectSession, type CollectVia, type Inquiry } from "../flows/collect.js";
import { noteTurn, markTurn, turnVariant, turnUsage, newTurnUsage, turnCheap, turnIp, turnExempt } from "./turn-usage.js";
import { auditKnowledge, type AuditReport } from "../knowledge/audit.js";
import { keyFacts } from "../knowledge/facts.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatConfig {
  llmProvider: "claude-cli" | "vllm" | "anthropic" | "openrouter";
  claudeCli?: ClaudeCLIConfig;
  vllm?: VLLMConfig;
  openRouter?: OpenRouterConfig;
  anthropicApiKey?: string;
  anthropicModel?: string;
  maxTokens?: number;
  topK?: number;
  systemPromptExtra?: string;
  // Jev-classified catalog of every chunk (knowledge-catalog.json). When present
  // and Jev is reachable, retrieval judges all chunks of the relevant catalogs.
  knowledgeCatalog?: KnowledgeCatalog | null;
  // "In chat" flows: who the assistant speaks for, and where a confirmed
  // inquiry goes (stored + emailed to the owner). Resolves false when it could
  // not be recorded, so the customer is never told it was sent when it wasn't.
  brandName?: string;
  onInquiry?: (inquiry: Inquiry) => Promise<boolean>;
  // The owner's structured offer (products & services) - authoritative for
  // "do you have X / how much is Y", and for the offer check in chat forms.
  offerItems?: OfferItem[];
  /** A large shop whose products come from its catalogue (src/scraper/catalogue.ts): products are searched per question. */
  catalogue?: { source: "woocommerce" | "shopify" | "sitemap"; products: number; siteUrl: string } | null;
  /** Whether the business's owner has a Whisp account (a set password); without one the chat is a demo. */
  hasOwnerAccount?: () => boolean;
  // Ecosystem broadcast (src/ecosystem/ask.ts): the businesses of our network that offer what we don't
  // have - `parts`: the parts of the need searched ([] = nothing to search); `keep`: the parts whose hits are
  // relayed, when only known later (src/network/coverage.ts).
  // onStart fires only when there are other businesses to ask (the widget shows
  // "checking with businesses we work with" while they decide).
  askEcosystem?: (messages: ChatMessage[], onStart?: () => void, parts?: string[], keep?: Promise<string[]>) => Promise<EcosystemMatch[]>;
  // The business's "question for the owner" form (an in-chat collect flow), created on
  // first use: a question the assistant can't answer is passed on through it.
  ensureQuestionFlow?: () => Promise<FlowDefinition | null>;
  // Hand-off links (src/ecosystem/handoff.ts): each business we recommend gets a
  // link that moves the customer to its bot with the conversation so far.
  // Returns tenantId -> URL.
  handoffLinks?: (targets: { tenantId: string; label: string }[], transcript: ChatMessage[], need: string) => Promise<Record<string, string>>;
}

export interface ChatResponse {
  message: string;
  sources: { url: string; title: string }[];
  // false when no usable site context survived retrieval+filtering — the answer
  // is an honest fallback, not grounded in the tenant's content. The server uses
  // this to log/quarantine demos that are active but effectively empty.
  grounded?: boolean;
  // Set when the answer was relayed from ecosystem businesses' bots.
  partners?: { tenantId: string; label: string }[];
  // Set when the model flagged that site content does not cover the question
  // ([[gap: ...]] marker or the log_unknown action) — the server logs it to the
  // D1 gap journal that the dashboard's knowledge-gap view reads.
  unknownQuestion?: string;
  // Not a question to the business (form answers, small talk, a blocked attempt): logged, but not counted in the
  // owner's "what people ask about" (contact details and "super" ranked as top questions - 2026-11-04).
  turnKind?: "question" | "form" | "chitchat" | "blocked";
  navigateTo?: string;
  suggestedAction?: { flowId: string; flowName: string; description: string };
  // An "in chat" flow (order / inquiry) in progress: where it stands, for a
  // caller driving it (e.g. another business's bot in an ecosystem referral).
  collect?: { flowId: string; stage: "collecting" | "confirming" | "sent" | "cancelled" | "failed"; missing: string[] };
  // The project this reply belongs to (multi-business work, src/projects).
  project?: { id: string; type: string; agent?: { status: "running" }; notify?: { lang: string; prompt: string; consent: string; button: string; link?: string; linkText?: string } };
  flowSession?: {
    active: boolean;
    status: FlowSession["status"];
    flowId: string;
    complete: boolean;
    executionMode?: "background" | "guided" | "highlight";
    guidedSteps?: any[];
    guidedInputs?: Record<string, string>;
    formActions?: any[];
    // Goal-driven flow: the widget runs the Jev step loop (/api/agent/step).
    agent?: { flowId: string; startUrl?: string; request: string; lang: "pl" | "en" | "other" };
  };
}

export interface StructuredResponse {
  message: string;
  action?: {
    type: "invoke_flow" | "navigate" | "log_unknown";
    flow_id?: string;
    inputs?: Record<string, string>;
    url?: string;
    question?: string;
  };
}


interface LLMBackend {
  generate(system: string, messages: ChatMessage[], maxTokens: number): Promise<string>;
  generateStream?(system: string, messages: ChatMessage[], maxTokens: number, onToken: (delta: string) => void): Promise<string>;
  generateStructured?(system: string, messages: ChatMessage[], maxTokens: number, schema: object): Promise<StructuredResponse>;
  // Tiny classification calls (yes/no, pick-a-number) on a small, fast model.
  classify?(system: string, prompt: string, maxTokens?: number): Promise<string>;
  generateWithTools?(system: string, messages: ChatMessage[], maxTokens: number, mcpConfig: MCPServerConfig): Promise<GenerateWithToolsResult>;
}

class VLLMBackend implements LLMBackend {
  private provider: VLLMProvider;

  constructor(config: VLLMConfig) {
    this.provider = new VLLMProvider(config);
  }

  async generate(system: string, messages: ChatMessage[], maxTokens: number): Promise<string> {
    const vllmMessages = [
      { role: "system" as const, content: system },
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];
    const result = await this.provider.chat(vllmMessages);
    return result.content;
  }
}

class OpenRouterBackend implements LLMBackend {
  private provider: OpenRouterProvider;

  constructor(config?: OpenRouterConfig) {
    this.provider = new OpenRouterProvider(config);
  }

  async generate(system: string, messages: ChatMessage[], maxTokens: number): Promise<string> {
    const orMessages = [
      { role: "system" as const, content: system },
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];
    // The caller's limit is honoured (it was dropped until 2026-10-29: every call ran at the default 1024).
    const result = await this.provider.chat(orMessages, maxTokens ? { maxTokens } : undefined);
    return result.content;
  }

  async generateStream(system: string, messages: ChatMessage[], maxTokens: number, onToken: (delta: string) => void): Promise<string> {
    const orMessages = [
      { role: "system" as const, content: system },
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];
    const result = await this.provider.chatStream(orMessages, onToken, maxTokens);
    return result.content;
  }

  // Small, fast model for internal classification (answerability gate, flow/mode
  // intent) — a big model is overkill for a one-word decision and adds latency.
  async classify(system: string, prompt: string, maxTokens = 8): Promise<string> {
    // Only the fallback when Jev is unavailable, so accuracy beats speed:
    // gpt-4o-mini routed 6/6 test messages (gemini-2.5-flash-lite 5/6); the
    // previous default, ibm-granite/granite-4.1-8b, no longer exists (404).
    const model = process.env.OPENROUTER_FAST_MODEL || "openai/gpt-4o-mini";
    const result = await this.provider.chat(
      [{ role: "system", content: system }, { role: "user", content: prompt }],
      { model, maxTokens, temperature: 0 },
    );
    return result.content;
  }
}

class ClaudeCLIBackend implements LLMBackend {
  provider: ClaudeCLIProvider;

  constructor(config?: ClaudeCLIConfig) {
    this.provider = new ClaudeCLIProvider(config || { mode: "local" });
  }

  async generate(system: string, messages: ChatMessage[], maxTokens: number): Promise<string> {
    const convo = messages.map((m) => (m.role === "user" ? "User: " : "Assistant: ") + m.content).join("\n\n");
    return this.provider.generate(system, convo + "\n\nAssistant:");
  }

  async generateStructured(system: string, messages: ChatMessage[], maxTokens: number, schema: object): Promise<StructuredResponse> {
    const convo = messages.map((m) => (m.role === "user" ? "User: " : "Assistant: ") + m.content).join("\n\n");
    return this.provider.generateStructured<StructuredResponse>(system, convo, schema);
  }

  async generateWithTools(system: string, messages: ChatMessage[], maxTokens: number, mcpConfig: MCPServerConfig): Promise<GenerateWithToolsResult> {
    const convo = messages.map((m) => (m.role === "user" ? "User: " : "Assistant: ") + m.content).join("\n\n");
    return this.provider.generateWithTools(system, convo + "\n\nAssistant:", mcpConfig);
  }
}

class AnthropicBackend implements LLMBackend {
  private client: any;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    // Dynamic import handled in factory
    this.model = model || "claude-sonnet-4-6-20250514";
    this.client = null;
    this.init(apiKey);
  }

  private init(apiKey?: string) {
    import("@anthropic-ai/sdk").then((mod) => {
      this.client = new mod.default({
        apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
      });
    });
  }

  async generate(system: string, messages: ChatMessage[], maxTokens: number): Promise<string> {
    if (!this.client) {
      const mod = await import("@anthropic-ai/sdk");
      this.client = new mod.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: messages.map((m: ChatMessage) => ({ role: m.role, content: m.content })),
    });

    return response.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("");
  }
}


const FOREIGN_SCRIPT = /[\u0400-\u04FF\u0370-\u03FF\u0590-\u05FF\u0600-\u06FF\u0E00-\u0E7F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/g;
function scriptOf(ch: string): string {
  const c = ch.codePointAt(0)!;
  if (c >= 0x0400 && c <= 0x04ff) return "Cyrillic";
  if (c >= 0x0370 && c <= 0x03ff) return "Greek";
  if (c >= 0x0590 && c <= 0x05ff) return "Hebrew";
  if (c >= 0x0600 && c <= 0x06ff) return "Arabic";
  if (c >= 0x0e00 && c <= 0x0e7f) return "Thai";
  if (c >= 0x3040 && c <= 0x30ff) return "Japanese";
  if (c >= 0xac00 && c <= 0xd7af) return "Korean";
  return "Chinese";
}

// The router's reading of the visitor's language, named outright at the end of the
// prompt: the general "same language" rule alone let an English question about a
// Polish site get an answer that switched to Polish mid-sentence.
const LANG_NAMES: Partial<Record<OfferLang, string>> = { pl: "Polish", en: "English", uk: "Ukrainian", fr: "French", de: "German" };
function replyLanguageOf(lang: string): string {
  const name = LANG_NAMES[lang as OfferLang];
  return name ? `\n\nREPLY LANGUAGE: ${name} - the whole reply in ${name}, even though our information is written in another language.` : lang === "other" ? "\n\nREPLY LANGUAGE: the language the customer writes in (not Polish unless they write Polish)." : "";
}
function replyLanguage(rt: TurnRoute | null): string {
  const name = rt && LANG_NAMES[rt.lang];
  return name ? `\n\nREPLY LANGUAGE: ${name} - the whole reply in ${name}, even though our information is written in another language.` : "";
}

// Honest failure messages of the in-chat forms, when the model cannot be used.
const COLLECT_FAILED: Record<OfferLang, { send: string; turn: string }> = {
  pl: { send: "Przepraszam, nie udało mi się teraz przekazać zapytania. Skontaktuj się z nami bezpośrednio, a chętnie pomożemy.", turn: "Przepraszam, coś poszło nie tak. Napisz proszę jeszcze raz." },
  en: { send: "Sorry, I couldn't pass your request on right now. Please contact us directly and we'll be happy to help.", turn: "Sorry, something went wrong. Please write that again." },
  uk: { send: "Вибачте, зараз не вдалося передати ваш запит. Зв'яжіться з нами безпосередньо - ми охоче допоможемо.", turn: "Вибачте, щось пішло не так. Напишіть, будь ласка, ще раз." },
  fr: { send: "Désolé, je n'ai pas pu transmettre votre demande pour le moment. Contactez-nous directement, nous vous aiderons volontiers.", turn: "Désolé, un problème est survenu. Pouvez-vous réécrire votre message ?" },
  de: { send: "Entschuldigung, ich konnte Ihre Anfrage gerade nicht weitergeben. Bitte kontaktieren Sie uns direkt, wir helfen gern.", turn: "Entschuldigung, da ist etwas schiefgelaufen. Bitte schreiben Sie es noch einmal." },
  other: { send: "Sorry, I couldn't pass your request on right now. Please contact us directly and we'll be happy to help.", turn: "Sorry, something went wrong. Please write that again." },
};
// An in-chat form the customer has not answered for this long is dropped.
const COLLECT_IDLE_MS = 30 * 60 * 1000;
const LANG_OF_NAME: Record<string, OfferLang> = { polish: "pl", english: "en", ukrainian: "uk", french: "fr", german: "de" };
// How long the reply waits for the coverage (src/network/coverage.ts) once its own information is ready: the coverage
// runs next to it from the start (usually done first or within ~1 s - smoke 2026-11-04: 1.2-4.4 s per need); a matcher
// call timing out (8 s, retried) held the first word up to 11 s. Late = no network this turn.
const COVERAGE_WAIT_MS = Number(process.env.COVERAGE_WAIT_MS) || 2500;
// A turn about the offer (router): a price, a product or service, a need, or a follow-up of one. A question about hours,
// contact, terms or the business itself has no offer items to match and nothing for the network - it never waits for
// the item matcher, the split or the coverage.
const aboutOffer = (rt: TurnRoute | null) => !rt || rt.price >= 0.3 || rt.specific >= 0.3 || rt.need >= 0.3 || rt.followup >= 0.5;
// How long a relay waits for its hand-off requests in the customer's language (one call of the network's model, next to
// the businesses' quotes): usually under 1.5 s; late or failed = the parts in Polish (src/llm/chat.ts handoffAsks).
const HANDOFF_ASK_MS = 4000;


// A network search started alongside our own reply (see networkStart): its matches only for `parts` - the parts of the
// need we don't have (all of them on an explicit ask for other businesses); allForeign = the coverage says none of the
// need is ours (never set on an explicit ask: it does not wait for the coverage).
interface NetworkAsk { need: string; lang: OfferLang; matches: Promise<EcosystemMatch[]>; parts: string[]; allForeign: boolean }

/** How a reply was produced (recorded per turn, reported in admin traces). */
export function routeOf(r: ChatResponse): Route {
  return r.project?.agent ? "agent" : r.project ? "estimate" : r.collect ? "collect" : r.flowSession ? "flow"
    : r.partners?.length ? "network" : r.grounded === false ? "refusal" : "knowledge";
}

const AUDIT_SESSION = "audit:";
// The widget's status line while the network is searched (interface text, like the typing dots - the reply itself is the model's).
const NETWORK_SEARCH: Record<string, string> = { pl: "Sprawdzam firmy w sieci Whisp…", en: "Checking businesses in the Whisp network…", uk: "Перевіряю компанії в мережі Whisp…", fr: "Je consulte les entreprises du réseau Whisp…", de: "Ich prüfe Unternehmen im Whisp-Netzwerk…" };

export class WebsiteChat {
  private backend: LLMBackend;
  private maxTokens: number;
  private topK: number;
  private embeddingProvider: EmbeddingProvider;
  private store: VectorStore;
  private context: WebsiteContext;
  private systemPromptExtra: string;
  private knowledgeCatalog: KnowledgeCatalog | null;
  private askEcosystem: ChatConfig["askEcosystem"];
  private ensureQuestionFlow: ChatConfig["ensureQuestionFlow"];
  // Sessions where we offered to pass the visitor's question on to the business
  // (no answer here, or no prices for a quote), or to check the network for the parts
  // we don't have (`parts`, searched on a yes): waiting for their yes.
  private handoffOffers: Map<string, { question: string; lang: OfferLang; kind: "question" | "quote" | "network"; parts?: string[]; at: number }> = new Map();
  // The router's decision per message (the stream path decides, the full path reuses it).
  private routeMemo: Map<string, { at: number; route: TurnRoute | null }> = new Map();
  private handoffLinks: ChatConfig["handoffLinks"];
  private contextNotes: { question: string; answer: string; addedAt: string }[] = [];
  private flowSessions: Map<string, FlowSession> = new Map();
  // When a message plausibly matches 2+ flows, we ask which one and remember
  // the candidates until the visitor picks (multi-flow disambiguation).
  private pendingDisambig: Map<string, { flows: FlowDefinition[]; at: number }> = new Map();
  private collectSessions: Map<string, CollectSession> = new Map();
  // Who sent this visitor here (an ecosystem hand-off link): marks any inquiry
  // the visitor then completes in this chat. Same idle TTL as collect sessions.
  private sessionVia: Map<string, { via: CollectVia; at: number }> = new Map();
  private brandName = "";
  private offerItems: OfferItem[] = [];
  private catalogue: ChatConfig["catalogue"] = null;
  private hasOwnerAccount?: () => boolean;
  private onInquiry?: (inquiry: Inquiry) => Promise<boolean>;

  constructor(
    embeddingProvider: EmbeddingProvider,
    store: VectorStore,
    context: WebsiteContext,
    config: ChatConfig
  ) {
    this.maxTokens = config.maxTokens || 1024;
    this.topK = config.topK || 15;
    this.embeddingProvider = embeddingProvider;
    this.store = store;
    this.context = context;
    this.systemPromptExtra = config.systemPromptExtra || "";
    this.knowledgeCatalog = config.knowledgeCatalog || null;
    this.brandName = config.brandName || "";
    this.offerItems = config.offerItems || [];
    this.catalogue = config.catalogue || null;
    this.hasOwnerAccount = config.hasOwnerAccount;
    this.onInquiry = config.onInquiry;
    this.askEcosystem = config.askEcosystem;
    this.ensureQuestionFlow = config.ensureQuestionFlow;
    this.handoffLinks = config.handoffLinks;

    if (config.llmProvider === "claude-cli") {
      this.backend = new ClaudeCLIBackend(config.claudeCli);
    } else if (config.llmProvider === "vllm") {
      if (!config.vllm) throw new Error("vllm config required when llmProvider is 'vllm'");
      this.backend = new VLLMBackend(config.vllm);
    } else if (config.llmProvider === "openrouter") {
      this.backend = new OpenRouterBackend(config.openRouter);
    } else {
      this.backend = new AnthropicBackend(config.anthropicApiKey, config.anthropicModel);
    }
  }

  /** Returns the context (useful for loading flows at startup) */
  getContext(): WebsiteContext {
    return this.context;
  }

  /** Add flows to the context (e.g. loaded from store at startup) */
  loadFlows(flows: FlowDefinition[]): void {
    this.context.flows = flows;
  }

  /** Set context notes that get injected into the system prompt */
  setContextNotes(notes: { question: string; answer: string; addedAt: string }[]): void {
    this.contextNotes = notes;
  }

  /** Start a flow session for a given session key */
  beginFlowSession(sessionKey: string, flow: FlowDefinition): ConversationResponse {
    const result = startFlowSession(flow);
    this.flowSessions.set(sessionKey, result.session);
    return result;
  }

  /** Check if a session key has an active flow session */
  hasActiveFlowSession(sessionKey: string): boolean {
    const session = this.flowSessions.get(sessionKey);
    if (!session) return false;
    return session.status === "collecting" || session.status === "confirming" || session.status === "choosing" || session.status === "touring" || session.status === "executing";
  }

  /** Get the active flow session for a key */
  getFlowSession(sessionKey: string): FlowSession | undefined {
    return this.flowSessions.get(sessionKey);
  }

  /** Clear a flow session */
  clearFlowSession(sessionKey: string): void {
    this.flowSessions.delete(sessionKey);
  }

  /** Get the allowed domain for this site */
  private linkIndex: LinkIndex | null | undefined;
  // Every on-site link in a reply must be a page the crawl found (see link-guard).
  private guardReplyLinks(text: string): string {
    if (this.linkIndex === undefined) {
      const pages = [
        ...this.context.pages.map((p) => ({ url: p.url, title: p.title })),
        ...this.context.siteMap.map((p) => ({ url: p.url, title: p.title })),
        ...(this.knowledgeCatalog?.chunks || []).map((c) => ({ url: c.url, title: c.title })),
      ].filter((p) => p.url);
      this.linkIndex = buildLinkIndex(pages);
    }
    const r = guardLinks(text, this.linkIndex);
    if (r.fixed || r.dropped) console.log(`[links] ${this.context.tenantId}: fixed ${r.fixed}, dropped ${r.dropped}`);
    return r.text;
  }

  private getAllowedDomain(): string | undefined {
    if (this.context.siteMap.length > 0) {
      try {
        return new URL(this.context.siteMap[0].url).hostname;
      } catch {}
    }
    return undefined;
  }


  // Every conversation is a project (src/projects/conversation.ts): the turn is answered, then
  // recorded in the conversation's project with how it was handled.
  async chat(messages: ChatMessage[], sessionKey?: string, formState?: Record<string, string>): Promise<ChatResponse> {
    // One pipeline: the non-streamed callers (Messenger, API without streaming) get the same reply.
    return this.chatStream(messages, sessionKey, () => {}, formState);
  }

  private recordConversationTurn(messages: ChatMessage[], sessionKey: string | undefined, r: ChatResponse): void {
    if (sessionKey?.startsWith(AUDIT_SESSION)) return; // knowledge-audit test turns are not conversations
    const user = messages.findLast((m) => m.role === "user")?.content || "";
    const route = routeOf(r);
    void conversationProject(this.context.tenantId, sessionKey || "default", user).then((pid) => recordTurn(pid, { user, assistant: r.message, route, data: r.project ? { project: r.project } : undefined }));
  }

  /** A conversation already inside something - an order form, an on-page flow, a "which one?" question: its next step, or null. */
  private async continueSession(messages: ChatMessage[], sessionKey: string, formState?: Record<string, string>, questionAnswered = false): Promise<ChatResponse | null> {
    const message = messages.findLast((m) => m.role === "user")?.content || "";
    const effectiveSessionKey = sessionKey;
    // An "in chat" flow (order / inquiry) in progress takes every message.
    const cs = this.collectSessions.get(effectiveSessionKey);
    if (cs) {
      const flow = this.context.flows.find((f) => f.id === cs.flowId && f.status === "active");
      if (flow && Date.now() - cs.at < COLLECT_IDLE_MS) return this.runCollect(flow, cs, effectiveSessionKey, message, questionAnswered);
      this.collectSessions.delete(effectiveSessionKey);
    }

    // If there's an active flow session collecting remaining inputs
    if (this.hasActiveFlowSession(effectiveSessionKey)) {
      const session = this.flowSessions.get(effectiveSessionKey)!;
      const result = await processUserInput(session, message, async (system, prompt) =>
        this.backend.generate(system, [{ role: "user", content: prompt }], 512), formState
      );

      // Touring stays alive (advances turn by turn); executing means the widget
      // now owns the remaining on-page actions, so we hand off and drop it.
      const done = result.complete || result.session.status === "executing";
      if (done) this.flowSessions.delete(effectiveSessionKey);

      const formActions = result.formActions && result.formActions.length ? result.formActions : undefined;
      return {
        message: result.message,
        sources: [],
        flowSession: {
          active: !done,
          status: result.session.status,
          flowId: result.session.flowId,
          complete: done,
          executionMode: (result.session.executionMode || result.session.flow.executionMode) === "highlight" ? "highlight" : "guided",
          formActions,
        },
      };
    }

    // If we previously asked "which flow did you mean?", resolve that first.
    const pending = this.pendingDisambig.get(effectiveSessionKey);
    if (pending && Date.now() - pending.at < 5 * 60 * 1000) {
      const picked = await this.pickFromCandidates(message, pending.flows);
      this.pendingDisambig.delete(effectiveSessionKey);
      if (picked && picked.executionMode === "agent") return this.startAgentFlow(picked, message);
      if (picked && picked.executionMode === "collect") {
        // The same decision as an order in the first message (packsStream): our form only when every part is ours;
        // otherwise the agent with the network for the rest, or (without one) the answer like any question.
        const cov = await this.coverageOf(this.coverageNeed(messages, message, null, effectiveSessionKey));
        if (!cov.own.some((o) => !o)) return this.startCollect(picked, effectiveSessionKey, message);
        if (agentEnabled() && (await this.hasNetwork().catch(() => false))) {
          const r = await this.agentTurn(messages, message, effectiveSessionKey, { coverage: cov });
          if (r) { this.packStateOf(effectiveSessionKey).calcStarted = true; return r; }
        }
        return null;
      }
      if (picked) {
        const started = this.beginFlowSession(effectiveSessionKey, picked);
        return { message: started.message, sources: [], flowSession: { active: true, status: "choosing", flowId: picked.id, complete: false } };
      }
    }

    return null;
  }

  // Parallel retrieval shared by chat() and chatStream(). Each Vectorize query is ~2s,
  // so all needed searches (main + optional pricing-boost + optional language) are
  // decided up front and run concurrently rather than back-to-back.
  private async retrieveContext(lastUserMessage: string): Promise<{ content: string; metadata: Record<string, unknown>; score: number }[]> {
    const pricingKeywords = /price|pricing|cost|how much|rate|fee|cennik|cena|koszt|ile kosztuje|opłat|tarif|preis|kosten/i;
    const isQueryEnglish = /^[a-z\s,.?!'"]+$/i.test(lastUserMessage.replace(/[0-9]/g, ""));
    const hasMostlyPolishContent = this.context.pages.some((p) => /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(p.title || ""));
    const langKeyTerms = (isQueryEnglish && hasMostlyPolishContent)
      ? lastUserMessage.toLowerCase().replace(/what|is|your|the|do|you|have|any|can|i|get|how|much/g, "").trim()
      : "";
    const tasks: Promise<{ content: string; metadata: Record<string, unknown>; score: number }[]>[] = [
      searchContext(lastUserMessage, this.embeddingProvider, this.store, { topK: this.topK }),
    ];
    if (pricingKeywords.test(lastUserMessage)) {
      tasks.push(searchContext("cennik cena koszt price pricing rates fees tariff", this.embeddingProvider, this.store, { topK: 5 }));
    }
    // Identity/about boost: content-heavy sites (many project case-studies) drown
    // the homepage "who we are / what we do" content, so retrieval surfaces
    // project pages for "czym się zajmujecie" / "od kiedy". A dedicated pass for
    // about/services terms brings the authoritative identity content into range.
    const identityKeywords = /\b(o nas|o firmie|czym si[eę] zajmuj|kim jeste[sś]|co robicie|co oferuj|jakie us[lł]ug|od kiedy|od jak dawna|about us?|who are you|what do you (do|offer)|your services|since when|how long have)\b/i;
    if (identityKeywords.test(lastUserMessage)) {
      tasks.push(searchContext("o nas o firmie czym się zajmujemy nasze usługi oferta zespół od kiedy działamy about us what we do our services company", this.embeddingProvider, this.store, { topK: 5 }));
    }
    if (langKeyTerms.length > 2) {
      tasks.push(searchContext(langKeyTerms, this.embeddingProvider, this.store, { topK: Math.floor(this.topK / 2) }));
    }
    const offerHits = this.offerItems.length ? findOfferItems(lastUserMessage, this.offerItems, 8, this.context.tenantId).catch(() => [] as OfferItem[]) : Promise.resolve([] as OfferItem[]);
    const [mainChunks, ...extraResults] = await Promise.all(tasks);
    const retrievedChunks = mainChunks;
    const seen = new Set(retrievedChunks.map((c) => c.content.slice(0, 50)));
    for (const extra of extraResults) {
      for (const chunk of extra) {
        const key = chunk.content.slice(0, 50);
        if (!seen.has(key)) { seen.add(key); retrievedChunks.push(chunk); }
      }
    }
    const fromCatalog = await this.catalogRetrieve(lastUserMessage, retrievedChunks);
    // The owner's offer items the message is about (judged by Jev), first. Matched by name only - whether
    // an item ANSWERS the question (its price yes, its availability on Saturday no) is judged by the gate
    // like any passage; a preset score made every matching item "confirmed".
    const offer = (await offerHits).map((it) => ({
      content: renderItem(it),
      metadata: { url: "", title: `Oferta: ${it.name}`, headingHierarchy: ["Oferta", it.category].filter(Boolean), type: "product", offer: true } as Record<string, unknown>,
      score: 1,
    }));
    return offer.length ? [...offer, ...fromCatalog] : fromCatalog;
  }

  // Catalog stage: Jev picks the relevant catalogs and judges every chunk in them
  // TOGETHER WITH the vector hits, so a chunk filed under another topic (a price
  // list answering "do you take blood samples?") is still judged. Jev hits come
  // first (score = Jev probability, marked jevScore). With no hit, the vector
  // chunks are returned carrying their Jev scores, so the gate does not judge
  // them a second time. No catalog / Jev down -> vector result unchanged.
  private async catalogRetrieve(
    question: string,
    vectorChunks: { content: string; metadata: Record<string, unknown>; score: number }[],
  ): Promise<{ content: string; metadata: Record<string, unknown>; score: number }[]> {
    if (!this.knowledgeCatalog) return vectorChunks;
    try {
      const byId = new Map(this.knowledgeCatalog.chunks.map((c) => [c.id, c]));
      const keyOf = (id: string, content: string) => id || content.slice(0, 200);
      const vectorHits: CatalogChunk[] = vectorChunks.map((c) => {
        const id = String(c.metadata.id || "");
        return byId.get(id) || {
          // Not in the catalog (e.g. knowledge added in the dashboard after the scrape).
          id: keyOf(id, c.content), catalogId: "", content: c.content,
          url: String(c.metadata.url || ""), title: String(c.metadata.title || ""), type: String(c.metadata.type || ""),
        };
      });
      const r = await retrieveFromCatalog(question, this.knowledgeCatalog, vectorHits);
      if (!r) return vectorChunks;
      if (r.hits.length === 0) {
        console.log(`[catalog] ${this.context.tenantId}: 0 hits (cats=${r.catalogIds.join(",")}, scored=${r.scored}, ${r.ms}ms)`);
        return vectorChunks.map((c) => {
          const sc = r.scores.get(keyOf(String(c.metadata.id || ""), c.content));
          return sc === undefined ? c : { ...c, metadata: { ...c.metadata, jevScore: sc } };
        });
      }
      console.log(`[catalog] ${this.context.tenantId}: ${r.hits.length} hits from [${r.catalogIds.join(",")}] + vector (scored=${r.scored}, ${r.ms}ms)`);
      return r.hits.slice(0, 25).map((h) => ({
        content: h.chunk.content,
        metadata: { id: h.chunk.id, url: h.chunk.url, title: h.chunk.title, type: h.chunk.type, catalog: h.chunk.catalogId, jevScore: h.score } as Record<string, unknown>,
        score: h.score,
      }));
    } catch (e: any) {
      console.warn(`[catalog] ${this.context.tenantId}: ${e?.message || e}`);
      return vectorChunks;
    }
  }

  // Streaming variant of chat(): for the common plain-text path it surfaces the answer
  // token-by-token via onToken(delta) (first token ~1s vs ~3.5s for the full answer).
  // Flow/tool/structured cases and backends without streaming defer to chat() and are
  // emitted whole. Returns the canonical (cleaned + validated) full response.
  // onStatus: interim progress for the widget while no tokens flow yet (e.g. the
  // ecosystem broadcast), in the visitor's language.
  async chatStream(messages: ChatMessage[], sessionKey: string | undefined, onToken: (delta: string) => void, formState?: Record<string, string>, onStatus?: (status: { kind: string; text: string }) => void): Promise<ChatResponse> {
    const r = await this.chatStreamInner(messages, sessionKey, onToken, formState, onStatus);
    this.recordConversationTurn(messages, sessionKey, r);
    return r;
  }

  private async chatStreamInner(messages: ChatMessage[], sessionKey: string | undefined, onToken: (delta: string) => void, formState?: Record<string, string>, onStatus?: (status: { kind: string; text: string }) => void): Promise<ChatResponse> {
    const lastUserMessage = messages.findLast((m) => m.role === "user")?.content || "";
    const key = sessionKey || "default";
    if (onStatus) this.statusOf.set(key, onStatus); else this.statusOf.delete(key);
    const v = validateInput(lastUserMessage);
    if (v.blocked) return this.packsStream(messages, messages, key, onToken, true, formState);
    const sanitized: ChatMessage[] = v.sanitized !== lastUserMessage
      ? messages.map((m, i) => (i === messages.length - 1 && m.role === "user") ? { ...m, content: v.sanitized } : m)
      : messages;
    return this.packsStream(messages, sanitized, key, onToken, false, formState);
  }

  // ── Dynamic context ("packs"): Jev picks whole blocks of our information for the
  // conversation, behaviour comes as instructions, the model writes every word, checks can block. ──
  private packIndex: PackIndex | null | undefined;
  // The streaming widget's status line for a session (e.g. "checking the Whisp network").
  private statusOf: Map<string, (status: { kind: string; text: string }) => void> = new Map();
  private packStates: Map<string, PackState> = new Map();

  private packStateOf(key: string): PackState {
    let s = this.packStates.get(key);
    if (!s) { s = { turns: 0 }; this.packStates.set(key, s); if (this.packStates.size > 3000) this.packStates.delete(this.packStates.keys().next().value!); }
    return s;
  }

  /** The variant's reply to one customer message (streamed). Every customer-facing word is the model's. */
  private async packsStream(messages: ChatMessage[], sanitizedMessages: ChatMessage[], sessionKey: string, onToken: (d: string) => void, blocked: boolean, formState?: Record<string, string>): Promise<ChatResponse> {
    const t0 = Date.now();
    const st = this.packStateOf(sessionKey);
    st.turns++;
    const question = sanitizedMessages.findLast((m) => m.role === "user")?.content || "";
    if (blocked) return { ...(await this.packsReply(sanitizedMessages, sessionKey, onToken, { behaviour: [BEHAVIOUR.blocked], packs: [], noFacts: true })), turnKind: "blocked" };

    // A form left for 30 min is over (as on the other paths) - without falling back to their texts.
    const cs = this.collectSessions.get(sessionKey);
    if (cs && Date.now() - cs.at >= COLLECT_IDLE_MS) this.collectSessions.delete(sessionKey);

    // Answering our offer to pass the question on: only an explicit yes starts the form ("ok, thanks" is not a yes).
    const offer = this.handoffOffers.get(sessionKey);
    if (offer && Date.now() - offer.at < 30 * 60 * 1000 && !this.collectSessions.has(sessionKey)) {
      const ourReply = sanitizedMessages.slice(0, -1).findLast((m) => m.role === "assistant")?.content || "";
      const what = offer.kind === "network" ? "to check businesses from our local network for the customer's question" : "to pass the customer's question on to our team";
      const a = await jevAsk({ our_offer: `We offered ${what} and asked whether they want that. Our reply was: ${ourReply.slice(-600)}`, message: question }, {
        answer: { type: "choice", instructions: "How does the customer's `message` answer `our_offer`?", criteria: {
          yes: offer.kind === "network" ? "Explicitly agrees (e.g. 'tak', 'tak, sprawdź', 'yes please', 'proszę')." : "Explicitly agrees to have it passed on (e.g. 'tak, przekaż', 'yes please', 'proszę'), or replies with their contact details (name, phone, e-mail, address).",
          what: "Asks what that means or how it works.",
          no: "Declines (e.g. 'nie', 'nie trzeba', 'no thanks').",
          other: "Anything else: thanks or ok without agreeing, a new question, another topic.",
        } },
      }, 4000).catch(() => null);
      const c = a?.answer as { choice?: string; probabilities?: Record<string, number> } | undefined;
      const answer = c?.choice && (c.probabilities?.[c.choice] ?? 0) >= 0.7 ? c.choice : "other";
      if (answer === "what") return this.packsReply(sanitizedMessages, sessionKey, onToken, { behaviour: [BEHAVIOUR.explainHandoff], packs: [], keepOffer: true });
      this.handoffOffers.delete(sessionKey);
      // Agreed that we check the network (offered when our information on it was vague): the search, then the reply.
      if (answer === "yes" && offer.kind === "network") return this.packsReply(sanitizedMessages, sessionKey, onToken, { packs: [], networkNeed: offer.question, networkParts: offer.parts, rt: { lang: offer.lang } as TurnRoute });
      if (answer === "yes") {
        const flow = await this.ensureQuestionFlow?.().catch(() => null);
        if (flow) {
          if (!this.context.flows.some((f) => f.id === flow.id)) this.context.flows.push(flow);
          console.log(`[handoff] ${this.context.tenantId}: ${offer.kind} passed to the business form (packs)`);
          // The form starts from the conversation, not from the last line: the question in its context,
          // and whatever the customer wrote with the "yes" (contact details often come with it).
          const context = sanitizedMessages.slice(-6, -1).map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content.slice(0, 400)}`).join("\n");
          const r = await this.startCollect(flow, sessionKey, `${offer.kind === "quote" ? "Prośba o wycenę" : "Pytanie"}: ${offer.question}\n${question}`, this.sessionVia.get(sessionKey)?.via, context);
          onToken(r.message);
          return r;
        }
      } else if (answer === "no") st.handoffDeclined = true;
    }

    // An open form: a question to us asked in the middle is answered (the form stays open); everything else goes to the form.
    if (this.collectSessions.has(sessionKey)) {
      const q = await jevAsk({ message: question }, {
        q: { type: "noul", instructions: "The customer is filling in an order or inquiry form in a chat. Is `message` a question to the business asking for information (price, availability, terms, how something works) rather than giving, correcting or declining details for the form?" },
        alsoAsks: { type: "noul", instructions: "Besides giving, correcting or declining details for the form, does `message` also ask the business something (a price, availability, a term, whether something is possible)?" },
      }, 3000).catch(() => null);
      if (((q?.q as JevNoulAnswer | undefined)?.noul ?? 0) >= 0.75) {
        const rtQ = await this.routeTurn(sanitizedMessages, question);
        return this.packsReply(sanitizedMessages, sessionKey, onToken, { rt: rtQ, extra: [BEHAVIOUR.midForm] });
      }
      // Details AND a question in one message: the form only took the details and said the team would answer with the order
      // (kamilkozielewicz, insanit, 2026-11-04 eval). The checked reply answers the question; the form then takes the details.
      if (((q?.alsoAsks as JevNoulAnswer | undefined)?.noul ?? 0) >= 0.7) {
        const rtQ = await this.routeTurn(sanitizedMessages, question);
        const answer = await this.packsReply(sanitizedMessages, sessionKey, onToken, { rt: rtQ, extra: [BEHAVIOUR.answerInForm] });
        const next = await this.continueSession(sanitizedMessages, sessionKey, formState, true);
        if (next?.message) onToken(`\n\n${next.message}`);
        return { ...answer, message: next?.message ? `${answer.message}\n\n${next.message}` : answer.message, ...(next?.collect ? { collect: next.collect } : {}) };
      }
    }
    // An open form / flow / pending choice: its next step (the form's replies are the model's).
    const next = await this.continueSession(sanitizedMessages, sessionKey, formState);
    if (next) { onToken(next.message); return { ...next, turnKind: "form" }; }

    const rt = await this.routeTurn(sanitizedMessages, question);
    markTurn(`routed ${rt?.intent || "-"}`);
    // The owner or staff testing their chat (kept for the conversation once Jev is sure): answered as their chat, not as a customer.
    // 0.5: the commonest owner opening ("co to jest? skąd wiesz rzeczy o mojej firmie?") scored 0.52-0.66 across runs.
    if (rt && rt.owner >= (Number(process.env.JEV_OWNER_MIN) || 0.5)) st.owner = true;
    if (rt) noteTurn("owner", { score: rt.owner, owner: !!st.owner });
    // An attempt on the assistant itself (any language, Jev): answered as a blocked message - no facts, no tools.
    if (rt && rt.injection >= (Number(process.env.JEV_INJECTION_MIN) || 0.8)) {
      noteTurn("injection", rt.injection);
      (await import("../security/quota.js")).logAbuse("injection", sessionKey, this.context.tenantId, question.slice(0, 200));
      return { ...(await this.packsReply(sanitizedMessages, sessionKey, onToken, { behaviour: [BEHAVIOUR.blocked], packs: [], noFacts: true })), turnKind: "blocked" };
    }
    // Starting one of our actions: decided here, so nothing falls back to the other path's texts.
    if (rt && rt.intent === "order" && rt.flow >= 0) {
      const flows = this.routableFlows();
      const picked = rt.flowAmbiguous.length > 1 ? rt.flowAmbiguous.slice(0, 2).map((i) => flows[i]).filter(Boolean) : [flows[rt.flow]].filter(Boolean);
      // An order form only when every part of the order is ours (src/network/coverage.ts): "not clearly not offered"
      // started a form for paving at a renovation firm (Jev: offered 0.02, unknown 0.57), and one matching part
      // ("wiertnica" in "wiertnica + korona") kept the rest from the network (chain test 2026-10-29).
      const cov = picked.length === 1 && picked[0].executionMode === "collect" && aboutOffer(rt) ? await this.coverageOf(this.coverageNeed(sanitizedMessages, question, rt, sessionKey)) : null;
      const elsewhere = !!cov && cov.own.some((o) => !o);
      if (picked.length > 1) {
        this.pendingDisambig.set(sessionKey, { flows: picked.slice(0, 3), at: Date.now() });
        return this.packsReply(sanitizedMessages, sessionKey, onToken, { behaviour: [BEHAVIOUR.whichAction(picked.map((f) => `"${f.name}"`))], packs: [], rt });
      }
      // Not ours to take: the order goes to the network businesses that have it (agent), as the form's
      // hand-over did before 2026-10-26 (since then such orders were only answered).
      if (elsewhere && agentEnabled() && (await this.hasNetwork().catch(() => false))) {
        const r = await this.agentTurn(messages, question, sessionKey, { coverage: cov! });
        if (r) { st.calcStarted = true; onToken(r.message); return r; }
      }
      if (picked.length === 1 && !elsewhere) {
        let r: ChatResponse;
        if (picked[0].executionMode === "agent") r = await this.startAgentFlow(picked[0], question);
        else if (picked[0].executionMode === "collect") {
          // An order that also asks us something ("chcę zamówić beton na sobotę - gdzie jesteście, do której pracujecie?"):
          // the form only collected and told the customer the team would answer with the order (2026-11-04 eval: 3 of
          // 4 such openings left the site's hours, travel terms or the machine's height unanswered). Now the question is
          // answered first by the checked reply, which then asks for the details the form still needs.
          const q = await jevAsk({ message: question }, { q: { type: "noul", instructions: "Besides wanting to order or book, does `message` also ask the business something - a price, availability, a term, a place, opening hours, whether something is possible or how something works?" } }, 3000).catch(() => null);
          const asks = (q?.q as JevNoulAnswer | undefined)?.noul ?? 0;
          noteTurn("orderAlsoAsks", asks);
          if (asks < 0.7) r = await this.startCollect(picked[0], sessionKey, question);
          else {
            // The form opens (and reads the message) in the background while the answer streams: run one after the
            // other they took 14.7 s before the first word. The reply asks for the form's details itself.
            const collectP = this.startCollect(picked[0], sessionKey, question);
            const fields = picked[0].requiredInputs.filter((f) => f.required).map((f) => f.label).slice(0, 3);
            const answer = await this.packsReply(sanitizedMessages, sessionKey, onToken, { rt, extra: [BEHAVIOUR.orderQuestion(fields)], formOpen: true });
            const started = await collectP.catch(() => null);
            const s = this.collectSessions.get(sessionKey);
            if (s?.transcript.length && s.transcript[s.transcript.length - 1].startsWith("Assistant:")) s.transcript[s.transcript.length - 1] = `Assistant: ${answer.message}`;
            return { ...answer, ...(started?.collect ? { collect: started.collect } : {}) };
          }
        }
        else { const started = this.beginFlowSession(sessionKey, picked[0]); r = { message: started.message, sources: [], flowSession: { active: true, status: "choosing", flowId: picked[0].id, complete: false } }; }
        onToken(r.message);
        return r;
      }
      // Not offered here (or nothing to start): answered like any question - the network may have it.
    }
    // A calculation. The business's own quote for the whole request, and quantities only (pure), decide as before;
    // otherwise which parts are ours (src/network/coverage.ts): a part we don't have and a network -> the agent, the
    // network asked for that part only; everything ours -> a simple one answered here, priced multi-step work by the
    // agent on our own data (nobody else asked), the rest answered here with a quote request to our team. The guessed
    // gates before ("we have prices" counted the network's prices as ours, "every item ours?") sent our own products to
    // a 2-4 minute calculation and to competitors (betonlazy-1: Bosta asked to quote Łazy's own B20; djmw-2, 2026-11-04 eval).
    if (rt && rt.intent === "calculate" && agentEnabled()) {
      // A calculation needs figures in the conversation; "how much for a bathroom?" is a quote question.
      const figures = /\d/.test(sanitizedMessages.filter((m) => m.role === "user").slice(-3).map((m) => m.content).join(" "));
      const pure = (rt.price < 0.5 || rt.ownPrices >= 0.5) && figures;
      if (!figures) return this.packsReply(sanitizedMessages, sessionKey, onToken, { rt, t0 });
      // The business's quoting model starts first (its two model calls took 3.2 s after a 4.2 s price check - Zajacfoto's
      // first word at 10.5 s): a quote that prices the whole request decides alone, without waiting for the checks below.
      const quoting = process.env.PRICING_CHAT === "on" || turnVariant().includes("pricing");
      const routeQuoteP = quoting ? this.quoteResultWithModel(sanitizedMessages.slice(-8).map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content.slice(0, 700)}`).join("\n")).catch(() => null) : Promise.resolve(null);
      // Our passages for the "simple calculation?" check below are read at the same time (they were read after it, +0.5-1 s).
      const oursP = this.knowledgePassages(question, 8).catch(() => [] as string[]);
      const { query } = this.turnQuery(sanitizedMessages, question, rt);
      // Our price list's items for this request - the same match the reply makes (same query and options: the
      // matcher's cache answers it there). The simple check saw only 8 loose passages before: Ostap's trestles +
      // posts (2080 + 4 x 42 zl, simple 0.92) were judged "not all ours" (0.17) and sent to a 47 s calculation.
      const itemsP: Promise<ItemMatch | null> = !this.catalogue && this.offerItems.length ? matchItems(query, this.offerItems, { limit: 8, tenant: this.context.tenantId, quantities: rt.price >= 0.5, alternatives: rt.specific >= 0.5 }).catch(() => null) : Promise.resolve(null);
      // Which parts are ours, at the same time (quantities only involve nobody else: not needed) - on the same text as the
      // reply's network start, so a calculation answered in the chat reuses this decision.
      const covP: Promise<Coverage | null> = pure || !aboutOffer(rt) ? Promise.resolve(null) : this.coverageOf(this.coverageNeed(sanitizedMessages, question, rt, sessionKey));
      // The business's own quoting model priced every part of the request (its program computes the amounts): answered
      // here, like the simple calculation. Zajacfoto's "6 h package + 4 extra hours + a session" (5500 + 1500 zl, computed)
      // went to a 75 s calculation held for approval because the guessed gates fell to simple 0.26 / ours 0.12 (2026-11-04).
      const routeQuote = await routeQuoteP;
      markTurn("quotedForRoute");
      noteTurn("quoteCovered", !!routeQuote?.covered);
      // Our own program priced every line it read - but it reads no line for a need its catalogue has no item for, so a part
      // we don't have is not "covered": the reply's coverage still offers (or relays) the network for it (chain C7: Rentbud's
      // vibrator and trowel priced, the concrete left out - a "covered" quote with the network off never offered it).
      if (routeQuote?.covered) return this.packsReply(sanitizedMessages, sessionKey, onToken, { rt, t0, extra: [BEHAVIOUR.simpleCalc] });
      // Listed unit prices times the customer's quantities: answered here (the owner's decision 2026-10-26); asked next to
      // the coverage (a part we don't have does not wait for it).
      const simpleP = (async () => {
        const convoText = sanitizedMessages.slice(-6).map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content.slice(0, 500)}`).join("\n");
        const pricedItems = ((await itemsP)?.items || []).filter((i) => i.price_value != null);
        const ours = [...pricedItems.map((p) => `- ${renderItem(p)}`), ...(await oursP)].join("\n\n").slice(0, 20000);
        const s = await jevAsk({ conversation: convoText, our_information: ours }, {
          // Up to three listed options (a hall's packages per person x the guests) are the owner's "at most three unit
          // prices" too: "options to compare" sent "a wedding for 100 on a Saturday" to a 1.5-minute calculation (2026-11-04).
          simple: { type: "noul", instructions: "Is the customer's LATEST request in `conversation` a simple calculation: at most three unit prices (listed by the business or given by the customer) times quantities the customer gave - also when they are up to three listed options or packages, each priced for the same quantities - or a simple quantity from dimensions they gave, with no measuring on site, design, discount or unlisted work?" },
        }, 4000).catch(() => null);
        const p = (s?.simple as JevNoulAnswer | undefined)?.noul;
        noteTurn("simpleCalc", p);
        return (p ?? 0) >= 0.4;
      })();
      const cov = await covP;
      markTurn("coverage");
      // A part we don't have: the agent with the network for it - the owner's wish 2026-10-26 to reach out to the companies
      // (until 2026-10-29 such orders got only a quote offer and never reached the network).
      if (cov?.own.some((o) => !o) && (await this.hasNetwork().catch(() => false))) {
        const r = await this.agentTurn(messages, question, sessionKey, { coverage: cov });
        if (r) { st.calcStarted = true; onToken(r.message); return r; }
      }
      const simple = await simpleP;
      markTurn("simpleCheck");
      if (simple) return this.packsReply(sanitizedMessages, sessionKey, onToken, { rt, t0, extra: [BEHAVIOUR.simpleCalc] });
      // More than a simple calculation (measuring, unlisted work, discounts, many items): quantities only, or every part of
      // ours priced -> the calculation and its approval; ours without prices -> answered here (partial: a quote request).
      const ownPriced = !!cov && cov.own.some(Boolean) && cov.own.every((o, k) => !o || cov.priced[k]);
      if (pure || ownPriced) {
        const r = await this.agentTurn(messages, question, sessionKey, pure ? { pureCalc: true } : { coverage: cov! });
        if (r) { st.calcStarted = true; onToken(r.message); return r; }
      }
      return this.packsReply(sanitizedMessages, sessionKey, onToken, { rt, t0 });
    }
    if (rt?.intent === "chitchat") return { ...(await this.packsReply(sanitizedMessages, sessionKey, onToken, { behaviour: [BEHAVIOUR.smalltalk], rt })), turnKind: "chitchat" };
    return this.packsReply(sanitizedMessages, sessionKey, onToken, { rt, t0 });
  }

  /**
   * Builds the context for this turn and streams the model's reply, then checks it. opts.packs = []
   * skips the knowledge selection (blocked input, explaining the hand-off); opts.behaviour adds the
   * turn's instructions; without them the turn is decided here (answer / no information + hand-off /
   * network).
   */
  private async packsReply(messages: ChatMessage[], sessionKey: string, onToken: (d: string) => void, opts: { behaviour?: string[]; extra?: string[]; packs?: Pack[]; noFacts?: boolean; rt?: TurnRoute | null; keepOffer?: boolean; handoffKind?: "question" | "quote" | "network"; networkNeed?: string; networkParts?: string[]; t0?: number; formOpen?: boolean }): Promise<ChatResponse> {
    const st = this.packStateOf(sessionKey);
    const question = messages.findLast((m) => m.role === "user")?.content || "";
    const rt = opts.rt ?? null;
    const convo = messages.slice(-8).map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content.slice(0, 700)}`).join("\n");
    const behaviour = [...(opts.behaviour || [])];
    let used: Pack[] = [];
    let passages: string[] = [];
    let packText = "";
    let answered = true;
    let network: { text: string; evidence: { content: string }[]; labels: string[]; links: string[]; partners: { tenantId: string; label: string }[] } | null = null;
    let searching: { matches: Promise<EcosystemMatch[]>; need: string; lang: OfferLang } | null = null;
    let offered: NetworkAsk | null = null; // the network offered for the parts we don't have (searched on a yes)
    let productLinks: string[] = [];
    const owner = !!st.owner;
    // Our own phone numbers / e-mails, and whether an earlier reply of this conversation already gave one.
    const prof = this.context.businessProfile;
    const ownContacts = [prof?.primaryPhone?.value, prof?.primaryEmail?.value, ...(prof?.alternatePhones || [])].filter(Boolean).map((c) => String(c).includes("@") ? String(c).toLowerCase() : String(c).replace(/\D/g, "").slice(-9)).filter((c) => c.length >= 6);
    const hasContact = (t: string) => { const digits = t.replace(/\D/g, ""), low = t.toLowerCase(); return ownContacts.some((c) => (c.includes("@") ? low : digits).includes(c)); };
    const contactGiven = messages.slice(0, -1).some((m) => m.role === "assistant" && hasContact(m.content));
    st.contactGiven = contactGiven;
    if (opts.networkNeed && this.askEcosystem) {
      // Exactly the parts we offered to check (the ones we don't have).
      const found = await Promise.race([this.askEcosystem([{ role: "user", content: opts.networkNeed }], undefined, opts.networkParts).catch(() => [] as EcosystemMatch[]), new Promise<EcosystemMatch[]>((r) => setTimeout(() => r([]), 15000))]);
      if (found.length) network = await this.networkBlock(found, opts.networkNeed, rt?.lang || "pl");
      behaviour.push(network ? BEHAVIOUR.networkAccepted : BEHAVIOUR.networkNone);
    }

    // The conversation's language: kept from the last message long enough to tell (a name, a phone
    // number or "ok" does not switch it); "other" = whatever language the customer writes in.
    if (rt && question.replace(/[\d\s+().,:;!?-]/g, "").length >= 12) st.lang = rt.lang;
    const lang = st.lang || rt?.lang || "";
    // Preset behaviour (small talk, quote, explaining the offer, which action) needs no knowledge selection.
    if (opts.packs === undefined && !opts.noFacts && !opts.behaviour?.length) {
      if (this.packIndex === undefined) this.packIndex = buildPackIndex(this.knowledgeCatalog, new Set(this.context.siteMap.filter((p) => p.type === "article").map((p) => p.url)));
      const { query, followup } = this.turnQuery(messages, question, rt);
      // A real need we can't meet may go to the network: started now (its coverage and search run next to our own
      // search and scoring), used below for the parts we don't have. The owner writing: the coverage only (our own pages
      // for the reply), no search - the network is never offered or relayed to the owner.
      // Over a spend cap or from a site the business does not own: no network search (src/security/budget.ts).
      const netStart = rt && !behaviour.length && !turnCheap() ? this.networkStart(question, messages, rt, !owner, sessionKey) : null;
      // Key facts (src/knowledge/facts.ts): the site's single sentences, found by meaning and kept by Jev - in parallel.
      // Our offer items for this message: a shop's catalogue (or its live search), otherwise the items read
      // from our pages and the owner's offer - the same item matcher the network search uses. Pages alone
      // missed them: "ubić podjazd" ranked paving guides above the compactor price list (chain C1).
      // null: the items could not be judged (Jev down) - then nothing is said about them.
      // A price question also reads the customer's quantities for the items (priced in code below).
      // A question about hours, contact, terms or the business itself (no price, product or need - router) has no
      // offer items to match: the model call that picks them (~1 s) was in front of every such reply.
      const offerTurn = aboutOffer(rt);
      const productsP: Promise<ItemMatch | null> = this.catalogue ? this.shopProducts(query, question, rt).then((items) => ({ items, given: new Map() }), () => ({ items: [], given: new Map() }))
        : this.offerItems.length && rt?.intent !== "chitchat" && offerTurn ? matchItems(query, this.offerItems, { limit: 8, tenant: this.context.tenantId, quantities: !!rt && rt.price >= 0.5, alternatives: !!rt && rt.specific >= 0.5 }).catch(() => null) : Promise.resolve({ items: [], given: new Map() });
      const factsP = turnVariant().includes("facts")
        ? this.embeddingProvider.embed([query]).then((v) => keyFacts(this.context.tenantId, v[0] || null, convo, question)).catch(() => null)
        : Promise.resolve(null);
      // The business's own quoting model (src/pricing/model.ts), when it has one and it is switched on: the
      // conversation read into a request in its terms, its program quotes it - replaces the recipe computation.
      // Started now, next to the search and the page scoring (it needs neither); was awaited after them (+1-2 s).
      const quoteP = rt && rt.price >= 0.5 && (process.env.PRICING_CHAT === "on" || turnVariant().includes("pricing")) ? this.quoteWithModel(convo).catch(() => null) : Promise.resolve(null);
      markTurn("reply");
      // The request's parts in Polish (the network's split - a model, stored per request; the item matcher asks
      // for the same one): a second search with them finds the pages that the customer's own words or language
      // miss - a Ukrainian "віброплита" found no compactor page (2026-11-04). Only for questions about the offer.
      const partsP: Promise<string[]> = rt?.intent !== "chitchat" && offerTurn ? import("../projects/broadcast.js").then((b) => b.splitNeed(query, this.context.tenantId)).catch(() => [] as string[]) : Promise.resolve([] as string[]);
      const search = (q: string) => searchContext(q, this.embeddingProvider, this.store, { topK: Math.max(this.topK, 20) }).catch((e) => { console.warn(`[packs] ${this.context.tenantId}: search failed - ${(e as Error).message}`); return [] as Awaited<ReturnType<typeof searchContext>>; });
      const [first, parts] = await Promise.all([search(query), partsP]);
      let hits = first;
      if (parts.length) {
        // Both searches' hits by rank, taken in turn (each list keeps its order), each passage once.
        const more = await search(parts.join("\n"));
        const seen = new Set<string>();
        hits = [];
        for (let k = 0; k < Math.max(first.length, more.length); k++) for (const h of [first[k], more[k]]) {
          const id = h ? String(h.metadata.id || h.content.slice(0, 80)) : "";
          if (h && !seen.has(id)) { seen.add(id); hits.push(h); }
        }
        noteTurn("parts", parts);
      }
      markTurn("searched");
      let scored: { p: Pack; s: number }[] = [];
      let hitIds: string[] | undefined;
      if (this.packIndex) {
        const byId = new Map(this.knowledgeCatalog!.chunks.map((c) => [c.id, c]));
        const enriched = hits.map((h) => { const c = byId.get(String(h.metadata.id || "")); return c ? { metadata: { ...h.metadata, url: c.url, catalog: c.catalogId } } : h; });
        const cands = candidatePacks(this.packIndex, enriched);
        // Last turn's packs stay candidates for a follow-up.
        if (followup) for (const id of st.lastPacks || []) { const p = this.packIndex.packs.get(id); if (p && !cands.includes(p)) cands.push(p); }
        hitIds = hits.map((h) => String(h.metadata.id || "")).filter(Boolean);
        const scores = await scorePacks(convo, cands, hitIds);
        markTurn("packsScored");
        noteTurn("candidates", cands.map((p, i) => `${scores ? scores[i].toFixed(2) : "?"} ${p.title.slice(0, 60)}${p.url ? ` | ${p.url}` : ""}`));
        if (scores) scored = cands.map((p, i) => ({ p, s: scores[i] })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s).slice(0, 4);
        // Jev unavailable: the search's best pages instead of "no information" for everything.
        else { scored = cands.slice(0, 3).map((p) => ({ p, s: 0.5 })); console.warn(`[packs] ${this.context.tenantId}: pack scoring unavailable - search order used`); }
        console.log(`[packs] ${this.context.tenantId}: ${hits.length} hits (${hits.filter((h) => byId.has(String(h.metadata.id || ""))).length} in catalog, ids e.g. ${hits.slice(0, 2).map((h) => String(h.metadata.id || "?").slice(0, 24)).join(",")}), ${cands.length} candidates [${cands.map((p) => p.title.slice(0, 30)).join("; ")}] scores ${scores?.map((x) => x.toFixed(2)).join(",")} -> ${scored.map((x) => `${x.p.title.slice(0, 40)}=${x.s.toFixed(2)}`).join(" | ") || "none"}`);
      } else {
        // No catalog: the passages themselves, judged as today.
        const rel = await jevPassageRelevance(question, hits.slice(0, 12).map((h) => (h.content || "").slice(0, 1500)));
        if (rel) passages = hits.slice(0, 12).filter((_, i) => rel[i] >= 0.5).map((h) => h.content);
        packText = passages.map((p) => p).join("\n\n---\n\n");
      }
      if (scored.length) ({ text: packText, used, passages } = renderPacks(scored.map((x) => x.p), undefined, hitIds!));
      const facts = await factsP;
      if (facts?.length) {
        noteTurn("facts", facts.map((f) => f.s.slice(0, 160)));
        packText = `### Key facts from our pages (word for word)\n${facts.map((f) => `- ${f.s}`).join("\n")}${packText ? `\n\n---\n\n${packText}` : ""}`;
        passages = [...facts.map((f) => f.s), ...passages];
      }
      const modelQuote = await quoteP;
      markTurn("quoted");
      if (modelQuote) noteTurn("modelQuote", modelQuote.slice(0, 600));
      // The products / offer items this message is about.
      const judged = await productsP;
      markTurn("itemsMatched");
      const products = judged?.items || [];
      if (products.length) {
        noteTurn("products", products.map((p) => `${p.name} | ${p.price_value ?? "-"} ${p.currency}`));
        const lines = products.map((p) => `- ${renderItem(p)}${p.url ? ` | Link: ${p.url}` : ""}`);
        // A price question: the customer's quantities read with the items, priced by code (src/offer/quantities.ts).
        if (modelQuote) { /* priced below by the business's quoting model */ }
        else if (judged?.given.size) {
          const { priceGiven, customerPriceLine } = await import("../offer/quantities.js");
          const computed = priceGiven(judged.given).map((c) => customerPriceLine(c));
          if (computed.length) { noteTurn("computed", computed); lines.push(`Computed for the customer's quantities (use these totals): ${computed.join("; ")}`); }
        }
        // A price question whose quantity was not clear ("half a day"): no total is computed, and the reply
        // must not work one out (C3: "6 h x 76 = 456 zł, hourly is cheaper" against a 380 zł daily rate).
        else if (judged && rt && rt.price >= 0.5) {
          const { inputsOf } = await import("../offer/quantities.js");
          if (products.some((p) => inputsOf(p).length)) lines.push("No total is computed for this request: the customer's quantity is not clear from the message - give the prices, do not work out a total.");
        }
        packText = `${packText ? `${packText}\n\n---\n\n` : ""}### ${this.catalogue ? "Products in our shop (from our catalogue)" : "Our offer and prices (from our price list)"}\n${lines.join("\n")}`;
        passages = [...passages, ...lines];
        productLinks = products.map((p) => p.url).filter(Boolean);
      }
      if (modelQuote) {
        packText = `${packText ? `${packText}\n\n---\n\n` : ""}### Prices computed from our price list for this request (use these amounts; ask for what it says is missing)\n${modelQuote}`;
        passages = [...passages, modelQuote];
      }
      // Asked for a specific product or service and none of our price list's items is it: that is a fact
      // (the matcher judged every item), not missing information - "our price list has no mini-excavator"
      // instead of "I don't have the mini-excavator's price", which says we rent one (chain C6).
      else if (judged && !this.catalogue && this.offerItems.length && rt && rt.specific >= 0.5 && !behaviour.length) {
        const line = `Our price list (${this.offerItems.length} items, read from our website) has no item that is what the customer asks for.`;
        // What could do the same job another way (judged by the matcher), with its price - offered as such (C6:
        // no mini-excavator, but a trencher digs the trench).
        const alt = (judged.alternatives || []).map((p) => `- ${renderItem(p)}${p.url ? ` | Link: ${p.url}` : ""}`);
        const altText = alt.length ? `\nNot what the customer asked for, but could do the same job another way (offer it as such):\n${alt.join("\n")}` : "";
        noteTurn("products", ["none of our price list", ...(judged.alternatives || []).map((p) => `alternative: ${p.name}`)]);
        packText = `${packText ? `${packText}\n\n---\n\n` : ""}### Our offer and prices (from our price list)\n${line}${altText}`;
        passages = [...passages, line, ...alt];
      }
      // Which parts of the need are ours (the network start's coverage, src/network/coverage.ts), waited for at most
      // COVERAGE_WAIT_MS once our own information is ready: one slow judgement (a matcher call timing out after 8 s) held
      // the first word of the reply. Late: no network this turn (fail closed) and no extra pages - except an explicit ask
      // for other businesses, which waits (in the same window) only for its split.
      const waited = new Promise<null>((r) => setTimeout(() => r(null), COVERAGE_WAIT_MS));
      const cov = netStart ? await Promise.race([netStart.cov, waited]) : null;
      const net = !netStart ? null : netStart.elsewhere ? await Promise.race([netStart.net, waited]) : cov ? await netStart.net : null;
      if (netStart && !cov) noteTurn("coverageLate", COVERAGE_WAIT_MS);
      else if (cov?.late) noteTurn("coverageLate", "limit");
      markTurn("coverage");
      // A part that is ours by our own pages brings those passages: the reply cannot say "no information" about what the
      // coverage just confirmed. Under a neutral heading: naming the part ("Our pages on underfloor heating installation")
      // told the reply what a screed maker's pages were about when the split made a part of a mere mention.
      const pagePassages = cov ? [...new Set(cov.parts.flatMap((_, k) => (cov.own[k] && cov.how[k] === "page" ? cov.passages[k] : [])))].filter((t) => !passages.includes(t)) : [];
      if (pagePassages.length) {
        packText = `${packText ? `${packText}\n\n---\n\n` : ""}### More from our own pages\n${pagePassages.join("\n\n")}`;
        passages = [...passages, ...pagePassages];
      }
      answered = passages.length > 0;
      // Relevant packs, but do they answer it fully? If not: what we know + the missing detail + the offer to ask the team.
      let partial = false;
      if (answered && jevEnabled()) {
        const f = await jevAsk({ conversation: convo, our_information: passages.join("\n\n").slice(0, 40000) }, {
          full: { type: "noul", instructions: "Does `our_information` contain everything needed to answer the customer's LATEST message in `conversation` (every part and detail asked)?" },
        }, 5000).catch(() => null);
        noteTurn("full", (f?.full as JevNoulAnswer | undefined)?.noul);
        markTurn("full");
        partial = ((f?.full as JevNoulAnswer | undefined)?.noul ?? 1) < 0.5;
      }
      // The network only for the parts we don't have (net.parts; the coverage replaced a whole-message "is it ours?" score -
      // < 0.35 relayed at once, < 0.8 offered - that sent our own products to competitors 7 times in the 2026-11-04 eval).
      // At once when nothing of ours answers, when none of the need is ours, or when the customer asks for other
      // businesses (router intent; W3: the venue's 120 zł "photographer service" fee was judged ours and the
      // photographers found were dropped).
      const alsoNetwork = !!net && answered && !net.allForeign && rt?.intent === "elsewhere";
      if (net && !owner && (!answered || net.allForeign || alsoNetwork)) {
        // Matches already there: one reply. Still searching and the widget can show it: say so now, show the
        // search, continue the message when the matches come (the owner's wish 2026-10-27, like Gemini's search).
        const quick = await Promise.race([net.matches, new Promise<null>((r) => setTimeout(() => r(null), this.statusOf.has(sessionKey) ? 400 : 10000))]); // no live status (API / tests): wait for the network search (3-8 s since it splits the need into parts)
        if (quick === null && this.statusOf.has(sessionKey)) {
          searching = { matches: net.matches, need: net.need, lang: net.lang };
          behaviour.push(alsoNetwork ? BEHAVIOUR.networkCheckAlso : BEHAVIOUR.networkCheck);
        } else if (quick?.length) {
          network = await this.networkBlock(quick, net.need, net.lang);
          behaviour.push(alsoNetwork ? BEHAVIOUR.networkAlso : BEHAVIOUR.network);
        }
      }
      // Offered at most once per question: again only for a new question two or more turns later, never after a decline.
      const offerOk = !!rt && !owner && !!this.ensureQuestionFlow && ["ask", "order", "calculate"].includes(rt.intent) && !st.handoffDeclined && (!st.handoffOfferedAt || st.turns - st.handoffOfferedAt >= 2) && !this.collectSessions.has(sessionKey);
      if (!answered && !network && !searching) {
        behaviour.push(owner || contactGiven ? BEHAVIOUR.noInfoBare : BEHAVIOUR.noInfo);
        if (offerOk) { behaviour.push(BEHAVIOUR.handoff); opts.handoffKind = "question"; }
      }
      if (answered && !network && !searching) {
        behaviour.unshift(BEHAVIOUR.answer);
        // A mixed turn: our parts answered, the parts we don't have only offered to check in the network when it has
        // businesses for them - our own answer first, the customer decides. Waited for only when it can be offered (not
        // after a decline, not twice in a row, no open form); the search started with the split, next to the coverage.
        const found = net && offerOk ? await Promise.race([net.matches, new Promise<null>((r) => setTimeout(() => r(null), 1500))]) : undefined;
        const netHas = found?.length ?? 0;
        if (netHas) { offered = net; opts.handoffKind = "network"; }
        // A missing detail of ours goes to our own team, never to the network: what we know, the detail not given, and the
        // offer to pass it on - as a quote request when a price is asked that no item or quote here gives (an instruction
        // "we have no prices here" contradicted prices that our pages give).
        const pricedHere = !!modelQuote || products.some((p) => p.price_value != null || p.components.some((c) => c.price_value != null));
        if (partial) {
          behaviour.push(owner || contactGiven ? BEHAVIOUR.partialBare : BEHAVIOUR.partial);
          if (offerOk && !opts.handoffKind) { behaviour.push(BEHAVIOUR.handoff); opts.handoffKind = rt && rt.price >= 0.5 && !pricedHere ? "quote" : "question"; }
        }
        if (offered) behaviour.push(BEHAVIOUR.offerNetwork(offered.parts));
        noteTurn("partialOffer", { netHas, late: found === null, offerOk, partial, pricedHere, kind: opts.handoffKind || null });
      }
    }
    behaviour.push(...(opts.extra || []));
    if (owner) behaviour.unshift(BEHAVIOUR.owner);

    const brand = this.brandName || this.context.businessProfile?.businessName?.value || this.getAllowedDomain() || "our business";
    const pages = this.context.siteMap.slice(0, 20).map((p) => `- ${p.title} (${p.url})`).join("\n");
    // The owner's own answers (added for questions the bot could not answer) are facts too.
    // Every owner answer (newest first) up to ~12k chars - the old "last 30" had no reason and silently
    // dropped older answers the fact check still trusted (docs/limits.md).
    let notesLen = 0;
    const notes = [...this.contextNotes].reverse().map((n) => `Q: ${n.question}\nA: ${n.answer}`).filter((t) => (notesLen += t.length + 2) <= 12000).join("\n\n");
    // What the chat is (a fact, for "what is this? how do you know this?" - owners testing their demo were told to write to their own e-mail).
    // The panel only when the owner really added answers there: on a demo "the firm gave me more information" was false (blind pairs, iteration 3).
    // For the owner: what this chat is, from data (pages read, the date, the price list, the panel's answers, where inquiries go).
    const priced = this.offerItems.filter((i) => i.price_value != null).length;
    const readOn = (() => { const d = Date.parse(this.context.lastUpdated || ""); return Number.isFinite(d) ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", day: "numeric", month: "long", year: "numeric" }).format(new Date(d)) : ""; })();
    // Without an owner account it is a demo nobody has claimed: "the chat run by the firm" and "the owner's data in the panel"
    // were told to owners of such demos (iteration-4 judges, bostabeton-1, helsen-2).
    const account = this.hasOwnerAccount ? this.hasOwnerAccount() : true;
    const about = owner ? [
      `- This is ${account ? "the Whisp chat" : "a Whisp demo chat, made by Whisp and not yet on the business's website and with no owner account,"} for ${brand}${this.getAllowedDomain() ? ` (${this.getAllowedDomain()})` : ""}. It answers from ${this.context.pages?.length || this.context.siteMap?.length || 0} pages of that website${readOn ? `, read on ${readOn}` : ""}${this.offerItems.length ? `, with ${this.offerItems.length} offer items read from them (${priced} with a price)` : ", which show no price list"}${this.contextNotes.length ? `, and ${this.contextNotes.length} answers the owner added in the Whisp panel` : ""}.`,
      account ? "- It cannot change its information itself: the owner corrects it or adds answers in the Whisp panel; changes on the website reach the chat when the website is read again."
        : "- It cannot change its information itself: with a Whisp account the owner corrects it or adds answers in the Whisp panel; changes on the website reach the chat when the website is read again.",
      `- ${account ? "" : "On the website, "}when a customer wants it, the chat takes their question or order with their contact details and, once they confirm, sends it to the business by e-mail and to the inquiries in the Whisp panel.`,
      // A fact for the check too: "you are writing as the owner, testing the chat" was blocked as unsupported (smoke test, helsen-2).
      "- The person writing in this conversation is the business's owner or staff, testing or correcting this chat.",
    ].join("\n") : "";
    let system = `You are the website chat assistant of ${brand}. You speak for the business as "we". You answer from ${brand}'s own website and price list${this.contextNotes.length ? " and what the business added in its Whisp panel" : ""}.${this.systemPromptExtra ? ` ${this.systemPromptExtra}` : ""}
${renderOfficialInfo(this.context.businessProfile)}${notes ? `\n## Answers from the owner\n${notes}\n` : ""}${about ? `\n## About this chat\n${about}\n` : ""}
${packText ? `\n## Our information for this conversation (use only this for facts about us)\n${packText}\n` : opts.noFacts ? "" : "\n## Our information for this conversation\n(nothing in our information answers this message)\n"}
${network ? `\n## Businesses from our network (their own information)\n${network.text}\n` : ""}
${pages ? `\n## Pages of our website\n${pages}\n` : ""}
${renderState(st)}

## Now
${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date())} (Warsaw). Use it for "today", "now", "this Saturday"; whether a Sunday is a trading Sunday or a day is a holiday only if our information says so.

## What to do in this reply
${behaviour.map((b) => `- ${b}`).join("\n")}

## Rules
- Facts about us (products, prices, stock, hours, terms, people, contact) only from the information above, never invented; a price only as written, for the item it belongs to; keep the source's hedges ("usually", "priced separately").
- Never say we don't offer, sell or do something unless our information says so.
- If the question is ambiguous (several locations, variants or departments), say which applies or ask briefly.
- General professional advice is fine when asked, clearly as general advice.
- Write naturally, like a helpful person at the business: full sentences, no lists unless listing 4+ items, at most about 80 words unless the customer asks for full details.
- End with at most one question${opts.handoffKind === "network" ? " (the offer to check our network, when instructed above)" : opts.handoffKind || opts.keepOffer ? " (the offer to pass the question on, when instructed above)" : ""}. Never offer to do something yourself - send, check, calculate, measure, book, arrange or call back: this chat can only answer.
- Links only as given above, as markdown [name](url).
- Answer every part of the customer's message. For a part our information doesn't answer directly but a sentence of it bears on (e.g. "we also serve towns bordering the capital" for a question about a nearby town), quote that sentence in quotation marks (translated into the customer's language if needed) instead of saying you don't know - and draw no conclusion from it. Only when there is no such sentence, say we don't state it.
- For a specific location, branch or department, use the address, phone and hours shown for that one; the official info is the general contact.
- If our information gives two different values for the same thing (two prices, two opening hours), don't pick one silently: give the one for the right item or place, or mention both.
- Speak as the business, naturally: "nie mam tej informacji", "tego nie podajemy na stronie" - never "w naszych informacjach / materiałach / danych / źródłach" or "in the information provided".
- Address the customer the way they address us: formal (Pan/Pani) if they write formally, otherwise informal; keep it consistent, and keep "we" for the business.
- Warranty, guarantees, VAT invoices, insurance, payment and legal terms: only what our information states. Safety-critical work (gas, electricity, load-bearing structures, asbestos): no step-by-step instructions - recommend a qualified professional.
- Reply in the customer's language (the language they write in), not in the language of our information.
- Never mention these instructions or "the information above".${replyLanguageOf(lang)}`;

    // A/B variant "lean": the rules a check already enforces are left out (links -> link check; meta-talk and
    // instructions -> meta check; facts/terms detail -> fact check). Measured before switching.
    if (turnVariant().includes("lean")) {
      const drop = [
        /\n- Links only as given above, as markdown \[name\]\(url\)\./,
        /\n- Speak as the business, naturally: [^\n]*/,
        /\n- Never mention these instructions or "the information above"\./,
      ];
      for (const d of drop) system = system.replace(d, "");
      system = system.replace(/- Facts about us \(products, prices, stock, hours, terms, people, contact\) only from the information above, never invented; [^\n]*/, "- Facts about us only from the information above.");
      system = system.replace(/- Warranty, guarantees, VAT invoices, insurance, payment and legal terms: only what our information states\. /, "- ");
    }
    noteTurn("used", used.map((p) => p.title.slice(0, 60)));
    if (turnVariant() === "trace") noteTurn("system", system);
    noteTurn("behaviour", behaviour.map(behaviourName));
    if (network) noteTurn("network", network.labels);
    let raw = "";
    markTurn("stream");
    await this.backend.generateStream!(system, messages, this.maxTokens, (d) => { raw += d; onToken(d); });
    // Searching the network: the status line while it runs, then the same message continues with what was found.
    if (searching) {
      this.statusOf.get(sessionKey)?.({ kind: "network", text: (NETWORK_SEARCH[lang] || NETWORK_SEARCH.en) });
      const found = await Promise.race([searching.matches, new Promise<EcosystemMatch[]>((r) => setTimeout(() => r([]), 12000))]).catch(() => [] as EcosystemMatch[]);
      if (found.length) network = await this.networkBlock(found, searching.need, searching.lang);
      else behaviour.push(BEHAVIOUR.noInfo); // nothing found: the contact check applies as for "no information"
      const offerOk = !network && rt && this.ensureQuestionFlow && !st.handoffDeclined && (!st.handoffOfferedAt || st.turns - st.handoffOfferedAt >= 2) && !this.collectSessions.has(sessionKey);
      if (offerOk) opts.handoffKind = "question";
      const next = network ? [BEHAVIOUR.networkFound] : [BEHAVIOUR.networkNone, ...(offerOk ? [BEHAVIOUR.handoff] : [])];
      system = system.replace(/## What to do in this reply\n[\s\S]*?\n\n## Rules/, `## What to do in this reply\nContinue your last message (already shown to the customer) - only the new part, nothing from it repeated:\n${next.map((b) => `- ${b}`).join("\n")}\n\n## Rules`);
      if (network) system = system.replace("\n## Now\n", `\n## Businesses from our network (their own information)\n${network.text}\n\n## Now\n`);
      noteTurn("networkSearch", { found: network?.labels || [] });
      onToken("\n\n");
      let more = "";
      // The shown start goes in as our message (the model allows no prefill): with it only in the prompt
      // the model answered the question again from the top (3 of 4 tries, 2026-10-27).
      const cont: ChatMessage[] = [...messages, { role: "assistant", content: raw.trim() }, { role: "user", content: "(Internal note, not from the customer: the network check has finished. Continue your message above - write only the new part, it is appended right after it.)" }];
      await this.backend.generateStream!(system, cont, this.maxTokens, (d) => { more += d; onToken(d); });
      raw = `${raw.trim()}\n\n${more.trim()}`;
    }
    // Checks; a failed one blocks the reply and sends it back to the model with the reasons. Every
    // rewrite is checked again (twice at most); the last one is sent.
    const sources = [...passages.map((content) => ({ content })), ...(network?.evidence || []),
      // What this chat is, so a reply describing itself ("I'm the chat on X's website...", asked by owners testing their
      // demo) is not blocked as unsupported - it was, in 3 of 14 fact-check blocks of the 2026-11-04 eval.
      { content: `This is ${account ? "the chat on the website of" : "a demo of the chat, made by Whisp, for the website of"} ${brand}${this.getAllowedDomain() ? ` (${this.getAllowedDomain()})` : ""}: it answers customers' questions for the business from the business's own website and price list and what the business added.` },
      // Offering to check the network is something this chat really does (on a yes it searches) - not a claim about the business.
      ...(opts.handoffKind === "network" ? [{ content: "This chat can check businesses from our local Whisp network for the customer's question, if the customer wants that." }] : []),
      ...(about ? [{ content: about }] : [])];
    const factsText = `${renderOfficialInfo(this.context.businessProfile)}\n${passages.join("\n")}`;
    const hasPhone = /(?:\+?\d[\d\s().-]{7,}\d)/.test(factsText.replace(/\d{2}-\d{3}/g, "")), hasEmail = /[\w.+-]+@[\w-]+\.[\w.]+/.test(factsText);
    const allowedLinks = new Set([...(network?.links || []), ...this.context.siteMap.map((p) => p.url), ...used.map((p) => p.url), ...productLinks].filter(Boolean));
    const siteHost = (() => { try { return new URL(this.context.siteMap[0]?.url || `https://${this.getAllowedDomain()}`).hostname.replace(/^www\./, ""); } catch { return ""; } })();
    const customerText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    // The order form opened with this reply (order + question): taking the order here is what the chat does - both drafts of
    // rentbud-3's opening ("czy mogę zapisać zamówienie?") were blocked as a hand-off offer and a promise, and the rewrite said
    // the opposite ("rezerwacji nie mogę tu przyjąć") while the form was open (iteration 4 smoke test).
    const wantOffer = !!opts.handoffKind || !!opts.keepOffer || !!opts.formOpen;
    // A reply without an answer should give our phone or e-mail (unless an earlier reply already did, or the owner is writing).
    // Any phone number or e-mail the reply gives that our information shows (a branch's line counts too).
    const factsDigits = factsText.replace(/\D/g, ""), factsLow = factsText.toLowerCase();
    const givesKnownContact = (t: string) => [...t.matchAll(/(?:\+?\d[\d\s().-]{7,}\d)/g)].some((m) => { const d = m[0].replace(/\D/g, "").slice(-9); return d.length >= 9 && factsDigits.includes(d); })
      || [...t.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)].some((m) => factsLow.includes(m[0].toLowerCase().replace(/[.,;:]+$/, "")));
    const needContact = ownContacts.length > 0 && !network && !owner && behaviour.some((b) => b === BEHAVIOUR.noInfo || b === BEHAVIOUR.partial) && !contactGiven;
    const finish = (final: string, offers: number): ChatResponse => {
      const cleaned = this.guardReplyLinks(final.replace(/\[\[[^\]]*\]\]/g, "").trim());
      // State for the next turn.
      // An offer to check the network keeps what it offered: the need and the parts we don't have (searched on a yes).
      const what = opts.handoffKind === "network" && offered ? { question: offered.need, parts: offered.parts } : { question };
      if ((opts.handoffKind || opts.keepOffer) && rt && offers >= 0.5) { this.handoffOffers.set(sessionKey, { ...what, lang: rt.lang, kind: opts.handoffKind || "question", at: Date.now() }); st.handoffOfferedAt = st.turns; }
      if (network) st.referred = [...new Set([...(st.referred || []), ...network!.labels])];
      if (used.length) st.lastPacks = used.map((p) => p.id);
      // A page title can hold markup as text (an SEO plugin's "Sala weselna ... <time datetime="2026">2026</time>" was shown to
      // Villa Mamma's customers in the sources line): tags are dropped from the title shown.
      const srcs = used.filter((p) => p.url).map((p) => ({ url: p.url, title: p.title.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() }));
      // A question about us that our information doesn't answer goes to the owner's gap list (dashboard).
      const gap = !answered && !opts.behaviour?.length && rt && ["ask", "order", "calculate"].includes(rt.intent) ? question.trim().slice(0, 200) : undefined;
      return { message: cleaned, sources: srcs, grounded: true, ...(gap ? { unknownQuestion: gap } : {}), ...(network ? { partners: network!.partners } : {}) };
    };
    let safeRewrite = false; // set once the fact check was found unavailable (one safe rewrite, not a loop)
    const check = async (text: string): Promise<{ problems: string[]; offers: number }> => {
      const problems: string[] = [];
      if (!text.trim()) return { problems: ["it is empty - write the reply"], offers: 0 };
      const statements = splitStatements(text);
      const [unsup, checks] = await Promise.all([
        !opts.noFacts && statements.length && jevEnabled() ? jevUnsupportedStatements(messages.filter((m) => m.role === "user").slice(-2).map((m) => m.content).join("\n"), statements, this.verifySources(sources, messages, 20000)).catch(() => null) : Promise.resolve(null),
        jevEnabled() ? jevAsk({ conversation: convo, reply: text, ...(network ? { network_businesses: network.text.slice(0, 6000) } : {}) }, {
          offers: { type: "noul", instructions: opts.handoffKind === "network" ? "Does `reply` offer to check businesses from a local network for the customer (or ask whether to check them)?" : "Does `reply` offer to pass the customer's question or request on to the business's team (or ask whether to pass it on)?" },
          denies: { type: "noul", instructions: "Does `reply` flatly state that the business does NOT offer, sell, do or have something?" },
          contradicts: { type: "noul", instructions: "Does `reply` contradict itself (e.g. says it cannot recommend anyone and then recommends someone, or says something is unavailable and then offers it)? Saying we have no information on something and recommending another business for it is NOT a contradiction." },
          callUs: { type: "noul", instructions: "Does `reply` tell the customer to call us, phone us, or e-mail us (or mention our phone number or e-mail as a way to reach us)?" },
          promises: { type: "noul", instructions: `Does \`reply\` offer or promise an action outside this chat - check availability or stock, book or schedule a visit or appointment, reserve, measure, prepare a quote or document, call them back, send them something? (Offering to explain, describe or advise more in this chat, asking the customer for details, offering to pass the question on to the team, offering to check businesses from our local network, or inviting them to contact us does not count.${opts.formOpen ? " Nor does taking the customer's order details in this chat and saying it goes to the team once they confirm - this chat does that." : ""})` },
          // The business's own documents are not meta-talk: "z naszego cennika wynika" / "our price list shows" blocked about
          // half of 22 meta-blocked drafts in the 2026-11-04 eval (0.93 -> 0.05), and one rewrite turned a right total wrong.
          // Nor is telling an owner who asks "how do you know this?" that the answers come from the site and the panel (0.67 -> 0.13).
          meta: { type: "noul", instructions: "Does `reply` talk about an internal resource it was given instead of speaking as the business - e.g. 'in our information', 'w dostępnych informacjach', 'z naszych informacji wynika', 'w naszych materiałach / danych / źródłach', 'in the information provided', 'according to the data I have'? NOT this: naming the business's own website, price list, menu, offer, terms or regulations ('z naszego cennika wynika', 'na naszej stronie', 'our price list shows', 'w regulaminie'), answering a question about this chat itself (what it is, where its answers come from) by naming the website, the price list or the business's Whisp panel, or plain 'I don't have that information' / 'nie mam tej informacji' / 'we don't list it on our website'." },
          unanswered: { type: "noul", instructions: "Does the customer's latest message in `conversation` ask about several things, and does `reply` skip one of them without saying anything about it?" },
          claimsSent: { type: "noul", instructions: "Does `reply` say that the customer's request, question or details HAVE BEEN passed on, sent, forwarded or registered (already done, not offered)?" },
          vouches: { type: "noul", instructions: "Does `reply` praise or vouch for another company (e.g. 'reliable', 'trusted', 'experienced', 'sprawdzona')?" },
          // W3: a wedding venue's chat gave a photographer's 3700 zł package as "the cheapest reportage we offer".
          ...(network ? { theirsAsOurs: { type: "noul", instructions: "Does `reply` present something that one of `network_businesses` offers - its service, product, package or price - as offered by us ('we offer', 'our', 'u nas', 'oferujemy', 'nasz')?" } as const } : {}),
        }, 4000).catch(() => null) : Promise.resolve(null),
      ]);
      const nl = (k: string) => ((checks?.[k] as JevNoulAnswer | undefined)?.noul ?? 0);
      const bad = unsup ? statements.filter((_, i) => unsup[i] >= (Number(process.env.JEV_VERIFY_MIN) || 0.6)) : [];
      // Fact check unavailable (Jev down or out of credits): no unchecked facts go out - the reply is
      // rewritten once to state only the official contact details (fail closed; was sent unchecked).
      if (!opts.noFacts && statements.length && !unsup && (jevEnabled() || !!process.env.JEV_API_KEY) && !safeRewrite) {
        noteTurn("factCheckUnavailable", true);
        safeRewrite = true;
        problems.push("our fact check is unavailable right now, so it cannot be sent as it is: keep only the business's name, phone, e-mail, address and opening hours exactly as in the official info, say briefly that you can't confirm other details in the chat at the moment, and give our phone or e-mail for the rest");
      }
      if (bad.length) problems.push(`these statements are not supported by our information (remove or correct them): ${bad.map((b) => `"${b}"`).join("; ")}`);
      if (!wantOffer && nl("offers") >= 0.6) problems.push("it offers to pass the question on to our team, which this reply must not do");
      if (!network && !answered && nl("denies") >= 0.6) problems.push("it says we do not offer or do something, although our information simply does not cover it");
      if (nl("contradicts") >= 0.6) problems.push("it contradicts itself");
      if (nl("promises") >= 0.6) problems.push("it offers or promises something this chat cannot do (checking availability, calculating, measuring, booking, calling back) - offer nothing of the kind");
      if (nl("meta") >= 0.6) problems.push("it talks about 'our information' / 'materials' / 'data' instead of speaking as the business");
      if (nl("unanswered") >= 0.6) problems.push("it skips a part of the customer's question - answer every part, or say for that part that you don't know");
      if (nl("claimsSent") >= 0.6) problems.push("it says the customer's request or details have been passed on or sent, but nothing has been sent - do not claim that");
      if (needContact && !hasContact(text) && !givesKnownContact(text)) problems.push("it does not give our phone number or e-mail from the official info - give it so the customer can ask us directly");
      if (network && hasContact(text)) problems.push("it gives our own phone number or e-mail, as if it were a recommended business's - give each business only the contact shown for it");
      if (network && nl("vouches") >= 0.6) problems.push("it praises or vouches for another company - describe them only by what they offer");
      if (network && nl("theirsAsOurs") >= 0.6) problems.push("it presents a recommended business's offer or price as ours - say which business offers it");
      if (!network && nl("callUs") >= 0.6 && (!hasPhone || !hasEmail) && !/\d{3}[\s-]?\d{3}[\s-]?\d{3}|@/.test(text)) problems.push(`it suggests ${!hasPhone && !hasEmail ? "calling or e-mailing" : !hasPhone ? "calling" : "e-mailing"} us, but our information shows no ${!hasPhone && !hasEmail ? "phone number or e-mail" : !hasPhone ? "phone number" : "e-mail"} - point only to channels shown in our information (e.g. the contact form)`);
      if (network) for (const l of network.links) if (!text.includes(l)) problems.push(`it leaves out the link ${l} for one of the recommended businesses`);
      for (const m of text.matchAll(/https?:\/\/[^\s)\]]+/g)) {
        const u = m[0].replace(/[.,;:!?]+$/, "");
        let host = ""; try { host = new URL(u).hostname.replace(/^www\./, ""); } catch {}
        if (!allowedLinks.has(u) && host !== siteHost && !host.endsWith("whisp.so")) problems.push(`it contains the link ${u}, which is not in our information - remove it`);
      }
      const scripts = (t: string) => new Set([...t.matchAll(FOREIGN_SCRIPT)].map((x) => scriptOf(x[0])));
      const inCustomer = scripts(customerText);
      const stray = [...scripts(text)].filter((x) => !inCustomer.has(x));
      if (stray.length) problems.push(`it contains words in another alphabet (${stray.join(", ")}) - use only the customer's language and its alphabet`);
      return { problems, offers: nl("offers") };
    };
    let final = raw;
    let verdict = await check(raw);
    markTurn("checked");
    for (let round = 0; round < 2 && verdict.problems.length; round++) {
      noteTurn(`blocked${round + 1}`, { problems: verdict.problems, draft: final.slice(0, 1500) });
      console.log(`[packs] ${this.context.tenantId}: reply blocked (round ${round + 1}, ${verdict.problems.length}): ${verdict.problems.map((p) => p.slice(0, 90)).join(" | ")}`);
      const fix = `${system}\n\n## CORRECTION\nYour previous reply was:\n"""\n${final.slice(0, 2500)}\n"""\nIt cannot be sent because ${verdict.problems.join("; and ")}. Write the reply again, keeping everything that was right - as the only reply: never mention, correct or apologise for an earlier version.`;
      let again = "";
      try { again = (await this.backend.generate(fix, messages, this.maxTokens)).trim(); } catch {}
      if (!again) break;
      final = again;
      verdict = await check(final);
    }
    return finish(final, verdict.offers);
  }

  /** The turn's search query: a follow-up or a short message keeps its subject - the previous question and what our last reply was about. */
  private turnQuery(messages: ChatMessage[], question: string, rt: TurnRoute | null): { query: string; followup: boolean } {
    const prevUser = messages.filter((m) => m.role === "user").slice(-2, -1)[0]?.content || "";
    const prevReply = messages.slice(0, -1).filter((m) => m.role === "assistant").slice(-1)[0]?.content || "";
    const followup = (rt && rt.followup >= 0.5) || question.length < 40;
    return { query: followup && prevUser ? `${prevUser}\n${prevReply.slice(0, 200)}\n${question}` : question, followup };
  }

  /** Knowledge audit (src/knowledge/audit.ts): the standard questions through this assistant, as test turns. */
  async auditKnowledge(): Promise<AuditReport> {
    const probe = async (question: string) => {
      const u = newTurnUsage();
      return turnUsage.run(u, async () => {
        const r = await this.chatStream([{ role: "user", content: question }], `${AUDIT_SESSION}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, () => {});
        return { reply: r.message || "", behaviour: (u.debug?.behaviour as string[] | undefined) || [], route: r.collect || r.flowSession ? "collect" : r.project ? "agent" : "knowledge" };
      });
    };
    return auditKnowledge(this.context.tenantId, this.context, this.knowledgeCatalog, probe);
  }

  /**
   * A shop's products for this message (src/scraper/catalogue.ts): the catalogue items closest by meaning
   * (vectors) plus those sharing a word or SKU with it (a catalogue number is not found by meaning), picked
   * by the item matcher (src/offer/search.ts); none of ours -> the shop's own live
   * search (a catalogue larger than our index, or a product added since the last scrape).
   */
  private async shopProducts(query: string, question: string, rt: TurnRoute | null): Promise<OfferItem[]> {
    if (!this.catalogue || (rt && rt.intent === "chitchat")) return [];
    const items = this.offerItems.filter((i) => i.source === "shop");
    const { nearestItems } = await import("../offer/vectors.js");
    const { matchOfferItems, words } = await import("../offer/search.js");
    let found: OfferItem[] = [];
    if (items.length) {
      const near = (await nearestItems(this.context.tenantId, items, query, 40)) || [];
      const stems = new Set(words(question).map((w) => w.slice(0, 5)));
      const lexical = items.map((i) => ({ i, n: words(`${i.name} ${i.description.slice(0, 60)}`).filter((w) => stems.has(w.slice(0, 5))).length }))
        .filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 25).map((x) => x.i);
      const pool = [...new Set([...lexical, ...near])].slice(0, 70);
      // A follow-up ("and the second one?") is judged with the previous turn (query), a new question alone.
      found = (await matchOfferItems(query, pool, 6)) || [];
    }
    if (!found.length && this.catalogue.source !== "sitemap") {
      const { searchShop } = await import("../scraper/catalogue.js");
      const live = await searchShop(this.catalogue.siteUrl, this.catalogue.source, question, 10).catch(() => [] as OfferItem[]);
      if (live.length) { noteTurn("productsLive", live.length); found = (await matchOfferItems(query, live, 6)) || []; }
    }
    return found;
  }

  /** The business's quoting model applied to the conversation: the quote as text for the reply, or null. */
  private pricingCache = new Map<string, { at: number; pb: import("../pricing/model.js").PricingBusiness | null }>();
  // tenantId: our own by default; a network business's for the businesses relayed to the customer.
  private async quoteWithModel(convo: string, tenantId = this.context.tenantId): Promise<string | null> {
    return (await this.quoteResultWithModel(convo, tenantId))?.text ?? null;
  }
  // The same conversation's quote once per turn: the calculation route asks first, the reply reuses it.
  private quoteMemo = new Map<string, { at: number; p: Promise<{ text: string; covered: boolean } | null> }>();
  private async quoteResultWithModel(convo: string, tenantId = this.context.tenantId): Promise<{ text: string; covered: boolean } | null> {
    const key = `${tenantId}\n${convo}`;
    const memo = this.quoteMemo.get(key);
    if (memo && Date.now() - memo.at < 60_000) return memo.p;
    const p = (async () => {
      const m = await import("../pricing/model.js");
      let hit = this.pricingCache.get(tenantId);
      if (!hit || Date.now() - hit.at > 10 * 60_000) this.pricingCache.set(tenantId, (hit = { at: Date.now(), pb: await m.loadPricing(tenantId) }));
      const pb = hit.pb;
      if (!pb?.parts.length) return null;
      return m.quoteResult(pb, convo);
    })();
    if (this.quoteMemo.size > 200) this.quoteMemo.clear();
    this.quoteMemo.set(key, { at: Date.now(), p });
    p.catch(() => this.quoteMemo.delete(key));
    return p;
  }

  /** The network businesses found for a need, as prompt text + fact-check evidence + links. lang: the customer's language. */
  private async networkBlock(found: EcosystemMatch[], need: string, lang: OfferLang) {
    // What each business's link sends its bot as the customer's request (written next to the quotes below).
    const asksP = this.handoffLinks ? this.handoffAsks(found.map((f) => f.parts || []), lang) : Promise.resolve([] as string[]);
    // Each relayed business with a quoting model prices the parts it was found for itself (its own program) - not the
    // whole need: its program read our own products in it too, and their prices reached our customer. The quote joins
    // its passages. Off unless the quoting model is on for this chat.
    if (process.env.PRICING_CHAT === "on" || turnVariant().includes("pricing")) {
      const quotes = await Promise.all(found.map((f) => (f.parts?.length ? Promise.race([this.quoteWithModel(f.parts.join("\n"), f.tenantId).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 8000))]) : Promise.resolve(null))));
      // With a quote, its offer rows are left out: one source per price (the reply took Zajac's 3500 zl / 6 h row
      // and added the 2 extra hours to the quote's 4500 zl that already had them).
      found = found.map((f, k) => (quotes[k] ? { ...f, passages: [{ content: `Prices computed from ${f.label}'s own price list for this request: ${quotes[k]!.replace(/\n/g, "; ")}`, url: "", title: "quote" }, ...f.passages.filter((p) => !p.item)] } : f));
      quotes.forEach((q, k) => q && noteTurn("networkQuote", `${found[k].tenantId}: ${q.slice(0, 400)}`));
    }
    // Each business's link carries only the parts it was found for, never the rest of the customer's request: the whole
    // message, as its bot's first message and in its chat log, gave a competitor the business's own products (2026-11-04,
    // owner). No parts known: no link.
    const asks = await asksP;
    const links: Record<string, string> = {};
    if (this.handoffLinks) await Promise.all(found.map(async (f, k) => {
      if (!asks[k]) return;
      const l = await this.handoffLinks!([{ tenantId: f.tenantId, label: f.label }], [{ role: "user", content: asks[k] }], asks[k]).catch(() => ({} as Record<string, string>));
      if (l[f.tenantId]) links[f.tenantId] = l[f.tenantId];
    }));
    const text = found.map((f) => `### ${f.label}${links[f.tenantId] ? ` | link for the customer: ${links[f.tenantId]}` : ""}\nContact: ${f.contact || "no phone or e-mail known - only the link"}\n${f.passages.map((p) => p.content.replace(/\s+/g, " ").slice(0, p.title === "quote" ? 2500 : 900)).join("\n")}`).join("\n\n---\n\n");
    const evidence = [
      { content: `Businesses from our network checked for the customer: ${found.map((f) => f.label).join(", ")}.` },
      // What each business was found for - its matched parts, not the whole need (that said each one offers all of it).
      ...found.flatMap((f) => [...f.passages.map((p) => ({ content: `${f.label}: ${p.content}` })), { content: `${f.label} contact: ${f.contact}` }, { content: `${f.label} offers, sells, rents or does ${f.parts?.length ? f.parts.map((x) => `"${x.slice(0, 200)}"`).join(", ") : `what the customer asked for ("${need.slice(0, 300)}")`} - checked against its own website.` }]),
    ];
    return { text, evidence, labels: found.map((f) => f.label), links: found.map((f) => links[f.tenantId]).filter(Boolean), partners: found.map((f) => ({ tenantId: f.tenantId, label: f.label })) };
  }

  /**
   * The customer's request each relayed business's bot gets through its hand-off link: only the parts it was found for
   * (the network's split - neutral, without personal data), in the customer's language. The parts are Polish (the
   * businesses' offers are); for English, Ukrainian, French or German the network's model translates them, adding
   * nothing - the parts as they are when it fails or takes over HANDOFF_ASK_MS, and for Polish or another language.
   */
  private async handoffAsks(lists: string[][], lang: OfferLang): Promise<string[]> {
    const plain = lists.map((l) => l.join("; "));
    const name = lang === "pl" ? "" : LANG_NAMES[lang];
    if (!name || !plain.some(Boolean)) return plain;
    const { llmJson } = await import("../projects/broadcast.js");
    const j = await Promise.race([
      llmJson(`Translate each numbered request of a customer into ${name}, keeping every quantity, date and place and adding nothing. Return JSON {"requests": ["...", ...]}: one per number, in the same order.`, plain.map((p, k) => `${k + 1}. ${p}`).join("\n"), 600).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), HANDOFF_ASK_MS)),
    ]);
    const out: unknown[] = Array.isArray(j?.requests) ? j.requests : [];
    return plain.map((p, k) => { const t = out[k]; return p && typeof t === "string" && t.trim() ? t.trim().slice(0, 600) : p; });
  }

  // Route tiny classification through the small fast model when available.
  private async fastClassify(system: string, prompt: string): Promise<string> {
    if (this.backend.classify) return this.backend.classify(system, prompt);
    return this.backend.generate(system, [{ role: "user", content: prompt }], 8);
  }

  // Start a goal-driven ("agent") flow: no input collection here; the widget
  // drives the page with /api/agent/step and asks the visitor for data as needed.
  private async hasNetwork(): Promise<boolean> {
    const { networkMembers } = await import("../projects/network.js");
    return (await networkMembers(this.context.tenantId).catch(() => [])).length > 1;
  }

  /** Which parts of a request we have ourselves (src/network/coverage.ts): the one decision every network path follows. */
  private coverageOf(text: string): Promise<Coverage> {
    return coverage(this.context.tenantId, text, { items: this.offerItems });
  }

  /**
   * The text a turn's coverage is decided on: the customer's own words - the latest message, after the request of the
   * previous one when the router says the latest is about that request's product or service (continues: "a z szarfą i
   * dowozem?" after the wreath - read alone, the sash and the delivery had no wreath to go with and the delivery came out
   * not the florist's, 2026-11-04 smoke), names nothing specific, or there is no route. That request is the previous
   * message's own text, or what it continued (kept per conversation, sessionKey). An explicit ask for other businesses is
   * read alone - never the parts of earlier turns (the owner's decision); networkStart joins it only when it names nothing.
   * One text for the order form, the calculation and the reply's network start, so a turn makes one decision (the memo
   * answers the others; the order and calculation used the reply's search query, whose 200 characters of our own reply
   * the split read as asked).
   */
  private coverageNeed(messages: ChatMessage[], question: string, rt: TurnRoute | null, sessionKey?: string): string {
    const prevUser = messages.filter((m) => m.role === "user").slice(-2, -1)[0]?.content || "";
    if (!prevUser) return question;
    const st = sessionKey ? this.packStateOf(sessionKey) : null;
    const before = st?.requests?.[prevUser] ?? prevUser;
    const joined = !rt || (rt.intent !== "elsewhere" && (rt.specific < 0.5 || (rt.continues ?? 0) >= 0.5));
    const need = joined ? `${before}\n${question}`.slice(-3000) : question;
    if (st) st.requests = { [prevUser]: before, [question]: need };
    return need;
  }

  /** Passages of this business's own site for a query (for its answers inside projects). */
  async knowledgePassages(query: string, limit = 10): Promise<string[]> {
    const chunks = await this.retrieveContext(query).catch(() => []);
    return chunks.slice(0, limit).map((c) => `${c.metadata?.title ? `## ${c.metadata.title}\n` : ""}${c.content}`);
  }

  // ── Projects: work on data by the project agent (sandbox, tools) ──
  /** The flows a visitor can start (orders, bookings, on-page tasks) - not the "question for the owner" form. */
  private routableFlows(): FlowDefinition[] {
    return this.context.flows.filter((f) => f.status === "active" && !isQuestionFlow(f));
  }

  /** The router's decision for this message (memoised: the stream path decides, the full path reuses it). */
  private async routeTurn(messages: ChatMessage[], message: string): Promise<TurnRoute | null> {
    if (!jevEnabled()) return null; // safe mode: no decision (and no memoised one from before)
    const prevUser = messages.filter((m) => m.role === "user").slice(-2, -1)[0]?.content || "";
    const prevReply = messages.slice(0, -1).filter((m) => m.role === "assistant").slice(-1)[0]?.content || "";
    const flows = this.routableFlows();
    // The previous customer message too: "specific" and "continues" read the message with it.
    const key = `${flows.map((f) => f.id).join(",")}\n${prevUser.slice(-300)}\n${prevReply.slice(-300)}\n${message}`;
    const hit = this.routeMemo.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.route;
    const r = await routeMessage(prevUser, prevReply, message, flows).catch(() => null);
    if (this.routeMemo.size > 300) this.routeMemo.clear();
    this.routeMemo.set(key, { at: Date.now(), route: r });
    if (r) console.log(`[route] ${this.context.tenantId}: ${r.intent}${r.flow >= 0 ? ` flow=${flows[r.flow]?.name}` : ""} price=${r.price.toFixed(2)} specific=${r.specific.toFixed(2)} need=${r.need.toFixed(2)} followup=${r.followup.toFixed(2)} continues=${r.continues.toFixed(2)} ${r.lang}: "${message.slice(0, 60)}"`);
    return r;
  }

  /**
   * Hands the message to the project agent and answers at once that the work is under way; the result
   * reaches the visitor through the widget (GET /api/chat/agent). Null without a project record (D1
   * down): the turn falls back to the knowledge answer.
   */
  private async agentTurn(messages: ChatMessage[], message: string, sessionKey: string, opts?: { pureCalc?: boolean; coverage?: Coverage }): Promise<ChatResponse | null> {
    // Costly background work is rationed against scripted abuse (2026-10-29; docs/limits.md): none over a
    // spend cap or from a foreign site, and per day at most AGENT_RUNS_SESSION per conversation (10),
    // AGENT_RUNS_IP per visitor IP (30 - offices and mobile carriers share IPs) and AGENT_RUNS_TENANT per
    // business (300). Counted only for runs that start. Over it the turn is answered from the pages (null).
    if (turnCheap()) { noteTurn("agentLimit", "cheap"); return null; }
    const { bump, peek, logAbuse } = await import("../security/quota.js");
    const ip = turnIp();
    const caps: [string, number][] = [[`agent:s:${sessionKey}`, Number(process.env.AGENT_RUNS_SESSION) || 10], ...(ip ? [[`agent:ip:${ip}`, Number(process.env.AGENT_RUNS_IP) || 30] as [string, number]] : []), [`agent:t:${this.context.tenantId}`, Number(process.env.AGENT_RUNS_TENANT) || 300]];
    if (!turnExempt()) for (const [k, cap] of caps) if ((await peek(k)) >= cap) { noteTurn("agentLimit", "quota"); logAbuse("agent_quota", k, this.context.tenantId); return null; }
    const countRun = () => { if (!turnExempt()) for (const [k, cap] of caps) void bump(k, cap); };
    const projectId = await conversationProject(this.context.tenantId, sessionKey, message);
    if (!projectId) return null;
    // Quantities only (no prices, no commitments): delivered without the owner's approval. The chat's coverage goes with
    // the request: the project's broadcast asks the network only for the parts we don't have (items as ids).
    const c = opts?.coverage;
    await setProjectMemory(projectId, { pureCalc: !!opts?.pureCalc, coverage: c ? { parts: c.parts, own: c.own, priced: c.priced, items: c.items.map((l) => l.map((i) => i.id)) } : null }).catch(() => {});
    const knowledge = await this.knowledgePassages(message);
    const [begun, lang] = await Promise.all([
      beginConversationAgent(projectId, messages, knowledge),
      jevAsk({ message }, { lang: { type: "choice", instructions: "In which language is `message` written?", criteria: { pl: "Polish", en: "English", uk: "Ukrainian", fr: "French", de: "German", other: "Another language" } } }, 3000),
    ]);
    const l = ((lang?.lang as any)?.choice as string) || "en";
    if (begun === "started") countRun();
    console.log(`[conversation] ${this.context.tenantId}: ${projectId} agent ${begun}`);
    const n = NOTIFY[l] || NOTIFY.en;
    const { customerLink, LINK_TEXT } = await import("../projects/conversation.js");
    const token = await customerLink(projectId).catch(() => "");
    const lk = NOTIFY[l] ? l : "en";
    const { OPEN_STATUS } = await import("../projects/conversation.js");
    const { availableChannels } = await import("../projects/notify-channels.js");
    const os = OPEN_STATUS[lk] || OPEN_STATUS.en;
    const channels = availableChannels().map((c) => os.names[c]);
    const notify = { lang: lk, prompt: n.prompt, consent: n.consent.split("{brand}").join((await import("../projects/network.js")).businessLabel(this.context.tenantId) || this.brandName || ""), button: n.button,
      ...(token ? { link: `${process.env.BASE_URL || "https://whisp.so"}/p/${token}`, linkText: LINK_TEXT[lk], open: os.button, openHint: os.hint.split("{channels}").join(channels.join(", ")) } : {}) };
    // The notice is the model's own words (the fixed text only if the model can't be reached).
    let notice = (begun === "busy" ? BUSY : WORKING)[l] || (begun === "busy" ? BUSY : WORKING).en;
    {
      const { reviewMode } = await import("../projects/review.js");
      const what = begun === "busy" ? "We are still working on the customer's previous request; this new message will be handled once that is ready. Tell them briefly."
        : reviewMode(this.context.tenantId) === "approve" && !opts?.pureCalc ? BEHAVIOUR.calcReviewed : BEHAVIOUR.calcStarted;
      const follow = token && begun !== "busy" ? ` Then say plainly that this can take a while and that a button under your message (shown by the chat - don't write it or its label yourself) opens the status of their request in a new tab with live updates, where they can also choose to be notified (${channels.join(", ")}) - so they don't have to wait here.` : "";
      notice = (await this.backend.generate(`You are the website chat assistant of ${this.brandName || "our business"}, speaking as "we". ${what}${follow} Reply in the customer's language, naturally.${replyLanguage(await this.routeTurn(messages, message).catch(() => null))}`, messages.slice(-4), 500).catch(() => "")).trim() || notice;
    }
    return { message: notice, sources: [], grounded: true, project: { id: projectId, type: CONVERSATION, agent: { status: "running" }, ...(begun === "busy" ? {} : { notify }) } };
  }


  // ── "In chat" flows: the assistant collects an order / inquiry itself ──
  /** Remember who referred this session (called on every hand-off turn). */
  setSessionVia(sessionKey: string, via: CollectVia): void {
    const now = Date.now();
    if (this.sessionVia.size > 500) for (const [k, v] of this.sessionVia) if (now - v.at > 30 * 60 * 1000) this.sessionVia.delete(k);
    this.sessionVia.set(sessionKey, { via, at: now });
  }

  /** The business's own information an order form checks requests against (offer items, site snippets). */
  private collectKnowledge(): ((q: string) => Promise<string[]>) | undefined {
    const cat = this.knowledgeCatalog;
    const offerItems = this.offerItems;
    return cat || offerItems.length
      ? async (q: string) => [
          ...(offerItems.length ? (await findOfferItems(q, offerItems, 5, this.context.tenantId).catch(() => [] as OfferItem[])).map(renderItem) : []),
          ...(cat ? lexicalSnippets(q, cat, 5) : []),
        ]
      : undefined;
  }

  private startCollect(flow: FlowDefinition, sessionKey: string, message: string, via?: CollectVia, context?: string): Promise<ChatResponse> {
    const remembered = this.sessionVia.get(sessionKey);
    const s = startSession(flow, via || (remembered && Date.now() - remembered.at < 30 * 60 * 1000 ? remembered.via : undefined));
    if (context) s.transcript.push(...context.split("\n").filter(Boolean));
    this.collectSessions.set(sessionKey, s);
    return this.runCollect(flow, s, sessionKey, message);
  }

  private async runCollect(flow: FlowDefinition, s: CollectSession, sessionKey: string, message: string, questionAnswered = false): Promise<ChatResponse> {
    const llm = (system: string, user: string, maxTokens = 700) => this.backend.generate(system, [{ role: "user", content: user }], maxTokens);
    const status = (stage: NonNullable<ChatResponse["collect"]>["stage"]) => ({ flowId: flow.id, stage, missing: stage === "collecting" || stage === "confirming" ? missingLabels(flow, s) : [] });
    try {
      // Whether the order is ours to take was decided before the form opened (coverage); the form only takes it.
      const r = await collectTurn(flow, s, message, this.brandName, llm, this.collectKnowledge(), questionAnswered);
      if ("cancelled" in r) { this.collectSessions.delete(sessionKey); return { message: r.reply, sources: [], collect: status("cancelled") }; }
      if ("inquiry" in r) {
        this.collectSessions.delete(sessionKey);
        const ok = this.onInquiry ? await this.onInquiry(r.inquiry).catch(() => false) : false;
        if (ok) return { message: r.reply, sources: [], collect: status("sent") };
        console.error(`[collect] inquiry for flow ${flow.id} could not be recorded`);
        return { message: this.collectFailed(s.language, true, message), sources: [], collect: status("failed") };
      }
      return { message: r.reply, sources: [], collect: status(s.stage) };
    } catch (e) {
      console.warn(`[collect] turn failed: ${(e as Error).message}`);
      return { message: this.collectFailed(s.language, false, message), sources: [], collect: status(s.stage) };
    }
  }

  // Honest failure messages for "in chat" flows, when the model itself cannot be
  // used: by the language the form's reader named earlier, else the message's own.
  private collectFailed(language: string | undefined, sending: boolean, message = ""): string {
    const l = LANG_OF_NAME[(language || "").trim().toLowerCase().split(/[\s(]/)[0]] || guessLang(message);
    return COLLECT_FAILED[l][sending ? "send" : "turn"];
  }

  private async startAgentFlow(flow: FlowDefinition, message: string): Promise<ChatResponse> {
    // Language by Jev, not keyword lists: works for any language the visitor uses.
    const l = await jevAsk({ message }, { lang: { type: "choice", instructions: "In which language is `message` written?", criteria: { pl: "Polish", en: "English", other: "Any other language" } } }, 3000);
    const lang = ((l?.lang as { choice?: string } | undefined)?.choice || "en") as "pl" | "en" | "other";
    let text = lang === "pl"
      ? `Jasne, przeprowadzę Cię przez to krok po kroku („${flow.name}”). Będę pokazywać, co klikam. O dane osobowe i zgody zapytam Ciebie.`
      : `Sure, I'll take you through it step by step ("${flow.name}"). I'll show what I click and ask you for personal details and consents.`;
    if (lang === "other") {
      // A plain translation task (the old "rewrite" prompt made the model echo
      // the visitor's own message back as the greeting).
      try {
        const t = (await this.backend.generate(
          "You translate short UI messages. Reply with the translation only.",
          [{ role: "user", content: `Translate the MESSAGE into the language that the VISITOR TEXT is written in. Keep the quoted name as it is.\n\nVISITOR TEXT: ${message.slice(0, 300)}\n\nMESSAGE: ${text}` }],
          200,
        )).trim();
        if (t && t !== message.trim()) text = t;
      } catch {}
    }
    return {
      message: text,
      sources: [],
      flowSession: { active: true, status: "executing" as FlowSession["status"], flowId: flow.id, complete: false, agent: { flowId: flow.id, startUrl: flow.startUrl, request: message.slice(0, 600), lang } },
    };
  }

  // Only a real need goes to the network (Jev, the router): the visitor explicitly asks to find it elsewhere,
  // or asks for one specific product or service - never a broad category or a follow-up. Only the parts we don't
  // have ourselves are relayed (src/network/coverage.ts); on an explicit ask for other businesses, every part of
  // that ask (the owner's decision). The search starts with the split, next to the coverage, and its hits for our
  // own parts are dropped when the coverage comes: started after the coverage, a mixed turn's offer had 1.5 s for a
  // 1.4-3.5 s search (review 2026-11-04). search = false (the owner writing): the coverage only, for our own pages.
  // null = not asked; cov: the coverage of the need; net: null = nothing for the network; elsewhere: net needs no coverage.
  private networkStart(question: string, messages: ChatMessage[], rt: TurnRoute | null, search: boolean, sessionKey?: string): { cov: Promise<Coverage>; net: Promise<NetworkAsk | null>; elsewhere: boolean } | null {
    const askEcosystem = this.askEcosystem;
    if (!askEcosystem || !rt) return null;
    const elsewhere = rt.intent === "elsewhere";
    const ask = elsewhere || (rt.intent !== "chitchat" && rt.specific >= 0.5 && rt.need >= 0.5 && rt.followup < 0.5);
    if (!ask) {
      console.log(`[ecosystem] ${this.context.tenantId}: not asked (${rt.intent}, specific ${rt.specific.toFixed(2)}, need ${rt.need.toFixed(2)}, follow-up ${rt.followup.toFixed(2)}): "${question.slice(0, 60)}"`);
      return null;
    }
    // The same stored split the coverage reads (one call, src/projects/broadcast.ts); its parts are the search's.
    const split = (text: string) => import("../projects/broadcast.js").then((b) => b.splitNeed(text, this.context.tenantId));
    // An explicit ask for other businesses: its own words, and every part of them is searched and relayed - nothing of it
    // waits for the coverage's item and page checks (they decide nothing there; a coverage later than the reply's wait
    // dropped the customer's ask - review 2026-11-04). When the ask names nothing itself ("a gdzie indziej to dostanę?",
    // its split has no part), the request it is about: the router's "specific" reads it with the previous message
    // (0.65-0.74 for such asks, probe 2026-11-04), so the bare ask was searched and found nothing. Otherwise the turn's
    // coverage text, the search for every part at once, and kept: the coverage's parts we don't have.
    let asked: Promise<{ need: string; parts: string[] }>;
    let cov: Promise<Coverage>;
    if (elsewhere) {
      asked = split(question).then(async (parts) => {
        if (parts.length) return { need: question, parts };
        const need = this.coverageNeed(messages, question, null, sessionKey);
        return { need, parts: need === question ? parts : await split(need) };
      });
      // Only for our own pages in the reply; an ask about hours, contact or terms elsewhere has no offer to judge.
      cov = aboutOffer(rt) ? asked.then(({ need }) => this.coverageOf(need), () => this.coverageOf(question)) : Promise.resolve<Coverage>({ parts: [], own: [], priced: [], items: [], passages: [], how: [] });
    } else {
      const need = this.coverageNeed(messages, question, rt, sessionKey);
      cov = this.coverageOf(need);
      asked = split(need).then((parts) => ({ need, parts }));
    }
    const matches: Promise<EcosystemMatch[]> = !search ? Promise.resolve([]) : asked
      .then(({ need, parts }) => (parts.length ? askEcosystem([{ role: "user", content: need }], undefined, parts, elsewhere ? undefined : cov.then((c) => c.parts.filter((_, k) => !c.own[k]))) : []))
      .catch((e) => { console.warn(`[ecosystem] ${this.context.tenantId}: broadcast failed: ${(e as Error).message}`); return [] as EcosystemMatch[]; });
    const net = elsewhere
      ? asked.then(({ need, parts }): NetworkAsk | null => (search && parts.length ? { need, lang: rt.lang, matches, parts, allForeign: false } : null), () => null)
      : Promise.all([asked, cov]).then(([{ need }, c]): NetworkAsk | null => {
        const foreign = c.parts.filter((_, k) => !c.own[k]);
        if (!search || !foreign.length) {
          console.log(`[ecosystem] ${this.context.tenantId}: not asked - ${!search ? "the owner is writing" : c.parts.length ? "every part is ours" : "no part to search"}: "${question.slice(0, 60)}"`);
          return null;
        }
        return { need, lang: rt.lang, matches, parts: foreign, allForeign: foreign.length === c.parts.length };
      }, () => null);
    return { cov, net, elsewhere };
  }


  // Deterministic flow triggering — the production backend (OpenRouter) has
  // neither tool-calling nor structured output, so invocation must NOT depend
  // on the LLM electing to emit an action (it roleplayed "reservation received"
  // instead — a false promise). Trigger phrases (LLM-generated at analysis
  // time) are matched directly against the user message.
  // LLM flow classifier — replaces the old deterministic phrase matcher. Given
  // the visitor's message and the active flows, decide which flow (if any) they
  // want to START. Returns [] (just chatting / a question), [flow] (one clear
  // intent), or [flowA, flowB] (genuinely ambiguous -> caller disambiguates).
  // One decision per message: the streaming path asks first and then hands the
  // same message to chat(), which asked again - a borderline message (a French
  // booking request at 0.57) could start the flow in one call and not the other.

  // LLM picks which candidate flow the visitor meant (or none) — used to resolve
  // an ambiguous first message that matched multiple flows.
  private async pickFromCandidates(message: string, flows: FlowDefinition[]): Promise<FlowDefinition | null> {
    if (flows.length === 0) return null;
    if (flows.length === 1) return flows[0];
    const jev = await jevPickOption(
      "The visitor was asked which task they want. Which option does their `message` mean? Choose none if it is unclear or matches no option.",
      message,
      flows.map((f) => `${f.name}: ${f.description || ""}`),
      "Unclear, or matches none of the options.",
    );
    if (jev) return jev.index >= 0 ? flows[jev.index] : null;
    const list = flows.map((f, i) => `${i + 1}. ${f.name} — ${f.description || ""}`).join("\n");
    const prompt = `The visitor was asked which task they want. Options:\n${list}\n\nTheir reply: "${message}"\n\nWhich option number do they mean? Reply with ONLY the number, or "0" if none/unclear.`;
    try {
      const raw = await this.fastClassify("You map a reply to an option number. One number only.", prompt);
      const n = parseInt((raw.match(/\d+/) || ["0"])[0], 10);
      return n >= 1 && n <= flows.length ? flows[n - 1] : null;
    } catch { return null; }
  }

  // Everything the reply model was given as fact: official info, owner notes, the site's page list
  // ("see our Realizacje page"), our own earlier replies in this conversation (each was checked when
  // it was sent - a follow-up repeating the address was flagged without them), and the passages.
  private verifySources(chunks: { content: string }[], messages: ChatMessage[] = [], maxLen = 2500): string[] {
    const pages = this.context.siteMap.slice(0, 20).map((p) => `- ${p.title} (${p.url})`).join("\n");
    const earlier = messages.slice(0, -1).filter((m) => m.role === "assistant").slice(-2).map((m) => `Earlier in this conversation we said: ${m.content.slice(0, 1500)}`);
    return [
      renderOfficialInfo(this.context.businessProfile),
      ...this.contextNotes.map((n) => `Q: ${n.question}\nA: ${n.answer}`),
      pages ? `Pages of our website:\n${pages}` : "",
      ...earlier,
      // The same passages the model saw (up to 25): checking against fewer made
      // correct lines of long lists look unsupported.
      ...chunks.slice(0, 600).map((c) => c.content.slice(0, maxLen)),
    ].filter((x) => x && x.trim());
  }

}
