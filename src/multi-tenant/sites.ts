/**
 * One owner, several businesses: the sites a dashboard session may switch between (owner 2026-11-18 - an owner who
 * signed up two sites with one e-mail saw only the one his login opened).
 *
 * The address is the identity, so the rule is about who has PROVEN the mailbox:
 * - the session's own account has a confirmed address (the set-password or reset link was used, or a password login -
 *   src/multi-tenant/password-reset.ts) and its password was not set with the apiKey: the key goes to whoever signs
 *   up, with any address typed, so such an account proves no mailbox;
 * - a site to switch to carries the same address and is either confirmed the same way, or has no password at all:
 *   nobody holds an account on it, and it was registered to this mailbox (its set-password link goes there).
 * A site whose password somebody else may hold (apiKey-claimed, or an unconfirmed address) is never listed.
 */
import { listTenants, type TenantRecord } from "./d1-registry.js";
import { addressConfirmed } from "./password-reset.js";

const norm = (e: unknown) => String(e || "").trim().toLowerCase();
const proven = (t: TenantRecord) => !!t.ownerPasswordHash && addressConfirmed(t) && !t.settings?.claimedWithApiKey;
const unclaimed = (t: TenantRecord) => !t.ownerPasswordHash;

/** The businesses the owner of `current` may open, `current` first, then newest first. [] when its address is not proven. */
export function ownedSites(current: TenantRecord, all: TenantRecord[] = listTenants()): TenantRecord[] {
  if (!proven(current)) return [];
  const address = norm(current.email);
  const others = all.filter((t) => t.id !== current.id && norm(t.email) === address && (proven(t) || unclaimed(t)));
  others.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return [current, ...others];
}

/** Whether the owner of `current` may switch to `targetId`. */
export function maySwitch(current: TenantRecord, targetId: string, all?: TenantRecord[]): boolean {
  return ownedSites(current, all).some((t) => t.id === targetId);
}

/**
 * A plan given to an ADDRESS, not to one site (owner 2026-11-19 - a partner who demos Whisp to clients adds a domain
 * and needs its full panel at once; a client who tries it with their own address gets the ordinary paid panel).
 * The mark (settings.billingExemptAddress, set by an admin) sits on one of the address's sites; it opens the panel of
 * every site the SESSION's account may open - the same proof of the mailbox as the switch, so typing the partner's
 * address at sign-up opens nothing.
 */
export function addressPlan(account: TenantRecord, targetId: string, all?: TenantRecord[]): boolean {
  const sites = ownedSites(account, all);
  return sites.some((t) => t.id === targetId) && sites.some((t) => t.settings?.billingExemptAddress === true);
}
