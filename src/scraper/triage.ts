/**
 * Which pages of a large site are worth reading (the owner's idea, 2026-10-29): Jev judges candidate
 * pages by their address and link text, before anything is fetched - listings, filters, tags, pagination,
 * archives, carts and accounts are left out; pages a customer would ask about are read. Large sites only
 * (crawler: TRIAGE_MIN_URLS sitemap addresses, or a shop with a catalogue); small sites crawl as before.
 * Jev unavailable: everything is read (null).
 */
import { jevAsk, type JevQuestion } from "../llm/jev.js";

export function makeTriage(siteNote: string): (cands: { url: string; text: string }[]) => Promise<boolean[] | null> {
  return async (cands) => {
    if (!cands.length) return [];
    const pages = cands.map((c) => { let p = c.url; try { const u = new URL(c.url); p = decodeURIComponent(u.pathname + u.search); } catch {} return `${p}${c.text ? ` (link: "${c.text}")` : ""}`; });
    const qs: Record<string, JevQuestion> = {};
    pages.forEach((_, i) => {
      qs[`p${i}`] = { type: "noul", instructions: `Is \`pages[${i}]\` (a page of the business's website, judged by its address and link text) a page with the business's own content: about it, its services, offer or individual products, prices, promotions, news or articles, catalogues or downloads, configurators, terms, policies, delivery, returns, warranty, service, contact, guides or FAQ? Answer no only for a listing of items (a category, tag, brand or search results page, a filter or sort variant, a page number), an archive by date or author, a cart, checkout, login or account page, a feed, or a duplicate in another format.${siteNote ? ` ${siteNote}` : ""}` };
    });
    const a = await jevAsk({ pages }, qs, 20000);
    if (!a) return null;
    return pages.map((_, i) => (((a as any)[`p${i}`]?.noul as number) ?? 1) >= 0.3); // leaning to read: a missed page costs more than a wasted fetch
  };
}
