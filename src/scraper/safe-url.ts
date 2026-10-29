/**
 * Fetches only reach the public internet: a scrape (onboarding takes any domain; the dashboard's URL
 * import any URL) must not read our own network - localhost, private ranges, cloud metadata
 * (169.254.169.254) - and hand it back as "knowledge" (open until 2026-10-29). Checked for the URL and
 * for every redirect hop, on the addresses the name resolves to.
 */
import { lookup } from "dns/promises";
import { isIP } from "net";

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return isIP(x.slice(7)) === 4 ? privateV4(x.slice(7)) : true;
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff");
}

/** Throws unless the URL is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(raw: string): Promise<void> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("invalid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("blocked host");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true }).catch(() => { throw new Error(`cannot resolve ${host}`); });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error("blocked address (not public)");
}

/** fetch() for site content: public addresses only, redirects followed by hand and each hop checked. */
export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let target = url;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(target);
    const r = await fetch(target, { ...init, redirect: "manual" });
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!loc || hop >= 8) return r;
    target = new URL(loc, target).toString();
  }
}
