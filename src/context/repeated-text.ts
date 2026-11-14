/**
 * Text that repeats across a site's pages - menus, category link lists, footers, "how to order" boxes that
 * are not marked up as navigation - is kept once, on the first page that shows it, and removed from the rest.
 *
 * Why: every page carried the same menu and footer text. A cake shop's 500 pages each became partly
 * "navigation menu" pieces; a search for one cake returned such pieces from unrelated product pages, and a
 * reply's page budget went to link lists (2026-11-14). No rule on a single page separates content from menus
 * (a "main area" share threshold was tried: no value works) - what a menu IS, is text most pages share.
 *
 * Code compares lines for equality and counts pages; it never reads what a line says.
 *   - A line is "shared" when it appears on at least SHARE of the pages (and on MIN_PAGES at least).
 *   - Only a RUN of shared lines in a row is removed (RUN_LINES lines, or RUN_CHARS characters): a single
 *     shared line between a page's own lines is a label of that page's content ("symbol:", "cena za 1 kg")
 *     and stays. So does the line at either end of a run that touches the page's own text in the same
 *     section: "90 zł / cena za kg / <footer...>" must not lose its unit to the footer.
 *   - Each line of a removed run stays on the first page that shows it; nothing is lost from the site.
 */
import type { MarkdownSection } from "../scraper/markdown.js";

const MIN_PAGES = 4;   // smaller sites are left as they are
const SHARE = 0.4;     // of the site's pages
const RUN_LINES = 3;
const RUN_CHARS = 200;

export interface RepeatedTextStats { pages: number; sharedLines: number; charsBefore: number; charsAfter: number }

const keyOf = (line: string) => line.replace(/\s+/g, " ").trim();

interface Entry { section: number; line: number; key: string } // line -1 = the section's heading

function entriesOf(sections: MarkdownSection[]): Entry[] {
  const out: Entry[] = [];
  sections.forEach((s, si) => {
    const h = keyOf(s.heading || "");
    if (h) out.push({ section: si, line: -1, key: `# ${h}` });
    s.content.split("\n").forEach((l, li) => { const key = keyOf(l); if (key) out.push({ section: si, line: li, key }); });
  });
  return out;
}

/** The pages' sections (same order) with repeated runs removed from all but the first page showing them. */
export function dropRepeatedText(pages: MarkdownSection[][]): { pages: MarkdownSection[][]; stats: RepeatedTextStats } {
  const size = (p: MarkdownSection[][]) => p.reduce((n, ss) => n + ss.reduce((m, s) => m + s.heading.length + s.content.length, 0), 0);
  const charsBefore = size(pages);
  if (pages.length < MIN_PAGES) return { pages, stats: { pages: pages.length, sharedLines: 0, charsBefore, charsAfter: charsBefore } };

  const perPage = pages.map(entriesOf);
  const seenOn = new Map<string, number>();
  for (const entries of perPage) for (const key of new Set(entries.map((e) => e.key))) seenOn.set(key, (seenOn.get(key) || 0) + 1);
  const limit = Math.max(MIN_PAGES, Math.ceil(pages.length * SHARE));
  const shared = (key: string) => (seenOn.get(key) || 0) >= limit;

  const keptOnce = new Set<string>();
  const out = pages.map((sections, p) => {
    const entries = perPage[p];
    const drop = new Set<Entry>();
    for (let a = 0; a < entries.length; ) {
      if (!shared(entries[a].key)) { a++; continue; }
      let b = a;
      while (b < entries.length && shared(entries[b].key)) b++;
      // The line at either end that touches the page's own text in the same section stays with it.
      const from = a > 0 && entries[a - 1].section === entries[a].section ? a + 1 : a;
      const to = b < entries.length && entries[b].section === entries[b - 1].section ? b - 1 : b;
      const run = entries.slice(from, Math.max(from, to));
      const long = run.length >= RUN_LINES || run.reduce((n, e) => n + e.key.length, 0) >= RUN_CHARS;
      // Of a run, the lines some earlier page already keeps go; lines new here stay (this is their one copy).
      if (long) for (const e of run) { if (keptOnce.has(e.key)) drop.add(e); else keptOnce.add(e.key); }
      a = b;
    }
    if (!drop.size) return sections;
    const dropLines = new Map<number, Set<number>>();
    for (const e of drop) { if (!dropLines.has(e.section)) dropLines.set(e.section, new Set()); dropLines.get(e.section)!.add(e.line); }
    const kept: MarkdownSection[] = [];
    sections.forEach((s, si) => {
      const gone = dropLines.get(si);
      if (!gone) { kept.push(s); return; }
      const content = s.content.split("\n").filter((_, li) => !gone.has(li)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
      // A heading goes only together with all of its text: over text that stays it is that text's heading.
      if (!content && (gone.has(-1) || !keyOf(s.heading || ""))) return;
      kept.push({ ...s, content });
    });
    return kept;
  });
  return { pages: out, stats: { pages: pages.length, sharedLines: [...seenOn.values()].filter((n) => n >= limit).length, charsBefore, charsAfter: size(out) } };
}
