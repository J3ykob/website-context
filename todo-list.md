# Website Context Framework — Project Plan & TODO

## Vision
A framework that allows website/business owners to make their website accessible through a chat interface. Instead of traditional navigation menus, visitors interact with an AI-powered chat that understands the website's content, structure, and processes.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Business Dashboard                         │
│  (manage context, record flows, view analytics, configure)   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                      Backend API                              │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Scraping   │  │  RAG Engine  │  │  Flow Executor    │  │
│  │  Engine     │  │  (LLM+Vector)│  │  (Action Replay)  │  │
│  └─────────────┘  └──────────────┘  └───────────────────┘  │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Embeddings │  │  Context     │  │  Multi-tenant     │  │
│  │  Pipeline   │  │  Store       │  │  Isolation        │  │
│  └─────────────┘  └──────────────┘  └───────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              Embeddable Chat Widget (Frontend)                │
│  (iframe/web component that site owners drop into their HTML)│
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Scraping Engine
**Goal:** Reliably extract content from any type of website.

### TODO:
- [x] Research and select scraping tools (Playwright for JS, Cheerio for static)
- [x] Implement static HTML scraper (fetch + parse)
- [x] Implement dynamic JS scraper (Playwright-based rendering, auto-fallback)
- [x] Build content extraction pipeline:
  - [x] Strip navigation/footer/boilerplate (readability algorithm)
  - [x] Extract structured content (headings, paragraphs, lists, tables)
  - [x] Extract metadata (title, description, OG tags)
  - [x] Extract internal links and build site map
  - [x] Extract forms and interactive elements
  - [x] Extract JSON-LD and microdata structured data
  - [x] Generate LLM-ready markdown (fit markdown with noise filtering)
- [x] Implement recursive BFS site crawler (robots.txt, rate limiting, redirect-aware)
- [x] Test against 5 real websites:
  - [x] Static HTML site (example.com) ✓
  - [x] React/Vite docs site (vitejs.dev → vite.dev) ✓
  - [x] Blog/WordPress style (blog.cloudflare.com) ✓
  - [x] E-commerce site (Shopify themes demo) ✓
  - [x] Documentation site (docs.github.com) ✓
- [x] Validate extracted data quality for each test site

---

## Phase 2: Data Processing & Embeddings ✅
**Goal:** Transform scraped content into searchable, structured context.

### TODO:
- [x] Design the Website Context Schema (structured, per-page, per-section)
- [x] Implement content chunking strategy:
  - [x] Semantic chunking (by heading/section)
  - [x] Overlap strategy for context preservation (150 char overlap)
  - [x] Metadata attachment per chunk (source URL, section, heading hierarchy)
- [x] Implement embedding pipeline:
  - [x] Select embedding model (OpenAI text-embedding-3-small)
  - [x] Batch embedding generation (configurable batch size)
  - [x] Vector storage (InMemoryVectorStore for dev, designed for pgvector/Qdrant swap)
- [x] Build context index:
  - [x] Site structure map (pages, hierarchy, relationships)
  - [x] Content index (chunks with type classification)
  - [x] Form/interaction index (forms extracted with field details)
- [ ] Test retrieval quality with sample queries against test sites (needs OPENAI_API_KEY)

---

## Phase 3: Website Context Structure ✅
**Goal:** Design a clean, scalable data model — NOT one big file.

### TODO:
- [x] Design per-tenant data model (TypeScript types in src/context/types.ts):
  - WebsiteContext → SiteMapEntry[] + PageContext[] + FlowDefinition[] + ContentChunk[]
  - Per-page: sections, forms, structured data, content hash
  - Per-chunk: content, metadata (url, title, heading hierarchy, type)
  - Flow definitions with steps, selectors, required inputs
- [x] Implement context building from crawl results (src/context/store.ts)
- [ ] Implement context CRUD operations (for dashboard editing)
- [ ] Build context versioning (track changes over time)
- [ ] Implement context diffing (know what changed between scrapes)
- [ ] Design scalable storage (DB schema for multi-tenant)

---

## Phase 4: Flow Recording System
**Goal:** Let business owners record step-by-step processes that the AI can replay.

### TODO:
- [ ] Design flow recording data model:
  - [ ] Steps (click, type, select, navigate, wait, assert)
  - [ ] Element selectors (multiple strategies for resilience)
  - [ ] Input data templates (what the user provides vs. constants)
  - [ ] Success/failure conditions
- [ ] Build flow recorder (browser-based, in dashboard):
  - [ ] Inject recording script into target site
  - [ ] Capture user interactions in sequence
  - [ ] Generate replayable flow definition
- [ ] Build flow executor:
  - [ ] Playwright-based flow replay
  - [ ] Variable substitution (user-provided data)
  - [ ] Error handling and retry logic
  - [ ] Execution status reporting
- [ ] Test with real flows:
  - [ ] Contact form submission
  - [ ] Product order flow
  - [ ] Account registration
  - [ ] Search and filter flow

---

## Phase 5: LLM Backend (RAG + Actions)
**Goal:** AI that answers questions using website context and executes recorded flows.

### TODO:
- [ ] Implement RAG pipeline:
  - [ ] Query understanding (intent classification)
  - [ ] Relevant chunk retrieval (vector similarity + keyword)
  - [ ] Context assembly (combine chunks with site structure)
  - [ ] Response generation (LLM with assembled context)
- [ ] Implement action handling:
  - [ ] Detect when user wants to perform an action
  - [ ] Match to recorded flows
  - [ ] Collect required inputs from user via chat
  - [ ] Execute flow and report results
- [ ] Implement conversation memory (per-session)
- [ ] Add guardrails (stay on-topic, don't hallucinate about site content)
- [ ] Test end-to-end with real website contexts

---

## Phase 6: Embeddable Chat Widget
**Goal:** Drop-in frontend that works on any website.

### TODO:
- [ ] Design chat widget UI (clean, customizable)
- [ ] Build as web component or iframe:
  - [ ] Minimal footprint, no CSS conflicts with host site
  - [ ] Responsive (mobile + desktop)
  - [ ] Customizable theme (colors, position, branding)
- [ ] Implement chat functionality:
  - [ ] Message send/receive
  - [ ] Typing indicators
  - [ ] Action confirmation dialogs
  - [ ] Rich responses (links, images, structured data)
- [ ] Build embed script (one-line installation for site owners)
- [ ] Test on various host sites (no style conflicts, works everywhere)

---

## Phase 7: Business Dashboard
**Goal:** Admin panel for business owners to manage everything.

### TODO:
- [ ] Authentication and tenant management
- [ ] Website management:
  - [ ] Add/remove websites
  - [ ] Trigger re-scrape
  - [ ] View/edit extracted context
- [ ] Flow management:
  - [ ] Record new flows
  - [ ] Edit/delete existing flows
  - [ ] Test flow execution
- [ ] Widget configuration:
  - [ ] Customize appearance
  - [ ] Set behavior rules
  - [ ] Get embed code
- [ ] Analytics (future):
  - [ ] Conversation logs
  - [ ] Common questions
  - [ ] Conversion tracking
  - [ ] User satisfaction metrics

---

## Phase 8: Multi-tenant & Scale
**Goal:** Support thousands of businesses with isolated data.

### TODO:
- [ ] Database design (tenant isolation)
- [ ] API key management
- [ ] Rate limiting per tenant
- [ ] Background job queue (scraping, embedding generation)
- [ ] CDN for widget delivery
- [ ] Monitoring and alerting

---

## Tech Stack (Proposed)

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Scraping | Playwright + Cheerio | JS rendering + fast static parsing |
| Backend | Node.js / TypeScript | Ecosystem, Playwright native |
| API | Express or Fastify | Fast, well-supported |
| Database | PostgreSQL + pgvector | Relational + vector in one DB |
| Embeddings | OpenAI text-embedding-3-small | Best quality/cost ratio |
| LLM | Claude API (Anthropic) | Superior reasoning, tool use |
| Vector Store | pgvector (start) → Pinecone (scale) | Start simple, scale later |
| Frontend Widget | Preact + Shadow DOM | Tiny bundle, no conflicts |
| Dashboard | Next.js | Full-stack React, SSR |
| Queue | BullMQ + Redis | Background jobs |
| Auth | Clerk or Auth.js | Quick to implement |

---

## Implementation Order & Current Status

1. ✅ Phase 1: Scraping Engine — tested on 5+ real sites
2. ✅ Phase 2: Embeddings & Data Processing — pipeline built, needs API key for live test
3. ✅ Phase 3: Context Structure Design — typed schema, builder implemented
4. ✅ Phase 5: LLM Backend (RAG) — WebsiteChat class with Claude API
5. **[NEXT] Phase 6: Chat Widget** — embeddable frontend
6. Phase 4: Flow Recording — browser-based recording + replay
7. Phase 7: Dashboard — Next.js admin panel
8. Phase 8: Scale — multi-tenant DB, job queues

## Research: Existing Tools & How We Differ

| Tool | What it does | Our advantage |
|------|-------------|---------------|
| Crawl4AI | Python crawler → LLM-ready markdown | We add flow recording, dashboard, widget embed |
| Firecrawl | SaaS scrape-to-markdown API | We're self-contained, owner-controlled |
| SiteGPT | Embed ChatGPT on your site | We use Claude, add flows, structured context |
| Kommunicate | Quick chatbot from website | We offer deeper context control, process automation |

Key technical learnings from research:
- Output "fit markdown" (BM25-filtered) for LLM context — done
- Preserve heading hierarchy for retrieval — done  
- Semantic chunking > character chunking — done
- Fast HTTP first, Playwright fallback — done

---

## Success Criteria

- Scraping works on 5+ different website types with >90% content extraction accuracy
- Chat can answer questions about a scraped website within 2 seconds
- Recorded flows execute reliably (>95% success rate)
- Widget loads in <100ms and has zero CSS conflicts
- New tenant onboarding takes <5 minutes
- System handles 100+ concurrent tenants without degradation
