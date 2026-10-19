/**
 * A business that has not joined learns about a real request after the customer got its part (prepared
 * from its public data, marked as not confirmed): one plain-text email with the request, what was
 * prepared, and a link - no account - where it can confirm or correct it. Joining the network is free.
 *
 * At most one email per business a day, never to a business that said no (settings.networkOptOut).
 * The recipient is settings.inviteEmail (set by an admin) or the tenant's email. The template is sent only
 * once approved (NETWORK_INVITE_EMAIL_APPROVED=1); until then only to the Whisp owner's own address, and
 * every invite - sent or not - is recorded with its full text (event "business_invited").
 */
import { getProject, addEvent } from "./store.js";
import { readFile } from "./repo.js";
import { d1Query } from "../storage/conversation-store.js";
import { getTenant } from "../multi-tenant/d1-registry.js";

const PER_DAY = 24 * 3600_000;

// The email: strictly the inquiry and the link; joining is one line. Plain text.
export interface NetworkInvite { business: string; from: string; domain: string; request: string; answer: string; link: string }

export function networkInviteText(m: NetworkInvite): { subject: string; text: string } {
  return {
    subject: "Nowe zapytanie klienta o Waszą ofertę",
    text: `Dzień dobry,

klient firmy ${m.from} szukał:
${m.request}

To jest w Waszej ofercie, więc asystent Whisp przygotował odpowiedź na podstawie Waszego cennika${m.domain ? ` (${m.domain})` : ""} i przekazał ją klientowi:
${m.answer || "(w cenniku nie ma ceny - klient wie, że wycenę podacie Wy)"}

Potwierdźcie ją albo poprawcie tutaj - to zajmie minutę, bez zakładania konta:
${m.link}

Whisp łączy lokalne firmy: gdy klient jednej z nich potrzebuje czegoś z Waszej oferty, zapytanie trafia do Was. Dołączenie jest bezpłatne - wtedy takie zapytania przychodzą najpierw do Was, a asystent przygotowuje odpowiedzi do Waszej akceptacji.

Nie chcecie takich zapytań? Wystarczy odpisać.

Whisp - whisp.so`,
  };
}

let ready: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  ready ||= d1Query("CREATE TABLE IF NOT EXISTS network_invites (tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, token TEXT NOT NULL, emailed INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, project_id))")
    .then(() => undefined).catch((e) => { ready = null; throw e; });
  return ready;
}

export async function inviteListed(subId: string): Promise<void> {
  await ensureSchema();
  const sub = await getProject(subId);
  const run = sub?.memory.agentRun as { runId?: string } | undefined;
  if (!sub || !run?.runId) return;
  const tenantId = sub.initiatorTenantId;
  const t = getTenant(tenantId);
  const { businessLabel } = await import("./network.js");
  const { openReview } = await import("./review.js");
  const answer = ((await readFile(subId, "odpowiedz.txt").catch(() => null)) || "").trim();
  // The page where the business sees the request and confirms or corrects the answer (no owner email).
  const rv = await openReview(subId, tenantId, run.runId, answer, [], false);
  const recent = await d1Query("SELECT COUNT(*) AS n FROM network_invites WHERE tenant_id = ? AND emailed = 1 AND created_at > ?", [tenantId, new Date(Date.now() - PER_DAY).toISOString()]);
  const to = String(t?.settings?.inviteEmail || t?.email || "").trim();
  const reason = t?.settings?.networkOptOut ? "opted out" : !to ? "no address" : Number(recent[0]?.n) > 0 ? "already emailed today" : "";
  // The link must work from an email: an absolute https address, whatever BASE_URL holds.
  let base = (process.env.BASE_URL || "").trim();
  if (!base.startsWith("http")) base = "https://whisp.so";
  while (base.endsWith("/")) base = base.slice(0, -1);
  const request = ((await readFile(subId, "rozmowa.md").catch(() => null)) || "").split("\n").filter((l) => l.startsWith("**")).map((l) => l.slice(l.indexOf(":**") + 3).trim()).join("\n") || String(sub.title);
  const mail = {
    business: businessLabel(tenantId),
    from: businessLabel(String(sub.memory.fromTenant || "")),
    domain: t?.domain || "",
    request: request.slice(0, 800),
    answer: answer.slice(0, 1500),
    link: `${base}/review/${rv.token}`,
  };
  const text = networkInviteText(mail);
  let emailed = false;
  if (!reason) {
    try {
      const { sendNetworkInviteEmail } = await import("../multi-tenant/email.js");
      emailed = await sendNetworkInviteEmail(to, text);
    } catch (e) { console.warn(`[invite] ${subId}: not emailed (${(e as Error).message})`); }
  }
  await d1Query("INSERT OR IGNORE INTO network_invites (tenant_id, project_id, token, emailed, created_at) VALUES (?, ?, ?, ?, ?)", [tenantId, subId, rv.token, emailed ? 1 : 0, new Date().toISOString()]);
  await addEvent(subId, { kind: "business_invited", actor: "system", data: { to, emailed, reason: reason || (emailed ? "" : "not sent (template awaiting approval, no email key, or send failed)"), link: mail.link, ...text } });
}
