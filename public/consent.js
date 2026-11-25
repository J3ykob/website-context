// Consent for the Meta Pixel on whisp.so pages. Nothing from Meta loads, and no cookie is written,
// until the visitor agrees. The choice lives in localStorage ('whisp-consent': 'granted' | 'denied');
// the privacy policy page offers a button to change it (whispConsent.reset()).
// A page that only manages the choice (the policy) includes this file with data-pixel="off".
(function () {
  var KEY = 'whisp-consent';
  var PIXEL_ID = '1427457739181980';
  var pixelOff = document.currentScript && document.currentScript.getAttribute('data-pixel') === 'off';

  var TEXT = {
    en: {
      body: 'We use the Meta Pixel (Facebook, Instagram) to see whether our ads work. It stores cookies in your browser - only if you agree.',
      yes: 'I agree', no: 'I do not agree', more: 'Privacy policy',
    },
    pl: {
      body: 'Używamy piksela Meta (Facebook, Instagram), żeby sprawdzać, czy nasze reklamy działają. Zapisuje on pliki cookies w Twojej przeglądarce - tylko jeśli się zgodzisz.',
      yes: 'Zgadzam się', no: 'Nie zgadzam się', more: 'Polityka prywatności',
    },
  };

  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) {} }
  function lang() {
    var l = null;
    try { l = localStorage.getItem('whisp-lang'); } catch (e) {}
    if (!l) l = document.documentElement.lang || navigator.language || 'en';
    return String(l).toLowerCase().indexOf('pl') === 0 ? 'pl' : 'en';
  }

  function loadPixel() {
    if (pixelOff || window.fbq) return;
    !function(f,b,e,v,n,t,s)
    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', PIXEL_ID);
    fbq('track', 'PageView');
  }

  function hide() { var el = document.getElementById('whisp-consent'); if (el) el.remove(); }

  function show() {
    if (document.getElementById('whisp-consent')) return;
    var t = TEXT[lang()];
    var box = document.createElement('div');
    box.id = 'whisp-consent';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', t.more);
    box.innerHTML =
      '<style>' +
      '#whisp-consent{position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:360px;box-sizing:border-box;' +
      'background:#111a2e;color:#e6ebf5;border:1px solid #1f2a44;border-radius:12px;padding:16px 18px;' +
      'font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.45)}' +
      '#whisp-consent p{margin:0 0 12px;color:#e6ebf5}' +
      '#whisp-consent a{color:#9aa6bf;text-decoration:underline}' +
      '#whisp-consent .wc-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}' +
      '#whisp-consent button{flex:1 1 130px;min-height:40px;padding:8px 12px;border-radius:8px;border:1px solid #3b82f6;' +
      'background:transparent;color:#e6ebf5;font:inherit;font-weight:600;cursor:pointer}' +
      '#whisp-consent button:hover{background:rgba(59,130,246,.18)}' +
      '#whisp-consent button:focus-visible{outline:2px solid #93c5fd;outline-offset:2px}' +
      '@media (max-width:520px){#whisp-consent{left:12px;right:12px;bottom:84px;max-width:none}}' +
      '</style>' +
      '<p></p><div class="wc-row"><button type="button" data-v="granted"></button><button type="button" data-v="denied"></button></div>' +
      '<a href="/polityka-prywatnosci#cookies"></a>';
    box.querySelector('p').textContent = t.body;
    box.querySelector('[data-v="granted"]').textContent = t.yes;
    box.querySelector('[data-v="denied"]').textContent = t.no;
    box.querySelector('a').textContent = t.more;
    box.addEventListener('click', function (ev) {
      var v = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-v');
      if (!v) return;
      write(v);
      hide();
      if (v === 'granted') loadPixel();
    });
    document.body.appendChild(box);
  }

  function start() {
    var v = read();
    if (v === 'granted') loadPixel();
    else if (v !== 'denied' && !pixelOff) show();
  }

  window.whispConsent = {
    // Forget the choice and ask again. After a withdrawal the pixel already on this page stops on the reload.
    reset: function () {
      var had = read() === 'granted';
      write(null);
      try {
        ['_fbp', '_fbc'].forEach(function (n) {
          document.cookie = n + '=; Max-Age=0; path=/';
          document.cookie = n + '=; Max-Age=0; path=/; domain=.' + location.hostname.replace(/^www\./, '');
        });
      } catch (e) {}
      if (had && window.fbq) { location.reload(); return; }
      show();
    },
  };

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
