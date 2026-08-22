/**
 * renderSitePage — the auto-generated micro-site for a Whisp tenant.
 *
 * For businesses with no website of their own, this ONE page is their whole web
 * presence: a warm, editorial "storefront" that (1) puts the Whisp assistant at
 * the centre as the primary interaction, (2) shows the business's real info at a
 * glance for customers who don't want to chat, and (3) lets the owner edit the
 * page inline (owner detected client-side; writes go through the authenticated
 * dashboard endpoint).
 *
 * This is server-rendered by Express and sent as-is — no build step, no client
 * framework. Everything (HTML/CSS/JS) is inline in the returned string.
 *
 * Design direction:
 *   - Display: Fraunces (soft, optical serif — characterful, warm, local).
 *   - Body/UI: Instrument Sans (clean modern grotesque).
 *   - Palette: warm paper by default, considered dark swap; single tunable accent.
 *   - Layout: centred editorial hero whose "ask" bar IS the chat, scannable info
 *     cards, a call-to-action contact band, and a conversation that expands in
 *     place with a docked composer.
 *
 * Contracts preserved from the previous version:
 *   - Chat: POST {baseUrl}/api/chat  {messages, tenantId, sessionId} -> {message}.
 *   - Minimal, escape-safe markdown for bot replies (**bold**, [text](url), paras).
 *
 * Owner edit save (see report / wire the endpoint to match):
 *   PUT {baseUrl}/api/dashboard/site-card
 *   Authorization: Bearer <wctx-dashboard-token>
 *   body: {
 *     siteCard: { tagline, eyebrow, phone, suggestions: string[], sections: {label,text}[] },
 *     accentColor: "#rrggbb",
 *     siteTheme: "light" | "dark"
 *   }
 */

interface SiteTenant {
  id: string;
  brandName: string | null;
  domain: string;
  settings?: any;
}

const esc = (s: any) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: any) => esc(s).replace(/"/g, "&quot;");

// Normalise a user-supplied hex to #rrggbb (what <input type=color> requires),
// or "" if it isn't a valid 3/6-digit hex — guards against CSS injection too.
function normHex(raw: string): string {
  const h = (raw || "").trim();
  if (/^#[0-9a-fA-F]{3}$/.test(h)) return ("#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]).toLowerCase();
  if (/^#[0-9a-fA-F]{6}$/.test(h)) return h.toLowerCase();
  return "";
}

// Free-form HTML mode: the page body is LLM-generated (already sanitized on save).
// We inject the real Whisp chat where {{WHISP_CHAT}} sits, plus the owner AI bar.
function renderCustomHtml(tenant: SiteTenant, baseUrl: string, editToken: string, siteHtml: string): string {
  const brand = tenant.brandName || tenant.domain || "Nasza firma";
  const settings = tenant.settings || {};
  const accent = /^#[0-9a-fA-F]{6}$/.test(settings.accentColor || "") ? settings.accentColor : "#bb5a30";
  const dark = settings.siteTheme === "dark";
  const cardBg = dark ? "#211b15" : "#ffffff";
  const cardInk = dark ? "#f3ece0" : "#241d16";
  const cardLine = dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.10)";
  const botBg = dark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.05)";
  const chatBlock =
    `<div class="whisp-chat" data-whisp><div class="wc-title">✨ Zapytaj nas o cokolwiek</div>` +
    `<div class="wc-msgs" data-wc-msgs></div>` +
    `<div class="wc-row"><input class="wc-input" data-wc-input placeholder="Napisz pytanie…" autocomplete="off"/>` +
    `<button class="wc-send" data-wc-send type="button" aria-label="Wyślij">→</button></div></div>`;
  const body = String(siteHtml).split("{{WHISP_CHAT}}").join(chatBlock);

  return `<!DOCTYPE html>
<html lang="pl" data-theme="${dark ? "dark" : "light"}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(brand)}</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,500&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{--accent:${accent};}
  *{box-sizing:border-box;} html,body{margin:0;padding:0;}
  .whisp-chat{max-width:600px;margin:26px auto;background:${cardBg};border:1px solid ${cardLine};border-radius:16px;padding:16px 16px 14px;box-shadow:0 12px 44px -16px rgba(0,0,0,.35);font-family:"Instrument Sans",system-ui,sans-serif;}
  .wc-title{font-weight:600;font-size:15px;margin-bottom:10px;color:${cardInk};}
  .wc-msgs{display:flex;flex-direction:column;gap:8px;max-height:340px;overflow-y:auto;}
  .wc-msgs:empty{display:none;}
  .wc-msg{max-width:88%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.5;white-space:pre-wrap;}
  .wc-user{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:4px;}
  .wc-bot{align-self:flex-start;background:${botBg};color:${cardInk};border-bottom-left-radius:4px;}
  .wc-bot a{color:var(--accent);} .wc-bot strong{font-weight:600;}
  .wc-row{display:flex;gap:8px;margin-top:10px;}
  .wc-input{flex:1;border:1px solid ${cardLine};background:transparent;color:${cardInk};border-radius:11px;padding:11px 13px;font:inherit;font-size:14px;outline:none;}
  .wc-send{border:none;border-radius:11px;background:var(--accent);color:#fff;font-size:18px;width:46px;cursor:pointer;line-height:1;}
  #wctx-ai-bar{position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;flex-direction:column;align-items:center;padding:0 12px 14px;pointer-events:none;font-family:"Instrument Sans",system-ui,sans-serif;}
  .aib-inner{pointer-events:auto;display:flex;gap:8px;align-items:center;width:100%;max-width:720px;background:${cardBg};border:1px solid ${cardLine};border-radius:16px;padding:8px 8px 8px 14px;box-shadow:0 10px 40px -12px rgba(0,0,0,.4);}
  #aib-input{flex:1;border:none;background:none;outline:none;font:inherit;font-size:14px;color:${cardInk};padding:8px 4px;}
  #aib-go{border:none;border-radius:11px;background:var(--accent);color:#fff;font:inherit;font-weight:600;font-size:14px;padding:9px 16px;cursor:pointer;white-space:nowrap;}
  #aib-go:disabled{opacity:.55;} .aib-undo{border:1px solid ${cardLine};background:none;color:${cardInk};border-radius:11px;font:inherit;font-size:13px;padding:9px 12px;cursor:pointer;}
  .aib-status{pointer-events:auto;font-size:12.5px;color:${cardInk};opacity:.75;margin-top:8px;text-align:center;min-height:15px;}
  #wctx-ai-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:88px;z-index:10000;background:${cardInk};color:${cardBg};padding:12px 18px;border-radius:12px;font-size:14px;max-width:560px;text-align:center;box-shadow:0 12px 44px -10px rgba(0,0,0,.5);}
</style>
</head>
<body>
${body}
<div style="text-align:center;padding:22px 16px;font-size:12px;opacity:.55;font-family:'Instrument Sans',system-ui,sans-serif">Strona i asystent od <a href="https://whisp.so" style="color:inherit">Whisp</a></div>
<script>
(function(){
  var API=${JSON.stringify(baseUrl)}, TENANT=${JSON.stringify(tenant.id)}, SES="site-"+Math.random().toString(36).slice(2);
  function md(t){return String(t||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>").replace(/\\[([^\\]]+)\\]\\((https?:[^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');}
  document.querySelectorAll("[data-whisp]").forEach(function(box){
    var msgs=box.querySelector("[data-wc-msgs]"),inp=box.querySelector("[data-wc-input]"),btn=box.querySelector("[data-wc-send]"),hist=[];
    function add(role,text){var d=document.createElement("div");d.className="wc-msg wc-"+role;if(role==="bot")d.innerHTML=md(text);else d.textContent=text;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return d;}
    function send(){var t=(inp.value||"").trim();if(!t)return;inp.value="";add("user",t);hist.push({role:"user",content:t});var typ=add("bot","…");btn.disabled=true;
      fetch(API+"/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:hist,tenantId:TENANT,sessionId:SES})}).then(function(r){return r.json().catch(function(){return{};});}).then(function(d){btn.disabled=false;var m=(d&&typeof d.message==="string"&&d.message.trim())?d.message:"Przepraszam, spróbuj ponownie za moment.";typ.innerHTML=md(m);hist.push({role:"assistant",content:m});msgs.scrollTop=msgs.scrollHeight;}).catch(function(){btn.disabled=false;typ.textContent="Błąd połączenia.";});}
    if(btn)btn.addEventListener("click",send); if(inp)inp.addEventListener("keydown",function(e){if(e.key==="Enter")send();});
  });
})();
</script>
<script>
/* owner AI bar */
(function(){
  var API=${JSON.stringify(baseUrl)}, TENANT=${JSON.stringify(tenant.id)}, EDIT_TOKEN=${JSON.stringify(editToken)}, tok=null;
  try{ tok=localStorage.getItem("wctx-dashboard-token"); }catch(e){}
  var sameTenant=false; try{ sameTenant=(localStorage.getItem("wctx-tenant-id")===TENANT); }catch(e){}
  if(!EDIT_TOKEN && !(tok&&sameTenant)) return;
  function showToast(t){var x=document.createElement("div");x.id="wctx-ai-toast";x.textContent=t;document.body.appendChild(x);setTimeout(function(){if(x.parentNode)x.parentNode.removeChild(x);},7000);}
  try{ var sm=sessionStorage.getItem("wctx-ai-summary"); if(sm){ sessionStorage.removeItem("wctx-ai-summary"); showToast("✨ "+sm); } }catch(e){}
  var bar=document.createElement("div"); bar.id="wctx-ai-bar";
  bar.innerHTML='<div class="aib-inner"><span style="font-size:16px">✨</span><input id="aib-input" placeholder="Opisz zmianę: np. usuń sekcję kontakt, dwie kolumny, ciemny motyw" autocomplete="off"/><button id="aib-go" type="button">Przeprojektuj</button><button id="aib-undo" type="button" class="aib-undo">Cofnij</button></div><div id="aib-status" class="aib-status"></div>';
  document.body.appendChild(bar);
  var input=document.getElementById("aib-input"),go=document.getElementById("aib-go"),undo=document.getElementById("aib-undo"),st=document.getElementById("aib-status");
  function req(path,body){var h={"Content-Type":"application/json"};if(EDIT_TOKEN){h["X-Edit-Token"]=EDIT_TOKEN;}else{h["Authorization"]="Bearer "+tok;}return fetch(API+path,{method:"POST",headers:h,body:JSON.stringify(body||{})});}
  function gen(){var p=(input.value||"").trim();if(!p)return;go.disabled=true;st.textContent="Przeprojektowuję Twoją stronę…";
    req("/api/dashboard/site-generate",{prompt:p}).then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});}).then(function(res){
      if(!res.ok){go.disabled=false;st.textContent=(res.d&&res.d.error)||"Nie udało się. Spróbuj ponownie.";return;}
      try{sessionStorage.setItem("wctx-ai-summary",res.d.changeSummary||"Zaktualizowano stronę.");}catch(e){}
      location.reload();
    }).catch(function(){go.disabled=false;st.textContent="Błąd połączenia.";});}
  go.addEventListener("click",gen); input.addEventListener("keydown",function(e){if(e.key==="Enter")gen();});
  undo.addEventListener("click",function(){undo.disabled=true;st.textContent="Cofam…";
    req("/api/dashboard/site-revert",{}).then(function(r){return r.json();}).then(function(d){if(d&&d.reverted){location.reload();}else{undo.disabled=false;st.textContent="Nic do cofnięcia.";}}).catch(function(){undo.disabled=false;st.textContent="Błąd.";});});
})();
</script>
</body>
</html>`;
}

export function renderSitePage(tenant: SiteTenant, baseUrl: string, editToken: string = ""): string {
  const _s = tenant.settings || {};
  if (typeof _s.siteHtml === "string" && _s.siteHtml.trim().length > 0) {
    return renderCustomHtml(tenant, baseUrl, editToken, _s.siteHtml);
  }
  const brand = tenant.brandName || tenant.domain || "Nasza firma";
  const settings = tenant.settings || {};
  const card = settings.siteCard || {};

  const tagline: string = (card.tagline || settings.tagline || "Zapytaj nas o wszystko - odpowiemy od razu.").toString();
  const eyebrow: string = (card.eyebrow || "").toString();
  const phone: string = (card.phone || "").toString().trim();

  const accent = normHex((settings.accentColor || "").toString()) || "#bb5a30";
  const theme = settings.siteTheme === "dark" ? "dark" : "light";
  const bgLiteral = theme === "dark" ? "#17130f" : "#f4eee3";

  const sections: { label: string; text: string }[] = (Array.isArray(card.sections) ? card.sections : [])
    .filter((s: any) => s && (s.label || s.text))
    .map((s: any) => ({ label: (s.label || "").toString(), text: (s.text || "").toString() }));

  const suggestions: string[] = (Array.isArray(card.suggestions) && card.suggestions.length)
    ? card.suggestions.map((s: any) => (s || "").toString()).filter(Boolean)
    : ["Jakie macie godziny otwarcia?", "Jak się z Wami skontaktować?", "Co oferujecie?"];

  const infoEmpty = sections.length === 0;
  const contactEmpty = !phone;
  const telHref = phone ? "tel:" + phone.replace(/[^0-9+]/g, "") : "#";

  const SEND_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';
  const PHONE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';

  const callPill = phone
    ? `<a class="pill" id="call-pill" href="${escAttr(telHref)}">${PHONE_ICON}<span>${esc(phone)}</span></a>`
    : "";

  const eyebrowHtml = `<p class="eyebrow reveal" data-edit="eyebrow" data-placeholder="Krótkie hasło (np. RESTAURACJA)" style="animation-delay:.05s">${esc(eyebrow)}</p>`;

  const chipsHtml = suggestions.slice(0, 6).map((q) =>
    `<span class="chip-wrap" data-chip>` +
      `<button type="button" class="chip">${esc(q)}</button>` +
      `<button type="button" class="chip-del edit-only" data-act="chip-del" aria-label="Usuń podpowiedź" tabindex="-1">&times;</button>` +
    `</span>`
  ).join("");

  const cardsHtml = sections.map((s) =>
    `<article class="card" data-section>` +
      `<div class="card-controls edit-only" role="group" aria-label="Edytuj sekcję">` +
        `<button type="button" class="cc" data-act="up" aria-label="Przenieś w górę">&#8593;</button>` +
        `<button type="button" class="cc" data-act="down" aria-label="Przenieś w dół">&#8595;</button>` +
        `<button type="button" class="cc cc-del" data-act="del" aria-label="Usuń sekcję">&times;</button>` +
      `</div>` +
      `<h3 class="card-label" data-placeholder="Nazwa sekcji">${esc(s.label)}</h3>` +
      `<div class="card-text" data-placeholder="Treść sekcji">${esc(s.text)}</div>` +
    `</article>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="pl" data-theme="${theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(brand)}</title>
<meta name="description" content="${escAttr(tagline)}">
<meta name="theme-color" content="${bgLiteral}">
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,500&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<script>document.documentElement.classList.add("js");</script>
<style>
  :root{
    --bg:#f4eee3; --paper:#fbf7ef; --raised:#ffffff;
    --ink:#241d16; --ink-soft:#6f6455; --ink-faint:#9a8f7e;
    --line:rgba(36,29,22,0.12); --line-soft:rgba(36,29,22,0.07);
    --accent:${accent};
    --accent-text:color-mix(in srgb, var(--accent) 80%, #241d16);
    --accent-soft:color-mix(in srgb, var(--accent) 14%, transparent);
    --accent-tint:color-mix(in srgb, var(--accent) 7%, var(--paper));
    --accent-line:color-mix(in srgb, var(--accent) 42%, var(--line));
    --on-accent:#fff;
    --shadow:0 1px 2px rgba(20,15,10,0.05), 0 16px 38px -16px rgba(20,15,10,0.22);
    --shadow-lg:0 2px 4px rgba(20,15,10,0.06), 0 26px 54px -18px rgba(20,15,10,0.30);
    --serif:"Fraunces",Georgia,"Times New Roman",serif;
    --sans:"Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
    --radius:18px;
  }
  :root[data-theme="dark"]{
    --bg:#17130f; --paper:#211b15; --raised:#2a231b;
    --ink:#f3ece0; --ink-soft:#b3a693; --ink-faint:#8a7d6a;
    --line:rgba(243,236,224,0.15); --line-soft:rgba(243,236,224,0.08);
    --accent-text:color-mix(in srgb, var(--accent) 82%, #f3ece0);
    --accent-tint:color-mix(in srgb, var(--accent) 12%, var(--paper));
    --shadow:0 1px 2px rgba(0,0,0,0.30), 0 16px 40px -16px rgba(0,0,0,0.55);
    --shadow-lg:0 2px 4px rgba(0,0,0,0.34), 0 28px 60px -18px rgba(0,0,0,0.66);
  }

  *{margin:0;padding:0;box-sizing:border-box;}
  html,body{min-height:100%;}
  html{scroll-behavior:smooth;}
  body{
    font-family:var(--sans); color:var(--ink); background:var(--bg); line-height:1.62;
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
    display:flex; flex-direction:column; min-height:100vh; position:relative; overflow-x:hidden;
    transition:padding .25s ease;
    background-image:
      radial-gradient(1200px 640px at 84% -10%, var(--accent-soft), transparent 60%),
      radial-gradient(900px 520px at 6% 2%, color-mix(in srgb, var(--accent) 6%, transparent), transparent 58%);
  }
  /* fine paper grain */
  body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.05;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}
  :root[data-theme="dark"] body::before{opacity:.06;}
  .wrap{position:relative;z-index:1;display:flex;flex-direction:column;flex:1;width:100%;}

  a{color:var(--accent-text);}
  ::selection{background:var(--accent-soft);}
  :focus-visible{outline:2.5px solid var(--accent);outline-offset:2px;border-radius:6px;}

  /* ---------- header ---------- */
  header{display:flex;align-items:center;justify-content:space-between;gap:16px;
    padding:20px clamp(20px,5vw,56px);max-width:1120px;margin:0 auto;width:100%;}
  .brand{display:flex;align-items:center;gap:11px;font-family:var(--serif);font-weight:600;
    font-size:clamp(17px,2.2vw,20px);letter-spacing:-0.01em;color:var(--ink);}
  .brand .mark{width:11px;height:11px;border-radius:50%;background:var(--accent);
    box-shadow:0 0 0 4px var(--accent-soft);flex-shrink:0;}
  .pill{display:inline-flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;
    color:var(--ink);text-decoration:none;border:1px solid var(--line);border-radius:999px;
    padding:8px 15px;background:var(--paper);white-space:nowrap;transition:transform .18s,border-color .18s,color .18s;}
  .pill svg{width:15px;height:15px;color:var(--accent);}
  .pill:hover{border-color:var(--accent);color:var(--accent-text);transform:translateY(-1px);}

  /* ---------- hero ---------- */
  main{width:100%;}
  .hero{max-width:820px;margin:0 auto;padding:clamp(30px,7vw,84px) clamp(20px,5vw,56px) 12px;text-align:center;width:100%;}
  .eyebrow{font-size:12px;letter-spacing:0.26em;text-transform:uppercase;color:var(--accent-text);
    font-weight:600;margin-bottom:20px;display:inline-block;}
  .eyebrow:empty{display:none;}
  .hero h1{font-family:var(--serif);font-weight:600;font-size:clamp(42px,8.6vw,88px);line-height:.98;
    letter-spacing:-0.025em;margin-bottom:16px;text-wrap:balance;color:var(--ink);}
  .hero .tag{font-family:var(--serif);font-style:italic;font-weight:500;font-size:clamp(18px,3vw,24px);
    color:var(--ink-soft);margin:0 auto 32px;max-width:600px;text-wrap:balance;}

  .ask{display:flex;align-items:center;gap:8px;background:var(--paper);border:1px solid var(--line);
    border-radius:var(--radius);padding:7px 7px 7px 20px;max-width:560px;margin:0 auto;box-shadow:var(--shadow);
    transition:border-color .2s,box-shadow .2s;}
  .ask:focus-within{border-color:var(--accent-line);box-shadow:var(--shadow-lg);}
  .ask input{flex:1;min-width:0;border:none;background:none;outline:none;font-family:var(--sans);
    font-size:16px;color:var(--ink);padding:11px 0;}
  .ask input::placeholder{color:var(--ink-faint);}

  .send-btn{width:46px;height:46px;border:none;border-radius:13px;background:var(--accent);
    color:var(--on-accent);display:flex;align-items:center;justify-content:center;cursor:pointer;
    transition:transform .16s,filter .16s,opacity .16s;flex-shrink:0;}
  .send-btn svg{width:19px;height:19px;}
  .send-btn:hover{filter:brightness(.93);transform:scale(1.05);}
  .send-btn:active{transform:scale(.97);}
  .send-btn:disabled{opacity:.5;cursor:default;transform:none;filter:none;}

  .chips{display:flex;flex-wrap:wrap;gap:9px;justify-content:center;align-items:center;margin:20px auto 0;max-width:640px;}
  .chip-wrap{position:relative;display:inline-flex;align-items:center;}
  .chip{font-family:var(--sans);font-size:13.5px;color:var(--ink-soft);background:var(--paper);
    border:1px solid var(--line-soft);border-radius:999px;padding:9px 16px;cursor:pointer;
    transition:transform .18s,border-color .18s,color .18s,box-shadow .18s;min-height:38px;}
  .chip:hover{border-color:var(--accent-line);color:var(--accent-text);transform:translateY(-1px);box-shadow:var(--shadow);}

  /* ---------- conversation ---------- */
  #conversation{display:none;max-width:640px;margin:clamp(20px,5vw,44px) auto 0;padding:0 clamp(16px,4vw,24px);width:100%;flex-direction:column;}
  body.chatting #conversation{display:flex;animation:rise .42s ease both;}
  body.chatting #hero{display:none;}
  .convo-head{display:flex;align-items:center;gap:12px;padding:6px 6px 14px;border-bottom:1px solid var(--line-soft);margin-bottom:6px;}
  .convo-dot{width:10px;height:10px;border-radius:50%;background:#2fbf71;box-shadow:0 0 0 4px color-mix(in srgb,#2fbf71 22%,transparent);flex-shrink:0;}
  .convo-meta{display:flex;flex-direction:column;line-height:1.2;flex:1;text-align:left;}
  .convo-meta strong{font-family:var(--serif);font-weight:600;font-size:16px;color:var(--ink);}
  .convo-meta small{font-size:12px;color:var(--ink-faint);}
  .convo-close{width:34px;height:34px;border-radius:10px;border:1px solid var(--line);background:var(--paper);
    color:var(--ink-soft);font-size:19px;line-height:1;cursor:pointer;transition:color .16s,border-color .16s;flex-shrink:0;}
  .convo-close:hover{color:var(--accent-text);border-color:var(--accent-line);}
  .messages{display:flex;flex-direction:column;gap:12px;padding:14px 2px 8px;min-height:34vh;}
  .msg{display:flex;max-width:88%;}
  .msg.user{align-self:flex-end;}
  .msg.bot{align-self:flex-start;}
  .bubble{padding:13px 17px;border-radius:18px;font-size:15px;line-height:1.6;animation:msgIn .32s ease both;}
  .msg.user .bubble{background:var(--accent);color:var(--on-accent);border-bottom-right-radius:5px;}
  .msg.bot .bubble{background:var(--paper);border:1px solid var(--line);color:var(--ink);border-bottom-left-radius:5px;}
  .bubble p{margin:0;} .bubble p + p{margin-top:.6em;}
  .bubble a{color:var(--accent-text);text-decoration:underline;text-underline-offset:2px;}
  .msg.user .bubble a{color:var(--on-accent);}
  .bubble strong{font-weight:600;}
  .bubble.typing{display:flex;gap:5px;align-items:center;}
  .bubble.typing span{width:7px;height:7px;border-radius:50%;background:var(--ink-faint);animation:dot 1.2s infinite;}
  .bubble.typing span:nth-child(2){animation-delay:.18s;} .bubble.typing span:nth-child(3){animation-delay:.36s;}

  /* docked composer (chat mode) */
  .dock{display:none;position:fixed;left:0;right:0;bottom:0;z-index:40;
    background:color-mix(in srgb,var(--bg) 90%,transparent);backdrop-filter:saturate(1.4) blur(10px);
    border-top:1px solid var(--line-soft);padding:12px clamp(16px,5vw,56px) calc(12px + env(safe-area-inset-bottom));}
  body.chatting .dock{display:block;animation:rise .3s ease both;}
  body.chatting{padding-bottom:88px;}
  .dock .ask{max-width:640px;box-shadow:var(--shadow-lg);}

  /* ---------- info cards ---------- */
  .info{max-width:1000px;margin:clamp(40px,8vw,80px) auto 0;padding:0 clamp(20px,5vw,56px);width:100%;}
  .info-head{display:flex;align-items:center;gap:16px;margin-bottom:24px;}
  .info-head h2{font-family:var(--serif);font-size:clamp(21px,3vw,27px);font-weight:600;color:var(--ink);letter-spacing:-0.01em;}
  .info-head .rule{flex:1;height:1px;background:var(--line);}
  .cards{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;}
  .card{position:relative;background:var(--paper);border:1px solid var(--line-soft);border-radius:var(--radius);
    padding:24px 26px;box-shadow:var(--shadow);overflow:hidden;transition:transform .22s,box-shadow .22s,border-color .22s;}
  .card::before{content:"";position:absolute;top:0;left:0;width:42px;height:3px;background:var(--accent);border-radius:0 0 3px 0;}
  .card:hover{transform:translateY(-3px);box-shadow:var(--shadow-lg);}
  .card-label{font-size:11.5px;letter-spacing:0.14em;text-transform:uppercase;color:var(--accent-text);font-weight:600;margin-bottom:11px;}
  .card-text{font-size:14.5px;line-height:1.64;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere;}
  /* scroll reveal (only when JS is present, so no-JS shows everything) */
  .js .card{opacity:0;transform:translateY(16px);}
  .js .card.in{opacity:1;transform:none;}

  /* ---------- contact band ---------- */
  .contact{max-width:1000px;margin:clamp(40px,7vw,72px) auto 0;padding:0 clamp(20px,5vw,56px);width:100%;}
  .contact-inner{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;
    background:var(--accent-tint);border:1px solid var(--accent-line);border-radius:22px;padding:clamp(24px,4vw,36px);}
  .contact-copy h3{font-family:var(--serif);font-size:clamp(22px,3.4vw,30px);font-weight:600;color:var(--ink);letter-spacing:-0.01em;margin-bottom:4px;}
  .contact-copy p{color:var(--ink-soft);font-size:15px;}
  .call-btn{display:inline-flex;align-items:center;gap:11px;background:var(--accent);color:var(--on-accent);
    text-decoration:none;font-weight:600;font-size:16px;padding:15px 26px;border-radius:14px;
    box-shadow:var(--shadow);transition:transform .16s,filter .16s;white-space:nowrap;}
  .call-btn svg{width:19px;height:19px;}
  .call-btn:hover{transform:translateY(-2px);filter:brightness(.94);}
  .call-num{font-variant-numeric:tabular-nums;}

  /* ---------- footer ---------- */
  footer{max-width:1000px;margin:clamp(48px,8vw,88px) auto 0;padding:26px clamp(20px,5vw,56px) 40px;
    border-top:1px solid var(--line-soft);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;width:100%;}
  footer .f-brand{font-family:var(--serif);font-weight:600;color:var(--ink);font-size:15px;}
  footer .powered{font-size:12.5px;color:var(--ink-faint);}
  footer .powered a{color:var(--ink-soft);text-decoration:none;font-weight:600;}
  footer .powered a:hover{color:var(--accent-text);}

  /* ---------- animations ---------- */
  .reveal{opacity:0;animation:rise .8s cubic-bezier(.2,.7,.2,1) forwards;}
  @keyframes rise{from{opacity:0;transform:translateY(16px);}to{opacity:1;transform:translateY(0);}}
  @keyframes msgIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
  @keyframes dot{0%,60%,100%{transform:translateY(0);opacity:.5;}30%{transform:translateY(-6px);opacity:1;}}

  /* ================= OWNER EDIT MODE (hidden for everyone by default) ================= */
  .edit-only{display:none;}
  .edit-fab,.editbar{display:none;}
  body.owner .edit-fab{display:inline-flex;}
  body.owner.editing .edit-fab{display:none;}
  body.owner.editing .editbar{display:flex;}
  body.owner.editing .card-controls{display:flex;}
  body.owner.editing .chip-del{display:inline-flex;}
  body.owner.editing .chip-add,body.owner.editing .section-add{display:inline-flex;}

  /* reveal empty regions only while the owner is editing, so they can fill them */
  .info[data-empty="true"],.contact[data-empty="true"]{display:none;}
  body.owner.editing .info[data-empty="true"],body.owner.editing .contact[data-empty="true"]{display:block;}
  body.owner.editing .info[data-empty="true"] .cards{min-height:1px;}

  .edit-fab{position:fixed;right:22px;bottom:22px;z-index:60;align-items:center;gap:8px;
    background:var(--ink);color:var(--bg);border:none;border-radius:999px;padding:13px 20px;font-family:var(--sans);
    font-size:14px;font-weight:600;cursor:pointer;box-shadow:var(--shadow-lg);transition:transform .16s;}
  .edit-fab:hover{transform:translateY(-2px);}
  .edit-fab svg{width:16px;height:16px;}

  .editbar{position:fixed;top:0;left:0;right:0;z-index:70;align-items:center;flex-wrap:wrap;gap:10px;
    padding:10px clamp(16px,4vw,28px);background:var(--raised);border-bottom:1px solid var(--line);box-shadow:var(--shadow);}
  body.editing{padding-top:60px;}
  .editbar .eb-title{font-family:var(--serif);font-weight:600;font-size:15px;color:var(--ink);margin-right:auto;display:flex;align-items:center;gap:8px;}
  .editbar .eb-title .mark{width:9px;height:9px;border-radius:50%;background:var(--accent);}
  .eb-swatch{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--ink-soft);
    border:1px solid var(--line);border-radius:10px;padding:5px 10px 5px 8px;cursor:pointer;}
  .eb-swatch input[type=color]{width:24px;height:24px;padding:0;border:none;background:none;cursor:pointer;border-radius:6px;}
  .eb-swatch input[type=color]::-webkit-color-swatch-wrapper{padding:0;}
  .eb-swatch input[type=color]::-webkit-color-swatch{border:1px solid var(--line);border-radius:6px;}
  .eb-btn{font-family:var(--sans);font-size:13.5px;font-weight:600;color:var(--ink);background:var(--paper);
    border:1px solid var(--line);border-radius:10px;padding:9px 15px;cursor:pointer;transition:border-color .16s,transform .12s;min-height:38px;}
  .eb-btn:hover{border-color:var(--accent-line);}
  .eb-btn:active{transform:scale(.98);}
  .eb-primary{background:var(--accent);color:var(--on-accent);border-color:transparent;}
  .eb-primary:hover{filter:brightness(.94);}
  .eb-status{font-size:13px;font-weight:600;color:var(--ink-faint);min-width:10px;transition:color .2s;}
  .eb-status.is-saving{color:var(--ink-soft);} .eb-status.is-saved{color:#2f9d5a;} .eb-status.is-error{color:#c0463a;}

  .card-controls{position:absolute;top:12px;right:12px;gap:5px;z-index:2;}
  .cc{width:30px;height:30px;border-radius:8px;border:1px solid var(--line);background:var(--raised);
    color:var(--ink-soft);font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:color .14s,border-color .14s;}
  .cc:hover{color:var(--accent-text);border-color:var(--accent-line);}
  .cc-del:hover{color:#c0463a;border-color:#c0463a;}
  .chip-del{width:22px;height:22px;margin-left:-4px;border-radius:50%;border:1px solid var(--line);background:var(--raised);
    color:var(--ink-soft);font-size:14px;line-height:1;cursor:pointer;align-items:center;justify-content:center;}
  .chip-del:hover{color:#c0463a;border-color:#c0463a;}
  .chip-add,.section-add{align-items:center;gap:6px;font-family:var(--sans);font-size:13.5px;font-weight:600;
    color:var(--accent-text);background:transparent;border:1px dashed var(--accent-line);border-radius:999px;
    padding:9px 16px;cursor:pointer;min-height:38px;transition:background .16s;}
  .section-add{border-radius:14px;margin-top:16px;}
  .chip-add:hover,.section-add:hover{background:var(--accent-soft);}

  body.editing [contenteditable="true"]{border-radius:8px;outline:2px dashed var(--accent-line);outline-offset:3px;
    transition:outline-color .16s,background .16s;cursor:text;}
  body.editing [contenteditable="true"]:hover{background:var(--accent-soft);}
  body.editing [contenteditable="true"]:focus{outline:2.5px solid var(--accent);background:transparent;}
  body.editing .chip[contenteditable="true"]{cursor:text;}
  [contenteditable="true"]:empty:before{content:attr(data-placeholder);color:var(--ink-faint);pointer-events:none;font-style:italic;}
  body.owner.editing .eyebrow{display:inline-block;}
  body.owner.editing .card{opacity:1 !important;transform:none !important;}

  /* ---------- responsive ---------- */
  @media(max-width:640px){
    .cards{grid-template-columns:1fr;}
    .contact-inner{flex-direction:column;align-items:flex-start;}
    .call-btn{width:100%;justify-content:center;}
    .msg{max-width:92%;}
    header{padding:16px 20px;}
    .pill span{display:none;}
    .pill{padding:9px;}
  }
  @media(prefers-reduced-motion:reduce){
    html{scroll-behavior:auto;}
    *,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important;}
    .reveal{opacity:1 !important;transform:none !important;}
    .js .card{opacity:1 !important;transform:none !important;}
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><span class="mark" aria-hidden="true"></span>${esc(brand)}</div>
    ${callPill}
  </header>

  <main>
    <section class="hero" id="hero" aria-label="Wprowadzenie">
      ${eyebrowHtml}
      <h1 class="reveal" style="animation-delay:.12s">${esc(brand)}</h1>
      <p class="tag reveal" data-edit="tagline" data-placeholder="Dodaj krótki opis" style="animation-delay:.2s">${esc(tagline)}</p>
      <div class="ask reveal" style="animation-delay:.28s">
        <input id="hero-input" type="text" placeholder="Zapytaj o godziny, ofertę, dojazd…" autocomplete="off" aria-label="Zadaj pytanie asystentowi">
        <button type="button" class="send-btn" id="hero-send" aria-label="Wyślij pytanie">${SEND_ICON}</button>
      </div>
      <div class="chips reveal" id="chips" style="animation-delay:.36s" role="group" aria-label="Przykładowe pytania">
        ${chipsHtml}
        <button type="button" class="chip-add edit-only" id="chip-add" data-act="add-chip">+ podpowiedź</button>
      </div>
    </section>

    <section id="conversation" aria-label="Rozmowa z asystentem">
      <div class="convo-head">
        <span class="convo-dot" aria-hidden="true"></span>
        <div class="convo-meta"><strong>Asystent ${esc(brand)}</strong><small>Zwykle odpowiada od razu</small></div>
        <button type="button" class="convo-close" id="chat-close" aria-label="Zamknij rozmowę">&times;</button>
      </div>
      <div class="messages" id="messages" role="log" aria-live="polite" aria-relevant="additions" aria-label="Wiadomości"></div>
    </section>

    <section class="info" id="info" data-empty="${infoEmpty ? "true" : "false"}" aria-label="Informacje">
      <div class="info-head"><h2>Dobrze wiedzieć</h2><div class="rule" aria-hidden="true"></div></div>
      <div class="cards" id="cards">${cardsHtml}</div>
      <button type="button" class="section-add edit-only" id="section-add" data-act="add-section">+ Dodaj sekcję</button>
    </section>

    <section class="contact" id="contact" data-empty="${contactEmpty ? "true" : "false"}" aria-label="Kontakt">
      <div class="contact-inner">
        <div class="contact-copy">
          <h3>Wolisz zadzwonić?</h3>
          <p>Chętnie odpowiemy na Twoje pytania.</p>
        </div>
        <a class="call-btn" id="call-btn" href="${escAttr(telHref)}">
          ${PHONE_ICON}
          <span class="call-num" data-edit="phone" data-placeholder="Numer telefonu">${esc(phone)}</span>
        </a>
      </div>
    </section>
  </main>

  <footer>
    <div class="f-brand">${esc(brand)}</div>
    <div class="powered">Strona i asystent od <a href="https://whisp.so" target="_blank" rel="noopener">Whisp</a></div>
  </footer>
</div>

<div class="dock" id="dock">
  <div class="ask">
    <input id="dock-input" type="text" placeholder="Napisz wiadomość…" autocomplete="off" aria-label="Napisz wiadomość">
    <button type="button" class="send-btn" id="dock-send" aria-label="Wyślij">${SEND_ICON}</button>
  </div>
</div>

<button type="button" class="edit-fab" id="edit-fab" aria-label="Edytuj tę stronę">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
  Edytuj
</button>

<div class="editbar" id="editbar" role="toolbar" aria-label="Pasek edycji strony">
  <span class="eb-title"><span class="mark" aria-hidden="true"></span>Tryb edycji</span>
  <label class="eb-swatch">Kolor<input type="color" id="ed-accent" value="${escAttr(accent)}" aria-label="Kolor akcentu"></label>
  <button type="button" class="eb-btn" id="ed-theme">Motyw</button>
  <span class="eb-status" id="ed-status" aria-live="polite"></span>
  <button type="button" class="eb-btn eb-primary" id="ed-save">Zapisz</button>
  <button type="button" class="eb-btn" id="ed-exit">Zakończ</button>
</div>

<script>
(function(){
  "use strict";
  var API=${JSON.stringify(baseUrl)}, TENANT=${JSON.stringify(tenant.id)};
  var SESSION="site-"+Math.random().toString(36).slice(2)+Date.now().toString(36);
  var messages=[];
  var doc=document, body=doc.body, root=doc.documentElement;
  function $(s,c){return (c||doc).querySelector(s);}
  function $$(s,c){return Array.prototype.slice.call((c||doc).querySelectorAll(s));}
  function reduce(){try{return !!(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches);}catch(e){return false;}}

  // ---- escape-safe minimal markdown for bot replies ----
  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  function safeUrl(u){u=String(u||"").trim();return /^(https?:\\/\\/|tel:|mailto:|\\/)/i.test(u)?u:"#";}
  function md(t){
    var s=esc(t);
    s=s.replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>");
    s=s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,function(m,txt,url){return '<a href="'+esc(safeUrl(url)).replace(/"/g,"&quot;")+'" target="_blank" rel="noopener noreferrer">'+txt+'</a>';});
    s=s.replace(/\\n{2,}/g,"</p><p>").replace(/\\n/g,"<br>");
    return "<p>"+s+"</p>";
  }

  // ---- chat ----
  var msgsEl=$("#messages"), heroInput=$("#hero-input"), dockInput=$("#dock-input"), dockSend=$("#dock-send"), heroSend=$("#hero-send");
  var chatting=false, sending=false;
  function scrollLast(){var l=msgsEl&&msgsEl.lastElementChild;if(l&&l.scrollIntoView){try{l.scrollIntoView({block:"end",behavior:reduce()?"auto":"smooth"});}catch(e){l.scrollIntoView();}}}
  function enterChat(){if(chatting)return;chatting=true;body.classList.add("chatting");setTimeout(function(){try{dockInput.focus();}catch(e){}},80);}
  function exitChat(){chatting=false;body.classList.remove("chatting");try{heroInput.focus();}catch(e){}}
  function addMsg(role,text){var d=doc.createElement("div");d.className="msg "+role;var b=doc.createElement("div");b.className="bubble";if(role==="bot"){b.innerHTML=md(text);}else{b.textContent=text;}d.appendChild(b);msgsEl.appendChild(d);scrollLast();return d;}
  function showTyping(){var d=doc.createElement("div");d.className="msg bot";d.innerHTML='<div class="bubble typing"><span></span><span></span><span></span></div>';msgsEl.appendChild(d);scrollLast();return d;}
  function setSending(v){sending=v;if(dockSend)dockSend.disabled=v;if(heroSend)heroSend.disabled=v;}
  function send(text){
    text=(text||"").trim();
    if(!text||sending)return;
    if(body.classList.contains("editing"))return;
    enterChat();
    if(heroInput)heroInput.value="";if(dockInput)dockInput.value="";
    messages.push({role:"user",content:text});
    addMsg("user",text);
    var typ=showTyping();setSending(true);
    fetch(API+"/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:messages,tenantId:TENANT,sessionId:SESSION})})
      .then(function(r){return r.json().catch(function(){return {};});})
      .then(function(data){typ.remove();var reply=(data&&typeof data.message==="string"&&data.message.trim())?data.message:"Przepraszam, chwilowo nie mogę odpowiedzieć - spróbuj ponownie za chwilę.";messages.push({role:"assistant",content:reply});addMsg("bot",reply);})
      .catch(function(){typ.remove();addMsg("bot","Coś poszło nie tak z połączeniem. Spróbuj ponownie za chwilę.");})
      .then(function(){setSending(false);try{dockInput.focus();}catch(e){}});
  }
  function onEnter(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send(e.currentTarget.value);}}
  if(heroInput)heroInput.addEventListener("keydown",onEnter);
  if(dockInput)dockInput.addEventListener("keydown",onEnter);
  if(heroSend)heroSend.addEventListener("click",function(){send(heroInput.value);});
  if(dockSend)dockSend.addEventListener("click",function(){send(dockInput.value);});
  var chatClose=$("#chat-close");if(chatClose)chatClose.addEventListener("click",exitChat);

  // ---- scroll reveal for info cards (progressive; no-JS shows all) ----
  var cards=$$(".card");
  if(("IntersectionObserver" in window)&&!reduce()){
    var io=new IntersectionObserver(function(en){en.forEach(function(x){if(x.isIntersecting){x.target.classList.add("in");io.unobserve(x.target);}});},{rootMargin:"0px 0px -8% 0px",threshold:0.08});
    cards.forEach(function(c){io.observe(c);});
  }else{cards.forEach(function(c){c.classList.add("in");});}

  // =================== OWNER EDIT MODE ===================
  var TOKEN=null,isOwner=false;
  try{var tk=localStorage.getItem("wctx-dashboard-token");var tid=localStorage.getItem("wctx-tenant-id");if(tk&&tid===TENANT){TOKEN=tk;isOwner=true;}}catch(e){}

  var editing=false,dirty=false;
  var accentInput=$("#ed-accent"),statusEl=$("#ed-status");

  function editableEls(){return $$('[data-edit],.card-label,.card-text,.chip');}
  function setEditable(on){editableEls().forEach(function(el){el.setAttribute("contenteditable",on?"true":"false");if(on){el.setAttribute("spellcheck","false");}});}
  function setStatus(s){if(!statusEl)return;statusEl.className="eb-status"+(s?(" is-"+s):"");statusEl.textContent=s==="saving"?"Zapisywanie…":s==="saved"?"Zapisano ✓":s==="error"?"Błąd - spróbuj ponownie":"";}
  function markDirty(){dirty=true;setStatus("");}
  function themeLabel(){var b=$("#ed-theme");if(!b)return;b.textContent=(root.getAttribute("data-theme")==="dark")?"Motyw: ciemny":"Motyw: jasny";}
  function txt(el){if(!el)return "";var s=(el.innerText!=null?el.innerText:el.textContent)||"";return s.split(String.fromCharCode(160)).join(" ").replace(/\\r/g,"").trim();}

  function enterEdit(){
    if(!isOwner||editing)return;editing=true;
    if(chatting)exitChat();
    body.classList.add("editing");
    setEditable(true);
    $$(".card").forEach(function(c){c.classList.add("in");});
    themeLabel();setStatus("");
    var tl=$('[data-edit="tagline"]');if(tl){try{tl.focus();}catch(e){}}
  }
  function exitEdit(){
    if(dirty){ if(!window.confirm("Masz niezapisane zmiany. Odrzucić je?"))return; location.reload(); return; }
    editing=false;body.classList.remove("editing");setEditable(false);
  }

  function collect(){
    return {
      tagline:txt($('[data-edit="tagline"]')),
      eyebrow:txt($('[data-edit="eyebrow"]')),
      phone:txt($('[data-edit="phone"]')),
      suggestions:$$(".chip").map(function(c){return txt(c);}).filter(function(x){return !!x;}),
      sections:$$("#cards .card").map(function(c){return {label:txt($(".card-label",c)),text:txt($(".card-text",c))};}).filter(function(s){return s.label||s.text;}),
      accentColor:accentInput?accentInput.value:null,
      siteTheme:(root.getAttribute("data-theme")==="dark")?"dark":"light"
    };
  }
  function save(){
    if(!TOKEN)return;
    var d=collect();
    var payload={siteCard:{tagline:d.tagline,eyebrow:d.eyebrow,phone:d.phone,suggestions:d.suggestions,sections:d.sections},accentColor:d.accentColor,siteTheme:d.siteTheme};
    setStatus("saving");
    fetch(API+"/api/dashboard/site-card",{method:"PUT",headers:{"Content-Type":"application/json","Authorization":"Bearer "+TOKEN},body:JSON.stringify(payload)})
      .then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json().catch(function(){return {};});})
      .then(function(){dirty=false;setStatus("saved");setTimeout(function(){location.reload();},700);})
      .catch(function(){setStatus("error");});
  }

  function addChip(){
    var chips=$("#chips");if(!chips)return;
    var wrap=doc.createElement("span");wrap.className="chip-wrap";wrap.setAttribute("data-chip","");
    wrap.innerHTML='<button type="button" class="chip" contenteditable="true" spellcheck="false" data-placeholder="Nowa podpowiedź"></button><button type="button" class="chip-del edit-only" data-act="chip-del" aria-label="Usuń podpowiedź" tabindex="-1">&times;</button>';
    var add=$("#chip-add");
    if(add&&add.parentNode===chips){chips.insertBefore(wrap,add);}else{chips.appendChild(wrap);}
    var b=wrap.querySelector(".chip");if(b){try{b.focus();}catch(e){}}
    markDirty();
  }
  function addSection(){
    var cw=$("#cards");if(!cw)return;
    var info=$("#info");if(info)info.setAttribute("data-empty","false");
    var card=doc.createElement("article");card.className="card in";card.setAttribute("data-section","");
    card.innerHTML='<div class="card-controls edit-only" role="group" aria-label="Edytuj sekcję"><button type="button" class="cc" data-act="up" aria-label="Przenieś w górę">&#8593;</button><button type="button" class="cc" data-act="down" aria-label="Przenieś w dół">&#8595;</button><button type="button" class="cc cc-del" data-act="del" aria-label="Usuń sekcję">&times;</button></div><h3 class="card-label" contenteditable="true" spellcheck="false" data-placeholder="Nazwa sekcji"></h3><div class="card-text" contenteditable="true" spellcheck="false" data-placeholder="Treść sekcji"></div>';
    cw.appendChild(card);
    var lab=card.querySelector(".card-label");if(lab){try{lab.focus();}catch(e){}}
    markDirty();
  }

  // delegated clicks: chip send (view mode) + all edit controls
  doc.addEventListener("click",function(e){
    var el=e.target;
    if(!el||!el.closest)return;
    if(body.classList.contains("editing")){var a=el.closest("a");if(a)e.preventDefault();} // don't follow links (e.g. tel:) while editing
    var chip=el.closest(".chip");
    if(chip){
      if(body.classList.contains("editing"))return; // allow caret placement while editing
      e.preventDefault();
      send(chip.textContent);
      return;
    }
    if(!isOwner)return;
    var act=el.getAttribute&&el.getAttribute("data-act");
    if(!act)return;
    if(act==="chip-del"){var w=el.closest(".chip-wrap");if(w&&w.parentNode){w.parentNode.removeChild(w);markDirty();}return;}
    if(act==="add-chip"){addChip();return;}
    if(act==="add-section"){addSection();return;}
    var cd=el.closest(".card");
    if(!cd)return;
    if(act==="del"){if(cd.parentNode){cd.parentNode.removeChild(cd);markDirty();}return;}
    if(act==="up"){var p=cd.previousElementSibling;if(p&&p.classList.contains("card")){cd.parentNode.insertBefore(cd,p);markDirty();}return;}
    if(act==="down"){var n=cd.nextElementSibling;if(n&&n.classList.contains("card")){cd.parentNode.insertBefore(n,cd);markDirty();}return;}
  });

  if(isOwner){
    body.classList.add("owner");
    var fab=$("#edit-fab");if(fab)fab.addEventListener("click",enterEdit);
    var saveBtn=$("#ed-save");if(saveBtn)saveBtn.addEventListener("click",save);
    var exitBtn=$("#ed-exit");if(exitBtn)exitBtn.addEventListener("click",exitEdit);
    var themeBtn=$("#ed-theme");
    if(themeBtn)themeBtn.addEventListener("click",function(){var d=root.getAttribute("data-theme")==="dark";root.setAttribute("data-theme",d?"light":"dark");themeLabel();markDirty();});
    if(accentInput)accentInput.addEventListener("input",function(){root.style.setProperty("--accent",accentInput.value);markDirty();});
    doc.addEventListener("input",function(e){if(editing&&e.target&&e.target.hasAttribute&&e.target.hasAttribute("contenteditable")){markDirty();}});
    window.addEventListener("beforeunload",function(e){if(editing&&dirty){e.preventDefault();e.returnValue="";}});
  }
})();
</script>
<script>
/* AI prompt-to-site — owner-only bar. Describe a change; an LLM rewrites the site. */
(function(){
  var API=${JSON.stringify(baseUrl)}, TENANT=${JSON.stringify(tenant.id)}, EDIT_TOKEN=${JSON.stringify(editToken)}, tok=null;
  try{ tok=localStorage.getItem("wctx-dashboard-token"); }catch(e){}
  var sameTenant=false; try{ sameTenant=(localStorage.getItem("wctx-tenant-id")===TENANT); }catch(e){}
  if(!EDIT_TOKEN && !(tok&&sameTenant)) return;
  function showToast(t){var x=document.createElement("div");x.id="wctx-ai-toast";x.textContent=t;document.body.appendChild(x);setTimeout(function(){if(x.parentNode)x.parentNode.removeChild(x);},7000);}
  try{ var sm=sessionStorage.getItem("wctx-ai-summary"); if(sm){ sessionStorage.removeItem("wctx-ai-summary"); showToast("\\u2728 "+sm); } }catch(e){}
  var css=document.createElement("style");
  css.textContent="#wctx-ai-bar{position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;flex-direction:column;align-items:center;padding:0 12px 14px;pointer-events:none;}"
   +".aib-inner{pointer-events:auto;display:flex;gap:8px;align-items:center;width:100%;max-width:720px;background:var(--paper,#fbf7ef);border:1px solid var(--line,rgba(0,0,0,.12));border-radius:16px;padding:8px 8px 8px 14px;box-shadow:0 10px 40px -12px rgba(0,0,0,.4);}"
   +".aib-spark{font-size:16px;line-height:1;}"
   +"#aib-input{flex:1;border:none;background:none;outline:none;font:inherit;font-size:14px;color:var(--ink,#241d16);padding:8px 4px;}"
   +"#aib-go{border:none;border-radius:11px;background:var(--accent,#bb5a30);color:#fff;font:inherit;font-weight:600;font-size:14px;padding:9px 16px;cursor:pointer;white-space:nowrap;}"
   +"#aib-go:disabled{opacity:.55;cursor:default;}"
   +".aib-undo{border:1px solid var(--line,rgba(0,0,0,.14));background:none;color:var(--ink-soft,#6f6455);border-radius:11px;font:inherit;font-size:13px;padding:9px 12px;cursor:pointer;}"
   +".aib-status{pointer-events:auto;font-size:12.5px;color:var(--ink-soft,#6f6455);margin-top:8px;text-align:center;min-height:15px;}"
   +"#wctx-ai-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:88px;z-index:10000;background:var(--ink,#241d16);color:var(--paper,#fbf7ef);padding:12px 18px;border-radius:12px;font-size:14px;max-width:560px;text-align:center;box-shadow:0 12px 44px -10px rgba(0,0,0,.5);}";
  document.head.appendChild(css);
  var bar=document.createElement("div"); bar.id="wctx-ai-bar";
  bar.innerHTML='<div class="aib-inner"><span class="aib-spark">\\u2728</span><input id="aib-input" placeholder="Opisz zmian\\u0119: np. przytulny klimat, dodaj sekcj\\u0119 o nas, akcent oliwkowy" autocomplete="off"/><button id="aib-go" type="button">Przeprojektuj</button><button id="aib-undo" type="button" class="aib-undo" title="Cofnij ostatni\\u0105 zmian\\u0119 AI">Cofnij</button></div><div id="aib-status" class="aib-status"></div>';
  document.body.appendChild(bar);
  var input=document.getElementById("aib-input"),go=document.getElementById("aib-go"),undo=document.getElementById("aib-undo"),status=document.getElementById("aib-status");
  function req(path,body){var h={"Content-Type":"application/json"};if(EDIT_TOKEN){h["X-Edit-Token"]=EDIT_TOKEN;}else{h["Authorization"]="Bearer "+tok;}return fetch(API+path,{method:"POST",headers:h,body:JSON.stringify(body||{})});}
  function generate(){var p=(input.value||"").trim();if(!p){input.focus();return;}go.disabled=true;status.textContent="Projektuj\\u0119 Twoj\\u0105 stron\\u0119\\u2026";
    req("/api/dashboard/site-generate",{prompt:p}).then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});}).then(function(res){
      if(!res.ok){go.disabled=false;status.textContent=(res.d&&res.d.error)||"Nie uda\\u0142o si\\u0119. Spr\\u00f3buj ponownie.";return;}
      try{sessionStorage.setItem("wctx-ai-summary",res.d.changeSummary||"Zaktualizowano stron\\u0119.");}catch(e){}
      location.reload();
    }).catch(function(){go.disabled=false;status.textContent="B\\u0142\\u0105d po\\u0142\\u0105czenia.";});}
  go.addEventListener("click",generate);
  input.addEventListener("keydown",function(e){if(e.key==="Enter")generate();});
  undo.addEventListener("click",function(){undo.disabled=true;status.textContent="Cofam\\u2026";
    req("/api/dashboard/site-revert",{}).then(function(r){return r.json();}).then(function(d){
      if(d&&d.reverted){location.reload();}else{undo.disabled=false;status.textContent="Nic do cofni\\u0119cia.";}
    }).catch(function(){undo.disabled=false;status.textContent="B\\u0142\\u0105d.";});});
})();
</script>
</body>
</html>`;
}
