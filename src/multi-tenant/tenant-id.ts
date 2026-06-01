/**
 * Canonical tenant-id derivation.
 *
 * This MUST stay byte-for-byte identical to the VPS scraper's form
 * (`domain.replace(/[^a-zA-Z0-9]/g, "_")`, used in vps-outreach.ts / outreach-loop.ts
 * / scrape-as.ts etc.) so that the Render registry id, the Vectorize namespace
 * (`{id}__{chunkId}`), the R2 path (`tenants/{id}/...`), and the demo URL all agree.
 *
 * Historically createTenant used `domain.replace(/\./g, "_")` which KEEPS hyphens,
 * while the VPS replaced them with `_`. For a hyphenated domain (my-hotel.com) the
 * two diverged (`my-hotel_com` vs `my_hotel_com`), so the registered tenant queried
 * an empty vector namespace and served ungrounded — the audit's one critical hole.
 *
 * Do NOT add toLowerCase() or www-stripping here unless every VPS call site is
 * changed in lockstep, or new ids will diverge from already-stored vectors/R2.
 */
export function normalizeTenantId(domainOrUrl: string): string {
  let host = domainOrUrl;
  try {
    if (/^https?:\/\//i.test(domainOrUrl)) host = new URL(domainOrUrl).hostname;
  } catch {
    /* fall back to the raw string */
  }
  return host.replace(/[^a-zA-Z0-9]/g, "_");
}
