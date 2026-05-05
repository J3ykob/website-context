# website.context — Business Strategy
## May 2026

---

## CORE THESIS

Free AI chat widget for every website in Poland → collect intent data → monetize analytics + referrals + business network. First mover in "agentic economy."

---

## PRODUCT TIERS

### Free Tier (the hook)
- Chat widget (replaces navigation)
- Basic chat with RAG
- Basic gap notifications (7-day history)
- Owner dashboard (basic)
- Cost to us: ~$0.22/business/month

### Paid: Analytics Pro — 149 PLN/month
- Intent heatmap (what visitors want, by page)
- Trend analysis ("pricing questions up 40% this week")
- Full conversation search (topic, sentiment, date)
- Weekly email digest
- 90-day history
- Export/API access

### Paid: Action Credits — pay per execution
- Contact form submission: 2 PLN
- Order/booking completion: 5 PLN
- Lead captured (email/phone): 1 PLN
- Pure performance pricing — they pay only when bot DOES something

### Paid: Industry Benchmarks — 299 PLN/month
- Cross-business anonymized insights for their sector
- "Your competitors' visitors convert at 12%, yours at 8%"
- "Top 10 questions in your industry this month"
- Unique data nobody else has

### Paid: Integrations — 99 PLN/month
- HubSpot/Salesforce/Pipedrive push
- Slack/Teams notifications
- Webhooks
- Zapier connector

### Paid: White-label — 199 PLN/month
- Remove branding
- Custom widget domain
- Custom styling

### Paid: AI Recommendations — 199 PLN/month
- "Add a FAQ about shipping — 23% ask about it"
- "Your pricing page is missing comparison info"
- "Visitors who ask about X convert 2x more"
- Turns passive analytics into actionable advice

---

## COST STRUCTURE

### Per Message
- Input: ~3,500 tokens × $0.14/1M (DeepSeek direct) = $0.00049
- Output: ~200 tokens × $0.28/1M = $0.000056
- **Per message: $0.00055**
- **Per conversation (5 msgs): $0.0027**
- **Per business/month (80 convos): $0.22**

### Infrastructure (shared, fixed)
- GPU server (BGE embeddings): ~€90/month
- Qdrant VPS: ~€30/month
- App server (multi-tenant): ~€25/month
- **Total infra: ~€145/month** (fixed regardless of tenant count)

### At Scale
| Tenants | LLM Cost | Infra | Total | Per Business |
|---------|----------|-------|-------|-------------|
| 100 | $22 | $155 | $177/mo | $1.77 |
| 500 | $108 | $155 | $263/mo | $0.53 |
| 1,000 | $216 | $175 | $391/mo | $0.39 |
| 5,000 | $1,080 | $250 | $1,330/mo | $0.27 |
| 10,000 | $2,160 | $400 | $2,560/mo | $0.26 |

---

## REVENUE PROJECTIONS

### Month 6 (500 businesses)
| Source | Count | Revenue |
|--------|-------|---------|
| Analytics Pro | 60 | ~$2,100 |
| Action credits | ~2,000 actions | ~$1,200 |
| Benchmarks | 10 | ~$700 |
| **Total revenue** | | **~$4,000** |
| **Total cost** | | **~$263** |
| **Profit** | | **~$3,737** |

### Month 12 (2,000 businesses)
| Source | Count | Revenue |
|--------|-------|---------|
| Analytics Pro | 300 | ~$10,500 |
| Action credits | ~10,000 actions | ~$6,000 |
| Benchmarks | 50 | ~$3,500 |
| **Total revenue** | | **~$20,000** |
| **Total cost** | | **~$540** |
| **Profit** | | **~$19,460** |

---

## PHASE 2: CONNECTED BUSINESS GRAPH

### The Vision
Every business's AI agent becomes an MCP server. When one agent can't help a visitor, it calls another agent's tools directly — agent-to-agent negotiation.

```
Visitor → "I need a mortgage for this apartment"

Real Estate Agent                    Mortgage Agent
     │                                    │
     ├─ [MCP] get_mortgage_options(       │
     │         property: "apartment",      │
     │         location: "Warsaw",         │
     │         price: 850000)              │
     │                                    │
     │         ◄── returns: [options...]   │
     │                                    │
     ├─ "I found two mortgage options      │
     │   for this property..."             │
     │                                    │
     ├─ [MCP] start_application(...)      │
     │                                    │
     │         ◄── { status: "started" }  │
```

Visitor never leaves the real estate site. Both businesses benefit. We charge the referral fee.

### Monetization Layers

**Layer 1: Referral Marketplace**
- Business A's visitor needs something Business A can't provide
- Platform matches to Business B
- Business B pays per qualified referral (5-100 PLN by industry)
- This is Google Ads but conversational and 10x more qualified

**Layer 2: Business Discovery Engine**
- Standalone chat: "Find me a plumber in Warsaw who can come tomorrow"
- Searches ALL business contexts on the platform
- Returns best match with direct chat handoff
- Domain: szukaj.pl or zapytaj.biz

**Layer 3: Industry Intelligence**
- Aggregate anonymized data across sectors
- Sell reports to industry associations, chambers of commerce, investors
- Primary research, real-time — nobody else has this

**Layer 4: B2B Matching**
- Businesses need other businesses
- Match and connect, charge both sides

### Network Effects
| Businesses | Value |
|-----------|-------|
| 100 | Chat widget (commodity) |
| 1,000 | Analytics + intent data (valuable) |
| 10,000 | Cross-referral network (very valuable) |
| 50,000 | Business discovery engine (massive) |
| 100,000+ | Poland's business intent graph (monopoly) |

---

## CONTENT MARKETING: DATA-DRIVEN LINKEDIN

### The Flywheel
Free widget → conversations → data → LinkedIn insights → viral posts → more installs → more data

### Content Series

**"What Poland Wants" (weekly)**
- Top queries by industry from real conversations
- "We analyzed 12,000 conversations across 200 Polish e-commerce stores this week..."
- Impossible to fake, impossible for competitors to replicate

**"The Gap Report" (bi-weekly)**
- What businesses don't answer but should
- "40% of real estate visitors ask about mortgage options but no agency mentions financing"

**"Saturday vs Monday" (weekly)**
- How customer intent shifts through the week
- Time-based patterns nobody has seen before

**"City Battle" (monthly)**
- Warsaw vs Krakow vs Wroclaw: what customers in each city want
- Regional patterns, local insights

**Industry Callouts (ongoing)**
- Direct, actionable: "Restaurant owners: 60% of your Saturday evening visitors ask 'do you deliver?'"
- Each post is a free ad for the platform

### Why This Works
- Real data = high engagement (people share surprising stats)
- Every post proves the product's value
- Business owners see it → "I want that data for MY site" → install free widget
- No marketing budget needed — the data IS the marketing
- Establishes thought leadership in "agentic economy" narrative

---

## GO-TO-MARKET: POLAND

### Phase 1: Beachhead (Months 1-3)
- Target: Polish e-commerce (Allegro sellers, Shopify stores)
- Channel: Direct outreach + LinkedIn content
- Partner with Polish web agencies as distribution
- Pricing: Free widget, Analytics Pro for early adopters at 99 PLN

### Phase 2: Vertical Expansion (Months 3-6)
- Real estate, healthcare, legal, tourism
- Vertical-specific templates
- Dig.IT grant alignment (June 2026 call)

### Phase 3: Network (Months 6-12)
- Cross-referral system goes live
- Business discovery engine beta
- Industry benchmarks product launch

### Phase 4: Scale (Year 2)
- Expand to Czech Republic, Slovakia, Hungary
- Agent-to-agent MCP communication
- Business graph becomes the moat
- Series A based on network effects data

---

## KEY METRICS TO TRACK

- Businesses onboarded (free)
- Conversations per business per month
- Knowledge gaps identified
- Conversion to paid analytics
- Action credits consumed
- Cross-referrals (Phase 2)
- LinkedIn engagement rate
- CAC (should be near zero with content flywheel)
- LTV (analytics + actions + referrals)

---

## COMPETITIVE MOAT (in order of defensibility)

1. **Network effects** — more businesses = better referrals = more businesses
2. **Data moat** — real-time intent data across thousands of businesses
3. **Agent-to-agent protocol** — MCP-based interop that competitors can't replicate without the network
4. **Content flywheel** — insights from data → adoption → more data
5. **First mover in Poland** — while Tidio/LiveChat focus on support

---

## RISKS

1. DeepSeek API reliability/availability
2. Polish language quality of LLM responses
3. Market education ("chat as navigation" is new)
4. Tidio could pivot (but their DNA is support, not navigation)
5. Data privacy regulation (GDPR compliance critical)

## MITIGATIONS

1. Multi-model fallback (DeepSeek → Gemini Flash → Qwen self-hosted)
2. Fine-tune or prompt-engineer for Polish
3. LinkedIn content educates the market organically
4. Move fast, build network effects before they notice
5. EU data storage, transparent AI disclosure, GDPR-by-design
