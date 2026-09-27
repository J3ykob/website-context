/**
 * Knowledge catalog: a self-growing, per-tenant directory of topical catalogs
 * ("Lokalizacje i godziny", "Cennik", "Zespół", ...) with every chunk assigned
 * to exactly one catalog. Built at scrape time, used at question time so Jev
 * judges ALL chunks of the relevant catalogs instead of only a vector top-k.
 *
 * Build (scrape time):
 *   1. Start from SEED_CATALOGS.
 *   2. Jev Choice assigns every chunk to a catalog or "other" (batched, parallel).
 *   3. The "other" chunks go to a generative LLM, which proposes new catalogs.
 *   4. Jev re-assigns the "other" chunks with the extended list. Repeat up to
 *      MAX_ROUNDS; whatever is still unassigned lands in "Inne".
 *   This is the self-growing index done in parallel rounds rather than one chunk
 *   at a time, so a 1,000-chunk catalog still builds in seconds.
 *
 * Retrieve (question time):
 *   1. Jev Noul per catalog: could it hold the answer? Keep the best few.
 *   2. Jev Noul per chunk of those catalogs: does it answer the question?
 *   3. Return chunks above threshold, best first, scored by Jev probability.
 *
 * Stored as knowledge-catalog.json next to context-meta.json (disk + R2).
 */
import { jevAsk, type JevQuestion, type JevChoiceAnswer, type JevNoulAnswer } from "../llm/jev.js";

export const CATALOG_FILE = "knowledge-catalog.json";

export interface CatalogDef { id: string; name: string; description: string }
export interface CatalogChunk {
  id: string;
  catalogId: string;
  content: string;
  url: string;
  title: string;
  type: string;
}
export interface KnowledgeCatalog {
  version: 1;
  builtAt: string;
  catalogs: CatalogDef[];
  chunks: CatalogChunk[];
}
export interface CatalogInputChunk {
  id: string;
  content: string;
  metadata: { url?: string; title?: string; type?: string };
}
/** Generative step: propose new catalogs for chunks that fit none of `existing`. */
export type CatalogNamer = (unassigned: string[], existing: CatalogDef[]) => Promise<CatalogDef[]>;

export const OTHER_ID = "other";
export const SEED_CATALOGS: CatalogDef[] = [
  { id: "contact", name: "Kontakt i informacje ogólne", description: "Company name, main phone, email, what the business is and does in general, about us, history." },
  { id: "locations", name: "Lokalizacje i godziny otwarcia", description: "Branch or store addresses, cities, directions, opening hours, days open or closed, per-location phone numbers." },
  { id: "pricing", name: "Cennik", description: "Prices, fees, price lists, costs of services or products, discounts, payment methods." },
  { id: "services", name: "Usługi i oferta", description: "Descriptions of services offered, what a service includes, who it is for, requirements, how it works." },
  { id: "products", name: "Produkty", description: "Individual products or menu items with their names, descriptions, variants, specifications." },
  { id: "people", name: "Zespół i ludzie", description: "Staff, doctors, specialists, owners, team members, their roles and qualifications." },
  { id: "howto", name: "FAQ i procedury", description: "Frequently asked questions, step-by-step procedures, booking process, what to bring, how to prepare." },
  { id: "reviews", name: "Opinie klientów", description: "Customer reviews, testimonials, ratings, case studies." },
  { id: "policies", name: "Regulaminy i polityki", description: "Terms, privacy policy, GDPR/RODO, cancellation and refund rules, legal notices." },
];

const MAX_ROUNDS = 3;
const MAX_CATALOGS = 40;
const CLASSIFY_BATCH = 8;
const SCORE_BATCH = 10;
const CONCURRENCY = 6;
const CHUNK_CHARS = 1500;

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const describe = (c: CatalogDef) => `${c.name}: ${c.description}`;

/** Jev assigns each text to one catalog id, or OTHER_ID. null entries = Jev failed for that batch. */
export async function classifyIntoCatalogs(texts: string[], catalogs: CatalogDef[]): Promise<(string | null)[]> {
  const criteria: Record<string, string> = {};
  for (const c of catalogs) criteria[c.id] = describe(c);
  criteria[OTHER_ID] = "None of the catalogs above fits this text well.";
  const idx = texts.map((_, i) => i);
  const results = await pool(batches(idx, CLASSIFY_BATCH), CONCURRENCY, async (batch) => {
    const questions: Record<string, JevQuestion> = {};
    batch.forEach((_, j) => {
      questions[`c${j}`] = {
        type: "choice",
        instructions: `Which knowledge catalog does \`chunks[${j}]\` of this business website belong to? Pick the catalog that best matches its MAIN topic.`,
        criteria,
      };
    });
    const answers = await jevAsk({ chunks: batch.map((i) => texts[i].slice(0, CHUNK_CHARS)) }, questions, 20000);
    return batch.map((_, j) => {
      const a = answers?.[`c${j}`] as JevChoiceAnswer | undefined;
      return a && typeof a.choice === "string" ? a.choice : null;
    });
  });
  return results.flat();
}

function slug(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "catalog";
  let id = base;
  for (let n = 2; taken.has(id) || id === OTHER_ID; n++) id = `${base}-${n}`;
  return id;
}

export async function buildCatalog(chunks: CatalogInputChunk[], namer: CatalogNamer | null, seeds: CatalogDef[] = SEED_CATALOGS): Promise<KnowledgeCatalog | null> {
  const catalogs: CatalogDef[] = seeds.map((c) => ({ ...c }));
  const assigned = new Map<string, string>();
  let pending = chunks.slice();
  for (let round = 0; round <= MAX_ROUNDS && pending.length > 0; round++) {
    const picks = await classifyIntoCatalogs(pending.map((c) => c.content), catalogs);
    if (picks.every((p) => p === null)) {
      if (round === 0) return null; // Jev unavailable: no catalog, chat keeps the vector path.
      break;
    }
    const unassigned: CatalogInputChunk[] = [];
    pending.forEach((c, i) => {
      const p = picks[i];
      if (p && p !== OTHER_ID && catalogs.some((k) => k.id === p)) assigned.set(c.id, p);
      else unassigned.push(c);
    });
    pending = unassigned;
    if (pending.length === 0 || round === MAX_ROUNDS || !namer || catalogs.length >= MAX_CATALOGS) break;
    let proposed: CatalogDef[] = [];
    try {
      proposed = await namer(pending.slice(0, 40).map((c) => c.content.slice(0, 600)), catalogs);
    } catch (e: any) {
      console.warn(`[catalog] namer failed: ${e?.message || e}`);
    }
    const taken = new Set(catalogs.map((c) => c.id));
    const fresh = proposed
      .filter((p) => p && p.name && p.description && !catalogs.some((c) => c.name.toLowerCase() === p.name.toLowerCase()))
      .slice(0, MAX_CATALOGS - catalogs.length)
      .map((p) => { const id = slug(p.name, taken); taken.add(id); return { id, name: p.name.slice(0, 80), description: p.description.slice(0, 300) }; });
    if (fresh.length === 0) break;
    catalogs.push(...fresh);
  }
  if (pending.length > 0) {
    catalogs.push({ id: OTHER_ID, name: "Inne", description: "Content that fits none of the other catalogs." });
    for (const c of pending) assigned.set(c.id, OTHER_ID);
  }
  const used = new Set(assigned.values());
  return {
    version: 1,
    builtAt: new Date().toISOString(),
    catalogs: catalogs.filter((c) => used.has(c.id)),
    chunks: chunks.map((c) => ({
      id: c.id,
      catalogId: assigned.get(c.id) || OTHER_ID,
      content: c.content,
      url: String(c.metadata.url || ""),
      title: String(c.metadata.title || ""),
      type: String(c.metadata.type || ""),
    })),
  };
}

/** LLM namer prompt; the caller supplies the generative call. */
export function namerPrompt(unassigned: string[], existing: CatalogDef[]): string {
  return `You organise a business website's knowledge into catalogs (topical folders).
Existing catalogs:
${existing.map((c) => `- ${c.name}: ${c.description}`).join("\n")}

These text chunks fit none of them:
${unassigned.map((t, i) => `[${i + 1}] ${t.replace(/\s+/g, " ")}`).join("\n")}

Propose 1-5 NEW catalogs that group these chunks by topic. Use the website's language for "name" (2-5 words) and English for "description" (one sentence listing what belongs there). Do not repeat an existing catalog. Reply with JSON only: {"catalogs":[{"name":"...","description":"..."}]}`;
}

export function parseNamerReply(raw: string): CatalogDef[] {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const list = JSON.parse(m[0])?.catalogs;
    return Array.isArray(list)
      ? list.filter((c: any) => typeof c?.name === "string" && typeof c?.description === "string").map((c: any) => ({ id: "", name: c.name.trim(), description: c.description.trim() }))
      : [];
  } catch { return []; }
}

export interface CatalogHit { chunk: CatalogChunk; score: number }
export interface CatalogRetrieval { catalogIds: string[]; hits: CatalogHit[]; scored: number; ms: number }

const CATALOG_MIN = 0.35;

// Lowercase, strip diacritics; 5-char prefixes act as a crude stemmer for Polish inflection.
const fold = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l");
function queryTerms(q: string): string[] {
  return [...new Set(fold(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 4).map((w) => w.slice(0, 5)))];
}
const MAX_SELECTED_CATALOGS = 3;
const MAX_SCORED_CHUNKS = 80;

/**
 * Two-stage retrieval: Jev picks catalogs, then scores every chunk inside them.
 * `preferIds` (e.g. vector hits) decide which chunks to keep when a selected
 * catalog is larger than MAX_SCORED_CHUNKS. Returns null when Jev is unavailable.
 */
export async function retrieveFromCatalog(question: string, catalog: KnowledgeCatalog, preferIds: string[] = [], minScore = 0.5): Promise<CatalogRetrieval | null> {
  const t0 = Date.now();
  const cats = catalog.catalogs;
  if (cats.length === 0) return null;
  const catQuestions: Record<string, JevQuestion> = {};
  cats.forEach((_, i) => {
    catQuestions[`k${i}`] = {
      type: "noul",
      instructions: `Could the catalog \`catalogs[${i}]\` of this business's knowledge base contain information that answers \`question\`?`,
    };
  });
  const catAnswers = await jevAsk({ question, catalogs: cats.map(describe) }, catQuestions);
  if (!catAnswers) return null;
  const ranked = cats
    .map((c, i) => ({ c, p: (catAnswers[`k${i}`] as JevNoulAnswer | undefined)?.noul ?? 0 }))
    .sort((a, b) => b.p - a.p);
  const selected = ranked.filter((r) => r.p >= CATALOG_MIN).slice(0, MAX_SELECTED_CATALOGS).map((r) => r.c.id);
  if (selected.length === 0) return { catalogIds: [], hits: [], scored: 0, ms: Date.now() - t0 };

  let candidates = catalog.chunks.filter((c) => selected.includes(c.catalogId));
  if (candidates.length > MAX_SCORED_CHUNKS) {
    // Big catalog (full-site scrape of a shop): Jev judges the MAX_SCORED_CHUNKS
    // most promising ones - vector hits first, then by word overlap with the question.
    const pref = new Map(preferIds.map((id, i) => [id, i]));
    const terms = queryTerms(question);
    const overlap = (c: CatalogChunk) => { const t = fold(c.content); return terms.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0); };
    candidates = candidates
      .map((c) => ({ c, p: pref.get(c.id) ?? 1e9, o: overlap(c) }))
      .sort((a, b) => a.p - b.p || b.o - a.o)
      .slice(0, MAX_SCORED_CHUNKS)
      .map((x) => x.c);
  }
  const scores = await pool(batches(candidates, SCORE_BATCH), CONCURRENCY, async (batch) => {
    const questions: Record<string, JevQuestion> = {};
    batch.forEach((_, j) => {
      questions[`p${j}`] = {
        type: "noul",
        instructions: `Does \`passages[${j}]\` contain information that answers \`question\` (fully, or for at least one location, product or case the question asks about)?`,
        criteria: {
          true: "The passage states the concrete facts needed to answer.",
          false: "The passage is off-topic or lacks the specific fact asked for.",
        },
      };
    });
    const answers = await jevAsk({ question, passages: batch.map((c) => c.content.slice(0, CHUNK_CHARS)) }, questions);
    return batch.map((_, j) => (answers?.[`p${j}`] as JevNoulAnswer | undefined)?.noul ?? -1);
  });
  const flat = scores.flat();
  if (flat.every((s) => s < 0)) return null;
  const hits = candidates
    .map((chunk, i) => ({ chunk, score: flat[i] }))
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score);
  return { catalogIds: selected, hits, scored: candidates.length, ms: Date.now() - t0 };
}
