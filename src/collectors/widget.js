/**
 * Пользовательские метрики: время до появления заданного селектора (виджет, чат, таблица).
 * Ставится ДО навигации, чтобы поймать даже быстрое появление элемента.
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
  collectScript: `window.__owaWidgetResults || {}`,
};
