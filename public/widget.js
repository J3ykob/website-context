(function() {
  var config = window.__wctx || {};
  var API_HOST = config.apiHost || window.location.origin;
  var TENANT_ID = config.tenantId || "default";
  var BRAND = config.brandName || "website.context";

  // Owner mode — activated via ?wctx-owner=true or config.ownerKey matching a cookie
  var urlParams = new URLSearchParams(window.location.search);
  var IS_OWNER = urlParams.get("wctx-owner") === "true" || config.ownerMode === true;

  // Persist owner mode in sessionStorage so it survives navigation
  if (IS_OWNER) sessionStorage.setItem("wctx-owner", "1");
  if (sessionStorage.getItem("wctx-owner") === "1") IS_OWNER = true;

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
    typing:  overlay.querySelector(".wctx-typing"),
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
  width:min(520px, calc(100vw - 32px));\
}\
#wctx-fab .wctx-bar-wrap {\
  display:flex;\
  flex-direction:column;\
  border-radius:20px;\
  background:rgba(255,255,255,0.35);\
  backdrop-filter:blur(12px) saturate(1.3);\
  -webkit-backdrop-filter:blur(12px) saturate(1.3);\
  border:1px solid rgba(255,255,255,0.35);\
  box-shadow:0 6px 24px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.4);\
  transition:all 0.35s cubic-bezier(0.4,0,0.2,1);\
  overflow:hidden;\
  max-height:52px;\
}\
#wctx-fab .wctx-bar-wrap:hover,\
#wctx-fab .wctx-bar-wrap.pinned {\
  max-height:380px;\
  box-shadow:0 12px 48px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.5);\
}\
#wctx-fab .wctx-bar-messages {\
  flex:1;\
  overflow-y:auto;\
  padding:0;\
  max-height:0;\
  opacity:0;\
  transition:all 0.35s cubic-bezier(0.4,0,0.2,1);\
}\
#wctx-fab .wctx-bar-wrap:hover .wctx-bar-messages,\
#wctx-fab .wctx-bar-wrap.pinned .wctx-bar-messages {\
  max-height:300px;\
  padding:14px 18px;\
  opacity:1;\
}\
#wctx-fab .wctx-bar-msg {\
  font-family:"Archivo",-apple-system,sans-serif;\
  font-size:13px; line-height:1.5; margin-bottom:8px;\
  color:rgba(10,10,10,0.7);\
}\
#wctx-fab .wctx-bar-msg:last-child { margin-bottom:0; }\
#wctx-fab .wctx-bar-msg.user {\
  text-align:right; color:rgba(10,10,10,0.5); font-weight:500;\
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
  font-size:14px; font-weight:500; color:rgba(10,10,10,0.8);\
  min-width:0;\
}\
#wctx-fab .wctx-bar-input::placeholder { color:rgba(10,10,10,0.3); }\
#wctx-fab .wctx-bar-send {\
  font-family:"Archivo",sans-serif;\
  font-size:11px; text-transform:uppercase; letter-spacing:0.08em; font-weight:700;\
  color:rgba(10,10,10,0.5); background:rgba(255,255,255,0.4);\
  border:1px solid rgba(0,0,0,0.06); border-radius:12px;\
  padding:10px 16px; cursor:pointer;\
  transition:all 0.2s;\
}\
#wctx-fab .wctx-bar-send:hover { background:rgba(255,255,255,0.7); color:rgba(10,10,10,0.8); }\
#wctx-fab .wctx-bar-expand {\
  background:none; border:none; cursor:pointer; padding:10px;\
  color:rgba(10,10,10,0.35); display:flex; transition:color 0.2s;\
}\
#wctx-fab .wctx-bar-expand:hover { color:rgba(10,10,10,0.7); }\
</style>\
<div class="wctx-bar-wrap">\
  <div class="wctx-bar-messages" id="wctx-bar-msgs"></div>\
  <div class="wctx-bar">\
    <span class="wctx-bar-dot"></span>\
    <input class="wctx-bar-input" type="text" placeholder="Ask anything…" autocomplete="off" />\
    <button class="wctx-bar-send" type="button">Send</button>\
    <button class="wctx-bar-expand" type="button" title="Expand chat">\
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M17 7H7M17 7V17"/></svg>\
    </button>\
  </div>\
</div>';
  document.body.appendChild(fab);

  var barInput = fab.querySelector(".wctx-bar-input");
  var barSend = fab.querySelector(".wctx-bar-send");
  var barExpand = fab.querySelector(".wctx-bar-expand");
  var barWrap = fab.querySelector(".wctx-bar-wrap");
  var barMsgs = fab.querySelector("#wctx-bar-msgs");

  // Pin the bar open when interacting
  barInput.addEventListener("focus", function() { barWrap.classList.add("pinned"); });
  barInput.addEventListener("blur", function() {
    setTimeout(function() {
      if (document.activeElement !== barInput && document.activeElement !== barSend) {
        barWrap.classList.remove("pinned");
      }
    }, 200);
  });

  // Send from the bottom bar — stay in bar mode, don't expand to full chat
  barSend.addEventListener("click", function() { sendFromBar(); });
  barInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") { e.preventDefault(); sendFromBar(); }
  });

  function sendFromBar() {
    var text = barInput.value.trim();
    if (!text) return;
    barInput.value = "";
    barWrap.classList.add("pinned");

    messages.push({ role: "user", content: text }); persistMessages();
    syncBarMessages();

    // Also add to the full chat messages (so they're there if user expands)
    if (state === "idle") {
      state = "chat";
      els.main.classList.remove("wctx-state-idle");
      els.main.classList.add("wctx-state-chat");
    }
    appendMsg("user", text);

    // Show thinking in bar
    var thinkDiv = document.createElement("div");
    thinkDiv.className = "wctx-bar-msg";
    thinkDiv.textContent = "Thinking...";
    thinkDiv.id = "wctx-bar-thinking";
    barMsgs.appendChild(thinkDiv);
    barMsgs.scrollTop = barMsgs.scrollHeight;

    fetch(API_HOST + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages, tenantId: TENANT_ID, sessionId: sessionId }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var t = document.getElementById("wctx-bar-thinking");
      if (t) t.remove();

      messages.push({ role: "assistant", content: data.message }); persistMessages();
      appendMsg("assistant", data.message, data.sources);
      syncBarMessages();

      // Handle LLM-driven navigation
      if (data.navigateTo) {
        setTimeout(function() { navigateToPage(data.navigateTo, ""); }, 1000);
      }

      // Handle guided flow
      if (data.flowSession && data.flowSession.guidedSteps && data.flowSession.guidedSteps.length > 0) {
        setTimeout(function() {
          launchGuidedExecution(data.flowSession.guidedSteps, data.flowSession.guidedInputs || {});
        }, 800);
      } else if (data.flowSession && data.flowSession.active) {
        barInput.placeholder = "Provide the requested info...";
      }
    })
    .catch(function() {
      var t = document.getElementById("wctx-bar-thinking");
      if (t) t.remove();
      messages.push({ role: "assistant", content: "Something went wrong." }); persistMessages();
      syncBarMessages();
    });
  }

  // Expand to full chat
  barExpand.addEventListener("click", openFullChat);

  // Sync messages to the mini bar view
  function syncBarMessages() {
    barMsgs.innerHTML = "";
    var recent = messages.slice(-4);
    recent.forEach(function(m) {
      var div = document.createElement("div");
      div.className = "wctx-bar-msg" + (m.role === "user" ? " user" : "");
      div.textContent = m.content.slice(0, 120) + (m.content.length > 120 ? "…" : "");
      barMsgs.appendChild(div);
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
    overlay.style.display = "";
    fab.style.display = "none";
    document.body.style.overflow = "hidden";
    els.input.focus();
  }

  function minimizeToBar() {
    overlay.style.display = "none";
    fab.style.display = "block";
    document.body.style.overflow = "";
    syncBarMessages();
  }

  els.browse.addEventListener("click", minimizeToBar);

  // Restore previous messages into the UI
  if (messages.length > 0) {
    els.main.classList.remove("wctx-state-idle");
    els.main.classList.add("wctx-state-chat");
    messages.forEach(function(m) { appendMsg(m.role, m.content); });
  }

  if (typeof START_MINIMIZED !== "undefined" && START_MINIMIZED) {
    minimizeToBar();
  } else {
    document.body.style.overflow = "hidden";
    els.input.focus();
  }

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

    fetch(API_HOST + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages, tenantId: TENANT_ID, sessionId: sessionId }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      messages.push({ role: "assistant", content: data.message }); persistMessages();
      appendMsg("assistant", data.message, data.sources);

      // Handle LLM-driven navigation
      if (data.navigateTo) {
        setTimeout(function() { navigateToPage(data.navigateTo, ""); }, 1000);
      }

      // Handle flow session state
      if (data.flowSession) {
        activeFlowSession = data.flowSession;

        // Guided execution — minimize chat and fill the form live
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
    })
    .catch(function() {
      appendMsg("assistant", "Something went wrong. Please try again.");
    })
    .finally(function() { setLoading(false); });
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

  function setLoading(on) {
    isLoading = on;
    els.typing.style.display = on ? "flex" : "none";
    els.send.disabled = on;
    if (on) els.msgs.scrollTop = els.msgs.scrollHeight;
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
  }

  function navigateToPage(url, label) {
    // Resolve relative URLs
    try { url = new URL(url, window.location.origin).href; } catch(e) {}

    appendMsg("system", "Showing you: " + (label || url));

    // Hide chat overlay, navigate the actual page
    minimizeToBar();

    // Navigate the host page
    window.location.href = url;
  }

  function md(t) {
    return t
      .replace(/```([\s\S]*?)```/g, "<pre>$1</pre>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="wctx-page-link">$1 →</a>')
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
  position:fixed; inset:12px;\
  font-family:"Archivo",-apple-system,BlinkMacSystemFont,sans-serif;\
  background:rgba(255,255,255,0.2);\
  backdrop-filter:blur(8px) saturate(1.2);\
  -webkit-backdrop-filter:blur(8px) saturate(1.2);\
  border-radius:20px;\
  border:1px solid rgba(255,255,255,0.3);\
  box-shadow:0 8px 32px rgba(0,0,0,0.08), inset 0 0 20px -5px rgba(255,255,255,0.4);\
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
  border-bottom:1px solid rgba(255,255,255,0.25);\
  flex-shrink:0;\
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
  0%,100%{opacity:1}\
  50%{opacity:0.3}\
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
.wctx-browse-btn:hover { background:rgba(255,255,255,0.45); color:rgba(10,10,10,0.7); border-color:rgba(255,255,255,0.5); }\
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
  bottom:0; left:0; right:0;\
  max-width:none;\
  padding:16px 32px 20px;\
  border-top:1px solid rgba(255,255,255,0.2);\
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
.wctx-send-btn:hover { color:rgba(10,10,10,0.8); }\
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
  animation:wctx-msgIn 0.35s cubic-bezier(0.4,0,0.2,1);\
}\
@keyframes wctx-msgIn {\
  from{opacity:0;transform:translateY(8px)}\
  to{opacity:1;transform:translateY(0)}\
}\
.wctx-msg-user {\
  align-self:flex-end;\
  background:rgba(10,10,10,0.65);\
  backdrop-filter:blur(8px);\
  -webkit-backdrop-filter:blur(8px);\
  color:rgba(255,255,255,0.95);\
  padding:14px 20px;\
  font-size:15px;\
  line-height:1.6;\
  font-weight:500;\
  border-radius:18px 18px 6px 18px;\
  border:1px solid rgba(255,255,255,0.05);\
}\
.wctx-msg-assistant {\
  align-self:flex-start;\
  font-size:15px;\
  line-height:1.7;\
  color:rgba(10,10,10,0.85);\
  background:rgba(255,255,255,0.3);\
  backdrop-filter:blur(8px);\
  -webkit-backdrop-filter:blur(8px);\
  padding:16px 20px;\
  border:1px solid rgba(255,255,255,0.3);\
  border-radius:18px 18px 18px 6px;\
  box-shadow:0 2px 8px rgba(0,0,0,0.04);\
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
  align-self:flex-start;\
  align-items:center;\
  gap:8px;\
  font-size:11px;\
  text-transform:uppercase;\
  letter-spacing:0.1em;\
  font-weight:600;\
  color:rgba(10,10,10,0.4);\
  background:rgba(255,255,255,0.25);\
  padding:10px 16px;\
  border-radius:14px;\
  border:1px solid rgba(255,255,255,0.2);\
}\
.wctx-typing::before {\
  content:"";\
  width:6px; height:6px;\
  border-radius:50%;\
  background:rgba(10,10,10,0.4);\
  animation:wctx-loadBlink 1s ease-in-out infinite;\
}\
@keyframes wctx-loadBlink {\
  0%,100%{opacity:1}\
  50%{opacity:0.2}\
}\
\
@media(max-width:768px){\
  .wctx-shell{inset:8px;border-radius:16px}\
  .wctx-topbar{padding:16px 20px;gap:14px}\
  .wctx-state-idle .wctx-input-zone{padding:0 20px}\
  .wctx-state-chat .wctx-input-zone{padding:12px 16px 16px}\
  .wctx-messages{padding:20px 16px 100px}\
  .wctx-chat-input{font-size:17px;padding:18px 0}\
  .wctx-browse-btn{display:none}\
  .wctx-input-frame{border-radius:14px}\
}\
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
    <div class="wctx-typing">Thinking</div>\
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
