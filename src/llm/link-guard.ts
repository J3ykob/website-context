/**
 * Link guard: every link the model writes to the tenant's own site must point at
 * a page the crawl actually found. The model used to build URLs from page titles
 * (keeping Polish letters: /badania-na-broń/, turning the /okulista/ page title
 * into /badania-okulistyczne-do-pracy-warszawa/) or mistype long slugs
 * (/…-lekarszych-…/). A link that is not a known page is mapped to the real page
 * it was meant as (same slug without diacritics, near-identical slug, or a slug
 * built from a page title); if none matches, the link is removed and its text kept.
 * Links to other domains are left to the output guard.
 */

export interface KnownPage { url: string; title?: string }
export interface LinkIndex {
  host: string;
  byNorm: Map<string, string>; // normalised path -> canonical URL
  byFolded: Map<string, string>; // diacritic-free path -> canonical URL
  byTitle: Map<string, string>; // slug of the page title -> canonical URL
  folded: [string, string][]; // [folded path, canonical URL]
}

const stripHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l");
}

function pathOf(u: URL): string {
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch {}
  p = p.toLowerCase().replace(/\/+$/, "");
  return p || "/";
}

function slugify(t: string): string {
  return "/" + fold(t).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Page titles carry a brand suffix ("X - Amygdala", "X | AMYGDALA"): the model
// slugs the first segment.
function titleSlugs(title: string): string[] {
  const first = title.split(/\s+[|–—-]\s+/)[0] || title;
  return [...new Set([slugify(first), slugify(title)])].filter((s) => s.length > 2);
}

export function buildLinkIndex(pages: KnownPage[]): LinkIndex | null {
  let host = "";
  const byNorm = new Map<string, string>();
  const byFolded = new Map<string, string>();
  const byTitle = new Map<string, string>();
  for (const p of pages) {
    let u: URL;
    try { u = new URL(p.url); } catch { continue; }
    if (!host) host = stripHost(u.hostname);
    if (stripHost(u.hostname) !== host) continue;
    const path = pathOf(u);
    if (!byNorm.has(path)) byNorm.set(path, p.url);
    if (!byFolded.has(fold(path))) byFolded.set(fold(path), p.url);
    for (const s of titleSlugs(p.title || "")) if (!byTitle.has(s)) byTitle.set(s, p.url);
  }
  if (!host) return null;
  return { host, byNorm, byFolded, byTitle, folded: [...byFolded.entries()] };
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** The known page a link was meant as, or null. */
export function resolveLink(href: string, index: LinkIndex): string | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }
  const path = pathOf(u);
  const exact = index.byNorm.get(path);
  if (exact) return exact + (u.hash || "");
  const f = fold(path);
  const noDiacritics = index.byFolded.get(f);
  if (noDiacritics) return noDiacritics;
  const fromTitle = index.byTitle.get(f);
  if (fromTitle) return fromTitle;
  let best: string | null = null;
  let bestScore = 0;
  for (const [kp, url] of index.folded) {
    const s = similarity(f, kp);
    if (s > bestScore) { bestScore = s; best = url; }
  }
  // Typos in a long slug ("lekarszych", "psychiatriczna") stay above 0.85; a
  // different page with a shared prefix does not.
  return bestScore >= 0.85 && f.length >= 8 ? best : null;
}

export function guardLinks(text: string, index: LinkIndex | null): { text: string; fixed: number; dropped: number } {
  if (!index) return { text, fixed: 0, dropped: 0 };
  let fixed = 0;
  let dropped = 0;
  const onSite = (href: string) => {
    try { return stripHost(new URL(href).hostname) === index.host; } catch { return false; }
  };
  // Markdown links first.
  let out = text.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g, (m, label: string, href: string) => {
    if (!onSite(href)) return m;
    const real = resolveLink(href, index);
    if (real === null) { dropped++; return label; }
    if (real !== href) fixed++;
    return `[${label}](${real})`;
  });
  // Bare on-site URLs outside markdown links.
  out = out.replace(/(^|[\s(<])(https?:\/\/[^\s)<>\]]+)/g, (m, pre: string, href: string) => {
    const trail = href.match(/[.,;:!?]+$/)?.[0] || "";
    const clean = trail ? href.slice(0, -trail.length) : href;
    if (!onSite(clean)) return m;
    const real = resolveLink(clean, index);
    if (real === null) { dropped++; return pre + trail; }
    if (real !== clean) fixed++;
    return pre + real + trail;
  });
  return { text: out, fixed, dropped };
}
