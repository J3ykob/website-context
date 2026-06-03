(function() {
  var config = window.__wctx || {};
  var API_HOST = config.apiHost || window.location.origin;
  var TENANT_ID = config.tenantId || "default";
  var BRAND = config.brandName || "Whisp";

  // Owner mode — activated via ?wctx-owner=true or config.ownerKey matching a cookie
  var urlParams = new URLSearchParams(window.location.search);
  var IS_OWNER = urlParams.get("wctx-owner") === "true" || config.ownerMode === true;

  // Persist owner mode in sessionStorage so it survives navigation
  if (IS_OWNER) sessionStorage.setItem("wctx-owner", "1");
  if (sessionStorage.getItem("wctx-owner") === "1") IS_OWNER = true;

  // --- Adaptive Theme Detection ---
  var currentTheme = "light";
  var themeDebounceTimer = null;

  function getLuminance(r, g, b) {
    return (0.299 * r + 0.587 * g + 0.114 * b);
  }

  function parseColor(colorStr) {
    if (!colorStr || colorStr === "transparent" || colorStr === "rgba(0, 0, 0, 0)") return null;
    var m = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
    return null;
  }

  function detectTheme() {
    // A visitor's explicit saved choice wins over both forceTheme and auto-detection.
    if (settings && (settings.theme === "dark" || settings.theme === "light")) {
      if (settings.theme !== currentTheme) { currentTheme = settings.theme; applyTheme(settings.theme); }
      return settings.theme;
    }
    // Allow forcing theme via config
    if (config.forceTheme === "dark" || config.forceTheme === "light") {
      var forced = config.forceTheme;
      if (forced !== currentTheme) { currentTheme = forced; applyTheme(forced); }
      return forced;
    }
    var theme = "light";
    try {
      // Strategy 1: Check body background color
      var bodyBg = getComputedStyle(document.body).backgroundColor;
      var parsed = parseColor(bodyBg);
      if (parsed && getLuminance(parsed.r, parsed.g, parsed.b) < 128) {
        theme = "dark";
      } else if (!parsed || bodyBg === "rgba(0, 0, 0, 0)") {
        // Strategy 2: Check html background
        var htmlBg = getComputedStyle(document.documentElement).backgroundColor;
        var parsedHtml = parseColor(htmlBg);
        if (parsedHtml && getLuminance(parsedHtml.r, parsedHtml.g, parsedHtml.b) < 128) {
          theme = "dark";
        } else {
          // Strategy 3: Sample elementFromPoint at the bottom center (where bar sits)
          var centerX = window.innerWidth / 2;
          var bottomY = window.innerHeight - 50;
          // Temporarily hide our elements to sample behind
          var fabDisplay = fab ? fab.style.display : "";
          var overlayDisplay = overlay ? overlay.style.display : "";
          if (fab) fab.style.display = "none";
          if (overlay) overlay.style.display = "none";
          var el = document.elementFromPoint(centerX, bottomY);
          if (fab) fab.style.display = fabDisplay;
          if (overlay) overlay.style.display = overlayDisplay;
          if (el) {
            var elBg = getComputedStyle(el).backgroundColor;
            var parsedEl = parseColor(elBg);
            if (parsedEl && getLuminance(parsedEl.r, parsedEl.g, parsedEl.b) < 128) {
              theme = "dark";
            }
          }
        }
      }
    } catch (e) {}

    if (theme !== currentTheme) {
      currentTheme = theme;
      applyTheme(theme);
    }
    return theme;
  }

  function applyTheme(theme) {
    if (theme === "dark") {
      fab && fab.classList.add("wctx-dark");
      overlay && overlay.classList.add("wctx-dark");
    } else {
      fab && fab.classList.remove("wctx-dark");
      overlay && overlay.classList.remove("wctx-dark");
    }
  }

  // ---- Visitor-local settings (theme / font size / color-impaired), cached in localStorage ----
  var SETTINGS_KEY = "wctx-settings";
  var settings = (function () { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; } })();
  function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }
  function applySettings() {
    [fab, overlay].forEach(function (el) {
      if (!el) return;
      el.classList.remove("wctx-fs-s", "wctx-fs-m", "wctx-fs-l");
      el.classList.add("wctx-fs-" + (settings.fontSize || "m"));
      el.classList.toggle("wctx-cb", settings.colorImpaired === true);
    });
    if (settings.theme === "dark" || settings.theme === "light") {
      currentTheme = settings.theme;
      applyTheme(settings.theme);
    }
    if (typeof updateSettingsUI === "function") updateSettingsUI();
  }
  function setThemePref(theme) {
    settings.theme = theme; currentTheme = theme; applyTheme(theme); saveSettings();
    if (typeof updateSettingsUI === "function") updateSettingsUI();
  }

  function debouncedDetectTheme() {
    if (themeDebounceTimer) clearTimeout(themeDebounceTimer);
    themeDebounceTimer = setTimeout(detectTheme, 150);
  }

  // Check for pending guided execution (resumed after navigation)
  var pendingGuided = sessionStorage.getItem("wctx-guided-state");
  if (pendingGuided) {
    sessionStorage.removeItem("wctx-guided-state");
    try {
      var guidedState = JSON.parse(pendingGuided);
      // Don't show the chat overlay — go straight to guided execution
      window.addEventListener("load", function() {
        // Inject guided executor and resume
        window.__flowRecorderConfig = { apiHost: API_HOST, tenantId: TENANT_ID };
        var gs = document.createElement("script");
        gs.src = API_HOST + "/guided-executor.js";
        gs.onload = function() {
          window.__wctxGuided.execute(
            guidedState.steps.slice(guidedState.nextIndex),
            guidedState.inputs
          );
        };
        document.head.appendChild(gs);
      });
      // Still load the widget below, but start minimized
      // We'll set a flag so the widget starts in bar mode
      var START_MINIMIZED = true;
    } catch(e) {}
  }

  // Direct record mode (legacy) — ?wctx-record=true
  if (urlParams.get("wctx-record") === "true") {
    window.__flowRecorderConfig = { apiHost: API_HOST, tenantId: TENANT_ID };
    var rs = document.createElement("script");
    rs.src = API_HOST + "/recorder.js";
    document.head.appendChild(rs);
    return;
  }

  // Inject font into the main document (Shadow DOM can't load fonts itself)
  if (!document.getElementById("wctx-font")) {
    var link = document.createElement("link");
    link.id = "wctx-font";
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&display=swap";
    document.head.appendChild(link);
  }

  // Build the overlay directly in the DOM (not Shadow DOM — avoids font/positioning issues)
  var overlay = document.createElement("div");
  overlay.id = "wctx-overlay";
  overlay.innerHTML = buildHTML();
  document.body.appendChild(overlay);

  // Restore messages from sessionStorage so chat survives navigation
  var savedMsgs = sessionStorage.getItem("wctx-messages");
  var messages = savedMsgs ? JSON.parse(savedMsgs) : [];
  var state = messages.length > 0 ? "chat" : "idle";
  var isLoading = false;

  function persistMessages() {
    sessionStorage.setItem("wctx-messages", JSON.stringify(messages.slice(-20)));
  }

  var els = {
    shell:   overlay.querySelector(".wctx-shell"),
    main:    overlay.querySelector(".wctx-main"),
    prompt:  overlay.querySelector(".wctx-idle-prompt"),
    inputZone: overlay.querySelector(".wctx-input-zone"),
    footnote: overlay.querySelector(".wctx-idle-footnote"),
    msgs:    overlay.querySelector(".wctx-messages"),
    input:   overlay.querySelector(".wctx-chat-input"),
    send:    overlay.querySelector(".wctx-send-btn"),
    browse:  overlay.querySelector(".wctx-browse-btn"),
  };

  // Events
  els.send.addEventListener("click", sendMessage);
  els.input.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  // Persistent bottom bar (Wispr Flow style) — shown when browsing
  var fab = document.createElement("div");
  fab.id = "wctx-fab";
  fab.innerHTML = '<style>\
#wctx-fab {\
  position:fixed; bottom:26px; left:50%; transform:translateX(-50%);\
  z-index:999998; display:none;\
  max-width:calc(100vw - 20px);\
}\
/* The input pill is the only in-flow element, so the fab (centered) keeps the INPUT\
   screen-centered. The mic + controls are absolutely positioned flanking it (asymmetric),\
   and stay hidden until the bar is interacted with (hover / focus / typing). */\
#wctx-fab .wctx-bar-row { position:relative; }\
#wctx-fab .wctx-glass {\
  background:rgba(200,200,210,0.55);\
  backdrop-filter:blur(40px) saturate(1.5); -webkit-backdrop-filter:blur(40px) saturate(1.5);\
  border:1px solid rgba(255,255,255,0.2); box-shadow:0 6px 24px rgba(0,0,0,0.12);\
}\
/* Bubbles start tucked UNDER the input (translated inward, scaled down, z-index below the\
   pill) and fly outward to the sides when the bar becomes active. */\
#wctx-fab .wctx-mic {\
  position:absolute; right:calc(100% + 10px); bottom:2px; z-index:1;\
  width:48px; height:48px; border-radius:50%;\
  display:flex; align-items:center; justify-content:center;\
  color:rgba(10,10,10,0.4); cursor:not-allowed; padding:0;\
  opacity:0; transform:translateX(64px) scale(0.5); transform-origin:right center; pointer-events:none;\
  transition:opacity 0.3s ease, transform 0.45s cubic-bezier(0.34,1.45,0.6,1);\
}\
#wctx-fab .wctx-ctrls {\
  position:absolute; left:calc(100% + 10px); bottom:2px; z-index:1;\
  display:flex; align-items:center; gap:2px; height:48px; padding:0 5px; border-radius:26px;\
  opacity:0; transform:translateX(-64px) scale(0.5); transform-origin:left center; pointer-events:none;\
  transition:opacity 0.3s ease, transform 0.45s cubic-bezier(0.34,1.45,0.6,1);\
}\
#wctx-fab.wctx-active .wctx-mic { opacity:0.55; transform:translateX(0) scale(1); }\
#wctx-fab.wctx-active .wctx-ctrls { opacity:1; transform:translateX(0) scale(1); pointer-events:auto; }\
#wctx-fab .wctx-ctl {\
  width:38px; height:38px; display:flex; align-items:center; justify-content:center;\
  background:none; border:none; cursor:pointer; border-radius:50%;\
  color:rgba(10,10,10,0.5); transition:background 0.2s, color 0.2s; padding:0;\
}\
#wctx-fab .wctx-ctl:hover { background:rgba(255,255,255,0.55); color:rgba(10,10,10,0.85); }\
#wctx-fab .wctx-bar-wrap {\
  display:flex;\
  flex-direction:column;\
  position:relative; z-index:2;\
  border-radius:24px;\
  width:clamp(260px, 30vw, 380px);\
  background:rgba(200,200,210,0.55);\
  backdrop-filter:blur(40px) saturate(1.5);\
  -webkit-backdrop-filter:blur(40px) saturate(1.5);\
  border:1px solid rgba(255,255,255,0.2);\
  box-shadow:0 6px 24px rgba(0,0,0,0.12);\
  transition:width 0.35s cubic-bezier(0.4,0,0.2,1), max-height 0.35s cubic-bezier(0.4,0,0.2,1), box-shadow 0.35s;\
  overflow:hidden;\
  max-height:52px;\
}\
#wctx-fab.wctx-active .wctx-bar-wrap {\
  width:clamp(320px, 60vw, 760px);\
  max-height:min(72vh, 620px);\
  box-shadow:0 12px 48px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.5);\
}\
/* Tablet: wide expanded input but still room for the bubbles. */\
@media (min-width:641px) and (max-width:1024px) { #wctx-fab.wctx-active .wctx-bar-wrap { width:clamp(320px, 56vw, 560px); } }\
/* Mobile: shrink bubbles + size the expanded input to the space left after they fly out, so nothing clips. */\
@media (max-width:640px) {\
  #wctx-fab .wctx-bar-wrap { width:clamp(140px, 52vw, 260px); }\
  /* input is centered, so symmetric space = 2x the wider (controls) side must fit */\
  #wctx-fab.wctx-active .wctx-bar-wrap { width:calc(100vw - 224px); }\
  #wctx-fab .wctx-mic { width:40px; height:40px; right:calc(100% + 7px); }\
  #wctx-fab .wctx-ctrls { height:40px; left:calc(100% + 7px); padding:0 3px; }\
  #wctx-fab .wctx-ctl { width:30px; height:30px; }\
}\
#wctx-fab .wctx-bar-messages {\
  display:flex;\
  flex-direction:column;\
  overflow-y:auto;\
  padding:0;\
  max-height:0;\
  opacity:0;\
  transition:all 0.35s cubic-bezier(0.4,0,0.2,1);\
}\
#wctx-fab.wctx-active .wctx-bar-messages {\
  max-height:min(64vh, 540px);\
  padding:12px 14px;\
  opacity:1;\
}\
#wctx-fab .wctx-bar-messages:empty { padding:0; max-height:0; }\
#wctx-fab .wctx-bar-bubble {\
  font-family:"Archivo",-apple-system,sans-serif;\
  font-size:16px; line-height:1.5; margin-bottom:6px;\
  padding:6px 10px;\
  border-radius:10px;\
  max-width:85%;\
  animation:wctx-bubbleIn 0.25s ease-out both;\
}\
@keyframes wctx-bubbleIn {\
  from { opacity:0; transform:translateY(6px) scale(0.95); }\
  to { opacity:1; transform:translateY(0) scale(1); }\
}\
#wctx-fab .wctx-bar-bubble:last-child { margin-bottom:0; }\
#wctx-fab .wctx-bar-bubble.user {\
  align-self:flex-end; margin-left:auto;\
  background:rgba(10,10,10,0.55);\
  color:rgba(255,255,255,0.9);\
  border-bottom-right-radius:4px;\
}\
#wctx-fab .wctx-bar-bubble.assistant {\
  align-self:flex-start; margin-right:auto;\
  background:rgba(255,255,255,0.3);\
  color:rgba(10,10,10,0.75);\
  border:1px solid rgba(0,0,0,0.04);\
  border-bottom-left-radius:4px;\
}\
/* markdown inside the compact bar bubble — keep tight + consistent (12px) */\
#wctx-fab .wctx-bar-bubble p { margin:0 0 5px; font-size:inherit; }\
#wctx-fab .wctx-bar-bubble p:last-child { margin-bottom:0; }\
#wctx-fab .wctx-bar-bubble strong { font-weight:700; }\
#wctx-fab .wctx-bar-bubble br { line-height:1.5; }\
#wctx-fab .wctx-bar-bubble code { background:rgba(0,0,0,0.06); padding:1px 5px; border-radius:4px; font-size:11px; font-family:ui-monospace,monospace; }\
#wctx-fab .wctx-bar-bubble pre { background:rgba(10,10,10,0.8); color:rgba(255,255,255,0.9); padding:8px 10px; font-size:11px; overflow-x:auto; margin:5px 0; border-radius:8px; white-space:pre-wrap; }\
#wctx-fab .wctx-bar-bubble a { color:inherit; text-decoration:underline; }\
#wctx-fab .wctx-bar-bubble a.wctx-page-link, #wctx-fab .wctx-bar-bubble a.wctx-action-btn {\
  display:inline-flex; align-items:center; gap:4px;\
  background:rgba(0,0,0,0.06); border:1px solid rgba(0,0,0,0.08); border-radius:7px;\
  padding:3px 9px; margin:3px 3px 3px 0; font-size:11px; font-weight:600;\
  color:inherit; text-decoration:none; cursor:pointer; line-height:1.3;\
}\
#wctx-fab.wctx-dark .wctx-bar-bubble a.wctx-page-link, #wctx-fab.wctx-dark .wctx-bar-bubble a.wctx-action-btn {\
  background:rgba(255,255,255,0.12); border-color:rgba(255,255,255,0.18);\
}\
#wctx-fab .wctx-bar {\
  display:flex; align-items:center; gap:10px;\
  padding:6px 6px 6px 18px;\
  flex-shrink:0;\
}\
#wctx-fab .wctx-bar-dot {\
  width:6px; height:6px; flex-shrink:0;\
  background:rgba(52,199,89,0.8);\
  border-radius:50%;\
  animation:wctx-blink 2.8s ease-in-out infinite;\
}\
#wctx-fab .wctx-bar-input {\
  flex:1; border:none; outline:none; background:transparent;\
  font-family:"Archivo",-apple-system,sans-serif;\
  font-size:16px; font-weight:500; color:rgba(10,10,10,0.8);\
  min-width:0;\
}\
#wctx-fab .wctx-bar-input::placeholder { color:rgba(10,10,10,0.3); }\
#wctx-fab .wctx-bar-send {\
  flex-shrink:0; width:34px; height:34px; border-radius:50%;\
  display:flex; align-items:center; justify-content:center;\
  color:rgba(10,10,10,0.55); background:rgba(255,255,255,0.45);\
  border:1px solid rgba(0,0,0,0.06); cursor:pointer; padding:0;\
  transition:all 0.2s;\
}\
#wctx-fab .wctx-bar-send:hover { background:rgba(255,255,255,0.85); color:rgba(10,10,10,0.9); }\
/* .wctx-bar-expand is now a .wctx-ctl (styled above); class kept only as a JS hook */\
\
#wctx-fab.wctx-dark .wctx-bar-wrap {\
  background:rgba(20,20,35,0.6);\
  border-color:rgba(255,255,255,0.08);\
  box-shadow:0 6px 24px rgba(0,0,0,0.3);\
  backdrop-filter:blur(40px) saturate(1.5); -webkit-backdrop-filter:blur(40px) saturate(1.5);\
}\
#wctx-fab.wctx-dark.wctx-active .wctx-bar-wrap {\
  box-shadow:0 12px 48px rgba(0,0,0,0.5);\
}\
#wctx-fab.wctx-dark .wctx-bar-bubble.user {\
  background:rgba(80,80,80,0.7);\
  color:#fff;\
}\
#wctx-fab.wctx-dark .wctx-bar-bubble.assistant {\
  background:rgba(50,50,50,0.7);\
  color:rgba(255,255,255,0.95);\
  border-color:rgba(80,80,80,0.4);\
}\
#wctx-fab.wctx-dark .wctx-bar-input { color:#fff; }\
#wctx-fab.wctx-dark .wctx-bar-input::placeholder { color:rgba(255,255,255,0.4); }\
#wctx-fab.wctx-dark .wctx-bar-send {\
  color:rgba(255,255,255,0.6);\
  background:rgba(255,255,255,0.08);\
  border-color:rgba(255,255,255,0.12);\
}\
#wctx-fab.wctx-dark .wctx-bar-send:hover { background:rgba(255,255,255,0.15); color:rgba(255,255,255,0.9); }\
#wctx-fab.wctx-dark .wctx-glass { background:rgba(20,20,35,0.6); border-color:rgba(255,255,255,0.08); box-shadow:0 6px 24px rgba(0,0,0,0.3); }\
#wctx-fab.wctx-dark .wctx-mic { color:rgba(255,255,255,0.4); }\
#wctx-fab.wctx-dark .wctx-ctl { color:rgba(255,255,255,0.55); }\
#wctx-fab.wctx-dark .wctx-ctl:hover { background:rgba(255,255,255,0.12); color:#fff; }\
/* font-size visitor setting (s/m/l) */\
#wctx-fab.wctx-fs-s .wctx-bar-bubble, #wctx-fab.wctx-fs-s .wctx-bar-input { font-size:14px; }\
#wctx-fab.wctx-fs-l .wctx-bar-bubble, #wctx-fab.wctx-fs-l .wctx-bar-input { font-size:19px; }\
/* color-impaired mode: max contrast + non-color cues (underlined links) */\
#wctx-fab.wctx-cb .wctx-bar-dot { background:#0a84ff; box-shadow:0 0 0 2px rgba(255,255,255,0.6); }\
#wctx-fab.wctx-cb .wctx-bar-bubble.assistant { background:#fff; color:#000; border:2px solid #000; }\
#wctx-fab.wctx-cb .wctx-bar-bubble.user { background:#000; color:#fff; border:2px solid #000; }\
#wctx-fab.wctx-cb.wctx-dark .wctx-bar-bubble.assistant { background:#000; color:#fff; border:2px solid #fff; }\
#wctx-fab.wctx-cb.wctx-dark .wctx-bar-bubble.user { background:#fff; color:#000; border:2px solid #fff; }\
#wctx-fab.wctx-cb .wctx-bar-bubble a { text-decoration:underline; font-weight:700; }\
</style>\
<div class="wctx-bar-row">\
  <button class="wctx-mic wctx-glass" type="button" disabled title="Voice input (coming soon)">\
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/></svg>\
  </button>\
  <div class="wctx-bar-wrap">\
    <div class="wctx-bar-messages" id="wctx-bar-msgs"></div>\
    <div class="wctx-bar">\
      <span class="wctx-bar-dot"></span>\
      <input class="wctx-bar-input" type="text" placeholder="Ask anything…" autocomplete="off" />\
      <button class="wctx-bar-send" type="button" title="Send">\
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>\
      </button>\
    </div>\
  </div>\
  <div class="wctx-ctrls wctx-glass">\
    <button class="wctx-ctl wctx-ctl-settings" type="button" title="Settings">\
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>\
    </button>\
    <button class="wctx-ctl wctx-ctl-theme" type="button" title="Toggle light / dark">\
      <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>\
    </button>\
    <button class="wctx-ctl wctx-bar-expand" type="button" title="Expand chat">\
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H4v6M4 4l6 6M14 20h6v-6M20 20l-6-6"/></svg>\
    </button>\
  </div>\
</div>';
  document.body.appendChild(fab);

  var barInput = fab.querySelector(".wctx-bar-input");
  var barSend = fab.querySelector(".wctx-bar-send");
  var barExpand = fab.querySelector(".wctx-bar-expand");
  var barWrap = fab.querySelector(".wctx-bar-wrap");
  var barMsgs = fab.querySelector("#wctx-bar-msgs");
  var btnSettings = fab.querySelector(".wctx-ctl-settings");
  var btnTheme = fab.querySelector(".wctx-ctl-theme");

  // ---- Settings modal (theme / text size / color-impaired) — local visitor prefs ----
  var settingsModal = null;
  function buildSettingsModal() {
    var m = document.createElement("div");
    m.id = "wctx-settings-modal";
    m.innerHTML = '<style>\
#wctx-settings-modal { position:fixed; inset:0; z-index:1000000; display:none; align-items:center; justify-content:center; }\
#wctx-settings-modal.open { display:flex; }\
#wctx-settings-modal .wctx-sm-bg { position:absolute; inset:0; background:rgba(10,10,15,0.5); backdrop-filter:blur(5px); -webkit-backdrop-filter:blur(5px); }\
#wctx-settings-modal .wctx-sm-card { position:relative; width:min(420px, calc(100vw - 32px)); max-height:85vh; overflow-y:auto; background:#fff; color:#16161c; border-radius:22px; padding:24px; box-shadow:0 24px 80px rgba(0,0,0,0.4); font-family:"Archivo",-apple-system,sans-serif; animation:wctx-sm-in 0.25s cubic-bezier(0.16,1,0.3,1) both; }\
@keyframes wctx-sm-in { from { opacity:0; transform:translateY(16px) scale(0.97);} to { opacity:1; transform:none; } }\
#wctx-settings-modal.wctx-dark .wctx-sm-card { background:#1c1c28; color:#f0f0f5; }\
#wctx-settings-modal .wctx-sm-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }\
#wctx-settings-modal .wctx-sm-head h3 { margin:0; font-size:19px; font-weight:700; }\
#wctx-settings-modal .wctx-sm-close { background:none; border:none; cursor:pointer; font-size:24px; line-height:1; color:inherit; opacity:0.45; padding:2px 6px; }\
#wctx-settings-modal .wctx-sm-close:hover { opacity:1; }\
#wctx-settings-modal .wctx-sm-row { margin-bottom:22px; }\
#wctx-settings-modal .wctx-sm-label { font-size:12px; font-weight:700; opacity:0.55; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:9px; }\
#wctx-settings-modal .wctx-seg { display:flex; gap:7px; }\
#wctx-settings-modal .wctx-seg button { flex:1; padding:11px; border-radius:13px; border:1.5px solid rgba(120,120,140,0.25); background:transparent; color:inherit; font-family:inherit; font-size:14px; font-weight:600; cursor:pointer; transition:all 0.15s; }\
#wctx-settings-modal .wctx-seg button:hover { border-color:rgba(120,120,140,0.55); }\
#wctx-settings-modal .wctx-seg button.active { background:#0a84ff; border-color:#0a84ff; color:#fff; }\
#wctx-settings-modal .wctx-toggle-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }\
#wctx-settings-modal .wctx-toggle-row span { font-size:15px; font-weight:600; }\
#wctx-settings-modal .wctx-switch { width:48px; height:28px; border-radius:14px; border:none; background:rgba(120,120,140,0.35); position:relative; cursor:pointer; transition:background 0.2s; flex-shrink:0; }\
#wctx-settings-modal .wctx-switch::after { content:""; position:absolute; top:3px; left:3px; width:22px; height:22px; border-radius:50%; background:#fff; transition:transform 0.2s; box-shadow:0 1px 3px rgba(0,0,0,0.3); }\
#wctx-settings-modal .wctx-switch.on { background:#0a84ff; }\
#wctx-settings-modal .wctx-switch.on::after { transform:translateX(20px); }\
#wctx-settings-modal .wctx-sm-hint { font-size:12px; opacity:0.5; margin-top:7px; line-height:1.4; }\
</style>\
<div class="wctx-sm-bg"></div>\
<div class="wctx-sm-card">\
  <div class="wctx-sm-head"><h3>Settings</h3><button class="wctx-sm-close" type="button" aria-label="Close">&times;</button></div>\
  <div class="wctx-sm-row"><div class="wctx-sm-label">Theme</div><div class="wctx-seg" data-seg="theme"><button data-v="light" type="button">Light</button><button data-v="dark" type="button">Dark</button></div></div>\
  <div class="wctx-sm-row"><div class="wctx-sm-label">Text size</div><div class="wctx-seg" data-seg="fontSize"><button data-v="s" type="button">Small</button><button data-v="m" type="button">Medium</button><button data-v="l" type="button">Large</button></div></div>\
  <div class="wctx-sm-row"><div class="wctx-toggle-row"><span>Color-impaired mode</span><button class="wctx-switch" data-toggle="colorImpaired" type="button" aria-label="Toggle color-impaired mode"></button></div><div class="wctx-sm-hint">Maximizes contrast and underlines links for clearer visibility.</div></div>\
</div>';
    document.body.appendChild(m);
    m.querySelector(".wctx-sm-bg").addEventListener("click", closeSettings);
    m.querySelector(".wctx-sm-close").addEventListener("click", closeSettings);
    m.querySelectorAll(".wctx-seg").forEach(function (seg) {
      seg.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-v]"); if (!b) return;
        var key = seg.getAttribute("data-seg"); var val = b.getAttribute("data-v");
        if (key === "theme") { setThemePref(val); }
        else { settings[key] = val; saveSettings(); applySettings(); }
      });
    });
    m.querySelector('[data-toggle="colorImpaired"]').addEventListener("click", function () {
      settings.colorImpaired = !settings.colorImpaired; saveSettings(); applySettings();
    });
    return m;
  }
  function updateSettingsUI() {
    if (!settingsModal) return;
    var t = settings.theme || currentTheme;
    var fs = settings.fontSize || "m";
    settingsModal.querySelectorAll('[data-seg="theme"] button').forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-v") === t); });
    settingsModal.querySelectorAll('[data-seg="fontSize"] button').forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-v") === fs); });
    var sw = settingsModal.querySelector('[data-toggle="colorImpaired"]'); if (sw) sw.classList.toggle("on", settings.colorImpaired === true);
    settingsModal.classList.toggle("wctx-dark", currentTheme === "dark");
  }
  function openSettings() { if (!settingsModal) settingsModal = buildSettingsModal(); settingsModal.classList.add("open"); updateSettingsUI(); }
  function closeSettings() { if (settingsModal) settingsModal.classList.remove("open"); }
  if (btnSettings) btnSettings.addEventListener("click", openSettings);
  if (btnTheme) btnTheme.addEventListener("click", function () { setThemePref(currentTheme === "dark" ? "light" : "dark"); });
  // Apply any saved visitor prefs now that fab + overlay exist.
  applySettings();

  // Active = any interaction with the bar (hover OR focus/typing). Expands the input and
  // reveals the flanking bubbles. mouseover/mouseout bubble up from the absolutely-positioned
  // bubbles (DOM children of the fab) even though they sit outside the fab's box, so moving
  // the cursor from the input onto a bubble keeps it open (no hover gap).
  var activeTimer;
  function setBarActive(on) {
    clearTimeout(activeTimer);
    if (on) { fab.classList.add("wctx-active"); }
    else { activeTimer = setTimeout(function() { if (document.activeElement !== barInput) fab.classList.remove("wctx-active"); }, 240); }
  }
  fab.addEventListener("mouseover", function() { setBarActive(true); });
  fab.addEventListener("mouseout", function(e) { if (!fab.contains(e.relatedTarget)) setBarActive(false); });
  barInput.addEventListener("focus", function() { setBarActive(true); });
  barInput.addEventListener("blur", function() { setBarActive(false); });

  // Send from the bottom bar — stay in bar mode, don't expand to full chat
  barSend.addEventListener("click", function() { sendFromBar(); });
  barInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") { e.preventDefault(); sendFromBar(); }
  });

  function sendFromBar() {
    var text = barInput.value.trim();
    if (!text) return;
    barInput.value = "";
    fab.classList.add("wctx-active");

    messages.push({ role: "user", content: text }); persistMessages();
    syncBarMessages();

    // Also add to the full chat messages (so they're there if user expands)
    if (state === "idle") {
      state = "chat";
      els.main.classList.remove("wctx-state-idle");
      els.main.classList.add("wctx-state-chat");
    }
    appendMsg("user", text);

    // Streaming bubble in the bar — starts as "Thinking...", fills token-by-token.
    var streamDiv = document.createElement("div");
    streamDiv.className = "wctx-bar-bubble assistant";
    streamDiv.id = "wctx-bar-thinking";
    streamDiv.textContent = "Thinking...";
    barMsgs.appendChild(streamDiv);
    barMsgs.scrollTop = barMsgs.scrollHeight;

    var raw = "";
    streamChat({
      onFirst: function() { raw = ""; streamDiv.innerHTML = ""; },
      onDelta: function(delta) {
        raw += delta;
        streamDiv.innerHTML = md(raw);
        barMsgs.scrollTop = barMsgs.scrollHeight;
      },
      onDone: function(data) {
        var t = document.getElementById("wctx-bar-thinking"); if (t) t.remove();
        messages.push({ role: "assistant", content: data.message }); persistMessages();
        appendMsg("assistant", data.message, data.sources);
        syncBarMessages(); // re-render the bar properly (links, sources, last-4 window)
        if (data.navigateTo) {
          setTimeout(function() { navigateToPage(data.navigateTo, ""); }, 1000);
        }
        if (data.flowSession && data.flowSession.guidedSteps && data.flowSession.guidedSteps.length > 0) {
          setTimeout(function() { launchGuidedExecution(data.flowSession.guidedSteps, data.flowSession.guidedInputs || {}); }, 800);
        } else if (data.flowSession && data.flowSession.active) {
          barInput.placeholder = "Provide the requested info...";
        }
      },
      onError: function(msg) {
        var t = document.getElementById("wctx-bar-thinking"); if (t) t.remove();
        messages.push({ role: "assistant", content: msg || "Something went wrong." }); persistMessages();
        syncBarMessages();
      }
    });
  }

  // Expand to full chat
  barExpand.addEventListener("click", openFullChat);

  // Sync messages to the mini bar view — render the SAME markdown as the full chat
  // (links, lists, line breaks, code) so the minimized bar isn't a wall of plain text.
  function syncBarMessages() {
    barMsgs.innerHTML = "";
    var recent = messages.slice(-4);
    recent.forEach(function(m, i) {
      var bubble = document.createElement("div");
      bubble.className = "wctx-bar-bubble" + (m.role === "user" ? " user" : " assistant");
      bubble.style.animationDelay = (i * 60) + "ms";
      if (m.role === "user") {
        bubble.textContent = m.content;
      } else {
        bubble.innerHTML = md(m.content);
        // Same link behavior as the full chat (navigate/open); tel:/mailto: stay native
        bubble.querySelectorAll("a[href]").forEach(function(a) {
          var href = a.getAttribute("href");
          if (!href || href.charAt(0) === "#" || href.indexOf("mailto:") === 0 || href.indexOf("tel:") === 0) return;
          a.removeAttribute("target");
          a.addEventListener("click", function(e) { e.preventDefault(); navigateToPage(href, a.textContent); });
        });
      }
      barMsgs.appendChild(bubble);
    });
    barMsgs.scrollTop = barMsgs.scrollHeight;
  }

  // Owner panel toggle
  if (IS_OWNER) {
    var ownerToggle = overlay.querySelector("#wctx-owner-toggle");
    var ownerPanel = overlay.querySelector("#wctx-owner-panel");

    ownerToggle.addEventListener("click", function() {
      ownerPanel.classList.toggle("open");
    });

    // Close panel when clicking outside
    document.addEventListener("click", function(e) {
      if (ownerPanel.classList.contains("open") && !ownerPanel.contains(e.target) && e.target !== ownerToggle) {
        ownerPanel.classList.remove("open");
      }
    });

    // Record flow
    overlay.querySelector("#wctx-action-record").addEventListener("click", function() {
      ownerPanel.classList.remove("open");
      minimizeToBar();
      window.__flowRecorderConfig = { apiHost: API_HOST, tenantId: TENANT_ID };
      var rs = document.createElement("script");
      rs.src = API_HOST + "/recorder.js";
      document.head.appendChild(rs);
    });

    // View flows
    overlay.querySelector("#wctx-action-flows").addEventListener("click", function() {
      ownerPanel.classList.remove("open");
      fetch(API_HOST + "/api/flows?tenantId=" + TENANT_ID)
        .then(function(r) { return r.json(); })
        .then(function(flows) {
          if (flows.length === 0) {
            appendMsg("system", "No flows recorded yet. Use 'Record a flow' to create one.");
          } else {
            var list = flows.map(function(f) {
              return "- **" + f.name + "** (" + f.status + ") — " + f.steps.length + " steps, triggers: " + (f.triggerPhrases || []).slice(0, 3).join(", ");
            }).join("\n");
            appendMsg("assistant", "Saved flows:\n\n" + list);
          }
          if (state === "idle") {
            state = "chat";
            els.main.classList.remove("wctx-state-idle");
            els.main.classList.add("wctx-state-chat");
          }
        });
    });

    // Re-scrape
    overlay.querySelector("#wctx-action-rescrape").addEventListener("click", function() {
      ownerPanel.classList.remove("open");
      appendMsg("system", "Re-scraping... (this will be available in the dashboard)");
      if (state === "idle") {
        state = "chat";
        els.main.classList.remove("wctx-state-idle");
        els.main.classList.add("wctx-state-chat");
      }
    });

    // Exit owner mode
    overlay.querySelector("#wctx-action-exit").addEventListener("click", function() {
      ownerPanel.classList.remove("open");
      sessionStorage.removeItem("wctx-owner");
      // Remove owner button
      ownerToggle.remove();
      ownerPanel.remove();
    });
  }

  function openFullChat() {
    var barRect = fab.getBoundingClientRect();
    var barCX = barRect.left + barRect.width / 2;
    var barCY = barRect.top + barRect.height / 2;

    overlay.style.display = "";
    fab.style.transition = "opacity 0.2s ease";
    fab.style.opacity = "0";
    var shell = els.shell;

    shell.style.transition = "none";
    shell.style.transform = "none";
    shell.style.opacity = "1";
    var shellRect = shell.getBoundingClientRect();
    var shellCX = shellRect.left + shellRect.width / 2;
    var shellCY = shellRect.top + shellRect.height / 2;

    var scaleX = barRect.width / shellRect.width;
    var scaleY = barRect.height / shellRect.height;
    var dx = barCX - shellCX;
    var dy = barCY - shellCY;

    shell.style.transform = "translate(" + dx + "px, " + dy + "px) scale(" + scaleX + ", " + scaleY + ")";
    shell.style.borderRadius = "28px";
    shell.style.opacity = "0";
    shell.offsetHeight;

    shell.style.transition = "transform 0.5s cubic-bezier(0.16,1,0.3,1), opacity 0.25s ease, border-radius 0.5s cubic-bezier(0.16,1,0.3,1)";
    shell.style.transform = "translate(0,0) scale(1,1)";
    shell.style.opacity = "1";
    shell.style.borderRadius = "0";

    document.body.style.overflow = "hidden";
    setTimeout(function() {
      shell.style.transition = "";
      shell.style.transform = "";
      shell.style.borderRadius = "";
      fab.style.display = "none";
      fab.style.opacity = "";
      fab.style.transition = "";
      els.input.focus();
    }, 550);
  }

  function minimizeToBar() {
    var shell = els.shell;
    var shellRect = shell.getBoundingClientRect();
    var shellCX = shellRect.left + shellRect.width / 2;
    var shellCY = shellRect.top + shellRect.height / 2;

    var barW = Math.min(520, window.innerWidth - 32);
    var barH = 52;
    var barCX = window.innerWidth / 2;
    var barCY = window.innerHeight - 26 - barH / 2;

    var scaleX = barW / shellRect.width;
    var scaleY = barH / shellRect.height;
    var dx = barCX - shellCX;
    var dy = barCY - shellCY;

    // Show bar immediately with fade-in, while shell collapses
    syncBarMessages();
    fab.style.display = "block";
    fab.style.opacity = "0";
    fab.style.transition = "opacity 0.35s ease";

    shell.style.transition = "transform 0.45s cubic-bezier(0.4,0,0.2,1), opacity 0.35s ease, border-radius 0.3s cubic-bezier(0.4,0,0.2,1)";
    shell.style.borderRadius = "28px";

    requestAnimationFrame(function() {
      shell.style.transform = "translate(" + dx + "px, " + dy + "px) scale(" + scaleX + ", " + scaleY + ")";
      shell.style.opacity = "0";
      fab.style.opacity = "1";
    });

    setTimeout(function() {
      overlay.style.display = "none";
      shell.style.transition = "none";
      shell.style.transform = "";
      shell.style.opacity = "";
      shell.style.borderRadius = "";
      fab.style.transition = "";
      document.body.style.overflow = "";
    }, 480);
  }

  els.browse.addEventListener("click", minimizeToBar);

  // Restore previous messages into the UI
  if (messages.length > 0) {
    els.main.classList.remove("wctx-state-idle");
    els.main.classList.add("wctx-state-chat");
    messages.forEach(function(m) { appendMsg(m.role, m.content); });
  }

  var startExpanded = config.startExpanded === true;
  if (config.demoMode) overlay.classList.add("wctx-demo");
  if (startExpanded) {
    overlay.style.display = "";
    fab.style.display = "none";
    document.body.style.overflow = "hidden";
    els.input.focus();
  } else {
    minimizeToBar();
  }

  // --- Initialize theme detection ---
  // Run once DOM is settled, then on scroll
  setTimeout(detectTheme, 100);
  window.addEventListener("scroll", debouncedDetectTheme, { passive: true });
  window.addEventListener("resize", debouncedDetectTheme, { passive: true });

  // --- Cross-domain state bridge (shared iframe) ---
  var stateIframe = document.createElement("iframe");
  stateIframe.src = API_HOST + "/widget-state.html";
  stateIframe.style.cssText = "display:none;width:0;height:0;border:none;position:absolute;";
  document.body.appendChild(stateIframe);

  var statePending = {};
  window.addEventListener("message", function(e) {
    if (!e.data || e.data.channel !== "wctx-state") return;
    var key = e.data.key;
    if (statePending[key]) {
      statePending[key](e.data.value);
      delete statePending[key];
    }
  });

  function getSharedState(key, cb) {
    statePending[key] = cb;
    stateIframe.contentWindow.postMessage({ channel: "wctx-state", action: "get", key: key }, "*");
    // Timeout fallback — if iframe doesn't respond in 1s, check localStorage
    setTimeout(function() {
      if (statePending[key]) {
        statePending[key](localStorage.getItem(key));
        delete statePending[key];
      }
    }, 1000);
  }

  function setSharedState(key, value) {
    localStorage.setItem(key, value); // local fallback
    stateIframe.contentWindow.postMessage({ channel: "wctx-state", action: "set", key: key, value: value }, "*");
  }

  // --- First-time onboarding modal ---
  var startedFullscreen = !(typeof START_MINIMIZED !== "undefined" && START_MINIMIZED);
  if (!IS_OWNER && !startedFullscreen) {
    // Wait for iframe to load, then check shared state
    stateIframe.addEventListener("load", function() {
      getSharedState("wctx-onboarded", function(val) {
        if (!val) {
          setTimeout(showOnboardingModal, 1500);
        }
      });
    });
  }

  function showOnboardingModal() {
    var onboardEl = document.createElement("div");
    onboardEl.className = "wctx-onboard-overlay" + (currentTheme === "dark" ? " wctx-dark" : "");
    onboardEl.innerHTML = '\
      <div class="wctx-onboard-card">\
        <h2>Meet your AI assistant</h2>\
        <p>You can interact with this website through a chat interface. Ask questions, get help, and complete tasks &mdash; all through conversation.</p>\
        <div class="wctx-onboard-arrow">\
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\
            <path d="M12 5v14M19 12l-7 7-7-7"/>\
          </svg>\
        </div>\
        <button class="wctx-onboard-btn" id="wctx-onboard-dismiss">Got it</button>\
      </div>\
    ';
    document.body.appendChild(onboardEl);

    onboardEl.querySelector("#wctx-onboard-dismiss").addEventListener("click", function() {
      setSharedState("wctx-onboarded", "1");
      onboardEl.style.opacity = "0";
      onboardEl.style.transition = "opacity 0.3s";
      setTimeout(function() { onboardEl.remove(); }, 300);
    });

    onboardEl.addEventListener("click", function(e) {
      if (e.target === onboardEl) {
        onboardEl.querySelector("#wctx-onboard-dismiss").click();
      }
    });
  }

  // --- Global keyboard capture ---
  // When no input/textarea is focused, typing goes to the chat widget
  document.addEventListener("keydown", function(e) {
    // Skip modifier keys, navigation, and function keys
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Tab" || e.key === "Escape" || e.key === "Enter") return;
    if (e.key.startsWith("Arrow") || e.key.startsWith("F") && e.key.length <= 3) return;
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
    if (e.key === "Backspace" || e.key === "Delete") return;

    // Check if an input element is focused
    var active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) {
      // No input focused — redirect to our chat input
      var target;
      if (overlay.style.display !== "none") {
        target = els.input;
      } else if (fab.style.display !== "none") {
        target = barInput;
        fab.classList.add("wctx-active");
      } else {
        return;
      }

      if (target && document.activeElement !== target) {
        target.focus();
        // The keydown event will now naturally go to the focused input
      }
      return;
    }

    var tag = active.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable) {
      return; // already typing into a form field
    }

    // Focused on a non-input element (button, link, div, etc.) — redirect
    var target2;
    if (overlay.style.display !== "none") {
      target2 = els.input;
    } else if (fab.style.display !== "none") {
      target2 = barInput;
      fab.classList.add("wctx-active");
    }
    if (target2) target2.focus();
  });

  // Rotating placeholder
  var placeholders = [
    "Tell me what you need…",
    "What are you looking for?",
    "Ask me anything about this site…",
    "How can I help you today?",
  ];
  var pIdx = 0;
  setInterval(function() {
    if (state === "idle" && !els.input.value) {
      pIdx = (pIdx + 1) % placeholders.length;
      els.input.placeholder = placeholders[pIdx];
    }
  }, 3000);

  var sessionId = sessionStorage.getItem("wctx-session-id");
  if (!sessionId) {
    sessionId = "session_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem("wctx-session-id", sessionId);
  }
  var activeFlowSession = null;

  // Stream a chat response over SSE. Calls cbs.onFirst() just before the first token
  // (clear the typing indicator), cbs.onDelta(text) per token, cbs.onDone(data) with the
  // canonical {message, sources, navigateTo, flowSession}, cbs.onError(msg) on failure.
  // Falls back to plain JSON if the server/proxy didn't actually stream.
  function streamChat(cbs) {
    var started = false;
    fetch(API_HOST + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages, tenantId: TENANT_ID, sessionId: sessionId, stream: true }),
    })
    .then(function(r) {
      var ct = r.headers.get("content-type") || "";
      // Non-streaming fallback (older server, or a proxy buffered the whole body).
      if (!r.body || !r.body.getReader || ct.indexOf("text/event-stream") === -1) {
        return r.json().then(function(data) {
          if (data && data.error) { if (cbs.onError) cbs.onError(data.message); return; }
          if (cbs.onFirst) cbs.onFirst();
          if (data.message && cbs.onDelta) cbs.onDelta(data.message);
          if (cbs.onDone) cbs.onDone(data);
        });
      }
      var reader = r.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      var finished = false;
      function handleEvent(payload) {
        var data;
        try { data = JSON.parse(payload); } catch (e) { return; }
        if (data.error) { finished = true; if (cbs.onError) cbs.onError(data.message); return; }
        if (data.done) { finished = true; if (cbs.onDone) cbs.onDone(data); return; }
        if (typeof data.delta === "string") {
          if (!started) { started = true; if (cbs.onFirst) cbs.onFirst(); }
          if (cbs.onDelta) cbs.onDelta(data.delta);
        }
      }
      function pump() {
        return reader.read().then(function(res) {
          if (res.done) {
            if (!finished && cbs.onError) cbs.onError(); // stream cut off before "done"
            return;
          }
          buffer += decoder.decode(res.value, { stream: true });
          var events = buffer.split("\n\n");
          buffer = events.pop() || ""; // keep the trailing partial event
          for (var i = 0; i < events.length; i++) {
            var line = events[i].trim();
            if (line.indexOf("data:") !== 0) continue;
            handleEvent(line.slice(5).trim());
          }
          if (finished) { try { reader.cancel(); } catch (e) {} return; }
          return pump();
        });
      }
      return pump();
    })
    .catch(function() { if (cbs.onError) cbs.onError(); });
  }

  function sendMessage() {
    var text = els.input.value.trim();
    if (!text || isLoading) return;

    if (state === "idle") {
      state = "chat";
      els.main.classList.remove("wctx-state-idle");
      els.main.classList.add("wctx-state-chat");
    }

    els.input.value = "";
    messages.push({ role: "user", content: text }); persistMessages();
    appendMsg("user", text);
    setLoading(true);

    var bubble = null, raw = "";
    streamChat({
      onFirst: function() {
        setLoading(false); // swap the typing dots for the live answer bubble
        bubble = document.createElement("div");
        bubble.className = "wctx-msg wctx-msg-assistant";
        els.msgs.appendChild(bubble);
      },
      onDelta: function(delta) {
        raw += delta;
        if (bubble) { bubble.innerHTML = md(raw); els.msgs.scrollTop = els.msgs.scrollHeight; }
      },
      onDone: function(data) {
        setLoading(false);
        // Replace the live (raw) bubble with the canonical cleaned render + links + sources.
        if (bubble) { bubble.remove(); bubble = null; }
        messages.push({ role: "assistant", content: data.message }); persistMessages();
        appendMsg("assistant", data.message, data.sources);

        if (data.navigateTo) {
          setTimeout(function() { navigateToPage(data.navigateTo, ""); }, 1000);
        }
        if (data.flowSession) {
          activeFlowSession = data.flowSession;
          if (data.flowSession.guidedSteps && data.flowSession.guidedSteps.length > 0) {
            setTimeout(function() {
              launchGuidedExecution(data.flowSession.guidedSteps, data.flowSession.guidedInputs || {});
            }, 800);
            activeFlowSession = null;
          } else if (data.flowSession.active) {
            els.input.placeholder = "Provide the requested info...";
          }
          if (data.flowSession.complete && !data.flowSession.guidedSteps) {
            activeFlowSession = null;
            els.input.placeholder = "Tell me what you need…";
          }
        }
      },
      onError: function(msg) {
        setLoading(false);
        if (bubble) { bubble.remove(); bubble = null; }
        appendMsg("assistant", msg || "Something went wrong. Please try again.");
      }
    });
  }

  function showFlowOffer(action) {
    if (!action) return;
    // The flow is already being handled via the conversation,
    // so we just update the input placeholder to indicate flow mode
    els.input.placeholder = "Provide the requested info...";
  }

  function startFlow(flowId) {
    activeFlowSession = { flowId: flowId, active: true };
    els.input.placeholder = "Provide the requested info...";
    els.input.focus();
  }

  function launchGuidedExecution(steps, inputs) {
    // Hide overlay, show the actual website
    minimizeToBar();

    appendMsg("system", "Switching to the website — I'll fill in what I can and highlight anything that needs your input.");

    // Inject guided executor script
    if (!window.__wctxGuided) {
      var s = document.createElement("script");
      s.src = API_HOST + "/guided-executor.js";
      s.onload = function() { window.__wctxGuided.execute(steps, inputs); };
      document.head.appendChild(s);
    } else {
      window.__wctxGuided.execute(steps, inputs);
    }
  }

  // Listen for guided executor events
  window.addEventListener("message", function(e) {
    if (!e.data || e.data.channel !== "wctx-guided") return;
    var type = e.data.type;
    var data = e.data.data || {};

    switch (type) {
      case "step-start":
        fab.querySelector("button").innerHTML = '<span class="wctx-fab-dot"></span>Filling in... step ' + (data.index + 1) + '/' + data.total;
        break;
      case "user-action-needed":
        fab.querySelector("button").innerHTML = '👆 ' + (data.message || "Your action needed");
        break;
      case "step-done":
        fab.querySelector("button").innerHTML = '<span class="wctx-fab-dot"></span>Filling in... step ' + (data.index + 1) + '/' + data.total;
        break;
      case "navigating":
        fab.querySelector("button").innerHTML = '<span class="wctx-fab-dot"></span>Navigating...';
        break;
      case "done":
        fab.querySelector("button").innerHTML = '<span class="wctx-fab-dot"></span>Done! Back to chat';
        setTimeout(function() {
          openFullChat();
          appendMsg("assistant", "All done! I filled in the form and you clicked submit. Is there anything else I can help with?");
        }, 2000);
        break;
      case "aborted":
        openFullChat();
        appendMsg("system", "Flow was cancelled.");
        break;
      case "step-error":
        break;
    }
  });

  var typingEl = null;
  function setLoading(on) {
    isLoading = on;
    els.send.disabled = on;
    if (on) {
      if (!typingEl) {
        typingEl = document.createElement("div");
        typingEl.className = "wctx-typing";
        typingEl.style.display = "flex";
        typingEl.innerHTML = '<span class="wctx-typing-dot"></span><span class="wctx-typing-dot"></span><span class="wctx-typing-dot"></span>';
        els.msgs.appendChild(typingEl);
      }
      els.msgs.scrollTop = els.msgs.scrollHeight;
    } else {
      if (typingEl) { typingEl.remove(); typingEl = null; }
    }
  }

  function appendMsg(role, content, sources) {
    var div = document.createElement("div");
    div.className = "wctx-msg wctx-msg-" + role;
    if (role === "assistant") {
      div.innerHTML = md(content);
      // Turn all links into "show page" buttons
      div.querySelectorAll("a[href]").forEach(function(a) {
        var href = a.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
        a.removeAttribute("target");
        a.addEventListener("click", function(e) {
          e.preventDefault();
          navigateToPage(href, a.textContent);
        });
      });
      if (sources && sources.length) {
        var s = document.createElement("div");
        s.className = "wctx-sources";
        s.textContent = "Sources — " + sources.map(function(x) { return x.title; }).join(" · ");
        div.appendChild(s);
      }
    } else {
      div.textContent = content;
    }
    els.msgs.appendChild(div);
    els.msgs.scrollTop = els.msgs.scrollHeight;
    return div;
  }

  function navigateToPage(url, label) {
    // Resolve relative URLs
    try { url = new URL(url, window.location.origin).href; } catch(e) {}

    // On demo/site pages (whisp.so), open in new tab instead of navigating
    var isDemo = window.location.hostname === "whisp.so" || window.location.pathname.indexOf("/demo/") === 0 || window.location.pathname.indexOf("/site/") === 0;
    if (isDemo) {
      appendMsg("system", "Opening: " + (label || url));
      window.open(url, "_blank");
    } else {
      appendMsg("system", "Showing you: " + (label || url));
      minimizeToBar();
      window.location.href = url;
    }
  }

  function md(t) {
    return t
      .replace(/```([\s\S]*?)```/g, "<pre>$1</pre>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="wctx-page-link">$1 →</a>')
      // Action buttons: phone numbers become call buttons
      .replace(/(?:tel:|phone:|zadzwoń:?\s*)?(\+?\d[\d\s-]{7,}\d)/g, function(m, num) {
        var clean = num.replace(/\s/g, "");
        return '<a href="tel:' + clean + '" class="wctx-action-btn">📞 ' + num.trim() + '</a>';
      })
      // Action buttons: email addresses become mailto buttons
      .replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '<a href="mailto:$1" class="wctx-action-btn">✉ $1</a>')
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>")
      .replace(/^/, "<p>").replace(/$/, "</p>");
  }

  function buildHTML() {
    return '<style>\
#wctx-overlay { position:fixed; inset:0; z-index:999999; pointer-events:none; }\
#wctx-overlay > * { pointer-events:auto; }\
\
.wctx-shell {\
  position:fixed; inset:0;\
  font-family:"Archivo",-apple-system,BlinkMacSystemFont,sans-serif;\
  background:rgba(200,200,210,0.55);\
  backdrop-filter:blur(40px) saturate(1.5);\
  -webkit-backdrop-filter:blur(40px) saturate(1.5);\
  border-radius:0;\
  border:none;\
  box-shadow:none;\
  color:#0a0a0a;\
  font-size:14px;\
  line-height:1.5;\
  -webkit-font-smoothing:antialiased;\
  display:flex;\
  flex-direction:column;\
  overflow:hidden;\
  transition:all 0.3s cubic-bezier(0.4,0,0.2,1);\
}\
\
.wctx-topbar {\
  display:flex;\
  align-items:center;\
  gap:32px;\
  padding:20px 32px;\
  font-size:11px;\
  text-transform:uppercase;\
  letter-spacing:0.1em;\
  font-weight:500;\
  color:rgba(10,10,10,0.5);\
  border-bottom:none;\
  flex-shrink:0;\
  animation:wctx-fadeDown 0.4s cubic-bezier(0.16,1,0.3,1) 0.15s both;\
}\
@keyframes wctx-fadeDown {\
  from{opacity:0;transform:translateY(-8px)}\
  to{opacity:1;transform:translateY(0)}\
}\
.wctx-logo {\
  display:flex;\
  align-items:center;\
  gap:12px;\
  color:rgba(10,10,10,0.85);\
  font-size:13px;\
  font-weight:700;\
  letter-spacing:0.1em;\
}\
.wctx-logo-mark {\
  width:22px; height:22px;\
  background:rgba(10,10,10,0.75);\
  border-radius:6px;\
  position:relative;\
}\
.wctx-logo-mark::before {\
  content:"";\
  position:absolute;\
  inset:4px;\
  border:1.5px solid rgba(255,255,255,0.7);\
  border-radius:3px;\
}\
.wctx-topbar-right {\
  margin-left:auto;\
  display:flex;\
  align-items:center;\
  gap:20px;\
}\
.wctx-dot {\
  width:6px; height:6px;\
  background:rgba(52,199,89,0.8);\
  border-radius:50%;\
  animation:wctx-blink 2.8s ease-in-out infinite;\
}\
@keyframes wctx-blink {\
  0%,100%{opacity:1;transform:scale(1)}\
  50%{opacity:0.3;transform:scale(0.85)}\
}\
.wctx-browse-btn {\
  font-family:"Archivo",sans-serif;\
  font-size:11px;\
  text-transform:uppercase;\
  letter-spacing:0.06em;\
  font-weight:600;\
  color:rgba(10,10,10,0.45);\
  background:rgba(255,255,255,0.25);\
  border:1px solid rgba(255,255,255,0.3);\
  border-radius:10px;\
  padding:8px 16px;\
  cursor:pointer;\
  transition:all 0.3s cubic-bezier(0.4,0,0.2,1);\
  backdrop-filter:blur(4px);\
  -webkit-backdrop-filter:blur(4px);\
}\
.wctx-browse-btn:hover { background:rgba(255,255,255,0.45); color:rgba(10,10,10,0.7); border-color:rgba(255,255,255,0.5); transform:translateY(-1px); }\
\
.wctx-owner-btn {\
  font-family:"Archivo",sans-serif;\
  font-size:11px;\
  text-transform:uppercase;\
  letter-spacing:0.06em;\
  font-weight:700;\
  color:rgba(255,255,255,0.9);\
  background:rgba(10,10,10,0.7);\
  border:none;\
  border-radius:10px;\
  padding:8px 14px;\
  cursor:pointer;\
  transition:all 0.2s;\
  backdrop-filter:blur(4px);\
  -webkit-backdrop-filter:blur(4px);\
}\
.wctx-owner-btn:hover { background:rgba(10,10,10,0.85); }\
\
.wctx-owner-panel {\
  position:fixed;\
  top:70px;\
  right:24px;\
  z-index:1000000;\
  background:rgba(255,255,255,0.4);\
  backdrop-filter:blur(16px) saturate(1.3);\
  -webkit-backdrop-filter:blur(16px) saturate(1.3);\
  border:1px solid rgba(255,255,255,0.35);\
  border-radius:16px;\
  padding:8px;\
  box-shadow:0 8px 32px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.4);\
  display:none;\
  flex-direction:column;\
  gap:2px;\
  min-width:200px;\
}\
.wctx-owner-panel.open { display:flex; }\
\
.wctx-owner-header {\
  font-size:10px;\
  text-transform:uppercase;\
  letter-spacing:0.12em;\
  font-weight:600;\
  color:rgba(10,10,10,0.35);\
  padding:8px 12px 6px;\
}\
\
.wctx-owner-action {\
  display:flex;\
  align-items:center;\
  gap:10px;\
  padding:10px 12px;\
  border:none;\
  background:transparent;\
  border-radius:10px;\
  font-family:"Archivo",sans-serif;\
  font-size:13px;\
  font-weight:500;\
  color:rgba(10,10,10,0.7);\
  cursor:pointer;\
  transition:all 0.15s;\
  text-align:left;\
}\
.wctx-owner-action:hover {\
  background:rgba(255,255,255,0.5);\
  color:rgba(10,10,10,0.9);\
}\
.wctx-owner-action svg { flex-shrink:0; color:rgba(10,10,10,0.4); }\
\
.wctx-main {\
  flex:1;\
  display:flex;\
  flex-direction:column;\
  overflow:hidden;\
  position:relative;\
}\
.wctx-state-idle {\
  justify-content:center;\
  align-items:center;\
  padding-bottom:10vh;\
  transition:all 0.5s cubic-bezier(0.16,1,0.3,1);\
}\
\
.wctx-idle-prompt {\
  font-size:11px;\
  font-weight:600;\
  letter-spacing:0.18em;\
  text-transform:uppercase;\
  color:rgba(10,10,10,0.35);\
  margin-bottom:20px;\
  display:flex;\
  align-items:center;\
  gap:12px;\
  transition:opacity 0.3s ease, transform 0.3s ease;\
}\
.wctx-idle-prompt::before {\
  content:"";\
  width:24px;\
  height:1px;\
  background:rgba(10,10,10,0.25);\
}\
.wctx-state-chat .wctx-idle-prompt { display:none; }\
.wctx-state-chat .wctx-idle-footnote { display:none; }\
\
.wctx-input-zone {\
  width:100%;\
  max-width:680px;\
  transition:all 0.4s cubic-bezier(0.4,0,0.2,1);\
}\
.wctx-state-idle .wctx-input-zone { padding:0 32px; }\
.wctx-state-chat .wctx-input-zone {\
  position:absolute;\
  bottom:0; left:50%; transform:translateX(-50%);\
  max-width:760px; width:100%;\
  padding:16px 32px 20px;\
  border-top:none;\
}\
\
.wctx-input-frame {\
  display:grid;\
  grid-template-columns:auto 1fr auto;\
  align-items:center;\
  background:rgba(255,255,255,0.3);\
  border:1px solid rgba(255,255,255,0.35);\
  border-radius:16px;\
  backdrop-filter:blur(8px);\
  -webkit-backdrop-filter:blur(8px);\
  box-shadow:0 4px 16px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.4);\
  transition:all 0.3s cubic-bezier(0.4,0,0.2,1);\
}\
.wctx-input-frame:focus-within {\
  border-color:rgba(255,255,255,0.5);\
  box-shadow:0 4px 24px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.5);\
}\
.wctx-input-icon {\
  padding:0 16px 0 22px;\
  color:rgba(10,10,10,0.35);\
  display:flex;\
  align-items:center;\
}\
.wctx-chat-input {\
  background:transparent;\
  border:none;\
  outline:none;\
  font-family:"Archivo",sans-serif;\
  font-size:20px;\
  font-weight:500;\
  color:#0a0a0a;\
  padding:22px 0;\
  width:100%;\
  letter-spacing:-0.015em;\
  transition:font-size 0.3s, padding 0.3s;\
}\
.wctx-state-chat .wctx-chat-input {\
  font-size:16px;\
  padding:16px 0;\
}\
.wctx-chat-input::placeholder { color:rgba(10,10,10,0.25); font-weight:400; }\
\
.wctx-send-btn {\
  background:none;\
  border:none;\
  font-family:"Archivo",sans-serif;\
  font-size:11px;\
  text-transform:uppercase;\
  letter-spacing:0.1em;\
  font-weight:700;\
  color:rgba(10,10,10,0.5);\
  cursor:pointer;\
  padding:22px 22px;\
  transition:all 0.2s;\
  border-radius:0 16px 16px 0;\
}\
.wctx-send-btn:hover { color:rgba(10,10,10,0.8); transform:scale(1.05); }\
.wctx-send-btn:disabled { opacity:0.2; }\
.wctx-state-chat .wctx-send-btn { padding:16px 22px; }\
\
.wctx-idle-footnote {\
  margin-top:16px;\
  font-size:12px;\
  color:rgba(10,10,10,0.3);\
  display:flex;\
  align-items:center;\
  gap:14px;\
}\
.wctx-idle-footnote kbd {\
  display:inline-flex;\
  align-items:center;\
  background:rgba(255,255,255,0.3);\
  border:1px solid rgba(255,255,255,0.3);\
  border-radius:5px;\
  color:rgba(10,10,10,0.4);\
  padding:2px 7px;\
  font-family:"Archivo",sans-serif;\
  font-size:10px;\
  font-weight:600;\
  margin-right:5px;\
}\
\
.wctx-messages {\
  flex:1;\
  overflow-y:auto;\
  padding:32px 32px 120px;\
  display:none;\
  flex-direction:column;\
  gap:20px;\
  max-width:760px;\
  width:100%;\
  margin:0 auto;\
}\
.wctx-state-chat .wctx-messages { display:flex; }\
\
.wctx-msg {\
  max-width:82%;\
  opacity:0;\
  transform:translateY(12px);\
  animation:wctx-msgIn 0.5s cubic-bezier(0.16,1,0.3,1) forwards;\
}\
@keyframes wctx-msgIn {\
  to{opacity:1;transform:translateY(0)}\
}\
.wctx-msg-user {\
  align-self:flex-end;\
  background:none;\
  color:rgba(10,10,10,0.7);\
  padding:0;\
  font-size:16px;\
  line-height:1.6;\
  font-weight:500;\
  text-align:right;\
  animation-duration:0.3s;\
}\
.wctx-msg-assistant {\
  align-self:flex-start;\
  font-size:16px;\
  line-height:1.7;\
  color:rgba(10,10,10,0.85);\
  background:none;\
  padding:0;\
  animation-duration:0.6s;\
}\
.wctx-msg-assistant p { margin-bottom:10px; }\
.wctx-msg-assistant p:last-child { margin-bottom:0; }\
.wctx-msg-assistant strong { font-weight:700; }\
.wctx-msg-assistant code {\
  background:rgba(0,0,0,0.05);\
  padding:2px 6px;\
  border-radius:5px;\
  font-size:13px;\
}\
.wctx-msg-assistant pre {\
  background:rgba(10,10,10,0.8);\
  color:rgba(255,255,255,0.9);\
  padding:14px 18px;\
  font-size:13px;\
  overflow-x:auto;\
  margin:10px 0;\
  border-radius:12px;\
}\
.wctx-msg-assistant a {\
  color:rgba(10,10,10,0.85);\
  text-decoration:none;\
}\
.wctx-msg-assistant a.wctx-page-link {\
  display:inline-flex;\
  align-items:center;\
  gap:4px;\
  background:rgba(255,255,255,0.4);\
  border:1px solid rgba(0,0,0,0.08);\
  border-radius:8px;\
  padding:4px 12px;\
  font-size:13px;\
  font-weight:600;\
  color:rgba(10,10,10,0.7);\
  cursor:pointer;\
  transition:all 0.2s;\
  backdrop-filter:blur(4px);\
  -webkit-backdrop-filter:blur(4px);\
  margin:2px 0;\
}\
.wctx-msg-assistant a.wctx-page-link:hover {\
  background:rgba(255,255,255,0.6);\
  color:rgba(10,10,10,0.9);\
  border-color:rgba(0,0,0,0.15);\
}\
.wctx-action-btn {\
  display:inline-flex; align-items:center; gap:6px;\
  background:rgba(59,130,246,0.12); border:1px solid rgba(59,130,246,0.2);\
  border-radius:10px; padding:8px 16px; margin:4px 2px;\
  font-size:14px; font-weight:600; color:#3b82f6;\
  text-decoration:none; cursor:pointer; transition:all 0.2s;\
}\
.wctx-action-btn:hover {\
  background:rgba(59,130,246,0.2); border-color:rgba(59,130,246,0.35);\
  transform:translateY(-1px);\
}\
\
.wctx-sources {\
  margin-top:12px;\
  font-size:11px;\
  color:rgba(10,10,10,0.3);\
  text-transform:uppercase;\
  letter-spacing:0.06em;\
  font-weight:500;\
  padding-top:10px;\
  border-top:1px solid rgba(0,0,0,0.05);\
}\
\
.wctx-typing {\
  display:none;\
  align-items:center;\
  gap:5px;\
  padding:12px 16px;\
  border-radius:16px 16px 16px 4px;\
  background:rgba(10,10,10,0.04);\
  border:1px solid rgba(10,10,10,0.06);\
  max-width:80px;\
  margin:4px 0;\
}\
.wctx-typing-dot {\
  width:6px; height:6px; border-radius:50%;\
  background:rgba(10,10,10,0.3);\
  animation:wctx-dot-bounce 1.2s infinite;\
}\
.wctx-typing-dot:nth-child(2) { animation-delay:0.2s; }\
.wctx-typing-dot:nth-child(3) { animation-delay:0.4s; }\
@keyframes wctx-dot-bounce { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-6px)} }\
\
@media(max-width:768px){\
  .wctx-shell{inset:0;border-radius:0}\
  .wctx-topbar{padding:16px 20px;gap:14px}\
  .wctx-state-idle .wctx-input-zone{padding:0 20px}\
  .wctx-state-chat .wctx-input-zone{padding:12px 16px 16px}\
  .wctx-messages{padding:20px 16px 100px}\
  .wctx-chat-input{font-size:17px;padding:18px 0}\
  .wctx-browse-btn{display:none}\
  .wctx-input-frame{border-radius:14px}\
}\
\
#wctx-overlay.wctx-dark .wctx-shell {\
  background:rgba(20,20,35,0.6);\
  backdrop-filter:blur(40px) saturate(1.5);\
  -webkit-backdrop-filter:blur(40px) saturate(1.5);\
  border:none;\
  box-shadow:none;\
  color:rgba(255,255,255,0.9);\
}\
#wctx-overlay.wctx-dark .wctx-topbar {\
  color:rgba(255,255,255,0.5);\
  border-bottom:none;\
}\
#wctx-overlay.wctx-dark .wctx-logo { color:rgba(255,255,255,0.9); }\
#wctx-overlay.wctx-dark .wctx-logo-mark { background:rgba(255,255,255,0.8); }\
#wctx-overlay.wctx-dark .wctx-logo-mark::before { border-color:rgba(10,10,10,0.7); }\
#wctx-overlay.wctx-dark .wctx-browse-btn {\
  color:rgba(255,255,255,0.5);\
  background:rgba(255,255,255,0.08);\
  border-color:rgba(255,255,255,0.12);\
}\
#wctx-overlay.wctx-dark .wctx-browse-btn:hover { background:rgba(255,255,255,0.15); color:rgba(255,255,255,0.8); border-color:rgba(255,255,255,0.2); }\
#wctx-overlay.wctx-dark .wctx-idle-prompt { color:rgba(255,255,255,0.35); }\
#wctx-overlay.wctx-dark .wctx-idle-prompt::before { background:rgba(255,255,255,0.25); }\
#wctx-overlay.wctx-dark .wctx-input-frame {\
  background:rgba(255,255,255,0.08);\
  border-color:rgba(255,255,255,0.12);\
  box-shadow:0 4px 16px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.06);\
}\
#wctx-overlay.wctx-dark .wctx-input-frame:focus-within {\
  border-color:rgba(255,255,255,0.2);\
  box-shadow:0 4px 24px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.1);\
}\
#wctx-overlay.wctx-dark .wctx-input-icon { color:rgba(255,255,255,0.35); }\
#wctx-overlay.wctx-dark .wctx-chat-input { color:#fff; }\
#wctx-overlay.wctx-dark .wctx-chat-input::placeholder { color:rgba(255,255,255,0.4); }\
#wctx-overlay.wctx-dark .wctx-send-btn { color:rgba(255,255,255,0.7); }\
#wctx-overlay.wctx-dark .wctx-send-btn:hover { color:#fff; }\
#wctx-overlay.wctx-dark .wctx-idle-footnote { color:rgba(255,255,255,0.3); }\
#wctx-overlay.wctx-dark .wctx-idle-footnote kbd {\
  background:rgba(255,255,255,0.08);\
  border-color:rgba(255,255,255,0.12);\
  color:rgba(255,255,255,0.4);\
}\
#wctx-overlay.wctx-dark .wctx-state-chat .wctx-input-zone { border-top:none; }\
#wctx-overlay.wctx-dark .wctx-msg-user {\
  background:none;\
  color:rgba(255,255,255,0.6);\
}\
#wctx-overlay.wctx-dark .wctx-msg-assistant {\
  color:rgba(255,255,255,0.9);\
  background:none;\
}\
#wctx-overlay.wctx-dark .wctx-msg-assistant code { background:rgba(255,255,255,0.1); color:rgba(255,255,255,0.85); }\
#wctx-overlay.wctx-dark .wctx-msg-assistant a { color:rgba(255,255,255,0.85); }\
#wctx-overlay.wctx-dark .wctx-msg-assistant a.wctx-page-link {\
  background:rgba(255,255,255,0.08);\
  border-color:rgba(255,255,255,0.15);\
  color:rgba(255,255,255,0.7);\
}\
#wctx-overlay.wctx-dark .wctx-msg-assistant a.wctx-page-link:hover { background:rgba(255,255,255,0.15); color:rgba(255,255,255,0.9); border-color:rgba(255,255,255,0.25); }\
#wctx-overlay.wctx-dark .wctx-sources { color:rgba(255,255,255,0.3); border-top-color:rgba(255,255,255,0.08); }\
#wctx-overlay.wctx-dark .wctx-typing {\
  background:rgba(255,255,255,0.06);\
  border-color:rgba(255,255,255,0.08);\
}\
#wctx-overlay.wctx-dark .wctx-typing-dot { background:rgba(255,255,255,0.3); }\
#wctx-overlay.wctx-dark .wctx-owner-panel {\
  background:rgba(255,255,255,0.08);\
  border-color:rgba(255,255,255,0.12);\
  box-shadow:0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.06);\
}\
#wctx-overlay.wctx-dark .wctx-owner-header { color:rgba(255,255,255,0.35); }\
#wctx-overlay.wctx-dark .wctx-owner-action { color:rgba(255,255,255,0.7); }\
#wctx-overlay.wctx-dark .wctx-owner-action:hover { background:rgba(255,255,255,0.1); color:rgba(255,255,255,0.9); }\
#wctx-overlay.wctx-dark .wctx-owner-action svg { color:rgba(255,255,255,0.4); }\
\
.wctx-onboard-overlay {\
  position:fixed; inset:0; z-index:1000001;\
  background:rgba(0,0,0,0.3);\
  backdrop-filter:blur(4px);\
  -webkit-backdrop-filter:blur(4px);\
  display:flex; align-items:center; justify-content:center;\
  animation:wctx-fadeIn 0.4s ease;\
}\
@keyframes wctx-fadeIn { from{opacity:0} to{opacity:1} }\
.wctx-onboard-card {\
  font-family:"Archivo",-apple-system,sans-serif;\
  max-width:400px; width:calc(100% - 32px);\
  background:rgba(255,255,255,0.4);\
  backdrop-filter:blur(16px) saturate(1.3);\
  -webkit-backdrop-filter:blur(16px) saturate(1.3);\
  border:1px solid rgba(255,255,255,0.35);\
  border-radius:24px;\
  padding:36px 32px 28px;\
  box-shadow:0 12px 48px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.5);\
  text-align:center;\
  animation:wctx-slideUp 0.5s cubic-bezier(0.4,0,0.2,1);\
}\
@keyframes wctx-slideUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }\
.wctx-onboard-card h2 {\
  margin:0 0 12px; font-size:22px; font-weight:700;\
  color:rgba(10,10,10,0.85); letter-spacing:-0.02em;\
}\
.wctx-onboard-card p {\
  margin:0 0 24px; font-size:14px; line-height:1.6;\
  color:rgba(10,10,10,0.6);\
}\
.wctx-onboard-arrow {\
  display:flex; justify-content:center; margin-bottom:20px;\
  animation:wctx-bounce 1.5s ease-in-out infinite;\
}\
@keyframes wctx-bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(6px)} }\
.wctx-onboard-arrow svg { color:rgba(10,10,10,0.4); }\
.wctx-onboard-btn {\
  font-family:"Archivo",sans-serif;\
  font-size:14px; font-weight:600;\
  color:rgba(255,255,255,0.95);\
  background:rgba(10,10,10,0.75);\
  border:none; border-radius:14px;\
  padding:14px 32px; cursor:pointer;\
  transition:all 0.2s;\
}\
.wctx-onboard-btn:hover { background:rgba(10,10,10,0.9); }\
.wctx-onboard-check {\
  display:flex; align-items:center; justify-content:center;\
  gap:8px; margin-top:16px;\
  font-size:12px; color:rgba(10,10,10,0.4);\
}\
.wctx-onboard-check input { margin:0; cursor:pointer; }\
.wctx-onboard-check label { cursor:pointer; }\
\
.wctx-dark .wctx-onboard-card {\
  background:rgba(255,255,255,0.08);\
  border-color:rgba(255,255,255,0.12);\
  box-shadow:0 12px 48px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06);\
}\
.wctx-dark .wctx-onboard-card h2 { color:rgba(255,255,255,0.9); }\
.wctx-dark .wctx-onboard-card p { color:rgba(255,255,255,0.5); }\
.wctx-dark .wctx-onboard-arrow svg { color:rgba(255,255,255,0.4); }\
.wctx-dark .wctx-onboard-btn {\
  background:rgba(255,255,255,0.15);\
  color:rgba(255,255,255,0.9);\
}\
.wctx-dark .wctx-onboard-btn:hover { background:rgba(255,255,255,0.25); }\
.wctx-dark .wctx-onboard-check { color:rgba(255,255,255,0.4); }\
</style>\
\
<div class="wctx-shell">\
  <div class="wctx-topbar">\
    <div class="wctx-logo">\
      <span class="wctx-logo-mark"></span>\
      <span>' + BRAND + '</span>\
    </div>\
    <div class="wctx-topbar-right">\
      <div class="wctx-dot"></div>\
      ' + (IS_OWNER ? '<button class="wctx-owner-btn" id="wctx-owner-toggle">Owner</button>' : '') + '\
      <button class="wctx-browse-btn">Browse site manually</button>\
    </div>\
  </div>\
  <div class="wctx-main wctx-state-idle">\
    <div class="wctx-idle-prompt">What can I help you with?</div>\
    <div class="wctx-messages"></div>\
    <div class="wctx-input-zone">\
      <div class="wctx-input-frame">\
        <div class="wctx-input-icon">\
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>\
          </svg>\
        </div>\
        <input class="wctx-chat-input" type="text" placeholder="Tell me what you need…" autocomplete="off" spellcheck="false" autofocus />\
        <button class="wctx-send-btn" type="button">Send</button>\
      </div>\
      <div class="wctx-idle-footnote">\
        <span><kbd>↵</kbd>Send</span>\
        <span>Ask anything about this website</span>\
      </div>\
    </div>\
  </div>\
</div>\
' + (IS_OWNER ? '\
<div class="wctx-owner-panel" id="wctx-owner-panel">\
  <div class="wctx-owner-header">Owner Actions</div>\
  <button class="wctx-owner-action" id="wctx-action-record">\
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>\
    Record a flow\
  </button>\
  <button class="wctx-owner-action" id="wctx-action-flows">\
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>\
    View saved flows\
  </button>\
  <button class="wctx-owner-action" id="wctx-action-rescrape">\
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>\
    Re-scrape website\
  </button>\
  <button class="wctx-owner-action" id="wctx-action-exit">\
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>\
    Exit owner mode\
  </button>\
</div>' : '') + '\
';
  }
})();
