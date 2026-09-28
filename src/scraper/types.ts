export interface ScrapedPage {
  url: string;
  title: string;
  description: string;
  content: ContentBlock[];
  metadata: PageMetadata;
  links: PageLink[];
  forms: FormElement[];
  structuredData: StructuredDataItem[];
  scrapedAt: string;
  renderMethod: "static" | "dynamic";
  // The HTML fetched during the crawl, reused by buildContext (then dropped).
  fetch?: import("./fetcher.js").FetchResult;
}

export interface ContentBlock {
  type: "heading" | "paragraph" | "list" | "table" | "code" | "image" | "blockquote";
  content: string;
  level?: number; // for headings (1-6)
  items?: string[]; // for lists
  rows?: string[][]; // for tables
  src?: string; // for images
  alt?: string; // for images
}

export interface PageMetadata {
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogType?: string;
  canonical?: string;
  language?: string;
  keywords?: string[];
  author?: string;
}

export interface PageLink {
  href: string;
  text: string;
  isInternal: boolean;
  isNavigation: boolean;
}

export interface FormElement {
  action: string;
  method: string;
  id?: string;
  name?: string;
  fields: FormField[];
}

export interface FormField {
  type: string;
  name: string;
  label?: string;
  placeholder?: string;
  required: boolean;
  options?: string[]; // for select/radio
}

export interface StructuredDataItem {
  type: string; // e.g., "Product", "Organization", "FAQPage"
  data: Record<string, unknown>;
}

export interface CrawlResult {
  baseUrl: string;
  pages: ScrapedPage[];
  siteMap: SiteMapNode;
  crawledAt: string;
  stats: CrawlStats;
}

export interface SiteMapNode {
  url: string;
  title: string;
  children: SiteMapNode[];
  depth: number;
}

export interface CrawlStats {
  totalPages: number;
  successPages: number;
  failedPages: number;
  totalTime: number;
  staticPages: number;
  dynamicPages: number;
}

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  respectRobotsTxt?: boolean;
  rateLimit?: number; // ms between requests per host
  includePatterns?: RegExp[];
  excludePatterns?: RegExp[];
  timeout?: number; // per-page timeout in ms
  userAgent?: string;
  useSitemap?: boolean; // seed the queue from robots.txt / sitemap.xml (default true)
  concurrency?: number; // pages fetched in parallel (default 6)
  // Called with each page as soon as it is extracted (with its HTML in page.fetch).
  // A consumer that processes pages here keeps memory flat: the crawl no longer
  // holds every page's HTML until the end.
  onPage?: (page: ScrapedPage) => Promise<void> | void;
}
