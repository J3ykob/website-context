/**
 * Page HTML as a visitor sees it once the page's scripts have run - for the common cases where
 * the raw HTML hides the real content (found by the 2026-10-25 quality review):
 * - animated counters: the number is in an attribute and the element starts at 0 or 1
 *   (helsen.pl "ponad 0" for data-digit="100", inter-bud.info "1" for data-to-value="22");
 * - e-mail addresses hidden from spam bots: Joomla's <joomla-hidden-mail> (base64 halves,
 *   kh-bud.pl, innerebud.pl), Cloudflare's data-cfemail (XOR-coded);
 * - mailto: / tel: links with no visible text (dachywarszawa.pl): the address goes into the text.
 */
const COUNTER_ATTR = /\bdata-(?:digit|to-value|count|counter|count-to|countto|to|target|number|end|end-value|purecounter-end|value)="([\d][\d\s.,]*)"/i;

function decodeCfEmail(hex: string): string {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

const b64 = (s: string) => { try { return Buffer.from(s, "base64").toString("utf-8"); } catch { return ""; } };

export function normalizeHtml(html: string): string {
  let out = html;
  // Animated counters: an element whose text is only a start number and that carries the target value.
  out = out.replace(/(<([a-z][a-z0-9]*)\b[^>]*>)\s*[0-9]{0,2}\s*(<\/\2>)/gi, (whole, open: string, _tag: string, close: string) => {
    const m = COUNTER_ATTR.exec(open);
    return m ? `${open}${m[1].trim()}${close}` : whole;
  });
  // Joomla: <joomla-hidden-mail first="base64(local)" last="base64(domain)">placeholder</joomla-hidden-mail>
  out = out.replace(/<joomla-hidden-mail\b([^>]*)>[\s\S]*?<\/joomla-hidden-mail>/gi, (whole, attrs: string) => {
    const first = /\bfirst="([^"]*)"/i.exec(attrs)?.[1], last = /\blast="([^"]*)"/i.exec(attrs)?.[1];
    const email = first && last ? `${b64(first)}@${b64(last)}` : "";
    return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email) ? `<a href="mailto:${email}">${email}</a>` : whole;
  });
  // Cloudflare: <a|span ... data-cfemail="hex">[email protected]</a|span>, and protected mailto: links.
  out = out.replace(/<(a|span)\b[^>]*\bdata-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/\1>/gi, (_w, _t, hex: string) => decodeCfEmail(hex));
  out = out.replace(/href="\/cdn-cgi\/l\/email-protection#([0-9a-f]+)"/gi, (_w, hex: string) => `href="mailto:${decodeCfEmail(hex)}"`);
  // mailto: / tel: links without visible text.
  out = out.replace(/<a\b([^>]*\bhref="(mailto|tel):([^"?]+)[^"]*"[^>]*)>((?:\s|&nbsp;|<br\s*\/?>)*)<\/a>/gi, (_w, attrs: string, _k: string, value: string, inner: string) =>
    `<a${attrs}>${decodeURIComponent(value)}${inner}</a>`);
  return out;
}
