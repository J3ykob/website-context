/**
 * Dashboard API for the offer (products & services):
 *   GET    /api/dashboard/offer                 the items
 *   POST   /api/dashboard/offer/items           add or update one item (by id)
 *   DELETE /api/dashboard/offer/items/:id       remove one item
 *   POST   /api/dashboard/offer/items/bulk      add reviewed items {items} (same name -> replaced)
 *   POST   /api/dashboard/offer/import-file     raw body + ?filename= -> {items} to review (not saved)
 *   POST   /api/dashboard/offer/extract-site    {items} found on the scraped website, to review (not saved)
 */
import type { Express, RequestHandler } from "express";
import { loadOffer, saveOffer, clean, mergeItems, type OfferItem } from "./store.js";
import { extractFromBlocks, type Llm } from "./extract.js";
import { extractFile } from "../knowledge/extract-file.js";
import { isImageUpload, extractImage, imageTextToBlocks } from "../knowledge/extract-image.js";
import { loadKnowledgeCatalog } from "../multi-tenant/tenant-manager.js";
import { OpenRouterProvider } from "../llm/openrouter-provider.js";

export interface OfferRouteDeps { auth: RequestHandler; onChanged: (tenantId: string) => void }

const llm: Llm = async (system, user, maxTokens = 2500) => {
  const or = new OpenRouterProvider({ maxTokens, temperature: 0 });
  return (await or.chat([{ role: "system", content: system }, { role: "user", content: user }], { maxTokens })).content;
};

export function registerOfferRoutes(app: Express, deps: OfferRouteDeps): void {
  const tid = (req: any) => req.tenantId as string;

  app.get("/api/dashboard/offer", deps.auth, async (req, res) => {
    res.json(await loadOffer(tid(req)));
  });

  app.post("/api/dashboard/offer/items", deps.auth, async (req, res) => {
    const it = clean(req.body);
    if (!it) { res.status(400).json({ error: "The item needs a name." }); return; }
    const offer = await loadOffer(tid(req));
    const items = offer.items.some((x) => x.id === it.id)
      ? offer.items.map((x) => (x.id === it.id ? { ...it, source: x.source, updatedAt: new Date().toISOString() } : x))
      : [...offer.items, { ...it, source: "manual" as const }];
    res.json(await saveOffer(tid(req), items));
    deps.onChanged(tid(req));
  });

  app.delete("/api/dashboard/offer/items/:id", deps.auth, async (req, res) => {
    const offer = await loadOffer(tid(req));
    res.json(await saveOffer(tid(req), offer.items.filter((x) => x.id !== req.params.id)));
    deps.onChanged(tid(req));
  });

  app.post("/api/dashboard/offer/items/bulk", deps.auth, async (req, res) => {
    const incoming = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 2000).map((x: any) => clean(x)).filter(Boolean) as OfferItem[];
    if (!incoming.length) { res.status(400).json({ error: "No items to add." }); return; }
    const offer = await loadOffer(tid(req));
    res.json(await saveOffer(tid(req), mergeItems(offer.items, incoming)));
    deps.onChanged(tid(req));
  });

  app.post("/api/dashboard/offer/import-file", deps.auth, (req, res) => {
    const filename = String(req.query.filename || "upload").slice(0, 200);
    const parts: Buffer[] = [];
    let size = 0, tooBig = false;
    req.on("data", (c: Buffer) => { size += c.length; if (size > 15 * 1024 * 1024) { tooBig = true; return; } parts.push(c); });
    req.on("end", async () => {
      if (tooBig) { res.status(413).json({ error: "File too large (max 15MB)" }); return; }
      const buffer = Buffer.concat(parts);
      if (!buffer.length) { res.status(400).json({ error: "Empty file" }); return; }
      try {
        const blocks = isImageUpload(filename, req.headers["content-type"])
          ? imageTextToBlocks((await extractImage(buffer, filename, req.headers["content-type"])).text)
          : (await extractFile(buffer, filename, req.headers["content-type"])).blocks;
        if (!blocks.length) { res.status(422).json({ error: "No readable text found in the file." }); return; }
        const items = await extractFromBlocks(blocks.slice(0, 120), llm, "file");
        console.log(`[offer] ${tid(req)}: ${items.length} item(s) found in ${filename}`);
        res.json({ items });
      } catch (e: any) {
        console.warn(`[offer] ${tid(req)}: import failed: ${e?.message || e}`);
        res.status(500).json({ error: "Could not read the file." });
      }
    });
  });

  app.post("/api/dashboard/offer/extract-site", deps.auth, async (req, res) => {
    const cat = await loadKnowledgeCatalog(tid(req));
    if (!cat?.chunks.length) { res.status(404).json({ error: "No scraped website content yet." }); return; }
    try {
      const items = await extractFromBlocks(cat.chunks.slice(0, 400).map((c) => c.content), llm, "website");
      console.log(`[offer] ${tid(req)}: ${items.length} item(s) found on the website`);
      res.json({ items });
    } catch (e: any) {
      console.warn(`[offer] ${tid(req)}: site extract failed: ${e?.message || e}`);
      res.status(500).json({ error: "Could not read the website content." });
    }
  });
}
