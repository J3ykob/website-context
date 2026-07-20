/**
 * Extract plain text from an uploaded knowledge file (PDF / XLSX / CSV / DOCX /
 * TXT / MD), so an owner can enrich the bot's knowledge base with documents,
 * not just typed text. Returns text split into paragraph-sized blocks ready to
 * embed as manual chunks.
 */

const MAX_TEXT = 200_000; // hard cap on extracted text per file
const BLOCK_TARGET = 1500; // paragraph-sized blocks, matching the scraper chunker

export interface ExtractResult {
  kind: "pdf" | "xlsx" | "csv" | "docx" | "text";
  blocks: string[];
  charCount: number;
}

function splitBlocks(text: string): string[] {
  const out: string[] = [];
  let rest = text.slice(0, MAX_TEXT).replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  // Prefer splitting on blank lines; fall back to sentence/length boundaries.
  const paras = rest.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  for (const para of paras) {
    let p = para;
    while (p.length > BLOCK_TARGET * 1.4) {
      let cut = p.lastIndexOf(". ", BLOCK_TARGET);
      if (cut < BLOCK_TARGET * 0.5) cut = p.lastIndexOf("\n", BLOCK_TARGET);
      if (cut < BLOCK_TARGET * 0.5) cut = BLOCK_TARGET;
      else cut += 1;
      out.push(p.slice(0, cut).trim());
      p = p.slice(cut).trim();
    }
    if (p) out.push(p);
  }
  return out.filter((b) => b.length > 1);
}

function extFromName(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

export async function extractFile(buffer: Buffer, filename: string, mime?: string): Promise<ExtractResult> {
  const ext = extFromName(filename);
  const m = (mime || "").toLowerCase();

  // ── PDF ──
  if (ext === "pdf" || m.includes("application/pdf")) {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    const clean = (text || "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    return { kind: "pdf", blocks: splitBlocks(clean), charCount: clean.length };
  }

  // ── Excel (xlsx/xls) ──
  if (ext === "xlsx" || ext === "xls" || m.includes("spreadsheetml") || m.includes("ms-excel")) {
    const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
    const wb = (XLSX as any).read(buffer, { type: "buffer" });
    let out = "";
    for (const name of wb.SheetNames) {
      const csv = (XLSX as any).utils.sheet_to_csv(wb.Sheets[name]);
      if (csv.trim()) out += `# ${name}\n${csv}\n\n`;
    }
    return { kind: "xlsx", blocks: splitBlocks(out.trim()), charCount: out.length };
  }

  // ── CSV ──
  if (ext === "csv" || m.includes("text/csv")) {
    const text = buffer.toString("utf-8").trim();
    return { kind: "csv", blocks: splitBlocks(text), charCount: text.length };
  }

  // ── Word (docx) ──
  if (ext === "docx" || m.includes("wordprocessingml")) {
    const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
    const { value } = await (mammoth as any).extractRawText({ buffer });
    const clean = (value || "").replace(/[ \t]+/g, " ").trim();
    return { kind: "docx", blocks: splitBlocks(clean), charCount: clean.length };
  }

  // ── Plain text / markdown ──
  if (ext === "txt" || ext === "md" || m.startsWith("text/")) {
    const text = buffer.toString("utf-8").trim();
    return { kind: "text", blocks: splitBlocks(text), charCount: text.length };
  }

  throw new Error(`Unsupported file type: ${ext || m || "unknown"}. Supported: PDF, XLSX, CSV, DOCX, TXT, MD.`);
}
