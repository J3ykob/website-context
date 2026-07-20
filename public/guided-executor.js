// Guided Flow Executor — runs in the user's browser on the actual page.
// Injected by the widget when a flow needs user interaction.
// Communicates back to the widget via postMessage.
(function() {
  var CHANNEL = "wctx-guided";

  window.__wctxGuided = {
    execute: execute,
    abort: abort,
  };

  var aborted = false;
  var highlightEl = null;
  // "auto" fills the form for the user; "highlight" only points — every step is
  // highlighted with an instruction and the USER performs it themselves.
  var MODE = "auto";

  function execute(steps, inputs, mode) {
    aborted = false;
    MODE = mode === "highlight" ? "highlight" : "auto";
    runSteps(steps, inputs, 0);
  }

  function abort() {
    aborted = true;
    removeHighlight();
    notify("aborted", { message: "Flow aborted by user" });
  }

  async function runSteps(steps, inputs, index) {
    if (aborted) return;
    if (index >= steps.length) {
      notify("done", { stepsCompleted: steps.length });
      return;
    }

    var step = steps[index];
    notify("step-start", { index: index, total: steps.length, description: step.description, action: step.action });

    try {
      var value = substituteVars(step.value, inputs);
      // Unfilled {{variables}} (highlight tour has no collected values) must not
      // leak into tooltips or fields — treat as "no value".
      if (value && /\{\{.*?\}\}/.test(value)) value = "";

      switch (step.action) {
        case "navigate":
          if (value) {
            var targetUrl;
            try { targetUrl = new URL(value, window.location.origin); } catch(e) { break; }
            var currentPath = window.location.pathname;
            var targetPath = targetUrl.pathname;

            // Skip if already on the right page
            if (currentPath === targetPath || currentPath === targetPath + "/") {
              break;
            }

            // Same origin — store state for resume after navigation
            notify("navigating", { url: targetUrl.href });
            sessionStorage.setItem("wctx-guided-state", JSON.stringify({
              steps: steps,
              inputs: inputs,
              nextIndex: index + 1,
              mode: MODE,
            }));

            // Try Next.js / SPA router first
            if (window.next && window.next.router) {
              window.next.router.push(targetPath).then(function() {
                sessionStorage.removeItem("wctx-guided-state");
                sleep(1000).then(function() { runSteps(steps, inputs, index + 1); });
              });
              return;
            }

            // Otherwise hard navigate — the widget will resume on reload
            window.location.href = targetUrl.href;
            return;
          }
          break;

        case "click":
          var clickEl = findElement(step.target);
          if (clickEl) {
            // Last step or submit button — let the user click it
            var isLastStep = (index === steps.length - 1);
            var isSubmit = clickEl.tagName === "BUTTON" || clickEl.type === "submit" ||
              (step.target.text && /submit|send|confirm|place order|pay|sign/i.test(step.target.text));

            if (MODE === "highlight" || isLastStep || isSubmit || step.requiresUserAction) {
              clickEl.scrollIntoView({ behavior: "smooth", block: "center" });
              await sleep(400);
              flashHighlight(clickEl, "user");
              notify("user-action-needed", {
                index: index,
                field: step.description || step.target.text || "this button",
                message: "Click this button to finish",
              });
              // Wait for user to click THIS specific element
              await new Promise(function(resolve) {
                function onClickExact(e) {
                  // Only resolve if the click is on this element or its children
                  if (clickEl.contains(e.target) || e.target === clickEl) {
                    document.removeEventListener("click", onClickExact, true);
                    removeHighlight();
                    resolve();
                  }
                }
                document.addEventListener("click", onClickExact, true);
                setTimeout(function() {
                  document.removeEventListener("click", onClickExact, true);
                  resolve();
                }, 120000);
              });
              await sleep(500);
            } else {
              flashHighlight(clickEl, "auto");
              await sleep(300);
              clickEl.click();
              await sleep(500);
            }
          } else {
            notify("step-warning", { index: index, message: "Element not found for click, skipping" });
          }
          break;

        case "type":
          var typeEl = findElement(step.target);
          if (typeEl) {
            if (MODE !== "highlight" && value && !isUserActionRequired(step, value)) {
              flashHighlight(typeEl, "auto");
              typeEl.scrollIntoView({ behavior: "smooth", block: "center" });
              await sleep(300);
              typeEl.focus();
              setNativeValue(typeEl, "");
              for (var ci = 0; ci < value.length; ci++) {
                setNativeValue(typeEl, value.substring(0, ci + 1));
                typeEl.dispatchEvent(new Event("input", { bubbles: true }));
                typeEl.dispatchEvent(new Event("change", { bubbles: true }));
                await sleep(25);
              }
              typeEl.dispatchEvent(new Event("change", { bubbles: true }));
              typeEl.dispatchEvent(new Event("blur", { bubbles: true }));
              await sleep(300);
              removeHighlight();
            } else {
              flashHighlight(typeEl, "user");
              typeEl.focus();
              typeEl.scrollIntoView({ behavior: "smooth", block: "center" });
              notify("user-action-needed", {
                index: index,
                field: step.description || step.target.css || "this field",
                message: value ? 'Type here: "' + value + '"' : "Please fill in this field",
              });
              await waitForUserInput(typeEl);
              removeHighlight();
            }
          }
          break;

        case "select":
          var selectEl = findElement(step.target);
          if (selectEl && MODE === "highlight") {
            flashHighlight(selectEl, "user");
            selectEl.scrollIntoView({ behavior: "smooth", block: "center" });
            notify("user-action-needed", {
              index: index,
              field: step.description || "this dropdown",
              message: value ? 'Choose: "' + value + '"' : "Pick an option here",
            });
            await new Promise(function(resolve) {
              function onPick() { selectEl.removeEventListener("change", onPick); resolve(); }
              selectEl.addEventListener("change", onPick);
              setTimeout(function() { selectEl.removeEventListener("change", onPick); resolve(); }, 120000);
            });
            removeHighlight();
          } else if (selectEl && value) {
            flashHighlight(selectEl, "auto");
            selectEl.scrollIntoView({ behavior: "smooth", block: "center" });
            await sleep(300);
            // Find the best matching option
            var options = selectEl.querySelectorAll("option");
            var bestOption = null;
            var valueLower = value.toLowerCase();
            for (var oi = 0; oi < options.length; oi++) {
              var optText = options[oi].textContent.trim().toLowerCase();
              var optVal = options[oi].value.toLowerCase();
              if (optVal === valueLower || optText === valueLower || optText.includes(valueLower) || valueLower.includes(optText)) {
                bestOption = options[oi];
                break;
              }
            }
            if (bestOption) {
              setNativeValue(selectEl, bestOption.value);
            } else {
              setNativeValue(selectEl, value);
            }
            selectEl.dispatchEvent(new Event("change", { bubbles: true }));
            selectEl.dispatchEvent(new Event("input", { bubbles: true }));
            await sleep(300);
            removeHighlight();
          }
          break;

        case "wait":
          await sleep(parseInt(value) || 1000);
          break;

        case "scroll":
          var scrollEl = findElement(step.target);
          if (scrollEl) {
            scrollEl.scrollIntoView({ behavior: "smooth", block: "center" });
            await sleep(500);
          }
          break;
      }

      notify("step-done", { index: index });
      await sleep(200);
      runSteps(steps, inputs, index + 1);

    } catch (err) {
      notify("step-error", { index: index, error: err.message || String(err) });
      // Continue despite errors
      await sleep(500);
      runSteps(steps, inputs, index + 1);
    }
  }

  function isUserActionRequired(step, value) {
    // Steps that contain un-substituted variables need user input
    if (value && value.match(/\{\{.*?\}\}/)) return true;
    // Steps flagged as requiring user action
    if (step.requiresUserAction) return true;
    // Payment-related fields
    var desc = (step.description || "").toLowerCase();
    var name = (step.target.css || "").toLowerCase();
    var sensitive = ["password", "card", "cvv", "cvc", "payment", "captcha", "signature", "otp", "verify"];
    return sensitive.some(function(s) { return desc.includes(s) || name.includes(s); });
  }

  function waitForUserInput(el) {
    return new Promise(function(resolve) {
      var resolved = false;

      function check() {
        if (aborted || resolved) return;
        if (el.value && el.value.trim().length > 0) {
          resolved = true;
          resolve();
          return;
        }
        requestAnimationFrame(check);
      }

      // Also resolve on blur (user tabbed away after filling)
      el.addEventListener("blur", function onBlur() {
        if (el.value && el.value.trim().length > 0) {
          resolved = true;
          el.removeEventListener("blur", onBlur);
          resolve();
        }
      });

      // Timeout after 2 minutes
      setTimeout(function() {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 120000);

      check();
    });
  }

  function findElement(target) {
    if (!target) return null;

    // Try selectors in priority order
    if (target.testId) {
      var el = document.querySelector('[data-testid="' + target.testId + '"]');
      if (el) return el;
    }
    if (target.ariaLabel) {
      var el = document.querySelector('[aria-label="' + target.ariaLabel + '"]');
      if (el) return el;
    }
    if (target.css) {
      try {
        var el = document.querySelector(target.css);
        if (el) return el;
      } catch(e) {}
    }
    if (target.text) {
      // Find by text content
      var all = document.querySelectorAll("a, button, label, span, h1, h2, h3, h4, p");
      for (var i = 0; i < all.length; i++) {
        if (all[i].textContent.trim().includes(target.text)) return all[i];
      }
    }
    if (target.xpath) {
      try {
        var result = document.evaluate(target.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (result.singleNodeValue) return result.singleNodeValue;
      } catch(e) {}
    }
    return null;
  }

  function flashHighlight(el, mode) {
    removeHighlight();

    // Highlighter pen effect — colored semi-transparent bar behind the element
    var color = mode === "auto" ? "rgba(250,204,21,0.45)" : "rgba(59,130,246,0.35)";
    var mark = document.createElement("div");
    mark.id = "wctx-highlight";
    mark.style.cssText = "position:absolute;z-index:999990;pointer-events:none;" +
      "background:" + color + ";" +
      "border-radius:3px;" +
      "transition:opacity 0.3s;";

    // Slight rotation and skew for hand-drawn feel
    var skew = (Math.random() - 0.5) * 1.2;
    var rotate = (Math.random() - 0.5) * 0.8;
    mark.style.transform = "skewX(" + skew + "deg) rotate(" + rotate + "deg)";

    function position() {
      var rect = el.getBoundingClientRect();
      var scrollX = window.scrollX || document.documentElement.scrollLeft;
      var scrollY = window.scrollY || document.documentElement.scrollTop;
      // Extend slightly left/right like a real highlighter stroke
      mark.style.left = (rect.left + scrollX - 4) + "px";
      mark.style.top = (rect.top + scrollY - 2) + "px";
      mark.style.width = (rect.width + 8) + "px";
      mark.style.height = (rect.height + 4) + "px";
    }

    position();
    document.body.appendChild(mark);
    highlightEl = mark;

    // Label for user-action elements
    if (mode === "user") {
      var label = document.createElement("div");
      label.id = "wctx-highlight-label";
      label.style.cssText = "position:absolute;z-index:999991;pointer-events:none;" +
        "font-family:Archivo,-apple-system,sans-serif;font-size:13px;font-weight:700;" +
        "color:rgba(37,99,235,0.9);white-space:nowrap;" +
        "transform:rotate(" + ((Math.random() - 0.5) * 3) + "deg);";
      label.textContent = "↑ click this";

      function positionLabel() {
        var rect = el.getBoundingClientRect();
        var scrollX = window.scrollX || document.documentElement.scrollLeft;
        var scrollY = window.scrollY || document.documentElement.scrollTop;
        label.style.left = (rect.left + scrollX) + "px";
        label.style.top = (rect.bottom + scrollY + 6) + "px";
      }

      positionLabel();
      document.body.appendChild(label);
      highlightLabel = label;

      highlightScrollHandler = function() { position(); positionLabel(); };
    } else {
      highlightScrollHandler = function() { position(); };
    }

    window.addEventListener("scroll", highlightScrollHandler, { passive: true });
    window.addEventListener("resize", highlightScrollHandler, { passive: true });
  }

  var highlightScrollHandler = null;
  var highlightLabel = null;

  function removeHighlight() {
    if (highlightEl) { highlightEl.remove(); highlightEl = null; }
    if (highlightLabel) { highlightLabel.remove(); highlightLabel = null; }
    if (highlightScrollHandler) {
      window.removeEventListener("scroll", highlightScrollHandler);
      window.removeEventListener("resize", highlightScrollHandler);
      highlightScrollHandler = null;
    }
  }

  // Set value on React/Next.js controlled inputs by using the native setter
  function setNativeValue(el, value) {
    var proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype :
                el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype :
                HTMLInputElement.prototype;
    var nativeSetter = Object.getOwnPropertyDescriptor(proto, "value");
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function substituteVars(value, inputs) {
    if (!value || !inputs) return value;
    return value.replace(/\{\{(\w+)\}\}/g, function(_, key) {
      return inputs[key] !== undefined ? inputs[key] : "{{" + key + "}}";
    });
  }

  function notify(type, data) {
    window.postMessage({ channel: CHANNEL, type: type, data: data || {} }, "*");
  }

  function sleep(ms) {
    return new Promise(function(r) { setTimeout(r, ms); });
  }

  // Resume is now handled by the widget (widget.js checks sessionStorage on load)
})();
