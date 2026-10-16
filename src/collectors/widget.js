/**
 * Пользовательские метрики: время до появления заданного селектора (виджет, чат, таблица).
 *
 * Два режима:
 *  - initScript: точный замер ЯВНЫХ селекторов — ставится ДО навигации,
 *    ловит появление с первого poll (200 мс).
 *  - autoPollScript: best-effort опрос АВТО-ДЕТЕКТНЫХ селекторов — запускается
 *    сразу после load; момент появления = момент обнаружения (приближение).
 */
module.exports = {
  initScript: (selectors) => `
    window.__owaWidgetStart = performance.timeOrigin;
    window.__owaWidgetResults = {};
    window.__owaWidgetSelectors = ${JSON.stringify(selectors)};
    (function poll() {
      for (const sel of window.__owaWidgetSelectors) {
        if (window.__owaWidgetResults[sel] !== undefined) continue;
        try {
          if (document.querySelector(sel)) {
            window.__owaWidgetResults[sel] = Math.round(performance.now());
          }
        } catch (e) {
          window.__owaWidgetResults[sel] = null;
        }
      }
      const pending = window.__owaWidgetSelectors.some((s) => window.__owaWidgetResults[s] === undefined);
      if (pending) setTimeout(poll, 200);
    })();
  `,
  autoPollScript: (selectors) => `
    (function () {
      const sels = ${JSON.stringify(selectors)};
      window.__owaWidgetAutoResults = window.__owaWidgetAutoResults || {};
      const results = window.__owaWidgetAutoResults;
      function check() {
        for (const sel of sels) {
          if (results[sel] !== undefined) continue;
          try {
            if (document.querySelector(sel)) results[sel] = Math.round(performance.now());
          } catch (e) {
            results[sel] = null;
          }
        }
      }
      check();
      const timer = setInterval(function () {
        check();
        if (sels.every(function (s) { return results[s] !== undefined; })) clearInterval(timer);
      }, 200);
    })()
  `,
  collectScript: `window.__owaWidgetResults || {}`,
  collectAutoScript: `window.__owaWidgetAutoResults || {}`,
};
