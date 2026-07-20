// Guided Flow Executor v2 — a resident form controller on the real page.
// The server (LLM-driven) sends field operations; this applies them and can
// read the live form state back. No self-running step loop: the conversation
// drives one action at a time, so the tour advances when the USER says so.
(function () {
  if (window.__wctxGuided && window.__wctxGuided.v === 2) return;
  var CHANNEL = "wctx-guided";
  var highlightEl = null, highlightLabel = null, highlightScrollHandler = null;

  // ─── Element resolution ────────────────────────────────────────────────────
  function findElement(target) {
    if (!target) return null;
    if (target.css) { try { var el = document.querySelector(target.css); if (el) return el; } catch (e) {} }
    if (target.xpath) {
      try { var r = document.evaluate(target.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); if (r.singleNodeValue) return r.singleNodeValue; } catch (e) {}
    }
    if (target.text) {
      var all = document.querySelectorAll("input, textarea, select, button, a");
      for (var i = 0; i < all.length; i++) if ((all[i].textContent || all[i].value || "").trim().indexOf(target.text) !== -1) return all[i];
    }
    return null;
  }

  // ─── Native-setter value assignment (React/Vue controlled inputs) ───────────
  function setNativeValue(el, value) {
    var proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
  }
  function fireInput(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ─── Value coercion by field type ──────────────────────────────────────────
  // <input type=date> needs yyyy-mm-dd; natural words ("tomorrow", "jutro") are
  // resolved here where a real Date is available. <select> matches an option.
  function coerceDate(value) {
    var v = (value || "").trim().toLowerCase();
    var d = new Date();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    if (v === "today" || v === "dzis" || v === "dzisiaj") {}
    else if (v === "tomorrow" || v === "jutro") d.setDate(d.getDate() + 1);
    else if (v === "day after tomorrow" || v === "pojutrze") d.setDate(d.getDate() + 2);
    else {
      var parsed = new Date(value);
      if (!isNaN(parsed.getTime())) d = parsed; else return "";
    }
    var mm = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }
  function matchOption(selectEl, value) {
    var v = (value || "").toLowerCase().trim();
    var opts = selectEl.querySelectorAll("option");
    // Exact value/text, then contains, then leading number ("2 people" -> "2").
    var num = (v.match(/\d+/) || [])[0];
    for (var pass = 0; pass < 3; pass++) {
      for (var i = 0; i < opts.length; i++) {
        var ov = (opts[i].value || "").toLowerCase(), ot = (opts[i].textContent || "").toLowerCase().trim();
        if (pass === 0 && (ov === v || ot === v)) return opts[i].value;
        if (pass === 1 && (ot.indexOf(v) !== -1 || (v && v.indexOf(ot) !== -1))) return opts[i].value;
        if (pass === 2 && num && (ov === num || ot.indexOf(num) !== -1)) return opts[i].value;
      }
    }
    return null;
  }

  // ─── Highlighter ────────────────────────────────────────────────────────────
  function removeHighlight() {
    if (highlightEl) { highlightEl.remove(); highlightEl = null; }
    if (highlightLabel) { highlightLabel.remove(); highlightLabel = null; }
    if (highlightScrollHandler) { window.removeEventListener("scroll", highlightScrollHandler); window.removeEventListener("resize", highlightScrollHandler); highlightScrollHandler = null; }
  }
  function highlight(el, instruction) {
    removeHighlight();
    var mark = document.createElement("div");
    mark.id = "wctx-highlight";
    mark.style.cssText = "position:absolute;z-index:999990;pointer-events:none;background:rgba(59,130,246,0.28);box-shadow:0 0 0 2px rgba(59,130,246,0.9);border-radius:6px;transition:all 0.2s;";
    var label = null;
    if (instruction) {
      label = document.createElement("div");
      label.id = "wctx-highlight-label";
      label.style.cssText = "position:absolute;z-index:999991;pointer-events:none;font-family:Archivo,-apple-system,sans-serif;font-size:13px;font-weight:600;color:#fff;background:#2563eb;padding:5px 11px;border-radius:8px;box-shadow:0 4px 14px rgba(37,99,235,0.4);white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;";
      label.textContent = instruction;
    }
    function pos() {
      var r = el.getBoundingClientRect(), sx = window.scrollX, sy = window.scrollY;
      mark.style.left = (r.left + sx - 4) + "px"; mark.style.top = (r.top + sy - 4) + "px";
      mark.style.width = (r.width + 8) + "px"; mark.style.height = (r.height + 8) + "px";
      if (label) { label.style.left = (r.left + sx) + "px"; label.style.top = (r.bottom + sy + 8) + "px"; }
    }
    pos();
    document.body.appendChild(mark); highlightEl = mark;
    if (label) { document.body.appendChild(label); highlightLabel = label; }
    highlightScrollHandler = pos;
    window.addEventListener("scroll", pos, { passive: true });
    window.addEventListener("resize", pos, { passive: true });
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function notify(type, data) {
    window.postMessage({ channel: CHANNEL, type: type, data: data || {} }, "*");
  }

  // ─── Read current form state for the given fields ──────────────────────────
  function readState(fields) {
    var state = {};
    (fields || []).forEach(function (f) {
      var el = findElement(f.target || { css: f.selector });
      if (!el) { state[f.name] = null; return; }
      if (el.tagName === "SELECT") {
        var opt = el.options[el.selectedIndex];
        state[f.name] = opt && opt.value ? (opt.textContent || opt.value).trim() : "";
      } else {
        state[f.name] = (el.value || "").trim();
      }
    });
    return state;
  }

  // ─── Apply a batch of field operations ─────────────────────────────────────
  // op: "set" (fill), "highlight" (point, wait for chat), "submit" (wait click).
  async function apply(actions) {
    for (var i = 0; i < (actions || []).length; i++) {
      var a = actions[i];
      var el = findElement(a.target || { css: a.selector });
      try {
        if (a.op === "set" && el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          highlight(el, null);
          await sleep(250);
          if (el.tagName === "SELECT") {
            var ov = matchOption(el, a.value);
            if (ov != null) { setNativeValue(el, ov); fireInput(el); }
          } else if (a.fieldType === "date" || el.type === "date") {
            var dv = coerceDate(a.value);
            if (dv) { setNativeValue(el, dv); fireInput(el); }
          } else {
            el.focus(); setNativeValue(el, "");
            for (var c = 0; c < a.value.length; c++) { setNativeValue(el, a.value.substring(0, c + 1)); el.dispatchEvent(new Event("input", { bubbles: true })); await sleep(18); }
            fireInput(el); el.dispatchEvent(new Event("blur", { bubbles: true }));
          }
          await sleep(200); removeHighlight();
          notify("field-set", { name: a.name });
        } else if (a.op === "highlight" && el) {
          highlight(el, a.instruction || ("Fill in " + (a.label || "this field")));
          notify("field-highlight", { name: a.name });
        } else if (a.op === "submit" && el) {
          highlight(el, a.instruction || "Click to finish");
          notify("submit-ready", { name: a.name });
        }
      } catch (e) { notify("op-error", { name: a && a.name, error: String(e && e.message) }); }
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clear() { removeHighlight(); }

  window.__wctxGuided = { v: 2, apply: apply, readState: readState, clear: clear };
  notify("ready", {});
})();
