/**
 * Dashboard API for the offer (products & services):
 *   GET    /api/dashboard/offer                 the items
 *   POST   /api/dashboard/offer/items           add or update one item (by id)
 *   DELETE /api/dashboard/offer/items/:id       remove one item
 *   POST   /api/dashboard/offer/items/bulk      add reviewed items {items} (same name -> replaced)
 *   POST   /api/dashboard/offer/import-file     raw body + ?filename= -> {items} to review (not saved)
 *   POST   /api/dashboard/offer/extract-site    {items} found on the scraped website, to review (not saved)
 *   GET    /api/dashboard/offer/template        the onboarding spreadsheet (xlsx), pre-filled
 *   Our spreadsheet uploaded to import-file is read column by column (no model) and saved at once.
 */
import type { Express, RequestHandler } from "express";
import { loadOffer, saveOffer, clean, mergeItems, priceText, type OfferItem } from "./store.js";
import { extractFromBlocks, type Llm } from "./extract.js";
import { buildTemplate, isTemplate, readTemplate } from "./sheet.js";
import { FIELDS, type FieldId } from "./schema.js";
import { getTenant } from "../multi-tenant/tenant-registry.js";
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

  // Items with their price in words and field labels, plus the schema for the editor.
  const view = (offer: Awaited<ReturnType<typeof loadOffer>>) => ({
    ...offer,
    items: offer.items.map((i) => ({ ...i, price_display: priceText(i) })),
    schema: Object.fromEntries((Object.keys(FIELDS) as FieldId[]).map((f) => [f, { label: FIELDS[f].label, values: Object.fromEntries(Object.entries(FIELDS[f].values).map(([k, d]) => [k, d.label])) }])),
  });
  app.get("/api/dashboard/offer", deps.auth, async (req, res) => {
    res.json(view(await loadOffer(tid(req))));
  });

  app.post("/api/dashboard/offer/items", deps.auth, async (req, res) => {
    const it = clean(req.body, "manual");
    if (!it) { res.status(400).json({ error: "The item needs a name." }); return; }
    // Everything the owner sets in the dashboard is theirs (kept on re-scrape).
    it.owner_set = (Object.keys(FIELDS) as FieldId[]).filter((f) => it.fields[f] && it.fields[f] !== "unknown");
    const offer = await loadOffer(tid(req));
    const items = offer.items.some((x) => x.id === it.id)
      ? offer.items.map((x) => (x.id === it.id ? { ...it, source: x.source, url: x.url, owner_set: [...new Set([...x.owner_set, ...it.owner_set])], updatedAt: new Date().toISOString() } : x))
      : [...offer.items, it];
    res.json(view(await saveOffer(tid(req), items)));
    deps.onChanged(tid(req));
  });

  app.delete("/api/dashboard/offer/items/:id", deps.auth, async (req, res) => {
    const offer = await loadOffer(tid(req));
    res.json(view(await saveOffer(tid(req), offer.items.filter((x) => x.id !== req.params.id))));
    deps.onChanged(tid(req));
  });

  app.post("/api/dashboard/offer/items/bulk", deps.auth, async (req, res) => {
    const incoming = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 2000).map((x: any) => clean(x)).filter(Boolean) as OfferItem[];
    if (!incoming.length) { res.status(400).json({ error: "No items to add." }); return; }
    const offer = await loadOffer(tid(req));
    res.json(view(await saveOffer(tid(req), mergeItems(offer.items, incoming))));
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
        if (await isTemplate(buffer)) {
          // Our spreadsheet: read exactly, saved at once (the owner already reviewed it in Excel).
          const { items, problems } = await readTemplate(buffer);
          const offer = await loadOffer(tid(req));
          const saved = await saveOffer(tid(req), mergeItems(offer.items, items));
          deps.onChanged(tid(req));
          console.log(`[offer] ${tid(req)}: spreadsheet imported (${items.length} rows, ${problems.length} problems)`);
          res.json({ template: true, saved: items.length, problems, offer: view(saved) });
          return;
        }
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

  app.get("/api/dashboard/offer/template", deps.auth, async (req, res) => {
    const t = getTenant(tid(req));
    const name = t?.brandName || t?.domain || tid(req);
    const buf = await buildTemplate(await loadOffer(tid(req)), name);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="oferta-${(t?.domain || tid(req)).split(".").join("-")}.xlsx"`);
    res.send(buf);
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
