/**
 * Renders the auto-generated micro-site for a tenant — a warm, editorial
 * "storefront" page (not a SaaS dashboard): elegant serif display, warm paper
 * palette, a single accent, visible info cards from the KB, and a chat that IS
 * the primary CTA. Chat-first businesses (no siteCard) still get a clean hero.
 */
interface SiteTenant {
  id: string;
  brandName: string | null;
  domain: string;
  settings?: any;
}

const esc = (s: any) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: any) => esc(s).replace(/"/g, "&quot;");

export function renderSitePage(tenant: SiteTenant, baseUrl: string): string {
  const brand = tenant.brandName || tenant.domain;
  const settings = tenant.settings || {};
  const card = settings.siteCard || {};
  const tagline = card.tagline || settings.tagline || "Zapytaj nas o wszystko";
  const eyebrow = card.eyebrow || "";
  const phone = (card.phone || "").toString().trim();
  const accent = settings.accentColor || "#bb5a30";
  const dark = settings.siteTheme === "dark";
  const sections: { label: string; text: string }[] = Array.isArray(card.sections) ? card.sections : [];
  const suggestions: string[] = (Array.isArray(card.suggestions) && card.suggestions.length)
    ? card.suggestions
    : ["Jakie macie godziny?", "Jak się z Wami skontaktować?", "Co oferujecie?"];

  // Palette tokens (warm paper default; dark is a considered swap, not an inversion).
  const t = dark
    ? { bg: "#17130f", paper: "#211b15", ink: "#f3ece0", inkSoft: "#b3a693", inkFaint: "#8a7d6a", line: "rgba(243,236,224,0.14)", lineSoft: "rgba(243,236,224,0.08)" }
    : { bg: "#f4eee3", paper: "#fbf7ef", ink: "#241d16", inkSoft: "#6f6455", inkFaint: "#9a8f7e", line: "rgba(36,29,22,0.12)", lineSoft: "rgba(36,29,22,0.07)" };

  const telHref = phone ? "tel:" + phone.replace(/[^0-9+]/g, "") : "";
  const callCta = phone ? `<a class="call" href="${escAttr(telHref)}">Zadzwoń · ${esc(phone)}</a>` : "";
  const eyebrowHtml = eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : "";
  const chips = suggestions.slice(0, 5).map((q) => `<div class="site-suggestion">${esc(q)}</div>`).join("");
  const infoHtml = sections.length
    ? `<section class="info" id="site-info"><div class="info-head"><span>Wszystko, co warto wiedzieć</span><div class="rule"></div></div><div class="cards">` +
      sections.map((s) => `<div class="card"><h3>${esc(s.label)}</h3><p>${esc(s.text)}</p></div>`).join("") +
      `</div></section>`
    : "";

  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(brand)}</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,500&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:${t.bg}; --paper:${t.paper}; --ink:${t.ink}; --ink-soft:${t.inkSoft}; --ink-faint:${t.inkFaint};
    --line:${t.line}; --line-soft:${t.lineSoft};
    --accent:${accent}; --accent-soft:${accent}1f;
    --shadow:0 1px 2px rgba(20,15,10,0.05), 0 14px 34px -14px rgba(20,15,10,0.20);
    --serif:"Fraunces",Georgia,serif; --sans:"Instrument Sans",system-ui,sans-serif;
  }
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body{min-height:100%;}
  body{
    font-family:var(--sans); color:var(--ink); background:var(--bg); line-height:1.6;
    -webkit-font-smoothing:antialiased; display:flex; flex-direction:column; min-height:100vh; position:relative;
    background-image:
      radial-gradient(1100px 620px at 82% -8%, var(--accent-soft), transparent 62%),
      radial-gradient(900px 520px at 8% 4%, rgba(120,110,70,0.08), transparent 60%);
  }
  body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:${dark ? "0.06" : "0.05"};
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}
  .wrap{position:relative;z-index:1;display:flex;flex-direction:column;flex:1;width:100%;}

  header{display:flex;align-items:center;justify-content:space-between;padding:22px clamp(20px,5vw,56px);max-width:1120px;margin:0 auto;width:100%;}
  .brand{display:flex;align-items:center;gap:10px;font-family:var(--serif);font-weight:600;font-size:19px;letter-spacing:-0.01em;color:var(--ink);}
  .brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft);}
  .call{font-size:13.5px;font-weight:600;color:var(--ink);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:9px 18px;transition:all .18s;background:var(--paper);white-space:nowrap;}
  .call:hover{border-color:var(--accent);color:var(--accent);transform:translateY(-1px);}

  .hero{max-width:820px;margin:0 auto;padding:clamp(36px,8vw,90px) clamp(20px,5vw,56px) 16px;text-align:center;width:100%;}
  .eyebrow{font-size:12px;letter-spacing:0.26em;text-transform:uppercase;color:var(--accent);font-weight:600;margin-bottom:22px;opacity:0;animation:rise .7s .05s forwards;}
  .hero h1{font-family:var(--serif);font-weight:600;font-size:clamp(42px,8.5vw,86px);line-height:0.99;letter-spacing:-0.025em;margin-bottom:16px;text-wrap:balance;color:var(--ink);opacity:0;animation:rise .8s .12s forwards;}
  .hero .tag{font-family:var(--serif);font-style:italic;font-weight:500;font-size:clamp(18px,3vw,23px);color:var(--ink-soft);margin-bottom:34px;opacity:0;animation:rise .8s .2s forwards;}
  .ask{display:flex;align-items:center;gap:8px;background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:8px 8px 8px 20px;max-width:540px;margin:0 auto;box-shadow:var(--shadow);opacity:0;animation:rise .8s .28s forwards;}
  .ask input{flex:1;border:none;background:none;outline:none;font-family:var(--sans);font-size:16px;color:var(--ink);padding:10px 0;}
  .ask input::placeholder{color:var(--ink-faint);}
  .ask button{width:44px;height:44px;border:none;border-radius:13px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .16s;flex-shrink:0;}
  .ask button:hover{filter:brightness(0.92);transform:scale(1.05);}
  .ask button svg{width:18px;height:18px;}
  .site-suggestions{display:flex;flex-wrap:wrap;gap:9px;justify-content:center;margin:20px auto 0;max-width:600px;opacity:0;animation:rise .8s .36s forwards;}
  .site-suggestion{font-size:13.5px;color:var(--ink-soft);background:var(--paper);border:1px solid var(--line-soft);border-radius:999px;padding:8px 15px;cursor:pointer;transition:all .18s;}
  .site-suggestion:hover{border-color:var(--accent);color:var(--accent);transform:translateY(-1px);box-shadow:var(--shadow);}

  .info{max-width:1000px;margin:clamp(40px,8vw,78px) auto 0;padding:0 clamp(20px,5vw,56px);width:100%;}
  .info-head{display:flex;align-items:center;gap:16px;margin-bottom:24px;}
  .info-head span{font-family:var(--serif);font-size:22px;font-weight:600;color:var(--ink);}
  .info-head .rule{flex:1;height:1px;background:var(--line);}
  .cards{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;}
  .card{background:var(--paper);border:1px solid var(--line-soft);border-radius:18px;padding:24px 26px;box-shadow:var(--shadow);position:relative;overflow:hidden;opacity:0;animation:rise .7s forwards;transition:transform .2s,box-shadow .2s;}
  .card:hover{transform:translateY(-3px);box-shadow:0 2px 4px rgba(20,15,10,0.06),0 22px 46px -14px rgba(20,15,10,0.28);}
  .card::before{content:"";position:absolute;top:0;left:0;width:40px;height:3px;background:var(--accent);border-radius:0 0 3px 0;}
  .card h3{font-size:11.5px;letter-spacing:0.14em;text-transform:uppercase;color:var(--accent);font-weight:600;margin-bottom:11px;}
  .card p{font-size:14.5px;line-height:1.62;color:var(--ink);white-space:pre-wrap;}
  .card:nth-child(1){animation-delay:.30s;}.card:nth-child(2){animation-delay:.36s;}.card:nth-child(3){animation-delay:.42s;}.card:nth-child(4){animation-delay:.48s;}.card:nth-child(5){animation-delay:.54s;}.card:nth-child(6){animation-delay:.60s;}.card:nth-child(7){animation-delay:.66s;}.card:nth-child(8){animation-delay:.72s;}

  /* chat mode */
  .site-messages{display:none;width:100%;max-width:600px;margin:0 auto;flex:1;overflow-y:auto;padding:8px 20px 16px;}
  .site-messages.active{display:flex;flex-direction:column;gap:12px;}
  .site-msg{max-width:86%;padding:13px 17px;border-radius:18px;font-size:15px;line-height:1.6;animation:msgIn .3s ease;}
  @keyframes msgIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
  .site-msg.user{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:5px;}
  .site-msg.bot{align-self:flex-start;background:var(--paper);border:1px solid var(--line);border-bottom-left-radius:5px;color:var(--ink);}
  .site-msg.bot a{color:var(--accent);} .site-msg.bot strong{font-weight:600;}
  .site-typing{display:flex;gap:4px;padding:14px 18px;align-self:flex-start;background:var(--paper);border:1px solid var(--line);border-radius:18px 18px 18px 5px;}
  .site-typing span{width:6px;height:6px;border-radius:50%;background:var(--ink-faint);animation:dotB 1.2s infinite;}
  .site-typing span:nth-child(2){animation-delay:.2s;}.site-typing span:nth-child(3){animation-delay:.4s;}
  @keyframes dotB{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
  .site-input-bar{display:none;padding:14px clamp(20px,5vw,56px);border-top:1px solid var(--line-soft);background:var(--bg);}
  .site-input-bar.active{display:block;}
  .site-input-bar .ask{margin:0 auto;}

  footer{max-width:1000px;margin:clamp(46px,8vw,84px) auto 0;padding:26px clamp(20px,5vw,56px) 36px;border-top:1px solid var(--line-soft);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;width:100%;}
  footer .f-brand{font-family:var(--serif);font-weight:600;color:var(--ink);font-size:15px;}
  footer .f-powered{font-size:12.5px;color:var(--ink-faint);}
  footer a{color:var(--ink-soft);text-decoration:none;} footer a:hover{color:var(--accent);}

  @keyframes rise{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:translateY(0);}}
  @media(max-width:640px){.cards{grid-template-columns:1fr;}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand"><span class="dot"></span>${esc(brand)}</div>
    ${callCta}
  </header>

  <main class="hero" id="hero">
    ${eyebrowHtml}
    <h1>${esc(brand)}</h1>
    <p class="tag">${esc(tagline)}</p>
    <div class="ask" id="hero-prompt">
      <input id="chat-input" type="text" placeholder="Zapytaj o menu, godziny, rezerwację…" autocomplete="off" autofocus />
      <button id="chat-send" aria-label="Wyślij"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg></button>
    </div>
    <div class="site-suggestions" id="suggestions">${chips}</div>
  </main>

  <div class="site-messages" id="messages"></div>
  ${infoHtml}

  <div class="site-input-bar" id="input-bar">
    <div class="ask">
      <input id="chat-input-bar" type="text" placeholder="Napisz wiadomość…" autocomplete="off" />
      <button id="chat-send-bar" aria-label="Wyślij"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg></button>
    </div>
  </div>

  <footer>
    <div class="f-brand">${esc(brand)}</div>
    <div class="f-powered">Strona i asystent · <a href="https://whisp.so">Whisp</a></div>
  </footer>
</div>

<script>
(function(){
  var API="${baseUrl}", TENANT="${esc(tenant.id)}", SESSION="site-"+Math.random().toString(36).slice(2);
  var messages=[];
  var hero=document.getElementById("hero"), msgsEl=document.getElementById("messages"), inputBar=document.getElementById("input-bar");
  var heroInput=document.getElementById("chat-input"), barInput=document.getElementById("chat-input-bar"), suggestions=document.getElementById("suggestions");
  var chatMode=false;
  function md(t){return t.replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>").replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank">$1</a>').replace(/\\n\\n/g,"</p><p>").replace(/\\n/g,"<br>").replace(/^/,"<p>").replace(/$/,"</p>");}
  function enterChatMode(){if(chatMode)return;chatMode=true;hero.style.flex="0";hero.style.paddingBottom="0";suggestions.style.display="none";document.getElementById("hero-prompt").style.display="none";var si=document.getElementById("site-info");if(si)si.style.display="none";msgsEl.classList.add("active");inputBar.classList.add("active");barInput.focus();}
  function addMsg(role,text){var d=document.createElement("div");d.className="site-msg "+role;if(role==="bot")d.innerHTML=md(text);else d.textContent=text;msgsEl.appendChild(d);msgsEl.scrollTop=msgsEl.scrollHeight;return d;}
  function showTyping(){var d=document.createElement("div");d.className="site-typing";d.innerHTML="<span></span><span></span><span></span>";msgsEl.appendChild(d);msgsEl.scrollTop=msgsEl.scrollHeight;return d;}
  function send(text){if(!text.trim())return;enterChatMode();messages.push({role:"user",content:text});addMsg("user",text);var typing=showTyping();
    fetch(API+"/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:messages,tenantId:TENANT,sessionId:SESSION})})
    .then(function(r){return r.json().catch(function(){return{};});})
    .then(function(data){typing.remove();var reply=(data&&typeof data.message==="string"&&data.message.trim())?data.message:"Przepraszam, chwilowo nie mogę odpowiedzieć - spróbuj ponownie za moment.";messages.push({role:"assistant",content:reply});addMsg("bot",reply);})
    .catch(function(){typing.remove();addMsg("bot","Coś poszło nie tak. Spróbuj ponownie.");});
    heroInput.value="";barInput.value="";}
  heroInput.addEventListener("keydown",function(e){if(e.key==="Enter")send(this.value);});
  barInput.addEventListener("keydown",function(e){if(e.key==="Enter")send(this.value);});
  document.getElementById("chat-send").addEventListener("click",function(){send(heroInput.value);});
  document.getElementById("chat-send-bar").addEventListener("click",function(){send(barInput.value);});
  document.querySelectorAll(".site-suggestion").forEach(function(el){el.addEventListener("click",function(){send(this.textContent);});});
})();
</script>
</body>
</html>`;
}
