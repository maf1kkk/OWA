/**
 * Дополнительные метрики: CLS, LCP, FPS, память, JS-ошибки.
 */
module.exports = {
  initScript: `
    window.__owaVitals = { lcp: null, cls: 0, clsEntries: [] };
    try {
      new PerformanceObserver((l) => {
        const es = l.getEntries();
        if (es.length) window.__owaVitals.lcp = Math.round(es[es.length - 1].startTime);
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) {}
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (!e.hadRecentInput) {
            window.__owaVitals.cls += e.value;
            window.__owaVitals.clsEntries.push({ value: Math.round(e.value * 10000) / 10000, startTime: Math.round(e.startTime) });
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}
    window.__owaJsErrors = [];
    window.addEventListener('error', (e) => {
      window.__owaJsErrors.push({ message: e.message, source: e.filename, line: e.lineno });
    });
  `,
  collectScript: `(() => ({
    vitals: window.__owaVitals || {},
    jsErrors: window.__owaJsErrors || [],
    memory: performance.memory
      ? {
          usedJSHeapSizeMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
          totalJSHeapSizeMB: Math.round(performance.memory.totalJSHeapSize / 1048576),
          jsHeapSizeLimitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
        }
      : null,
  }))()`,
};
