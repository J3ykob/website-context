/**
 * Offline page check of the password pages and the two pages that open the dashboard (login.html "Forgot
 * password?", setup.html set/reset modes, dashboard.html's 401 handling, lead.html's dashboard button).
 * The pages are served from this checkout against a stub API; every request that is not to the local stub is
 * aborted (no fonts, no production, nobody is e-mailed). The server side is covered by
 * src/multi-tenant/password-reset.test.ts and src/projects/lead.test.ts.
 *
 * Usage: npx tsx tests/e2e/auth-pages.mts        (exit 1 on any FAIL)
 */
import express from "express";
import { chromium, type Page } from "playwright";
import { fileURLToPath } from "url";
import { resolve } from "path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const app = express();
app.use(express.json());
const seen: { url: string; body: any }[] = [];
let forgotStatus = 200, resetStatus = 200, linkStatus = 200, forgotSending = true;
let resetAnswer: any = { token: "sess", tenantId: "acme_pl", signedOut: true };
const revoked = new Set<string>();
const DEAD = "This link has expired or was already used. Ask for a new one on the login page.";
app.get("/auth/login", (_q, r) => r.sendFile(resolve(root, "public/auth/login.html")));
app.get("/auth/setup", (_q, r) => r.sendFile(resolve(root, "public/auth/setup.html")));
app.get("/dashboard", (_q, r) => r.sendFile(resolve(root, "public/dashboard.html")));
app.get("/lead/:token", (_q, r) => r.sendFile(resolve(root, "public/lead.html")));
app.post("/api/auth/login", (q, r) => { seen.push({ url: q.url, body: q.body }); r.status(401).json({ error: "Password not set. Use setup-password endpoint." }); });
app.post("/api/auth/forgot-password", (q, r) => {
  seen.push({ url: q.url, body: q.body });
  if (forgotStatus === 200) r.json({ ok: true, minutes: 60, sending: forgotSending });
  else r.status(forgotStatus).json({ error: "Too many requests. Try again later." });
});
app.post("/api/auth/reset-link", (q, r) => {
  seen.push({ url: q.url, body: q.body });
  if (linkStatus === 200) r.json({ domain: "acme.pl" });
  else r.status(linkStatus).json({ error: DEAD });
});
app.post("/api/auth/reset-password", (q, r) => {
  seen.push({ url: q.url, body: q.body });
  if (resetStatus !== 200) { r.status(resetStatus).json({ error: DEAD }); return; }
  revoked.add("old"); // the reset ends the account's other sessions
  r.json(resetAnswer);
});
app.post("/api/auth/setup-password", (q, r) => { seen.push({ url: q.url, body: q.body }); r.status(401).json({ error: "Invalid or expired setup token" }); });
// A subscribed business's lead page: "owner" has a password (the button opens the login), "member" has none.
app.get("/api/lead/:token", (_q, r) => r.json({ status: "unlocked", unlocked: true, business: "Acme", from: "Beta", brand: "Whisp", teaser: "", hiddenChars: 0, request: "Rusztowanie 120 m2", answer: "", expiresAt: new Date(Date.now() + 3600_000).toISOString(), pricePln: 149, payments: true, phone: "", manage: true, demoUrl: "/demo/acme_pl" }));
app.post("/api/lead/:token/dashboard", (q, r) => { r.json(q.params.token === "owner" ? { login: true } : { token: "lead-sess", tenantId: "gamma_pl" }); });
// The dashboard's own API: a revoked or missing session is a 401, everything else an empty answer.
app.use("/api", (q, r) => {
  const tok = String(q.headers.authorization || "").replace("Bearer ", "");
  if (!tok || revoked.has(tok)) { r.status(401).json({ error: "Invalid or expired session" }); return; }
  if (q.originalUrl.split("?")[0] === "/api/dashboard/billing") { r.json({ access: true }); return; }
  r.json({});
});
const server = app.listen(0, "127.0.0.1");
await new Promise((ok) => server.once("listening", ok));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const browser = await chromium.launch();
const out: string[] = [];
const check = (name: string, cond: boolean, extra = "") => out.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` - ${extra}` : ""}`);
async function page(lang: "en" | "pl"): Promise<Page> {
  const ctx = await browser.newContext({ locale: lang === "pl" ? "pl-PL" : "en-US" });
  await ctx.route("**/*", (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  ctx.setDefaultTimeout(5000);
  return ctx.newPage();
}
const text = (p: Page, sel: string) => p.locator(sel).innerText({ timeout: 3000 }).catch(() => "(missing)");
const visible = (p: Page, sel: string) => p.locator(sel).isVisible();
const stored = (p: Page) => p.evaluate(() => localStorage.getItem("wctx-dashboard-token"));
// One scenario per block: a step that throws (an element or a page that never came) is a FAIL, and the run goes on.
const lastTo = (path: string) => [...seen].reverse().find((s) => s.url === path);
async function scenario(name: string, fn: () => Promise<void>) {
  forgotStatus = 200; resetStatus = 200; linkStatus = 200; forgotSending = true;
  resetAnswer = { token: "sess", tenantId: "acme_pl", signedOut: true }; revoked.clear();
  try { await fn(); } catch (e: any) { check(`${name}: ran to the end`, false, String(e?.message || e).split("\n")[0]); }
  for (const c of browser.contexts()) await c.close().catch(() => {});
}
async function fillPassword(p: Page) {
  await p.fill("#password", "new-password-1");
  await p.fill("#confirm", "new-password-1");
}

// 1. Login page, English: the forgot form in the same card, its own tab title, one answer for every address.
await scenario("forgot form", async () => {
  const p = await page("en");
  await p.goto(`${base}/auth/login`);
  await p.fill("#email", "Owner@Example.com ");
  await p.click("#forgot-link");
  check("EN forgot form shown, login form hidden", (await visible(p, "#forgot-form")) && !(await visible(p, "#login-form")));
  check("EN forgot title + tab title", (await text(p, "#title")) === "Forgot your password?" && (await p.title()) === "Reset password - Whisp", await p.title());
  check("EN e-mail carried over", (await p.inputValue("#forgot-email")) === "Owner@Example.com");
  await p.click("#forgot-btn");
  await p.waitForSelector("#forgot-msg.visible");
  const sentMsg = await text(p, "#forgot-msg");
  check("EN sent message: minutes, the support address when nothing arrives, the way without a password",
    sentMsg.includes("works for 60 minutes") && sentMsg.includes("Nothing arrived? Check your spam folder or write to jakub@whisp.so.") && sentMsg.includes("Never set a password?"), sentMsg);
  const last = seen[seen.length - 1];
  check("EN request body", last.url === "/api/auth/forgot-password" && last.body.email === "Owner@Example.com" && last.body.lang === "en", JSON.stringify(last.body));
  await p.click("#lang-toggle");
  const plMsg = await text(p, "#forgot-msg");
  check("switch to PL re-renders message, title, tab title", plMsg.includes("Link działa przez 60") && plMsg.includes("albo napisz do nas (jakub@whisp.so)") && (await text(p, "#title")) === "Nie pamiętasz hasła?" && (await p.title()) === "Nowe hasło - Whisp", plMsg);
  forgotSending = false; // resets cannot reach anyone yet (e-mail not approved): the page says so, no promised link
  await p.click("#forgot-btn");
  await p.waitForFunction(() => document.getElementById("forgot-msg")!.textContent!.includes("nie wysyłamy jeszcze"));
  check("PL nothing can be sent: the support address instead of a link", (await text(p, "#forgot-msg")).startsWith("Linków do zmiany hasła nie wysyłamy jeszcze") && !(await text(p, "#forgot-msg")).includes("wysłaliśmy"), await text(p, "#forgot-msg"));
  await p.click("#lang-toggle");
  check("EN nothing can be sent, after the switch", (await text(p, "#forgot-msg")) === "We can't send password links by e-mail yet. Write to jakub@whisp.so and we'll get you back into your dashboard.", await text(p, "#forgot-msg"));
  await p.click("#lang-toggle");
  forgotSending = true;
  forgotStatus = 429;
  await p.click("#forgot-btn");
  await p.waitForSelector("#error-msg.visible");
  check("PL 429 text", (await text(p, "#error-msg")) === "Za dużo prób. Spróbuj ponownie później.", await text(p, "#error-msg"));
  forgotStatus = 200;
  await p.click("#back-link");
  check("back to login: form, title, tab title", (await visible(p, "#login-form")) && !(await visible(p, "#forgot-form")) && (await text(p, "#title")) === "Zaloguj się" && (await p.title()) === "Logowanie - Whisp", await p.title());
  await p.context().close();
});

// 1b. Login answered 401 in English: the page's own words with the way on, not the API's developer text.
await scenario("login 401, English", async () => {
  const p = await page("en");
  await p.goto(`${base}/auth/login`);
  await p.fill("#email", "owner@example.com");
  await p.fill("#password", "some-password-1");
  await p.click("#submit-btn");
  await p.waitForSelector("#error-msg.visible");
  const msg = await text(p, "#error-msg");
  check("EN login 401: page text with the way on", msg.startsWith("Wrong e-mail or password.") && msg.includes("jakub@whisp.so") && !msg.includes("setup-password endpoint"), msg);
  await p.context().close();
});

// 2. Reset link for a .pl business: Polish by default, no Terms box, its own chrome, posts the fragment token.
await scenario("reset link, Polish", async () => {
  const p = await page("en");
  await p.goto(`${base}/auth/setup?tenant=acme_pl#reset=TOKEN.abc`);
  check("PL reset title (tenant *_pl) + tab title", (await text(p, "h1")) === "Ustaw nowe hasło" && (await p.title()) === "Ustaw nowe hasło - Whisp", await p.title());
  check("token taken out of the address bar (query kept)", p.url() === `${base}/auth/setup?tenant=acme_pl`, p.url());
  await p.waitForFunction(() => document.getElementById("subtitle")!.textContent!.includes("acme.pl"));
  check("the business the link is for, before anything is typed", (await text(p, "#subtitle")).startsWith("Wybierz nowe hasło do panelu firmy acme.pl w") && lastTo("/api/auth/reset-link")?.body.token === "TOKEN.abc", await text(p, "#subtitle"));
  await p.click("#lang-toggle");
  check("the business stays after a language switch", (await text(p, "#subtitle")).startsWith("Choose a new password for the Whisp dashboard of acme.pl."), await text(p, "#subtitle"));
  await p.click("#lang-toggle");
  check("Terms box hidden in reset mode", !(await visible(p, "#terms-row")));
  check("footer leads back to the login", !(await visible(p, "#footer-q")) && (await text(p, "#footer-a")) === "Wróć do logowania", await text(p, "#footer-a"));
  check("form shown (no invalid-link error)", (await visible(p, "#setup-form")) && !(await visible(p, "#error-msg")));
  check("button text", (await text(p, "#submit-btn")) === "Zapisz nowe hasło", await text(p, "#submit-btn"));
  await fillPassword(p);
  resetStatus = 401;
  await p.click("#submit-btn");
  await p.waitForSelector("#error-msg.visible");
  check("PL 401 text for a used link", (await text(p, "#error-msg")).startsWith("Ten link wygasł albo został już użyty"), await text(p, "#error-msg"));
  const last = seen[seen.length - 1];
  check("reset request body", last.url === "/api/auth/reset-password" && last.body.token === "TOKEN.abc" && last.body.password === "new-password-1" && !("tenantId" in last.body), JSON.stringify(last.body));
  resetStatus = 200;
  await p.click("#submit-btn");
  await p.waitForSelector("#success-msg.visible");
  check("PL success text, no warning", (await text(p, "#success-msg")) === "Hasło zmienione - przenosimy Cię do panelu..." && !(await visible(p, "#error-msg")), await text(p, "#success-msg"));
  await p.waitForURL(`${base}/dashboard`, { timeout: 5000 });
  check("redirect to dashboard + session stored", (await stored(p)) === "sess");
  await p.context().close();
});

// 3. Password saved but no session: its own text, then the login page without this account's dead token.
await scenario("reset without a session", async () => {
  const p = await page("en");
  await p.goto(`${base}/auth/setup`); // same origin, to hold the old session before the link opens
  await p.evaluate(() => { localStorage.setItem("wctx-dashboard-token", "dead"); localStorage.setItem("wctx-tenant-id", "acme_pl"); });
  await p.goto(`${base}/auth/setup?tenant=acme_pl#reset=T3`);
  await fillPassword(p);
  resetAnswer = { token: "", tenantId: "acme_pl", signedOut: true };
  await p.click("#submit-btn");
  await p.waitForSelector("#success-msg.visible");
  check("no session: PL text says log in", (await text(p, "#success-msg")) === "Hasło zmienione - zaloguj się nowym hasłem.", await text(p, "#success-msg"));
  await p.waitForURL(`${base}/auth/login`, { timeout: 5000 });
  await p.waitForTimeout(300);
  check("no session: stays on the login page, the dead token dropped", p.url() === `${base}/auth/login` && (await stored(p)) === null, p.url());
  await p.context().close();
});

// 4. No session, and the browser holds another business's session: the login form is shown, not that dashboard.
await scenario("reset without a session, another business signed in", async () => {
  const p = await page("en");
  await p.goto(`${base}/auth/setup?tenant=acme_com#reset=T4`);
  await p.evaluate(() => { localStorage.setItem("wctx-dashboard-token", "other"); localStorage.setItem("wctx-tenant-id", "beta_com"); });
  await fillPassword(p);
  resetAnswer = { token: "", tenantId: "acme_com", signedOut: true };
  await p.click("#submit-btn");
  await p.waitForSelector("#success-msg.visible");
  check("no session: EN text says log in", (await text(p, "#success-msg")) === "Password changed - log in with your new password.", await text(p, "#success-msg"));
  await p.waitForURL(`${base}/auth/login`, { timeout: 5000 });
  await p.waitForTimeout(300);
  check("no session: the login form, not another business's dashboard", p.url() === `${base}/auth/login` && (await visible(p, "#login-form")) && (await stored(p)) === null, p.url());
  await p.context().close();
});

// 5. The other devices could not be signed out: said plainly, with time to read it, then the dashboard.
await scenario("reset, other devices not signed out", async () => {
  const p = await page("en");
  await p.goto(`${base}/auth/setup?tenant=acme_com#reset=T5`);
  await fillPassword(p);
  resetAnswer = { token: "sess5", tenantId: "acme_com", signedOut: false };
  await p.click("#submit-btn");
  await p.waitForSelector("#error-msg.visible");
  check("not signed out: EN warning next to the success text", (await text(p, "#error-msg")).startsWith("We could not sign you out on your other devices") && (await visible(p, "#success-msg")), await text(p, "#error-msg"));
  await p.click("#lang-toggle");
  check("not signed out: PL warning after the switch", (await text(p, "#error-msg")).startsWith("Nie udało się wylogować Cię na innych urządzeniach"), await text(p, "#error-msg"));
  await p.waitForTimeout(2000);
  check("not signed out: still on the page after 2 s", p.url().includes("/auth/setup"), p.url());
  await p.waitForURL(`${base}/dashboard`, { timeout: 12000 });
  check("not signed out: then the dashboard with the new session", (await stored(p)) === "sess5");
  resetAnswer = { token: "sess", tenantId: "acme_pl", signedOut: true };
  await p.context().close();
});

// 6. Reset link in English, and the first-time setup link unchanged.
await scenario("reset in English, setup unchanged", async () => {
  const p = await page("en");
  await p.goto(`${base}/auth/setup?tenant=acme_com#reset=T2`);
  check("EN reset title + tab title", (await text(p, "h1")) === "Set a new password" && (await p.title()) === "Set a new password - Whisp", await p.title());
  // The e-mail was English (the login page's language): the link says so, and a .pl business's page follows it.
  await p.goto(`${base}/auth/setup?tenant=acme_pl#reset=T2b&lang=en`);
  check("the link's language over the *_pl rule", (await text(p, "h1")) === "Set a new password" && lastTo("/api/auth/reset-link")?.body.token === "T2b", await text(p, "h1"));
  await p.goto(`${base}/auth/setup?token=abc&tenant=acme_com`);
  check("setup mode unchanged: title, tab title, Terms box, footer", (await text(p, "h1")) === "Set your password" && (await p.title()) === "Set your password - Whisp" && (await visible(p, "#terms-row")) && (await text(p, "#footer-q")) === "Already have a password?", await text(p, "h1"));
  await fillPassword(p);
  await p.check("#terms");
  await p.click("#submit-btn");
  await p.waitForSelector("#error-msg.visible");
  const last = seen[seen.length - 1];
  check("setup still posts to setup-password with Terms", last.url === "/api/auth/setup-password" && last.body.termsAccepted === true && last.body.tenantId === "acme_com", JSON.stringify(last.body));
  check("EN set-password link that no longer works: the way on, not the API's words", (await text(p, "#error-msg")) === "This link no longer works. Already set a password? Log in. Never set one? Write to jakub@whisp.so and we'll send you a new link.", await text(p, "#error-msg"));
  await p.click("#lang-toggle");
  check("PL set-password link that no longer works", (await text(p, "#error-msg")) === "Ten link już nie działa. Masz już hasło? Zaloguj się. Nie masz jeszcze hasła? Napisz do nas (jakub@whisp.so) - wyślemy nowy link.", await text(p, "#error-msg"));
  await p.click("#lang-toggle");
  await p.goto(`${base}/auth/setup`);
  check("no token at all: invalid-link message", (await visible(p, "#error-msg")) && !(await visible(p, "#setup-form")));
  await p.goto(`${base}/auth/setup?tenant=acme_com&reset=T6q`);
  check("a token in the query string is not read (it would reach server logs)", (await visible(p, "#error-msg")) && !(await visible(p, "#setup-form")) && lastTo("/api/auth/reset-link")?.body.token !== "T6q");
  await p.context().close();
});

// 6b. A reset link already used or expired: said as the page opens, before a password is typed twice.
await scenario("dead reset link", async () => {
  linkStatus = 401;
  const p = await page("pl");
  await p.goto(`${base}/auth/setup?tenant=acme_pl#reset=T6b`);
  await p.waitForSelector("#error-msg.visible");
  check("PL dead link at once: its text, no form", (await text(p, "#error-msg")).startsWith("Ten link wygasł albo został już użyty") && !(await visible(p, "#setup-form")), await text(p, "#error-msg"));
  await p.click("#lang-toggle");
  check("EN dead link: the API's own words", (await text(p, "#error-msg")) === DEAD, await text(p, "#error-msg"));
  check("dead link: the footer leads back to the login", (await visible(p, "#footer-a")) && (await text(p, "#footer-a")) === "Back to log in");
  await p.context().close();
});

// 7. A dashboard tab still open with the old session while the reset logs the owner in, in another tab.
await scenario("two dashboard tabs", async () => {
  revoked.clear();
  const a = await page("pl");
  await a.goto(`${base}/auth/login`);
  await a.evaluate(() => { localStorage.setItem("wctx-dashboard-token", "old"); localStorage.setItem("wctx-tenant-id", "acme_pl"); });
  await a.goto(`${base}/dashboard`);
  await a.waitForTimeout(800);
  const b = await a.context().newPage();
  await b.goto(`${base}/auth/setup?tenant=acme_pl#reset=T7`);
  resetAnswer = { token: "new", tenantId: "acme_pl", signedOut: true };
  await fillPassword(b);
  await b.click("#submit-btn");
  await b.waitForURL(`${base}/dashboard`, { timeout: 5000 });
  await a.evaluate(() => (window as any).loadAll()).catch(() => {}); // tab A's next 30 s poll, still with "old"
  await a.waitForTimeout(1500);
  check("old tab's 401 keeps the new session", (await stored(b)) === "new");
  check("old tab reloads onto the dashboard with it", new URL(a.url()).pathname === "/dashboard" && (await a.evaluate(() => (window as any).AUTH_TOKEN)) === "new", a.url());
  await b.reload();
  await b.waitForTimeout(800);
  check("new tab stays on the dashboard after a reload", new URL(b.url()).pathname === "/dashboard", b.url());
  resetAnswer = { token: "sess", tenantId: "acme_pl", signedOut: true };
  await a.context().close();
});

// 8. The lead page's dashboard button: the login for an owner with a password, a session for a business without.
await scenario("lead page dashboard button", async () => {
  const p = await page("pl");
  await p.goto(`${base}/lead/owner`);
  await p.waitForSelector("#panel-card:not(.hidden)");
  await p.click("#panel");
  await p.waitForURL(`${base}/auth/login`, { timeout: 5000 });
  check("lead link, owner with a password: the login page, no session stored", (await stored(p)) === null, p.url());
  await p.goto(`${base}/lead/member`);
  await p.waitForSelector("#panel-card:not(.hidden)");
  await p.click("#panel");
  await p.waitForURL(`${base}/dashboard`, { timeout: 5000 });
  check("lead link, business without a password: its session, the dashboard", (await stored(p)) === "lead-sess", p.url());
  await p.context().close();
});

await browser.close();
server.close();
console.log(out.join("\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
