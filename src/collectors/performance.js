/**
 * Сбор метрик Performance API.
 * Выполняется в контексте страницы (page.evaluate).
 */

function collect() {
  const nav = performance.getEntriesByType('navigation')[0] || null;
  const paint = performance.getEntriesByType('paint');
  const timing = performance.timing; // deprecated, но нужен для лабораторной

  const legacy = timing
    ? {
        loadTime: timing.loadEventEnd - timing.navigationStart,
        domContentLoaded: timing.domContentLoadedEventEnd - timing.navigationStart,
      }
    : null;

  const fcp = paint.find((e) => e.name === 'first-contentful-paint');
  const resources = performance.getEntriesByType('resource');
  const byType = {};
  for (const r of resources) {
    const t = r.initiatorType || 'other';
    (byType[t] = byType[t] || { count: 0, totalDuration: 0, totalTransferSize: 0, totalDecodedBodySize: 0 });
    byType[t].count++;
    byType[t].totalDuration += r.duration;
    byType[t].totalTransferSize += r.transferSize || 0;
    byType[t].totalDecodedBodySize += r.decodedBodySize || 0;
  }

  return {
    legacy,
    navigation: nav
      ? {
          type: nav.type,
          redirectCount: nav.redirectCount,
          // фазы, мс от navigationStart
          dns: nav.domainLookupEnd - nav.domainLookupStart,
          tcp: nav.connectEnd - nav.connectStart,
          ssl: nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0,
          ttfb: nav.responseStart - nav.requestStart,
          responseDownload: nav.responseEnd - nav.responseStart,
          domInteractive: nav.domInteractive,
          domContentLoaded: nav.domContentLoadedEventEnd,
          domComplete: nav.domComplete,
          loadEvent: nav.loadEventEnd,
          transferSize: nav.transferSize,
          encodedBodySize: nav.encodedBodySize,
          decodedBodySize: nav.decodedBodySize,
        }
      : null,
    paint: {
      firstPaint: (paint.find((e) => e.name === 'first-paint') || {}).startTime || null,
      firstContentfulPaint: fcp ? fcp.startTime : null,
    },
    resources: {
      count: resources.length,
      byType,
      top10Slowest: resources
        .slice()
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 10)
        .map((r) => ({
          name: r.name,
          type: r.initiatorType,
          duration: Math.round(r.duration),
          size: r.transferSize || 0,
        })),
      top5Heaviest: resources
        .slice()
        .sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
        .slice(0, 5)
        .map((r) => ({
          name: r.name,
          type: r.initiatorType,
          size: r.transferSize || 0,
          duration: Math.round(r.duration),
        })),
    },
  };
}

module.exports = { collectScript: `(${collect.toString()})()` };
