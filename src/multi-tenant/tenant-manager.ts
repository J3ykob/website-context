/**
 * Tenant Manager — lazily loads and caches WebsiteChat instances per tenant.
 * Shares a single BGEEmbeddingProvider across all tenants, with per-tenant Qdrant collections.
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { BGEEmbeddingProvider } from "../embeddings/bge-provider.js";
import { QdrantVectorStore } from "../embeddings/qdrant-store.js";
import { WebsiteChat } from "../llm/chat.js";
import type { WebsiteContext, SiteMapEntry, FlowDefinition } from "../context/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(__dirname, "../../data");

interface CachedTenant {
  chat: WebsiteChat;
  lastAccess: number;
}

export class TenantManager {
  private cache = new Map<string, CachedTenant>();
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
      return cached.chat;
    }

    // Load context metadata from disk
    const metaPath = resolve(DATA_ROOT, tenantId, "context-meta.json");
    if (!existsSync(metaPath)) {
      throw new Error(`No context metadata found for tenant ${tenantId}. Has the site been scraped?`);
    }

    const metaRaw = await readFile(metaPath, "utf-8");
    const meta = JSON.parse(metaRaw) as {
      tenantId: string;
      siteUrl: string;
      siteMap: SiteMapEntry[];
      flows: FlowDefinition[];
      pages: { id: string; url: string; title: string; description: string }[];
      lastScrapedAt: string;
      pagesCount: number;
      chunksCount: number;
    };

    // Build minimal WebsiteContext (chunks are in Qdrant, not loaded into memory)
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
      flows: meta.flows || [],
      chunks: [], // Chunks are in Qdrant, not in memory
    };

    // Per-tenant Qdrant store
    const collection = `wctx_${tenantId}`;
    const store = new QdrantVectorStore({
      host: process.env.QDRANT_HOST,
      port: process.env.QDRANT_PORT ? parseInt(process.env.QDRANT_PORT) : undefined,
      collection,
      createIfMissing: false,
    });

    // Create WebsiteChat with OpenRouter
    const chat = new WebsiteChat(this.bgeProvider, store, context, {
      llmProvider: "openrouter",
      openRouter: {
        apiKey: process.env.OPENROUTER_API_KEY!,
        model: process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001",
        siteUrl: meta.siteUrl,
      },
      systemPromptExtra: `This assistant is deployed on ${new URL(meta.siteUrl).hostname}. Never reference or provide information about any other website or domain.`,
    });

    // Load context notes if they exist
    const allNotes: { question: string; answer: string }[] = [];
    const notesPath = resolve(DATA_ROOT, tenantId, "context_notes.json");
    if (existsSync(notesPath)) {
      try {
        allNotes.push(...JSON.parse(await readFile(notesPath, "utf-8")));
      } catch {}
    }
    // Load auto-extracted business info notes
    const autoNotesPath = resolve(DATA_ROOT, tenantId, "auto-context-notes.json");
    if (existsSync(autoNotesPath)) {
      try {
        allNotes.push(...JSON.parse(await readFile(autoNotesPath, "utf-8")));
      } catch {}
    }
    if (allNotes.length > 0) {
      chat.setContextNotes(allNotes.map(n => ({ ...n, addedAt: (n as any).addedAt || new Date().toISOString() })));
    }

    // Cache the instance
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
