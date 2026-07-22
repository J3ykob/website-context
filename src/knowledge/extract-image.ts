/**
 * Vision extraction — read a photo of a business document (menu, price list,
 * flyer, opening-hours sign, business card) and transcribe everything useful into
 * text for the knowledge base. For businesses whose "content" only exists on paper
 * or in a photo. Uses an open-weights multilingual vision model (qwen3-vl), so it
 * reads Polish menus/prices as well as English.
 */
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "qwen/qwen3-vl-32b-instruct";

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif",
};

export function isImageUpload(filename: string, contentType?: string): boolean {
  if (contentType && /^image\//i.test(contentType)) return true;
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return ext in IMAGE_MIME;
}

export interface ImageExtraction { text: string; charCount: number }

export async function extractImage(buffer: Buffer, filename: string, contentType?: string): Promise<ImageExtraction> {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const mime = (contentType && /^image\//i.test(contentType) ? contentType : IMAGE_MIME[ext]) || "image/jpeg";
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;

  const body = {
    model: VISION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You transcribe a photo of a business document (menu, price list, flyer, opening-hours sign, business card, poster) into clean text for a customer-service assistant. " +
          "Transcribe EVERY item, price, name, phone, address, hour and detail EXACTLY as shown, keeping structure (group items, keep prices next to their item). " +
          "Write in the document's OWN language. If a value is unreadable, omit it — never guess a price or number. Output only the transcribed content, no commentary.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe everything useful for answering customer questions from this image." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 1800,
    temperature: 0,
  };

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Vision model ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  const data = (await resp.json()) as any;
  const text = (data.choices?.[0]?.message?.content || "").trim();
  return { text, charCount: text.length };
}

/** Split transcribed text into ~1200-char blocks on blank lines (for chunking). */
export function imageTextToBlocks(text: string, maxChars = 1200): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length + 2 > maxChars) { out.push(buf); buf = ""; }
    buf = buf ? buf + "\n\n" + p : p;
    if (buf.length >= maxChars) { out.push(buf); buf = ""; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((b) => b.length > 8);
}
