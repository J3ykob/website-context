/**
 * Flow Recorder - Captures user interactions for replay
 * Self-contained vanilla JS, no dependencies
 * Inject via bookmarklet or iframe in dashboard
 */
(function () {
  "use strict";

  // Prevent double-initialization
  if (window.__flowRecorderActive) return;
  window.__flowRecorderActive = true;

  // Determine the API host: if loaded via bookmarklet, use the script's origin
  var scriptSrc = (document.currentScript && document.currentScript.src) || "";
  var apiOrigin = "";
  if (scriptSrc) {
    try { apiOrigin = new URL(scriptSrc).origin; } catch(e) {}
  }

  const CONFIG = {
    endpoint: window.__flowRecorderEndpoint || (apiOrigin + "/api/flows/record"),
    ignoredSelectors: [".flow-recorder-overlay", ".flow-recorder-overlay *"],
  };

  const state = {
    recording: false,
    steps: [],
    startTime: null,
    stepCounter: 0,
  };

  // ─── Selector Generation ───────────────────────────────────────────────────

  function getTestId(el) {
    return el.getAttribute("data-testid") || el.getAttribute("data-cy") || null;
  }

  function getAriaLabel(el) {
    return el.getAttribute("aria-label") || null;
  }

  function getTextContent(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "button" || tag === "label") {
      const text = el.textContent.trim();
      if (text && text.length < 80) return text;
    }
    return null;
  }

  function getIdSelector(el) {
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) {
      return "#" + el.id;
    }
    return null;
  }

  function getNthChildIndex(el) {
    let index = 1;
    let sibling = el.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === el.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    return index;
  }

  function getShortestUniqueCSS(el) {
    // 1. Try ID
    const idSel = getIdSelector(el);
    if (idSel && document.querySelectorAll(idSel).length === 1) {
      return idSel;
    }

    // 2. Try tag + meaningful classes
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList)
      .filter(function (c) {
        return !/^(ng-|_|js-)/.test(c) && c.length < 40;
      })
      .slice(0, 3);

    if (classes.length > 0) {
      const classSel = tag + "." + classes.join(".");
      if (document.querySelectorAll(classSel).length === 1) {
        return classSel;
      }
    }

    // 3. Try with attribute selectors (name, type for inputs)
    if (el.name) {
      const attrSel = tag + '[name="' + el.name + '"]';
      if (document.querySelectorAll(attrSel).length === 1) {
        return attrSel;
      }
    }

    // 4. Build path from ancestors
    var parts = [];
    var current = el;
    while (current && current !== document.body && parts.length < 5) {
      var part = current.tagName.toLowerCase();
      var cid = getIdSelector(current);
      if (cid && document.querySelectorAll(cid).length === 1) {
        parts.unshift(cid);
        break;
      }
      var cClasses = Array.from(current.classList)
        .filter(function (c) {
          return !/^(ng-|_|js-)/.test(c) && c.length < 40;
        })
        .slice(0, 2);
      if (cClasses.length > 0) {
        part += "." + cClasses.join(".");
      }
      var nthIdx = getNthChildIndex(current);
      var siblings = current.parentElement
        ? current.parentElement.querySelectorAll(":scope > " + current.tagName.toLowerCase())
        : [];
      if (siblings.length > 1) {
        part += ":nth-of-type(" + nthIdx + ")";
      }
      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function getXPath(el) {
    var parts = [];
    var current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      var tag = current.tagName.toLowerCase();
      if (current.id && /^[a-zA-Z][\w-]*$/.test(current.id)) {
        parts.unshift('//' + tag + '[@id="' + current.id + '"]');
        return parts.join("/");
      }
      var index = 0;
      var sibling = current;
      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.tagName === current.tagName) {
          index++;
        }
        sibling = sibling.previousSibling;
      }
      parts.unshift(tag + "[" + index + "]");
      current = current.parentNode;
    }
    return "/" + parts.join("/");
  }

  function generateSelectors(el) {
    var selectors = {};

    var testId = getTestId(el);
    if (testId) selectors.testId = testId;

    var ariaLabel = getAriaLabel(el);
    if (ariaLabel) selectors.ariaLabel = ariaLabel;

    selectors.css = getShortestUniqueCSS(el);
    selectors.xpath = getXPath(el);

    var text = getTextContent(el);
    if (text) selectors.text = text;

    return selectors;
  }

  // ─── Value Templating ──────────────────────────────────────────────────────

  function templateValue(value, inputType) {
    if (!value) return value;
    // Detect email patterns
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "{{email}}";
    // Detect phone patterns
    if (/^[\d\s\-+()]{7,}$/.test(value)) return "{{phone}}";
    // Detect URLs
    if (/^https?:\/\//.test(value)) return "{{url}}";
    // Type hints from input type
    if (inputType === "email") return "{{email}}";
    if (inputType === "tel") return "{{phone}}";
    if (inputType === "password") return "{{password}}";
    return value;
  }

  // ─── Event Handlers ────────────────────────────────────────────────────────

  function isRecorderElement(el) {
    return el.closest && el.closest(".flow-recorder-overlay");
  }

  function recordStep(action, target, value) {
    state.stepCounter++;
    state.steps.push({
      id: "step_" + state.stepCounter,
      order: state.stepCounter,
      action: action,
      target: target,
      value: value || undefined,
      timestamp: Date.now() - state.startTime,
      url: window.location.href,
      description: action + " on " + (target.text || target.css || target.xpath),
    });
    updateUI();
  }

  function handleClick(e) {
    if (!state.recording) return;
    var el = e.target;
    if (isRecorderElement(el)) return;

    // Skip if this is an input (we handle those via input/change)
    var tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    var selectors = generateSelectors(el);
    recordStep("click", selectors);
  }

  var inputDebounce = {};

  function handleInput(e) {
    if (!state.recording) return;
    var el = e.target;
    if (isRecorderElement(el)) return;

    var tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return;

    // Debounce: record final value after 500ms of no typing
    var key = getShortestUniqueCSS(el);
    clearTimeout(inputDebounce[key]);
    inputDebounce[key] = setTimeout(function () {
      var selectors = generateSelectors(el);
      var value = templateValue(el.value, el.type);
      recordStep("type", selectors, value);
    }, 500);
  }

  function handleChange(e) {
    if (!state.recording) return;
    var el = e.target;
    if (isRecorderElement(el)) return;

    var tag = el.tagName.toLowerCase();
    if (tag === "select") {
      var selectors = generateSelectors(el);
      recordStep("select", selectors, el.value);
    }
  }

  function handleSubmit(e) {
    if (!state.recording) return;
    var form = e.target;
    if (isRecorderElement(form)) return;
    var selectors = generateSelectors(form);
    recordStep("submit", selectors);
  }

  var lastUrl = window.location.href;

  function handleNavigation() {
    if (!state.recording) return;
    var currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      recordStep("navigate", { css: "window" }, currentUrl);
    }
  }

  // ─── UI Overlay ────────────────────────────────────────────────────────────

  var overlay = null;

  function createOverlay() {
    overlay = document.createElement("div");
    overlay.className = "flow-recorder-overlay";
    overlay.innerHTML =
      '<div style="' +
      "position:fixed;top:16px;right:16px;z-index:2147483647;" +
      "background:#1a1a2e;color:#fff;padding:12px 20px;border-radius:12px;" +
      "font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;" +
      "box-shadow:0 8px 32px rgba(0,0,0,0.4);display:flex;align-items:center;gap:12px;" +
      "user-select:none;" +
      '">' +
      '<span class="rec-dot" style="' +
      "width:12px;height:12px;border-radius:50%;background:#ff4444;" +
      "animation:rec-pulse 1s infinite;" +
      '"></span>' +
      '<span class="rec-steps" style="font-weight:600;">0 steps</span>' +
      '<button class="rec-stop" style="' +
      "background:#ff4444;border:none;color:#fff;padding:6px 14px;" +
      "border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;" +
      '">Stop & Save</button>' +
      "</div>";

    var style = document.createElement("style");
    style.textContent =
      "@keyframes rec-pulse{0%,100%{opacity:1}50%{opacity:0.3}}";
    overlay.appendChild(style);
    document.body.appendChild(overlay);

    overlay.querySelector(".rec-stop").addEventListener("click", stopRecording);
  }

  function updateUI() {
    if (!overlay) return;
    var stepsEl = overlay.querySelector(".rec-steps");
    if (stepsEl) {
      stepsEl.textContent = state.steps.length + " step" + (state.steps.length !== 1 ? "s" : "");
    }
  }

  function removeOverlay() {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  }

  // ─── Recording Control ─────────────────────────────────────────────────────

  function startRecording() {
    state.recording = true;
    state.steps = [];
    state.startTime = Date.now();
    state.stepCounter = 0;
    lastUrl = window.location.href;

    // Record the initial navigation
    recordStep("navigate", { css: "window" }, window.location.href);

    document.addEventListener("click", handleClick, true);
    document.addEventListener("input", handleInput, true);
    document.addEventListener("change", handleChange, true);
    document.addEventListener("submit", handleSubmit, true);

    // Poll for navigation changes (catches pushState/replaceState)
    state.navInterval = setInterval(handleNavigation, 500);

    createOverlay();
  }

  function stopRecording() {
    state.recording = false;

    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("input", handleInput, true);
    document.removeEventListener("change", handleChange, true);
    document.removeEventListener("submit", handleSubmit, true);
    clearInterval(state.navInterval);

    removeOverlay();
    saveRecording();
  }

  function saveRecording() {
    var flow = {
      id: "flow_" + Date.now(),
      name: "Recorded Flow",
      description: "Flow recorded on " + new Date().toISOString(),
      triggerPhrases: [],
      steps: state.steps.map(function (s) {
        return {
          id: s.id,
          order: s.order,
          action: s.action,
          target: s.target,
          value: s.value,
          description: s.description,
          timeout: 10000,
        };
      }),
      requiredInputs: detectRequiredInputs(state.steps),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "draft",
    };

    // POST to endpoint
    fetch(CONFIG.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(flow),
    })
      .then(function (res) {
        if (res.ok) {
          showNotification("Flow saved successfully! (" + flow.steps.length + " steps)");
        } else {
          showNotification("Failed to save flow (HTTP " + res.status + ")");
          console.error("[FlowRecorder] Save failed:", res.statusText);
        }
      })
      .catch(function (err) {
        showNotification("Failed to save flow: " + err.message);
        console.error("[FlowRecorder] Save error:", err);
        // Fallback: download as JSON
        downloadFlow(flow);
      });

    window.__flowRecorderActive = false;
  }

  function detectRequiredInputs(steps) {
    var inputs = [];
    var seen = {};
    steps.forEach(function (step) {
      if (step.value && /^\{\{(\w+)\}\}$/.test(step.value)) {
        var name = step.value.replace(/[{}]/g, "");
        if (!seen[name]) {
          seen[name] = true;
          var type = "text";
          if (name === "email") type = "email";
          else if (name === "phone") type = "phone";
          else if (name === "url") type = "text";
          else if (name === "password") type = "text";
          inputs.push({
            name: name,
            label: name.charAt(0).toUpperCase() + name.slice(1),
            type: type,
            required: true,
            description: "Value for " + name,
          });
        }
      }
    });
    return inputs;
  }

  function downloadFlow(flow) {
    var blob = new Blob([JSON.stringify(flow, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "flow-" + flow.id + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function showNotification(msg) {
    var el = document.createElement("div");
    el.className = "flow-recorder-overlay";
    el.style.cssText =
      "position:fixed;bottom:24px;right:24px;z-index:2147483647;" +
      "background:#1a1a2e;color:#fff;padding:14px 24px;border-radius:10px;" +
      "font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;" +
      "box-shadow:0 8px 32px rgba(0,0,0,0.4);transition:opacity 0.5s;";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0";
      setTimeout(function () { el.remove(); }, 600);
    }, 3000);
  }

  // ─── Auto-start ────────────────────────────────────────────────────────────
  startRecording();
})();
