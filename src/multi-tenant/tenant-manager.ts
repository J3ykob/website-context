/**
 * Tenant Manager — lazily loads and caches WebsiteChat instances per tenant.
 * Shares a single BGEEmbeddingProvider across all tenants; vectors live in per-tenant
 * Cloudflare Vectorize namespaces (Qdrant has been fully retired from the serving path).
 */

import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { BGEEmbeddingProvider } from "../embeddings/bge-provider.js";
import { CloudflareVectorizeStore } from "../embeddings/vectorize-store.js";
import { WebsiteChat } from "../llm/chat.js";
import { getFlows } from "../flows/flow-store.js";
import { getTenant } from "./tenant-registry.js";
import type { WebsiteContext, SiteMapEntry, FlowDefinition, OfficialBusinessInfo } from "../context/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(__dirname, "../../data");

interface CachedTenant {
  chat: WebsiteChat;
  lastAccess: number;
}

export class TenantManager {
  // LRU cache: Map insertion order tracks recency (move-to-end on hit). Hard cap
  // bounds RAM — without it the cache grew unbounded as more of the ~800+ tenants
  // were accessed (only a 30-min idle sweep), the primary OOM cause on Render.
  private cache = new Map<string, CachedTenant>();
  private readonly maxCache = Math.max(5, parseInt(process.env.TENANT_CACHE_MAX || "50"));
  private bgeProvider: BGEEmbeddingProvider;
  private evictionInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Shared BGE provider across all tenants
    this.bgeProvider = new BGEEmbeddingProvider({
      host: process.env.BGE_HOST,
      port: process.env.BGE_PORT ? parseInt(process.env.BGE_PORT) : undefined,
    });

    // Run eviction every 5 minutes
    this.evictionInterval = setInterval(() => this.evictStale(), 5 * 60 * 1000);
  }

  /**
   * Get or create a WebsiteChat instance for a tenant.
   */
  async getChatForTenant(tenantId: string): Promise<WebsiteChat> {
    const cached = this.cache.get(tenantId);
    if (cached) {
      cached.lastAccess = Date.now();
      // LRU touch: re-insert so this tenant becomes most-recently-used (Map keeps
      // insertion order, so the first key is always the eviction candidate).
      this.cache.delete(tenantId);
      this.cache.set(tenantId, cached);
      return cached.chat;
    }

    // Load context metadata from disk or R2
    const metaPath = resolve(DATA_ROOT, tenantId, "context-meta.json");
    let metaRaw: string | null = null;
    if (existsSync(metaPath)) {
      metaRaw = await readFile(metaPath, "utf-8");
    } else {
      // Try R2
      try {
        const { downloadTenantFile } = await import("../storage/r2.js");
        console.log(`[tenant-manager] Fetching context-meta from R2 for ${tenantId}`);
        const r2Data = await downloadTenantFile(tenantId, "context-meta.json");
        if (r2Data) {
          metaRaw = r2Data.toString("utf-8");
          // Cache locally for next time
          const { mkdirSync } = await import("fs");
          const dir = resolve(DATA_ROOT, tenantId);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          await writeFile(metaPath, metaRaw);
          console.log(`[tenant-manager] Cached ${tenantId} context-meta from R2`);
        }
      } catch (r2err: any) {
        console.warn(`[tenant-manager] R2 context-meta load failed for ${tenantId}: ${r2err.message}`);
      }
    }
    // No scrape metadata — an interview / manual tenant with no website. Synthesize a
    // minimal context so the bot still runs; retrieval works off Vectorize (the KB was
    // built by the interview / manual uploads, not a crawl).
    if (!metaRaw) {
      const t = getTenant(tenantId);
      if (!t) throw new Error(`No context metadata and no tenant record for ${tenantId}`);
      const now = new Date().toISOString();
      metaRaw = JSON.stringify({
        tenantId,
        siteUrl: /^https?:/i.test(t.siteUrl) ? t.siteUrl : `https://${t.domain}`,
        siteMap: [], flows: [], pages: [],
        lastScrapedAt: now, pagesCount: 0, chunksCount: t.chunksCount, officialInfo: null,
      });
    }
    const meta = JSON.parse(metaRaw) as {
      tenantId: string;
      siteUrl: string;
      siteMap: SiteMapEntry[];
      flows: FlowDefinition[];
      pages: { id: string; url: string; title: string; description: string }[];
      lastScrapedAt: string;
      pagesCount: number;
      chunksCount: number;
      officialInfo?: OfficialBusinessInfo | null;
    };

    // Build minimal WebsiteContext (chunks live in Vectorize, not loaded into memory)
    const context: WebsiteContext = {
      tenantId: meta.tenantId,
      version: 1,
      lastUpdated: meta.lastScrapedAt,
      siteMap: meta.siteMap,
      pages: meta.pages.map((p) => ({
        id: p.id,
        url: p.url,
        title: p.title,
        description: p.description,
        lastScraped: meta.lastScrapedAt,
        contentHash: "",
        sections: [],
        forms: [],
        structuredData: [],
      })),
      // Flows come from the R2-backed flow-store (source of truth), not meta.flows
      // (which was scrape-time only) — so owner-recorded flows actually reach the bot.
      flows: await getFlows(meta.tenantId),
      chunks: [], // Chunks live in Vectorize, not in memory
      businessProfile: meta.officialInfo || undefined,
    };

    // Per-tenant vector store — Cloudflare Vectorize (the only store in production).
    const store = new CloudflareVectorizeStore({ tenantId });

    // A tenant with no pages is an interview / no-website business — give it an
    // identity from its brand name rather than the synthetic hostname.
    const brand = context.siteMap.length === 0 ? (getTenant(tenantId)?.brandName || "") : "";
    const systemPromptExtra = brand
      ? `You ARE "${brand}". This business has NO website and no separate pages — you are its ONLY channel. Always speak as ${brand} using "we/our/us". ` +
        `NEVER output a link, a URL, or a markdown link, and NEVER tell the visitor to check / see / visit "our website", "our page", "the site" or "online" (in any language) — there is none. ` +
        `Answer with the facts directly, or give the phone number. For anything that changes day to day (e.g. a daily special), say it's best to call. Only discuss this business.`
      : `This assistant is deployed on ${new URL(meta.siteUrl).hostname}. Never reference or provide information about any other website or domain.`;

    // Create WebsiteChat with OpenRouter
    const chat = new WebsiteChat(this.bgeProvider, store, context, {
      llmProvider: "openrouter",
      openRouter: {
        apiKey: process.env.OPENROUTER_API_KEY!,
        model: process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001",
        siteUrl: meta.siteUrl,
      },
      systemPromptExtra,
    });

    // Load ONLY owner-curated context notes (context_notes.json). We deliberately no
    // longer inject auto-context-notes.json — those are regex-extracted "facts" and
    // brittle extraction turned a car price into a "phone number" (899000.00), which,
    // injected as an authoritative note, made the bot confidently repeat the wrong
    // number even when the visitor corrected it. Contact / hours / address are now
    // answered from the actual retrieved chunks (real data, in context) with the
    // grounding gate for honesty — no separately-extracted facts to go stale or wrong.
    const allNotes: { question: string; answer: string }[] = [];
    const notesPath = resolve(DATA_ROOT, tenantId, "context_notes.json");
    if (existsSync(notesPath)) {
      try {
        allNotes.push(...JSON.parse(await readFile(notesPath, "utf-8")));
      } catch {}
    }
    if (allNotes.length > 0) {
      chat.setContextNotes(allNotes.map(n => ({ ...n, addedAt: (n as any).addedAt || new Date().toISOString() })));
    }

    // Cache the instance, evicting the least-recently-used while at capacity.
    while (this.cache.size >= this.maxCache) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      console.log(`[tenant-manager] LRU-evicted ${oldest} (cap ${this.maxCache})`);
    }
    this.cache.set(tenantId, { chat, lastAccess: Date.now() });

    return chat;
  }

  /**
   * Evict tenants that haven't been accessed in 30 minutes.
   */
  evictTenant(tenantId: string): void {
    this.cache.delete(tenantId);
    console.log(`[tenant-manager] Evicted tenant: ${tenantId}`);
  }

  evictStale(): void {
    const thirtyMinutes = 30 * 60 * 1000;
    const now = Date.now();

    for (const [tenantId, entry] of this.cache) {
      if (now - entry.lastAccess > thirtyMinutes) {
        this.cache.delete(tenantId);
        console.log(`[tenant-manager] Evicted stale tenant: ${tenantId}`);
      }
    }
  }

  /**
   * Stop the eviction interval (for clean shutdown).
   */
  destroy(): void {
    clearInterval(this.evictionInterval);
  }
}
