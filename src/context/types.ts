export interface TenantConfig {
  id: string;
  name: string;
  domain: string;
  createdAt: string;
  updatedAt: string;
  settings: WidgetSettings;
  scrapeConfig: ScrapeConfig;
}

export interface WidgetSettings {
  primaryColor: string;
  position: "bottom-right" | "bottom-left";
  greeting: string;
  placeholder: string;
  brandName: string;
  brandLogo?: string;
}

export interface ScrapeConfig {
  maxPages: number;
  maxDepth: number;
  rateLimit: number;
  excludePatterns: string[];
  includePatterns: string[];
  schedule?: string; // cron expression for re-scraping
}

// A single canonical business fact carrying its own provenance, so the injector can
// decide whether to assert it. Phones/emails are only ever produced from TYPED sources
// (JSON-LD / tel:/mailto: links) — never regex-scraped from prose — which is what
// turned a car price into "899000.00". Absence is a first-class state: a missing field
// means "no trustworthy source found", and the bot then says it doesn't have it rather
// than guessing.
export interface BusinessFact<T = string> {
  value: T;
  source: "json-ld" | "microdata" | "tel-mailto" | "footer" | "contact-page";
  confidence: "high" | "medium";
  sourceUrl: string;
}

// The authoritative "Official Business Info" profile: small, always-loaded (lives in
// context-meta.json, NOT the vector store), and always injected into the chat prompt so
// "what's your main phone/email/address/hours?" is answered from here instead of losing
// to testimonial/listing chunks in retrieval. One mechanism for ALL primary facts.
export interface OfficialBusinessInfo {
  businessName?: BusinessFact;
  primaryPhone?: BusinessFact;
  primaryEmail?: BusinessFact;
  primaryAddress?: BusinessFact;
  openingHours?: BusinessFact;
  // Real contacts we deliberately did NOT promote to primary (specific agents/departments,
  // or all candidates when genuinely ambiguous). Kept so the bot can answer "another number?"
  // and so multi-contact sites can list options instead of guessing one.
  alternatePhones?: string[];
  alternateEmails?: string[];
  extractedAt: string;
  extractionBasis: string; // human-readable provenance audit trail
}

export interface WebsiteContext {
  tenantId: string;
  version: number;
  lastUpdated: string;
  siteMap: SiteMapEntry[];
  pages: PageContext[];
  flows: FlowDefinition[];
  chunks: ContentChunk[];
  // Canonical primary business facts (always injected; see OfficialBusinessInfo).
  businessProfile?: OfficialBusinessInfo;
}

export interface SiteMapEntry {
  id: string;
  url: string;
  title: string;
  parentId?: string;
  depth: number;
  type: "page" | "section" | "form" | "product" | "article" | "faq";
}

export interface PageContext {
  id: string;
  url: string;
  title: string;
  description: string;
  lastScraped: string;
  contentHash: string;
  sections: SectionContext[];
  forms: FormContext[];
  structuredData: Record<string, unknown>[];
}

export interface SectionContext {
  id: string;
  heading: string;
  level: number;
  content: string;
  parentSectionId?: string;
}

export interface FormContext {
  id: string;
  name: string;
  description: string;
  action: string;
  method: string;
  fields: FormFieldContext[];
}

export interface FormFieldContext {
  name: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export interface ContentChunk {
  id: string;
  pageId: string;
  sectionId?: string;
  content: string;
  contextPrefix?: string; // Anthropic contextual retrieval
  metadata: ChunkMetadata;
  embedding?: number[];
}

export interface ChunkMetadata {
  url: string;
  title: string;
  headingHierarchy: string[];
  type: "content" | "faq" | "product" | "form-description" | "navigation" | "pricing";
}

export interface FlowDefinition {
  id: string;
  name: string;
  description: string;
  triggerPhrases: string[];
  steps: FlowStep[];
  requiredInputs: FlowInput[];
  createdAt: string;
  updatedAt: string;
  lastTestedAt?: string;
  status: "draft" | "active" | "disabled";
  executionMode?: "background" | "guided" | "auto";
}

export interface FlowStep {
  id: string;
  order: number;
  action: "navigate" | "click" | "type" | "select" | "wait" | "assert" | "scroll";
  target: ElementSelector;
  value?: string; // for type/select actions — can reference inputs as {{inputName}}
  description: string;
  timeout?: number;
  requiresUserAction?: boolean; // true for payment fields, CAPTCHAs, etc.
}

export interface ElementSelector {
  css?: string;
  xpath?: string;
  text?: string;
  testId?: string;
  ariaLabel?: string;
}

export interface FlowInput {
  name: string;
  label: string;
  type: "text" | "email" | "phone" | "number" | "select" | "date";
  required: boolean;
  description: string;
  validation?: string; // regex pattern
}
