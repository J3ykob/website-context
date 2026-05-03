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

export interface WebsiteContext {
  tenantId: string;
  version: number;
  lastUpdated: string;
  siteMap: SiteMapEntry[];
  pages: PageContext[];
  flows: FlowDefinition[];
  chunks: ContentChunk[];
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
  metadata: ChunkMetadata;
  embedding?: number[];
}

export interface ChunkMetadata {
  url: string;
  title: string;
  headingHierarchy: string[];
  type: "content" | "faq" | "product" | "form-description" | "navigation";
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
