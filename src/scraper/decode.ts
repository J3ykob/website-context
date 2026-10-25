/**
 * A page's text in the encoding it declares. response.text() always decodes UTF-8, so older Polish
 * sites in windows-1250 / ISO-8859-2 (konkretbud.pl, masterbud.pl) lost every Polish letter to "�"
 * in the knowledge base ("przer�bki"). Charset from the Content-Type header, else from <meta charset>
 * / http-equiv in the first bytes; UTF-8 when nothing is declared or the label is unknown.
 */
export async function decodeResponse(response: Response): Promise<string> {
  const buf = new Uint8Array(await response.arrayBuffer());
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(response.headers.get("content-type") || "")?.[1];
  const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  const decode = (label?: string) => { try { return label ? new TextDecoder(label.toLowerCase()).decode(buf) : null; } catch { return null; } };
  const declared = fromHeader || fromMeta;
  const text = decode(declared) ?? new TextDecoder("utf-8").decode(buf);
  // A server that says UTF-8 for a page written in another charset: trust the page's own declaration.
  if (fromMeta && fromMeta.toLowerCase() !== (declared || "").toLowerCase() && (text.match(/�/g) || []).length > 3) return decode(fromMeta) ?? text;
  return text;
}
