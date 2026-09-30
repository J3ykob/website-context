/**
 * E2E: the Amygdala booking flow (agent flow on the live registration site),
 * driven through the production widget by a simulated customer who writes in
 * Polish, English, Ukrainian or French.
 *
 * The customer is a model with a fixed profile that answers the assistant in
 * its language (no phrase matching on the assistant's messages, so any language
 * works). Jev checks every assistant message is in the customer's language. The
 * run passes when the registration reaches its summary page (the final
 * "ZAKOŃCZ" button is shown) - it is never clicked, and every non-GET request
 * to amygdala.pl is blocked, so no real booking can be made.
 *
 * Usage: OPENROUTER_API_KEY=... JEV_API_KEY=... npx tsx tests/e2e/agent-flow-languages.mts [pl,en,uk,fr]
 */
import { chromium, type Page } from "playwright";
import { jevAsk } from "../../src/llm/jev.js";

const LANGS: Record<string, { name: string; first: string }> = {
  pl: { name: "Polish", first: "Jestem kierowcą taxi, zapisz mnie na Pragę na środę." },
  en: { name: "English", first: "I'm a taxi driver, please book me in at the Praga branch on Wednesday." },
  uk: { name: "Ukrainian", first: "Я таксист, запишіть мене у відділення на Празі на середу." },
  fr: { name: "French", first: "Je suis chauffeur de taxi, inscrivez-moi à l'agence de Praga mercredi." },
};
const PROFILE = `You are a taxi driver booking the full exam package for taxi drivers (medical + psychological + eye doctor). You want the branch in the Praga district of Warsaw, on Wednesday; if asked for an hour, take 12:00 or the free hour closest to it. Your details: name Jan, surname Testowy, email jan.testowy@example.com, phone 500600700. No notes before the visit. You pay on site, not online. You agree to the consents.`;
const BOOKMARK = "(function(){window.__wctx={apiHost:'https://whisp.so',tenantId:'www_amygdala_pl',brandName:'Amygdala'};var s=document.createElement('script');s.src='https://whisp.so/widget.js?'+Date.now();document.body.appendChild(s);})();";

async function llm(system: string, user: string): Promise<string> {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || "qwen/qwen3-235b-a22b-2507", temperature: 0, max_tokens: 200, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  return ((await r.json()) as any).choices[0].message.content;
}
function json(raw: string): any {
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  try { return a >= 0 && b > a ? JSON.parse(raw.slice(a, b + 1)) : null; } catch { return null; }
}

/** The simulated customer's next move after an assistant message. */
async function customer(lang: string, assistant: string, history: string[]): Promise<{ action: string; text?: string; consent?: string }> {
  const j = json(await llm(
    `${PROFILE}\nYou write only in ${LANGS[lang].name}, briefly, like a real customer in a chat. Output only JSON.`,
    `Conversation so far:\n${history.slice(-10).join("\n")}\n\nThe assistant just wrote:\n"""${assistant}"""\n\nYour next move as JSON:
- {"action": "wait"} if the message is only a status or needs no answer (e.g. "one moment", "clicking ...").
- {"action": "tick", "consent": "<the consent's own text, copied from the assistant's message>", "text": "<short 'done' in your language>"} if the assistant asks you to tick a consent yourself.
- {"action": "done"} if the assistant says everything is ready and asks you to check the details and click the final button.
- {"action": "manual"} if the assistant asks you to do a step by hand on the page.
- {"action": "say", "text": "<your answer in ${LANGS[lang].name}>"} otherwise (answer what it asks, following your profile).`,
  ));
  return j && typeof j.action === "string" ? j : { action: "wait" };
}

async function inLanguage(text: string, lang: string): Promise<number> {
  // The assistant's own words must be in the customer's language; option names,
  // dates and field labels it lists or quotes from the (Polish) website may not be.
  const a: any = await jevAsk({ text }, { ok: { type: "noul", instructions: `Leaving out any items listed or quoted from the website (option names, dates, field labels), are the assistant's own sentences in \`text\` written in ${LANGS[lang].name}?` } }, 8000);
  return a?.ok?.noul ?? 1;
}

async function tick(p: Page, consent: string): Promise<boolean> {
  const needle = consent.replace("…", "").slice(0, 40);
  return p.evaluate((q) => {
    const all = [...document.querySelectorAll("label, span, p, div")].filter((e) => e.children.length < 6 && (e.textContent || "").includes(q));
    for (const e of all) {
      let n: Element | null = e;
      for (let k = 0; k < 5 && n; k++, n = n.parentElement) {
        const cb = n.querySelector('input[type="checkbox"]:not(:checked), [role="checkbox"][aria-checked="false"]');
        if (cb) { (cb as HTMLElement).click(); return true; }
      }
    }
    return false;
  }, needle).catch(() => false);
}

async function run(lang: string): Promise<{ lang: string; ok: boolean; secs: number; wrongLanguage: string[]; summary: string }> {
  const b = await chromium.launch();
  const p = await b.newPage({ locale: "pl-PL", viewport: { width: 1366, height: 900 } });
  await p.route("**/*", (r) => (r.request().method() !== "GET" && r.request().url().includes("amygdala.pl") ? r.abort() : r.continue()));
  await p.goto("https://rejestracja.amygdala.pl/", { waitUntil: "networkidle", timeout: 45000 });
  await p.evaluate(BOOKMARK);
  await p.waitForSelector(".wctx-bar-input", { timeout: 15000 });
  const t0 = Date.now();
  const T = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  const history: string[] = [];
  const say = async (text: string) => { console.log(`  ${T()} >> ${text}`); history.push(`Customer: ${text}`); await p.fill(".wctx-bar-input", text); await p.press(".wctx-bar-input", "Enter"); };
  const botMessages = () => p.$$eval(".wctx-messages .wctx-msg-assistant", (es) => es.map((e) => (e as HTMLElement).innerText.trim()).filter((t) => t && !t.startsWith("⚙")));
  const finalShown = () => p.getByRole("button", { name: "ZAKOŃCZ" }).first().isVisible().catch(() => false);

  await say(LANGS[lang].first);
  const wrongLanguage: string[] = [];
  let seen = 0, done = false;
  while (!done && Date.now() - t0 < 300000) {
    await p.waitForTimeout(1000);
    const ms = await botMessages();
    while (seen < ms.length && !done) {
      const m = ms[seen++];
      console.log(`  ${T()} << ${m.split("\n").join(" / ").slice(0, 160)}`);
      history.push(`Assistant: ${m}`);
      const score = await inLanguage(m, lang);
      if (score < 0.5) { wrongLanguage.push(m.slice(0, 120)); console.log(`       !! not ${LANGS[lang].name} (${score.toFixed(2)})`); }
      const next = await customer(lang, m, history);
      if (next.action === "done") { done = true; break; }
      if (next.action === "tick" && next.consent) { console.log(`       (ticks consent: ${(await tick(p, next.consent)) ? "ok" : "not found"})`); if (next.text) await say(next.text); }
      else if (next.action === "manual") { await p.getByRole("button", { name: "DALEJ" }).first().click({ timeout: 5000 }).catch(() => {}); console.log("       (does the step by hand: DALEJ)"); }
      else if (next.action === "say" && next.text) await say(next.text);
    }
  }
  const reached = await finalShown();
  const body = (await p.innerText("body")).split("\n").map((l) => l.trim());
  const at = body.findIndex((l) => l.startsWith("Termin wizyty"));
  const summary = at >= 0 ? body.slice(at, at + 2).join(" ") : "(no summary)";
  await b.close();
  return { lang, ok: done && reached && wrongLanguage.length === 0, secs: Math.round((Date.now() - t0) / 1000), wrongLanguage, summary };
}

const which = (process.argv[2] || "pl,en,uk,fr").split(",").filter((l) => LANGS[l]);
const results = [];
for (const lang of which) { console.log(`\n=== ${LANGS[lang].name}`); results.push(await run(lang)); }
console.log("\n=== RESULTS");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${LANGS[r.lang].name.padEnd(10)} ${String(r.secs).padStart(4)}s | ${r.summary}${r.wrongLanguage.length ? ` | not in ${LANGS[r.lang].name}: ${r.wrongLanguage.length}` : ""}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
