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
import { buildPackIndex, candidatePacks, scorePacks, renderPacks, renderState, BEHAVIOUR, type Pack, type PackIndex, type PackState } from "./packs.js";
import { isQuestionFlow } from "../flows/collect-store.js";
import { setMemory as setProjectMemory } from "../projects/store.js";
import { type OfferLang, jevPassageRelevance, jevPickOption, jevEnabled, splitStatements, jevUnsupportedStatements, jevAsk, SENTENCE_END, type JevNoulAnswer } from "./jev.js";
import { retrieveFromCatalog, lexicalSnippets, type KnowledgeCatalog, type CatalogChunk } from "../knowledge/catalog.js";
import { buildLinkIndex, guardLinks, type LinkIndex } from "./link-guard.js";
import { findOfferItems } from "../offer/search.js";
import type { Business } from "../projects/compare.js";
import { agentEnabled } from "../projects/agent.js";
import { conversationProject, recordTurn, beginConversationAgent, WORKING, BUSY, NOTIFY, CONVERSATION, type Route } from "../projects/conversation.js";
import { renderItem, type OfferItem } from "../offer/store.js";
import { collectTurn, startSession, missingLabels, offeredHere, type CollectSession, type CollectVia, type Inquiry } from "../flows/collect.js";
import { noteTurn, turnVariant } from "./turn-usage.js";
import { planPrompt, parsePlan, numberSentences, renderPlan, type Plan } from "./plan.js";

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
  // The businesses of our network (this one included) that have a structured
  // offer - for "what would this list / job cost?" projects (compare_offers@1).
  networkOffers?: () => Promise<Business[]>;
  // Ecosystem broadcast (src/ecosystem/ask.ts): when our own content has nothing
  // on the question, the other businesses of our ecosystem each decide from their
  // own knowledge whether they can answer; their answers come back here.
  // onStart fires only when there are other businesses to ask (the widget shows
  // "checking with businesses we work with" while they decide).
  askEcosystem?: (messages: ChatMessage[], onStart?: () => void) => Promise<EcosystemMatch[]>;
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
    const result = await this.provider.chat(orMessages);
    return result.content;
  }

  async generateStream(system: string, messages: ChatMessage[], maxTokens: number, onToken: (delta: string) => void): Promise<string> {
    const orMessages = [
      { role: "system" as const, content: system },
      ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];
    const result = await this.provider.chatStream(orMessages, onToken);
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


// A network search started alongside our own reply (see networkStart).
interface NetworkAsk { need: string; lang: OfferLang; matches: Promise<EcosystemMatch[]> }

/** How a reply was produced (recorded per turn, reported in admin traces). */
export function routeOf(r: ChatResponse): Route {
  return r.project?.agent ? "agent" : r.project ? "estimate" : r.collect ? "collect" : r.flowSession ? "flow"
    : r.partners?.length ? "network" : r.grounded === false ? "refusal" : "knowledge";
}

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
  // (no answer here, or no prices for a quote): waiting for their yes.
  private handoffOffers: Map<string, { question: string; lang: OfferLang; kind: "question" | "quote"; at: number }> = new Map();
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
  private networkOffers?: () => Promise<Business[]>;
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
    this.networkOffers = config.networkOffers;
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
    const user = messages.findLast((m) => m.role === "user")?.content || "";
    const route = routeOf(r);
    void conversationProject(this.context.tenantId, sessionKey || "default", user).then((pid) => recordTurn(pid, { user, assistant: r.message, route, data: r.project ? { project: r.project } : undefined }));
  }

  /** A conversation already inside something - an order form, an on-page flow, a "which one?" question: its next step, or null. */
  private async continueSession(messages: ChatMessage[], sessionKey: string, formState?: Record<string, string>): Promise<ChatResponse | null> {
    const message = messages.findLast((m) => m.role === "user")?.content || "";
    const effectiveSessionKey = sessionKey;
    // An "in chat" flow (order / inquiry) in progress takes every message.
    const cs = this.collectSessions.get(effectiveSessionKey);
    if (cs) {
      const flow = this.context.flows.find((f) => f.id === cs.flowId && f.status === "active");
      if (flow && Date.now() - cs.at < COLLECT_IDLE_MS) return this.runCollect(flow, cs, effectiveSessionKey, message);
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
      if (picked && picked.executionMode === "collect") return this.startCollect(picked, effectiveSessionKey, message);
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
    const offerHits = this.offerItems.length ? findOfferItems(lastUserMessage, this.offerItems).catch(() => [] as OfferItem[]) : Promise.resolve([] as OfferItem[]);
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

  private async chatStreamInner(messages: ChatMessage[], sessionKey: string | undefined, onToken: (delta: string) => void, formState?: Record<string, string>, _onStatus?: (status: { kind: string; text: string }) => void): Promise<ChatResponse> {
    const lastUserMessage = messages.findLast((m) => m.role === "user")?.content || "";
    const key = sessionKey || "default";
    const v = validateInput(lastUserMessage);
    if (v.blocked) return this.packsStream(messages, messages, key, onToken, true, formState);
    const sanitized: ChatMessage[] = v.sanitized !== lastUserMessage
      ? messages.map((m, i) => (i === messages.length - 1 && m.role === "user") ? { ...m, content: v.sanitized } : m)
      : messages;
    return this.packsStream(messages, sanitized, key, onToken, false, formState);
  }

  // ── Dynamic context ("packs", A/B variant): Jev picks whole blocks of our information for the
  // conversation, behaviour comes as instructions, the model writes every word, checks can block. ──
  private packIndex: PackIndex | null | undefined;
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
    if (blocked) return this.packsReply(sanitizedMessages, sessionKey, onToken, { behaviour: [BEHAVIOUR.blocked], packs: [], noFacts: true });

    // A form left for 30 min is over (as on the other paths) - without falling back to their texts.
    const cs = this.collectSessions.get(sessionKey);
    if (cs && Date.now() - cs.at >= COLLECT_IDLE_MS) this.collectSessions.delete(sessionKey);

    // Answering our offer to pass the question on: only an explicit yes starts the form ("ok, thanks" is not a yes).
    const offer = this.handoffOffers.get(sessionKey);
    if (offer && Date.now() - offer.at < 30 * 60 * 1000 && !this.collectSessions.has(sessionKey)) {
      const ourReply = sanitizedMessages.slice(0, -1).findLast((m) => m.role === "assistant")?.content || "";
      const a = await jevAsk({ our_offer: `We offered to pass the customer's question on to our team and asked whether they want that. Our reply was: ${ourReply.slice(-600)}`, message: question }, {
        answer: { type: "choice", instructions: "How does the customer's `message` answer `our_offer`?", criteria: {
          yes: "Explicitly agrees to have it passed on (e.g. 'tak, przekaż', 'yes please', 'proszę'), or replies with their contact details (name, phone, e-mail, address).",
          what: "Asks what that means or how it works.",
          no: "Declines (e.g. 'nie', 'nie trzeba', 'no thanks').",
          other: "Anything else: thanks or ok without agreeing, a new question, another topic.",
        } },
      }, 4000).catch(() => null);
      const c = a?.answer as { choice?: string; probabilities?: Record<string, number> } | undefined;
      const answer = c?.choice && (c.probabilities?.[c.choice] ?? 0) >= 0.7 ? c.choice : "other";
      if (answer === "what") return this.packsReply(sanitizedMessages, sessionKey, onToken, { behaviour: [BEHAVIOUR.explainHandoff], packs: [], keepOffer: true });
      this.handoffOffers.delete(sessionKey);
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
      const q = await jevAsk({ message: question }, { q: { type: "noul", instructions: "The customer is filling in an order or inquiry form in a chat. Is `message` a question to the business asking for information (price, availability, terms, how something works) rather than giving, correcting or declining details for the form?" } }, 3000).catch(() => null);
      if (((q?.q as JevNoulAnswer | undefined)?.noul ?? 0) >= 0.75) {
        const rtQ = await this.routeTurn(sanitizedMessages, question);
        return this.packsReply(sanitizedMessages, sessionKey, onToken, { rt: rtQ, extra: [BEHAVIOUR.midForm] });
      }
    }
    // An open form / flow / pending choice: its next step (the form's replies are the model's).
    const next = await this.continueSession(sanitizedMessages, sessionKey, formState);
    if (next) { onToken(next.message); return next; }

    const rt = await this.routeTurn(sanitizedMessages, question);
    // Starting one of our actions: decided here, so nothing falls back to the other path's texts.
    if (rt && rt.intent === "order" && rt.flow >= 0) {
      const flows = this.routableFlows();
      const picked = rt.flowAmbiguous.length > 1 ? rt.flowAmbiguous.slice(0, 2).map((i) => flows[i]).filter(Boolean) : [flows[rt.flow]].filter(Boolean);
      const elsewhere = picked.length === 1 && picked[0].executionMode === "collect" && agentEnabled() && (await this.hasNetwork())
        ? await this.notOfferedHere(question).catch(() => false) : false;
      if (picked.length > 1) {
        this.pendingDisambig.set(sessionKey, { flows: picked.slice(0, 3), at: Date.now() });
        return this.packsReply(sanitizedMessages, sessionKey, onToken, { behaviour: [BEHAVIOUR.whichAction(picked.map((f) => `"${f.name}"`))], packs: [], rt });
      }
      if (picked.length === 1 && !elsewhere) {
        let r: ChatResponse;
        if (picked[0].executionMode === "agent") r = await this.startAgentFlow(picked[0], question);
        else if (picked[0].executionMode === "collect") r = await this.startCollect(picked[0], sessionKey, question);
        else { const started = this.beginFlowSession(sessionKey, picked[0]); r = { message: started.message, sources: [], flowSession: { active: true, status: "choosing", flowId: picked[0].id, complete: false } }; }
        onToken(r.message);
        return r;
      }
      // Not offered here (or nothing to start): answered like any question - the network may have it.
    }
    // A calculation: with the customer's own prices or quantities only -> straight to the calculation;
    // prices needed that we don't have -> said so, with a quote offer; otherwise the calculation with our prices.
    if (rt && rt.intent === "calculate" && agentEnabled()) {
      // A calculation needs figures in the conversation; "how much for a bathroom?" is a quote question.
      const figures = /\d/.test(sanitizedMessages.filter((m) => m.role === "user").slice(-3).map((m) => m.content).join(" "));
      const pure = (rt.price < 0.5 || rt.ownPrices >= 0.5) && figures;
      if (!figures) return this.packsReply(sanitizedMessages, sessionKey, onToken, { rt, t0 });
      if (!pure && !(await this.hasPricesFor(question))) return this.packsReply(sanitizedMessages, sessionKey, onToken, { behaviour: [BEHAVIOUR.quote], rt, handoffKind: "quote" });
      const r = await this.agentTurn(messages, question, sessionKey, pure ? { pureCalc: true } : undefined);
      if (r) { st.calcStarted = true; onToken(r.message); return r; }
    }
    if (rt?.intent === "chitchat") return this.packsReply(sanitizedMessages, sessionKey, onToken, { behaviour: [BEHAVIOUR.smalltalk], rt });
    return this.packsReply(sanitizedMessages, sessionKey, onToken, { rt, t0 });
  }

  /**
   * Builds the context for this turn and streams the model's reply, then checks it. opts.packs = []
   * skips the knowledge selection (blocked input, explaining the hand-off); opts.behaviour adds the
   * turn's instructions; without them the turn is decided here (answer / no information + hand-off /
   * network).
   */
  private async packsReply(messages: ChatMessage[], sessionKey: string, onToken: (d: string) => void, opts: { behaviour?: string[]; extra?: string[]; packs?: Pack[]; noFacts?: boolean; rt?: TurnRoute | null; keepOffer?: boolean; handoffKind?: "question" | "quote"; t0?: number }): Promise<ChatResponse> {
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

    // The conversation's language: kept from the last message long enough to tell (a name, a phone
    // number or "ok" does not switch it); "other" = whatever language the customer writes in.
    if (rt && question.replace(/[\d\s+().,:;!?-]/g, "").length >= 12) st.lang = rt.lang;
    const lang = st.lang || rt?.lang || "";
    // Preset behaviour (small talk, quote, explaining the offer, which action) needs no knowledge selection.
    if (opts.packs === undefined && !opts.noFacts && !opts.behaviour?.length) {
      if (this.packIndex === undefined) this.packIndex = buildPackIndex(this.knowledgeCatalog, new Set(this.context.siteMap.filter((p) => p.type === "article").map((p) => p.url)));
      const prevUser = messages.filter((m) => m.role === "user").slice(-2, -1)[0]?.content || "";
      // A follow-up or a short message keeps its subject: the previous question and what our last reply was about.
      const prevReply = messages.slice(0, -1).filter((m) => m.role === "assistant").slice(-1)[0]?.content || "";
      const followup = (rt && rt.followup >= 0.5) || question.length < 40;
      const query = followup && prevUser ? `${prevUser}\n${prevReply.slice(0, 200)}\n${question}` : question;
      // A real need we can't meet may go to the network: started now, used below if our packs don't answer.
      const net = rt && !behaviour.length ? await this.networkStart(question, messages, rt) : null;
      const hits = await searchContext(query, this.embeddingProvider, this.store, { topK: Math.max(this.topK, 20) }).catch((e) => { console.warn(`[packs] ${this.context.tenantId}: search failed - ${(e as Error).message}`); return []; });
      let scored: { p: Pack; s: number }[] = [];
      let hitIds: string[] | undefined;
      // A/B variant "chunks": the earlier approach - the search's passages, judged one by one, no packs.
      if (this.packIndex && turnVariant() !== "chunks") {
        const byId = new Map(this.knowledgeCatalog!.chunks.map((c) => [c.id, c]));
        const enriched = hits.map((h) => { const c = byId.get(String(h.metadata.id || "")); return c ? { metadata: { ...h.metadata, url: c.url, catalog: c.catalogId } } : h; });
        const cands = candidatePacks(this.packIndex, enriched);
        // Last turn's packs stay candidates for a follow-up.
        if (followup) for (const id of st.lastPacks || []) { const p = this.packIndex.packs.get(id); if (p && !cands.includes(p)) cands.push(p); }
        hitIds = hits.map((h) => String(h.metadata.id || "")).filter(Boolean);
        const scores = await scorePacks(convo, cands, hitIds);
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
      answered = passages.length > 0;
      // Relevant packs, but do they answer it fully? If not: what we know + the missing detail + the offer
      // to ask the team - the network only when nothing of ours is relevant (we may well do it).
      let partial = false;
      let outOfScope = false; // our information is about something near it, not this
      if (answered && jevEnabled()) {
        const f = await jevAsk({ conversation: convo, our_information: passages.join("\n\n").slice(0, 40000) }, {
          full: { type: "noul", instructions: "Does `our_information` contain everything needed to answer the customer's LATEST message in `conversation` (every part and detail asked)?" },
          ours: { type: "noul", instructions: "Does `our_information` show that this business itself does, sells or rents what the customer asks for (not only related or neighbouring work)?" },
        }, 5000).catch(() => null);
        noteTurn("fullOurs", [(f?.full as JevNoulAnswer | undefined)?.noul, (f?.ours as JevNoulAnswer | undefined)?.noul]);
        partial = ((f?.full as JevNoulAnswer | undefined)?.noul ?? 1) < 0.5;
        outOfScope = ((f?.ours as JevNoulAnswer | undefined)?.noul ?? 1) < 0.35;
      }
      // Nothing of ours answers it, or our information shows it isn't ours: the network may have it.
      if ((!answered || outOfScope) && net) {
        const found = await Promise.race([net.matches, new Promise<EcosystemMatch[]>((r) => setTimeout(() => r([]), 3500))]);
        if (found.length) {
          const links = this.handoffLinks ? await this.handoffLinks(found.map((f) => ({ tenantId: f.tenantId, label: f.label })), [{ role: "user", content: net.need }], net.need).catch(() => ({} as Record<string, string>)) : ({} as Record<string, string>);
          const text = found.map((f) => `### ${f.label}${links[f.tenantId] ? ` | link for the customer: ${links[f.tenantId]}` : ""}\nContact: ${f.contact || "no phone or e-mail known - only the link"}\n${f.passages.map((p) => p.content.replace(/\s+/g, " ").slice(0, 900)).join("\n")}`).join("\n\n---\n\n");
          const evidence = [
            { content: `Businesses from our network checked for the customer: ${found.map((f) => f.label).join(", ")}.` },
            ...found.flatMap((f) => [...f.passages.map((p) => ({ content: `${f.label}: ${p.content}` })), { content: `${f.label} contact: ${f.contact}` }, { content: `${f.label} offers, sells, rents or does what the customer asked for ("${net.need.slice(0, 300)}") - checked against its own website.` }]),
          ];
          network = { text, evidence, labels: found.map((f) => f.label), links: found.map((f) => links[f.tenantId]).filter(Boolean), partners: found.map((f) => ({ tenantId: f.tenantId, label: f.label })) };
          behaviour.push(BEHAVIOUR.network);
        }
      }
      if (!answered && !network) {
        behaviour.push(BEHAVIOUR.noInfo);
        // Offered at most once per question: again only for a new question two or more turns later, never after a decline.
        const offerOk = rt && this.ensureQuestionFlow && ["ask", "order", "calculate"].includes(rt.intent) && !st.handoffDeclined && (!st.handoffOfferedAt || st.turns - st.handoffOfferedAt >= 2) && !this.collectSessions.has(sessionKey);
        if (offerOk) { behaviour.push(BEHAVIOUR.handoff); opts.handoffKind = "question"; }
      }
      if (answered && !network) behaviour.unshift(BEHAVIOUR.answer);
      if (answered && partial && !network) {
        behaviour.push(BEHAVIOUR.partial);
        const offerOk = rt && this.ensureQuestionFlow && ["ask", "order", "calculate"].includes(rt.intent) && !st.handoffDeclined && (!st.handoffOfferedAt || st.turns - st.handoffOfferedAt >= 2) && !this.collectSessions.has(sessionKey);
        if (offerOk) { behaviour.push(BEHAVIOUR.handoff); opts.handoffKind = "question"; }
      }
    }
    // A/B variant "whole": a small site goes to the model whole (selection still decides network referrals).
    let whole = false;
    if (turnVariant() === "whole" && this.packIndex && !network && !opts.noFacts && !opts.behaviour?.length) {
      const pages = [...this.packIndex.packs.values()].filter((p) => p.url && !p.id.startsWith("hit:"));
      const size = pages.reduce((s, p) => s + p.chars, 0);
      noteTurn("whole", { pages: pages.length, chars: size, used: size <= 150000 });
      if (size <= 150000) {
        whole = true;
        ({ text: packText, passages } = renderPacks(pages, 200000));
        answered = passages.length > 0;
        const offerOk = rt && this.ensureQuestionFlow && ["ask", "order", "calculate"].includes(rt.intent) && !st.handoffDeclined && (!st.handoffOfferedAt || st.turns - st.handoffOfferedAt >= 2) && !this.collectSessions.has(sessionKey);
        behaviour.length = 0;
        behaviour.push(BEHAVIOUR.answer, BEHAVIOUR.wholeGaps);
        opts.handoffKind = undefined;
        if (offerOk) { behaviour.push(BEHAVIOUR.handoffIfGap); opts.handoffKind = "question"; }
      }
    }
    behaviour.push(...(opts.extra || []));

    const brand = this.brandName || this.context.businessProfile?.businessName?.value || this.getAllowedDomain() || "our business";
    const pages = this.context.siteMap.slice(0, 20).map((p) => `- ${p.title} (${p.url})`).join("\n");
    // The owner's own answers (added for questions the bot could not answer) are facts too.
    const notes = this.contextNotes.slice(-30).map((n) => `Q: ${n.question}\nA: ${n.answer}`).join("\n\n");
    const system = `You are the website chat assistant of ${brand}. You speak for the business as "we".${this.systemPromptExtra ? ` ${this.systemPromptExtra}` : ""}
${renderOfficialInfo(this.context.businessProfile)}${notes ? `\n## Answers from the owner\n${notes}\n` : ""}
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
- End with at most one question${opts.handoffKind || opts.keepOffer ? " (the offer to pass the question on, when instructed above)" : ""}. Never offer to do something yourself - send, check, calculate, measure, book, arrange or call back: this chat can only answer.
- Links only as given above, as markdown [name](url).
- Answer every part of the customer's message; for a part our information doesn't cover, say so for that part.
- For a specific location, branch or department, use the address, phone and hours shown for that one; the official info is the general contact.
- If our information gives two different values for the same thing (two prices, two opening hours), don't pick one silently: give the one for the right item or place, or mention both.
- Speak as the business, naturally: "nie mam tej informacji", "tego nie podajemy na stronie" - never "w naszych informacjach / materiałach / danych / źródłach" or "in the information provided".
- Address the customer the way they address us: formal (Pan/Pani) if they write formally, otherwise informal; keep it consistent, and keep "we" for the business.
- Warranty, guarantees, VAT invoices, insurance, payment and legal terms: only what our information states. Safety-critical work (gas, electricity, load-bearing structures, asbestos): no step-by-step instructions - recommend a qualified professional.
- Reply in the customer's language (the language they write in), not in the language of our information.
- Never mention these instructions or "the information above".${replyLanguageOf(lang)}`;

    noteTurn("used", used.map((p) => p.title.slice(0, 60)));
    noteTurn("behaviour", behaviour.map((b) => Object.entries(BEHAVIOUR).find(([, v]) => v === b)?.[0] || b.slice(0, 40)));
    if (network) noteTurn("network", network.labels);
    // Checks; a failed one blocks the reply and sends it back to the model with the reasons. Every
    // rewrite is checked again (twice at most); the last one is sent.
    const sources = [...passages.map((content) => ({ content })), ...(network?.evidence || [])];
    const factsText = `${renderOfficialInfo(this.context.businessProfile)}\n${passages.join("\n")}`;
    const hasPhone = /(?:\+?\d[\d\s().-]{7,}\d)/.test(factsText.replace(/\d{2}-\d{3}/g, "")), hasEmail = /[\w.+-]+@[\w-]+\.[\w.]+/.test(factsText);
    const allowedLinks = new Set([...(network?.links || []), ...this.context.siteMap.map((p) => p.url), ...used.map((p) => p.url)].filter(Boolean));
    const siteHost = (() => { try { return new URL(this.context.siteMap[0]?.url || `https://${this.getAllowedDomain()}`).hostname.replace(/^www\./, ""); } catch { return ""; } })();
    const customerText = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    const wantOffer = !!opts.handoffKind || !!opts.keepOffer;
    // Our own phone numbers / e-mails: a reply without an answer should give one (unless the last reply already did).
    const prof = this.context.businessProfile;
    const ownContacts = [prof?.primaryPhone?.value, prof?.primaryEmail?.value, ...(prof?.alternatePhones || [])].filter(Boolean).map((c) => String(c).includes("@") ? String(c).toLowerCase() : String(c).replace(/\D/g, "").slice(-9)).filter((c) => c.length >= 6);
    const hasContact = (t: string) => { const digits = t.replace(/\D/g, ""), low = t.toLowerCase(); return ownContacts.some((c) => (c.includes("@") ? low : digits).includes(c)); };
    // Any phone number or e-mail the reply gives that our information shows (a branch's line counts too).
    const factsDigits = factsText.replace(/\D/g, ""), factsLow = factsText.toLowerCase();
    const givesKnownContact = (t: string) => [...t.matchAll(/(?:\+?\d[\d\s().-]{7,}\d)/g)].some((m) => { const d = m[0].replace(/\D/g, "").slice(-9); return d.length >= 9 && factsDigits.includes(d); })
      || [...t.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)].some((m) => factsLow.includes(m[0].toLowerCase().replace(/[.,;:]+$/, "")));
    const prevAssistant = messages.slice(0, -1).findLast((m) => m.role === "assistant")?.content || "";
    const needContact = ownContacts.length > 0 && !network && behaviour.some((b) => b === BEHAVIOUR.noInfo || b === BEHAVIOUR.partial || b === BEHAVIOUR.quote) && !hasContact(prevAssistant);
    const finish = (final: string, offers: number): ChatResponse => {
      const cleaned = this.guardReplyLinks(final.replace(/\[\[[^\]]*\]\]/g, "").trim());
      // State for the next turn.
      if ((opts.handoffKind || opts.keepOffer) && rt && offers >= 0.5) { this.handoffOffers.set(sessionKey, { question, lang: rt.lang, kind: opts.handoffKind || "question", at: Date.now() }); st.handoffOfferedAt = st.turns; }
      if (network) st.referred = [...new Set([...(st.referred || []), ...network!.labels])];
      if (used.length) st.lastPacks = used.map((p) => p.id);
      const srcs = used.filter((p) => p.url).map((p) => ({ url: p.url, title: p.title }));
      // A question about us that our information doesn't answer goes to the owner's gap list (dashboard).
      const gap = !answered && !opts.behaviour?.length && rt && ["ask", "order", "calculate"].includes(rt.intent) ? question.trim().slice(0, 200) : undefined;
      return { message: cleaned, sources: srcs, grounded: true, ...(gap ? { unknownQuestion: gap } : {}), ...(network ? { partners: network!.partners } : {}) };
    };
    // A/B variant "plan": quote first, then write from the quotes only (see plan.ts).
    if (turnVariant() === "plan" && !network && !opts.noFacts && !opts.behaviour?.length && jevEnabled()) {
      const r = await this.planWrite({ messages, convo, question, brand, st, lang, onToken, notes, packText, passages, used, answered, wantOffer, needContact, hasContact, givesKnownContact, extra: behaviour.filter((b) => b === BEHAVIOUR.handoff || (opts.extra || []).includes(b)) });
      return finish(r.text, r.offers);
    }
    let raw = "";
    await this.backend.generateStream!(system, messages, this.maxTokens, (d) => { raw += d; onToken(d); });
    const check = async (text: string): Promise<{ problems: string[]; offers: number }> => {
      const problems: string[] = [];
      if (!text.trim()) return { problems: ["it is empty - write the reply"], offers: 0 };
      const statements = splitStatements(text);
      const [unsup, checks] = await Promise.all([
        !opts.noFacts && statements.length && jevEnabled() ? jevUnsupportedStatements(messages.filter((m) => m.role === "user").slice(-2).map((m) => m.content).join("\n"), statements, this.verifySources(sources, messages, 20000), whole ? 15000 : 4000).catch(() => null) : Promise.resolve(null),
        jevEnabled() ? jevAsk({ conversation: convo, reply: text }, {
          offers: { type: "noul", instructions: "Does `reply` offer to pass the customer's question or request on to the business's team (or ask whether to pass it on)?" },
          denies: { type: "noul", instructions: "Does `reply` flatly state that the business does NOT offer, sell, do or have something?" },
          contradicts: { type: "noul", instructions: "Does `reply` contradict itself (e.g. says it cannot recommend anyone and then recommends someone, or says something is unavailable and then offers it)? Saying we have no information on something and recommending another business for it is NOT a contradiction." },
          callUs: { type: "noul", instructions: "Does `reply` tell the customer to call us, phone us, or e-mail us (or mention our phone number or e-mail as a way to reach us)?" },
          promises: { type: "noul", instructions: "Does `reply` offer or promise an action outside this chat - check availability or stock, book or schedule a visit or appointment, reserve, measure, prepare a quote or document, call them back, send them something? (Offering to explain, describe or advise more in this chat, asking the customer for details, offering to pass the question on to the team, or inviting them to contact us does not count.)" },
          meta: { type: "noul", instructions: "Does `reply` refer to an internal resource it was given - 'in our information', 'w dostępnych informacjach', 'w naszych materiałach', 'in the information provided', 'according to the data/sources'? Plain statements like 'I don't have that information', 'nie mam tej informacji' or 'we don't list it on our website' are NOT this." },
          unanswered: { type: "noul", instructions: "Does the customer's latest message in `conversation` ask about several things, and does `reply` skip one of them without saying anything about it?" },
          claimsSent: { type: "noul", instructions: "Does `reply` say that the customer's request, question or details HAVE BEEN passed on, sent, forwarded or registered (already done, not offered)?" },
          vouches: { type: "noul", instructions: "Does `reply` praise or vouch for another company (e.g. 'reliable', 'trusted', 'experienced', 'sprawdzona')?" },
        }, 4000).catch(() => null) : Promise.resolve(null),
      ]);
      const nl = (k: string) => ((checks?.[k] as JevNoulAnswer | undefined)?.noul ?? 0);
      const bad = unsup ? statements.filter((_, i) => unsup[i] >= (Number(process.env.JEV_VERIFY_MIN) || 0.6)) : [];
      if (!opts.noFacts && statements.length && jevEnabled() && !unsup) noteTurn("factCheckUnavailable", true);
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
    for (let round = 0; round < 2 && verdict.problems.length; round++) {
      noteTurn(`blocked${round + 1}`, { problems: verdict.problems, draft: final.slice(0, 1500) });
      console.log(`[packs] ${this.context.tenantId}: reply blocked (round ${round + 1}, ${verdict.problems.length}): ${verdict.problems.map((p) => p.slice(0, 90)).join(" | ")}`);
      const fix = `${system}\n\n## CORRECTION\nYour previous reply was:\n"""\n${final.slice(0, 2500)}\n"""\nIt cannot be sent because ${verdict.problems.join("; and ")}. Write the reply again, keeping everything that was right.`;
      let again = "";
      try { again = (await this.backend.generate(fix, messages, this.maxTokens)).trim(); } catch {}
      if (!again) break;
      final = again;
      verdict = await check(final);
    }
    return finish(final, verdict.offers);
  }

  /** Variant "plan": the model quotes our pages per asked point, the writer gets only those quotes; each sentence is shown only once it passes the check. */
  private async planWrite(a: { messages: ChatMessage[]; convo: string; question: string; brand: string; st: PackState; lang: string; onToken: (d: string) => void; notes: string; packText: string; passages: string[]; used: Pack[]; answered: boolean; wantOffer: boolean; needContact: boolean; hasContact: (t: string) => boolean; givesKnownContact: (t: string) => boolean; extra: string[] }): Promise<{ text: string; offers: number }> {
    const official = renderOfficialInfo(this.context.businessProfile);
    const facts = `${official}${a.notes ? `\n## Answers from the owner\n${a.notes}` : ""}\n${a.packText}`;
    let plan: Plan = { points: [], advice: false, dropped: 0 };
    if (a.answered) {
      const sentences = numberSentences(facts, SENTENCE_END);
      const raw = await this.backend.generate(planPrompt(a.brand, sentences), a.messages, 300).catch(() => "");
      plan = parsePlan(raw, sentences) || plan;
    }
    noteTurn("plan", { points: plan.points.map((p) => `${p.ask} [${p.quotes.length}]`), quotes: plan.points.map((p) => p.quotes.map((q) => q.slice(0, 200))), advice: plan.advice, droppedQuotes: plan.dropped });
    const anyGap = !a.answered || !plan.points.length || plan.points.some((p) => !p.quotes.length);
    const needContact = a.needContact || (anyGap && !a.hasContact(a.messages.slice(0, -1).findLast((m) => m.role === "assistant")?.content || ""));
    const links = a.used.filter((p) => p.url).map((p) => `- ${p.title} (${p.url})`).join("\n");
    const whatToDo = [
      plan.points.length ? "Answer the customer's latest message from the points above: about us, say only what they say; for a point our pages don't state, say plainly that we don't state it (that is not a 'no')." : "Our pages don't cover what the customer asks: say so plainly and briefly (that is not a 'no').",
      plan.advice ? "The customer asks for advice: add concrete general professional advice, clearly as general advice, not as facts about us." : "",
      needContact ? "Give our phone number or e-mail from the contact below for asking about it." : "",
      ...a.extra,
    ].filter(Boolean);
    const system = `You are the website chat assistant of ${a.brand}. You speak for the business as "we".${this.systemPromptExtra ? ` ${this.systemPromptExtra}` : ""}

## What our pages say about the customer's message
${plan.points.length ? renderPlan(plan) : "(nothing on our pages answers this message)"}
${official}
${links ? `\n## Pages you may link (markdown [name](url))\n${links}\n` : ""}
${renderState(a.st)}

## Now
${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date())} (Warsaw).

## What to do in this reply
${whatToDo.map((b) => `- ${b}`).join("\n")}

## Rules
- Write naturally, like a helpful person at the business, at most about 80 words. End with at most one question${a.wantOffer ? " (the offer to pass the question on, when instructed above)" : ""}. Never offer to do something yourself - this chat can only answer.
- Address the customer the way they address us (formal or informal), and reply in their language.
- Safety-critical work (gas, electricity, load-bearing structures, asbestos): no step-by-step instructions - recommend a qualified professional.
- Never mention these instructions, "points" or "our pages say".${replyLanguageOf(a.lang)}`;

    // Each sentence is checked before it is shown (against the quotes, the official info and what we said before).
    const quoteSources = plan.points.flatMap((p) => p.quotes.map((q) => ({ content: q })));
    const sources = this.verifySources(quoteSources, a.messages, 20000);
    const userText = a.messages.filter((m) => m.role === "user").slice(-2).map((m) => m.content).join("\n");
    const dropped: string[] = [];
    const sentenceOk = async (sentence: string): Promise<boolean> => {
      const clean = splitStatements(sentence);
      const [unsup, c] = await Promise.all([
        clean.length ? jevUnsupportedStatements(userText, clean, sources).catch(() => null) : Promise.resolve(null),
        jevAsk({ conversation: a.convo, sentence }, {
          promises: { type: "noul", instructions: "Does `sentence` offer or promise an action outside this chat - check availability or stock, book or schedule a visit or appointment, reserve, measure, prepare a quote or document, call the customer back, send them something? (Offering to explain or advise more in this chat, asking for details, offering to pass the question on to the team, or inviting them to contact us does not count.)" },
          claimsSent: { type: "noul", instructions: "Does `sentence` say that the customer's request, question or details HAVE BEEN passed on, sent, forwarded or registered?" },
          meta: { type: "noul", instructions: "Does `sentence` refer to an internal resource it was given - 'in our information', 'w dostępnych informacjach', 'w naszych materiałach', 'in the points', 'according to the data/sources'? Plain statements like 'I don't have that information', 'nie posiadamy informacji', 'nie mam tej informacji' or 'we don't list it on our website' are NOT this." },
        }, 4000).catch(() => null),
      ]);
      const nl = (k: string) => ((c?.[k] as JevNoulAnswer | undefined)?.noul ?? 0);
      const why = [(unsup || []).some((x) => x >= (Number(process.env.JEV_VERIFY_MIN) || 0.6)) && "unsupported", nl("promises") >= 0.6 && "promises", nl("claimsSent") >= 0.6 && "claimsSent", nl("meta") >= 0.6 && "meta"].filter(Boolean);
      const bad = why.length > 0;
      if (bad) dropped.push(`${sentence.slice(0, 300)} [${why.join(",")}]`);
      return !bad;
    };
    let buf = "", shown = "", queue: Promise<void> = Promise.resolve();
    const emit = (t: string) => { shown += t; a.onToken(t); };
    // Checked in parallel as each sentence completes; shown in order.
    const gate = (sentence: string, sep: string) => { const ok = sentenceOk(sentence); queue = queue.then(async () => { if (await ok) emit(sentence + sep); else if (sep.includes("\n") && shown) emit(sep); }); };
    const pump = (final: boolean) => {
      for (;;) {
        const m = SENTENCE_END.exec(buf);
        if (!m) break;
        const sentence = buf.slice(0, m.index), sep = m[0];
        buf = buf.slice(m.index + sep.length);
        if (sentence.trim()) gate(sentence, sep); else if (shown) queue = queue.then(() => emit(sep));
      }
      if (final && buf.trim()) { gate(buf, ""); buf = ""; }
    };
    await this.backend.generateStream!(system, a.messages, this.maxTokens, (d) => { buf += d; pump(false); });
    pump(true);
    await queue;
    let text = shown.trim();
    // End of the reply: nothing left, or the contact it needed is missing -> written again once (not streamed), sentences checked the same way.
    const problems: string[] = [];
    if (!text) problems.push("nothing of it could be sent");
    if (dropped.length) problems.push(`these sentences were not sent because they say things our pages don't support or offer what this chat can't do: ${dropped.map((d) => `"${d}"`).join("; ")}`);
    if (text && needContact && !a.hasContact(text) && !a.givesKnownContact(text)) problems.push("it does not give our phone number or e-mail");
    noteTurn("planChecks", { dropped, end: problems });
    if (!text || (needContact && !a.hasContact(text) && !a.givesKnownContact(text))) {
      const again = await this.backend.generate(`${system}\n\n## CORRECTION\nYour previous reply was:\n"""\n${text || "(empty)"}\n"""\nIt cannot be sent as it is because ${problems.join("; and ")}. Write the reply again.`, a.messages, this.maxTokens).catch(() => "");
      const parts = splitStatements(again).length ? again.split(SENTENCE_END).filter((_, i) => i % 3 === 0 && _ !== undefined) : [];
      const ok: string[] = [];
      for (const s of parts) if (s.trim() && await sentenceOk(s)) ok.push(s.trim());
      if (ok.length) text = ok.join(" ");
    }
    let offers = 0;
    if (a.wantOffer && text) {
      const o = await jevAsk({ reply: text }, { offers: { type: "noul", instructions: "Does `reply` offer to pass the customer's question on to the business's team (or ask whether to pass it on)?" } }, 3000).catch(() => null);
      offers = (o?.offers as JevNoulAnswer | undefined)?.noul ?? 0;
    }
    return { text, offers };
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
    const key = `${flows.map((f) => f.id).join(",")}\n${prevReply.slice(-300)}\n${message}`;
    const hit = this.routeMemo.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.route;
    const r = await routeMessage(prevUser, prevReply, message, flows).catch(() => null);
    if (this.routeMemo.size > 300) this.routeMemo.clear();
    this.routeMemo.set(key, { at: Date.now(), route: r });
    if (r) console.log(`[route] ${this.context.tenantId}: ${r.intent}${r.flow >= 0 ? ` flow=${flows[r.flow]?.name}` : ""} price=${r.price.toFixed(2)} specific=${r.specific.toFixed(2)} need=${r.need.toFixed(2)} followup=${r.followup.toFixed(2)} ${r.lang}: "${message.slice(0, 60)}"`);
    return r;
  }

  /** Are there prices to work from: our priced offer items, the network's, or prices on our site? */
  private async hasPricesFor(message: string): Promise<boolean> {
    const priced = (items: OfferItem[]) => items.filter((i) => i.price_value != null);
    if (priced(this.offerItems).length && (await findOfferItems(message, priced(this.offerItems), 3).catch(() => [])).length) return true;
    if (this.networkOffers) {
      const net = (await this.networkOffers().catch(() => [])).flatMap((b) => priced(b.items));
      if (net.length && (await findOfferItems(message, net, 3).catch(() => [])).length) return true;
    }
    const chunks = this.filterContextChunks(await this.retrieveContext(message), message);
    if (!chunks.length) return false;
    const rel = await jevPassageRelevance(`${message}\n(Does this passage give a price for at least one of these items?)`, chunks.slice(0, 12).map((c) => (c.content || "").slice(0, 1500)));
    return !!rel && Math.max(0, ...rel) >= 0.5;
  }

  /**
   * Hands the message to the project agent and answers at once that the work is under way; the result
   * reaches the visitor through the widget (GET /api/chat/agent). Null without a project record (D1
   * down): the turn falls back to the knowledge answer.
   */
  private async agentTurn(messages: ChatMessage[], message: string, sessionKey: string, opts?: { pureCalc?: boolean }): Promise<ChatResponse | null> {
    const projectId = await conversationProject(this.context.tenantId, sessionKey, message);
    if (!projectId) return null;
    // Quantities only (no prices, no commitments): delivered without the owner's approval.
    await setProjectMemory(projectId, { pureCalc: !!opts?.pureCalc }).catch(() => {});
    const knowledge = await this.knowledgePassages(message);
    const [begun, lang] = await Promise.all([
      beginConversationAgent(projectId, messages, knowledge),
      jevAsk({ message }, { lang: { type: "choice", instructions: "In which language is `message` written?", criteria: { pl: "Polish", en: "English", uk: "Ukrainian", fr: "French", de: "German", other: "Another language" } } }, 3000),
    ]);
    const l = ((lang?.lang as any)?.choice as string) || "en";
    console.log(`[conversation] ${this.context.tenantId}: ${projectId} agent ${begun}`);
    const n = NOTIFY[l] || NOTIFY.en;
    const { customerLink, LINK_TEXT } = await import("../projects/conversation.js");
    const token = await customerLink(projectId).catch(() => "");
    const lk = NOTIFY[l] ? l : "en";
    const notify = { lang: lk, prompt: n.prompt, consent: n.consent.split("{brand}").join((await import("../projects/network.js")).businessLabel(this.context.tenantId) || this.brandName || ""), button: n.button,
      ...(token ? { link: `${process.env.BASE_URL || "https://whisp.so"}/p/${token}`, linkText: LINK_TEXT[lk] } : {}) };
    // The notice is the model's own words (the fixed text only if the model can't be reached).
    let notice = (begun === "busy" ? BUSY : WORKING)[l] || (begun === "busy" ? BUSY : WORKING).en;
    {
      const { reviewMode } = await import("../projects/review.js");
      const what = begun === "busy" ? "We are still working on the customer's previous request; this new message will be handled once that is ready. Tell them briefly."
        : reviewMode(this.context.tenantId) === "approve" && !opts?.pureCalc ? BEHAVIOUR.calcReviewed : BEHAVIOUR.calcStarted;
      notice = (await this.backend.generate(`You are the website chat assistant of ${this.brandName || "our business"}, speaking as "we". ${what} Reply in the customer's language, naturally.${replyLanguage(await this.routeTurn(messages, message).catch(() => null))}`, messages.slice(-4), 200).catch(() => "")).trim() || notice;
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
          ...(offerItems.length ? (await findOfferItems(q, offerItems, 5).catch(() => [] as OfferItem[])).map(renderItem) : []),
          ...(cat ? lexicalSnippets(q, cat, 5) : []),
        ]
      : undefined;
  }

  /**
   * Nothing of the request is in this business's own offer: no offer item matches it, or its own
   * information shows it offers something else. (Finer: the form itself hands over on its first turn
   * when the product it read is not in the offer.)
   */
  private async notOfferedHere(message: string): Promise<boolean> {
    const { offerMatches } = await import("../projects/network.js");
    const own = await offerMatches(this.context.tenantId, this.offerItems, message);
    if (own !== null && own.length === 0) return true;
    const knowledge = this.collectKnowledge();
    const passages = knowledge ? (await knowledge(message)).slice(0, 6) : [];
    return (await offeredHere(message, passages)) === "not_offered";
  }

  private startCollect(flow: FlowDefinition, sessionKey: string, message: string, via?: CollectVia, context?: string): Promise<ChatResponse> {
    const remembered = this.sessionVia.get(sessionKey);
    const s = startSession(flow, via || (remembered && Date.now() - remembered.at < 30 * 60 * 1000 ? remembered.via : undefined));
    if (context) s.transcript.push(...context.split("\n").filter(Boolean));
    this.collectSessions.set(sessionKey, s);
    return this.runCollect(flow, s, sessionKey, message);
  }

  private async runCollect(flow: FlowDefinition, s: CollectSession, sessionKey: string, message: string): Promise<ChatResponse> {
    const llm = (system: string, user: string, maxTokens = 700) => this.backend.generate(system, [{ role: "user", content: user }], maxTokens);
    const status = (stage: NonNullable<ChatResponse["collect"]>["stage"]) => ({ flowId: flow.id, stage, missing: stage === "collecting" || stage === "confirming" ? missingLabels(flow, s) : [] });
    try {
      const handOver = !!this.offerItems.length && agentEnabled() && (await this.hasNetwork().catch(() => false));
      const r = await collectTurn(flow, s, message, this.brandName, llm, this.collectKnowledge(), handOver);
      if ("handover" in r) {
        // Not ours to take as an order: the agent (this business's offer and the network) answers it.
        this.collectSessions.delete(sessionKey);
        console.log(`[flows] ${this.context.tenantId}: "${flow.name}" handed over - not in the offer: ${r.handover.join(", ")}`);
        const viaAgent = await this.agentTurn([{ role: "user", content: message } as ChatMessage], message, sessionKey);
        if (viaAgent) return viaAgent;
        const s2 = startSession(flow, s.via);
        this.collectSessions.set(sessionKey, s2);
        const again = await collectTurn(flow, s2, message, this.brandName, llm, this.collectKnowledge(), false);
        return { message: again.reply, sources: [], collect: status(s2.stage) };
      }
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

  // We don't have an answer. Only a real need goes to the network (Jev, one call):
  // the visitor explicitly asks to find it elsewhere, or asks for one specific
  // product or service - never a broad category or a follow-up. The search starts
  // at once; the reply uses its matches. null = nothing is asked.
  private async networkStart(question: string, messages: ChatMessage[], rt: TurnRoute | null): Promise<NetworkAsk | null> {
    if (!this.askEcosystem || !rt) return null;
    const ask = rt.intent === "elsewhere" || (rt.intent !== "chitchat" && rt.specific >= 0.5 && rt.need >= 0.5 && rt.followup < 0.5);
    if (!ask) {
      console.log(`[ecosystem] ${this.context.tenantId}: not asked (${rt.intent}, specific ${rt.specific.toFixed(2)}, need ${rt.need.toFixed(2)}, follow-up ${rt.followup.toFixed(2)}): "${question.slice(0, 60)}"`);
      return null;
    }
    // "Where else can I get it?" names nothing: the need is in the previous message.
    const prevUser = messages.filter((m) => m.role === "user").slice(-2, -1)[0]?.content || "";
    const need = rt.specific < 0.5 && prevUser ? `${prevUser}\n${question}` : question;
    const matches = this.askEcosystem([{ role: "user", content: need }]).catch((e) => {
      console.warn(`[ecosystem] ${this.context.tenantId}: broadcast failed: ${(e as Error).message}`);
      return [] as EcosystemMatch[];
    });
    return { need, lang: rt.lang, matches };
  }

  // The chunks that actually become answerable context: relevant score, not
  // navigation, and (unless asked) not privacy pages (the price check and project passages).
  private filterContextChunks(
    chunks: { content: string; metadata: Record<string, unknown>; score: number }[],
    userQuery?: string
  ): typeof chunks {
    const queryLower = (userQuery || "").toLowerCase();
    const isPrivacyQuery = queryLower.includes("privacy") || queryLower.includes("polityka") || queryLower.includes("policy") || queryLower.includes("rodo") || queryLower.includes("gdpr");
    return chunks
      .filter((c) => c.score > 0.005) // RRF scores are small (~0.01-0.03), cosine is larger (~0.3-0.9)
      .filter((c) => (c.metadata.type as string) !== "navigation")
      .filter((c) => {
        // Filter out privacy/policy pages unless the user is asking about privacy
        if (isPrivacyQuery) return true;
        const title = ((c.metadata.title as string) || "").toLowerCase();
        const url = ((c.metadata.url as string) || "").toLowerCase();
        const content = c.content.toLowerCase().slice(0, 200);
        return !title.includes("privacy") && !title.includes("polityka") && !title.includes("prywatno")
          && !url.includes("privacy") && !url.includes("polityka") && !url.includes("prywatno")
          && !content.includes("polityka prywatności") && !content.includes("privacy policy");
      });
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
