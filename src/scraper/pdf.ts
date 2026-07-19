/**
 * PDF text extraction for the crawler. Polish business sites keep menus, price
 * lists and terms in PDFs — before this module those either got skipped or
 * (worse, pre-2026-07-19) ingested as raw bytes and chunked into gibberish.
 *
 * Digital PDFs extract cleanly via unpdf (serverless pdf.js build). Scanned /
 * image-only PDFs yield almost no text and are skipped — indexing noise is
 * worse than a gap the owner can fill via the dashboard.
 */

import type { ScrapedPage } from "./types.js";

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_TEXT = 60_000;
// Blocks sized like normal page paragraphs so the downstream chunker (and the
// BGE input window) never sees one giant monolithic block.
const BLOCK_TARGET = 1500;

function splitBlocks(text: string): string[] {
  const out: string[] = [];
  let rest = text.slice(0, MAX_PDF_TEXT);
  while (rest.length > BLOCK_TARGET) {
    let cut = rest.lastIndexOf(". ", BLOCK_TARGET);
    if (cut < BLOCK_TARGET * 0.5) cut = BLOCK_TARGET;
    else cut += 1;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out.filter(Boolean);
}

export async function fetchPdfAsPage(
  url: string,
  opts: { timeout: number; userAgent: string }
): Promise<ScrapedPage | null> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": opts.userAgent },
      signal: AbortSignal.timeout(opts.timeout * 2),
    });
    if (!resp.ok) return null;
    if (Number(resp.headers.get("content-length") || 0) > MAX_PDF_BYTES) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > MAX_PDF_BYTES) return null;

    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(buf);
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    const clean = (text || "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    // Scanned/image-only PDFs extract to (almost) nothing — skip them.
    if (clean.length < 200) return null;

    const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "").replace(/\.pdf$/i, "");
    const title = fileName.replace(/[_-]+/g, " ").trim() || "PDF document";

    return {
      url,
      title,
      description: `PDF document (${totalPages} ${totalPages === 1 ? "page" : "pages"})`,
      content: splitBlocks(clean).map((t) => ({ type: "paragraph" as const, content: t })),
      metadata: {},
      links: [],
      forms: [],
      structuredData: [],
      scrapedAt: new Date().toISOString(),
      renderMethod: "static",
    };
  } catch {
    return null;
  }
}
