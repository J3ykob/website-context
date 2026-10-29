import type { Request } from "express";

/**
 * The visitor's IP. Every request reaches Render through Cloudflare, which sets CF-Connecting-IP to the
 * real client and overwrites any value the client sent (checked 2026-10-29 with a spoofed header, also
 * via the onrender.com host). X-Forwarded-For's FIRST entry is whatever the client sent - it was used
 * for rate limits until then, so any limit could be dodged by sending a different value each time.
 */
export function clientIp(req: Request): string {
  const cf = String(req.headers["cf-connecting-ip"] || "").trim();
  if (cf) return cf;
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket?.remoteAddress || req.ip || "unknown");
}
