/*
 * Whisp agent kit - the browser half of goal-driven flows. Deliberately thin:
 * it only (1) snapshots the visible, actionable controls of the page as an
 * indexed table and (2) executes ONE server-decided command against an index
 * it observed. It holds no model, no API key and no decision logic; the server
 * (Jev) decides every step. Model output never becomes selectors, coordinates
 * or code here: commands can only reference indices from the last snapshot.
 *
 * Snapshot approach adapted from browser-use/jev-ultrafast (MIT).
 */
(function () {
  if (window.__whispAgentKit) return;

  var nodes = new Map(); // index -> element (last snapshot only)

  var ROLES = ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio", "option", "gridcell", "combobox", "textbox", "searchbox", "spinbutton"];
  var SELECTOR = "a[href],button,input,textarea,select,summary,[contenteditable='true']," + ROLES.map(function (r) { return "[role='" + r + "']"; }).join(",");

  function safe(e) { return ["password", "file", "hidden"].indexOf(e.type) < 0; }
  function ownUi(e) { return !!e.closest("#wctx-root,[id^='wctx-'],[class*='wctx-']"); }
  function visible(e) {
    if (e.closest("[aria-hidden='true'],[inert]")) return false;
    if (e.checkVisibility) return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    var s = getComputedStyle(e);
    return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }
  function name(e, seen) {
    seen = seen || new Set();
    if (!e || seen.has(e)) return "";
    seen.add(e);
    var ref = (e.getAttribute("aria-labelledby") || "").split(/\s+/).map(function (id) { return name(document.getElementById(id), seen); }).filter(Boolean).join(" ");
    var labels = e.labels ? Array.prototype.map.call(e.labels, function (l) { return name(l, seen); }).filter(Boolean).join(" ") : "";
    var text = e.tagName === "INPUT" ? "" : (e.innerText || e.textContent || "");
    return (ref || e.getAttribute("aria-label") || labels ||
      (["button", "submit", "reset"].indexOf(e.type) >= 0 ? e.value : "") || e.getAttribute("alt") ||
      text || e.getAttribute("title") || e.getAttribute("placeholder") || e.getAttribute("name") || "").replace(/\s+/g, " ").trim().slice(0, 160);
  }
  function role(e) {
    var r = e.getAttribute("role");
    if (ROLES.indexOf(r) >= 0) return r;
    if (e.tagName === "BUTTON" || e.tagName === "SUMMARY") return "button";
    if (e.tagName === "A") return "link";
    if (e.tagName === "SELECT") return "combobox";
    if (e.tagName === "TEXTAREA" || e.isContentEditable) return "textbox";
    if (e.tagName === "INPUT") {
      if (e.type === "checkbox" || e.type === "radio") return e.type;
      if (["button", "submit", "reset", "image"].indexOf(e.type) >= 0) return "button";
      if (e.type === "search") return "searchbox";
      if (e.type === "number") return "spinbutton";
      return "textbox";
    }
    return null;
  }
  function inView(e) {
    var r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  // Indexed table of visible controls. Controls below the fold are included
  // (flagged offscreen) so a long list (28 exam packages) is choosable at once.
  function snapshot() {
    nodes = new Map();
    var elements = [];
    var list = document.querySelectorAll(SELECTOR);
    for (var k = 0; k < list.length && elements.length < 150; k++) {
      var e = list[k];
      if (!safe(e) || ownUi(e) || !visible(e) || e.matches(":disabled") || e.closest("[aria-disabled='true']")) continue;
      var r = role(e);
      if (!r) continue;
      var rect = e.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      // A card with role=button often contains its own inner buttons; keep the outer one.
      if (r === "gridcell" && e.querySelector("button,[role='button']")) continue;
      var ops = [];
      if (r === "textbox" || r === "searchbox" || r === "spinbutton" || (r === "combobox" && e.tagName !== "SELECT")) ops.push("TYPE");
      if (e.tagName === "SELECT") ops.push("SELECT");
      if (e.tagName !== "SELECT" && r !== "textbox" && r !== "searchbox" && r !== "spinbutton") ops.push("CLICK");
      if (r === "combobox" && e.tagName !== "SELECT") ops.push("CLICK");
      var idx = elements.length + 1;
      nodes.set(idx, e);
      var item = { i: idx, role: r, label: name(e), ops: ops };
      // Where it sits: header/nav/footer links restart or leave a multi-step process.
      var area = e.closest("header,[role='banner']") ? "header" : e.closest("nav,[role='navigation']") ? "nav" : e.closest("footer,[role='contentinfo']") ? "footer" : "";
      if (area) item.area = area;
      if (e.value !== undefined && e.tagName !== "BUTTON" && e.tagName !== "A") item.value = String(e.value).slice(0, 120);
      if (e.checked !== undefined && (r === "checkbox" || r === "radio")) item.checked = !!e.checked;
      var pressed = e.getAttribute("aria-pressed") || e.getAttribute("aria-selected") || e.getAttribute("aria-checked");
      if (pressed) item.selected = pressed === "true";
      if (e.getAttribute("aria-expanded")) item.expanded = e.getAttribute("aria-expanded") === "true";
      if (e.required || e.getAttribute("aria-required") === "true") item.required = true;
      if (e.tagName === "SELECT") item.options = Array.prototype.slice.call(e.options, 0, 60).map(function (o, j) { return { j: j, label: (o.textContent || "").trim().slice(0, 80) }; });
      if (!inView(e)) item.offscreen = true;
      elements.push(item);
    }
    var text = (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000);
    var errors = Array.prototype.map.call(document.querySelectorAll("[role='alert'],[aria-invalid='true'],.error,.invalid-feedback,.text-red-500,.text-destructive"), function (x) { return (x.innerText || x.getAttribute("aria-label") || "").trim(); }).filter(Boolean).slice(0, 8);
    return { url: location.href, title: document.title, text: text, elements: elements, errors: errors };
  }

  function setNativeValue(el, value) {
    var proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  var hl = null;
  function highlight(el) {
    try {
      if (!hl) {
        hl = document.createElement("div");
        hl.id = "wctx-agent-hl"; // z-index below the chat widget (~1e6): it must never cover the chat
        hl.style.cssText = "position:fixed;pointer-events:none;z-index:999990;border:3px solid #3b82f6;border-radius:8px;box-shadow:0 0 0 4px rgba(59,130,246,.25);transition:all .18s ease";
        document.body.appendChild(hl);
      }
      var r = el.getBoundingClientRect();
      hl.style.left = (r.left - 4) + "px"; hl.style.top = (r.top - 4) + "px";
      hl.style.width = (r.width + 8) + "px"; hl.style.height = (r.height + 8) + "px";
      hl.style.display = "block";
    } catch (e) {}
  }
  function clearHighlight() { if (hl) hl.style.display = "none"; }
  var lastHl = null;
  var _hl = highlight;
  highlight = function (el) { lastHl = el; _hl(el); };
  window.addEventListener("scroll", function () { if (lastHl && hl && hl.style.display !== "none") _hl(lastHl); }, true);

  function settle(maxMs) {
    return new Promise(function (resolve) {
      var quietFor = 350, last = Date.now(), start = Date.now();
      var mo = new MutationObserver(function () { last = Date.now(); });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      (function tick() {
        if (Date.now() - last >= quietFor || Date.now() - start >= (maxMs || 3000)) { mo.disconnect(); resolve(); return; }
        setTimeout(tick, 80);
      })();
    });
  }

  // Execute one command: {op, i, text?, option?}. Returns {ok, error?}.
  async function act(cmd) {
    if (!cmd || !cmd.op) return { ok: false, error: "no command" };
    if (cmd.op === "SCROLL_DOWN") { window.scrollBy({ top: innerHeight * 0.8, behavior: "smooth" }); await settle(800); return { ok: true }; }
    if (cmd.op === "SCROLL_UP") { window.scrollBy({ top: -innerHeight * 0.8, behavior: "smooth" }); await settle(800); return { ok: true }; }
    if (cmd.op === "WAIT") { await settle(2500); return { ok: true }; }
    var el = nodes.get(cmd.i);
    if (!el || !el.isConnected) return { ok: false, error: "element " + cmd.i + " is gone" };
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await new Promise(function (r) { setTimeout(r, 250); });
    highlight(el);
    await new Promise(function (r) { setTimeout(r, 350); });
    try {
      if (cmd.op === "CLICK") {
        el.click();
      } else if (cmd.op === "TYPE") {
        el.focus();
        if (el.isContentEditable) { el.textContent = cmd.text || ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
        else setNativeValue(el, cmd.text || "");
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      } else if (cmd.op === "SELECT") {
        var opt = el.options && el.options[cmd.option];
        if (!opt) return { ok: false, error: "option " + cmd.option + " is gone" };
        setNativeValue(el, opt.value);
      } else {
        return { ok: false, error: "unknown op " + cmd.op };
      }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
    await settle(3000);
    return { ok: true };
  }

  // The chat widget covers the bottom of the screen: give the page (or its inner
  // scroll container) room below, and bring the element into the upper part of
  // the viewport so the visitor can actually see and click it.
  function scrollParent(el) {
    for (var x = el.parentElement; x && x !== document.body; x = x.parentElement) {
      var st = getComputedStyle(x);
      if (/(auto|scroll)/.test(st.overflowY) && x.scrollHeight > x.clientHeight + 4) return x;
    }
    return null;
  }
  function makeRoom(el) {
    var sp = scrollParent(el) || document.body;
    if (!sp.dataset.wctxPad) {
      sp.dataset.wctxPad = "1";
      sp.style.paddingBottom = ((parseFloat(getComputedStyle(sp).paddingBottom) || 0) + Math.round(innerHeight * 0.5)) + "px";
    }
    el.style.scrollMarginTop = Math.round(innerHeight * 0.2) + "px";
    el.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  // Point at an element without acting (final submit and consents are left to the visitor).
  function point(i) { var el = nodes.get(i); if (el) { makeRoom(el); setTimeout(function () { highlight(el); }, 450); } }

  // Cheap page-state fingerprint (does not touch the index map): lets the widget
  // notice that the visitor acted on the page themselves while the agent waited.
  function signature() {
    var parts = [location.href];
    var list = document.querySelectorAll(SELECTOR);
    for (var k = 0; k < list.length && k < 300; k++) {
      var e = list[k];
      if (!safe(e) || ownUi(e) || !visible(e)) continue;
      parts.push((e.tagName || "") + "|" + (e.innerText || e.value || "").slice(0, 40) + "|" + (e.checked ? 1 : 0) + "|" + (e.getAttribute("aria-pressed") || e.getAttribute("aria-checked") || e.getAttribute("data-state") || ""));
    }
    return parts.join("\n");
  }
  // Current state of an element from the last snapshot (value typed / box ticked).
  function stateOf(i) {
    var e = nodes.get(i);
    if (!e || !e.isConnected) return null;
    var ticked = e.checked === true || e.getAttribute("aria-checked") === "true" || e.getAttribute("aria-pressed") === "true" || e.getAttribute("data-state") === "checked";
    return { value: e.value !== undefined ? String(e.value) : "", ticked: ticked };
  }

  window.__whispAgentKit = { snapshot: snapshot, act: act, point: point, clear: clearHighlight, signature: signature, stateOf: stateOf };
})();
