/**
 * Краулер сайта: очередь внутренних ссылок, ограничение доменом и глубины.
 *
 * Каждая страница проходит облегчённый аудит (Performance, SEO, Accessibility) —
 * Security и Content пропускаются ради экономии ресурсов (в коммерческом
 * сценарии «аудит сайта» они идут по умолчанию).
 *
 * Один браузер на весь обход: страницы открываются последовательно
 * (конкурентность к чужому сайту — 1 по умолчанию) с паузой между запросами.
 */
'use strict';

const { launchBrowser } = require('../browser');
const { AuditSession } = require('../audit/session');
const { PerformanceSection, SeoSection, AccessibilitySection } = require('../audit/sections');
const { loadRobots, isAllowed } = require('./robots');

/** Нормализовать URL: убрать хэш, привести схему/хост к нижнему регистру. */
function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    u.hash = '';
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hostname = u.hostname.toLowerCase();
    // Нормализация слэша в конце: /a/ и /a — одна страница.
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return null;
  }
}

/** Тот же домен (регистронезависимо), что и у стартового URL. */
function sameHost(url, startHost) {
  try {
    return new URL(url).hostname.toLowerCase() === startHost.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Обойти сайт и проаудитировать страницы.
 *
 * @param {string} startUrl
 * @param {object} [opts]
 * @param {number} [opts.maxPages=10]
 * @param {number} [opts.maxDepth=2]
 * @param {number} [opts.delayMs=300] — пауза между страницами
 * @param {boolean} [opts.respectRobots=true]
 * @param {string[]} [opts.seedUrls] — дополнительные стартовые URL (для режима sitemap)
 * @param {Function} [opts.logger]
 * @returns {Promise<object>} отчёт по сайту
 */
async function crawlSite(startUrl, opts = {}) {
  const maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages : 10;
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 2;
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 300;
  const respectRobots = opts.respectRobots !== false;
  const logger = opts.logger || (() => {});

  const start = normalizeUrl(startUrl);
  if (!start) throw new Error('Некорректный стартовый URL: ' + startUrl);
  const startHost = new URL(start).hostname;

  const robots = respectRobots ? await loadRobots(start) : { parser: null, exists: false };

  const seen = new Set([start]);
  const queue = [{ url: start, depth: 0 }];
  for (const seed of opts.seedUrls || []) {
    const norm = normalizeUrl(seed);
    if (norm && sameHost(norm, startHost) && !seen.has(norm)) {
      seen.add(norm);
      queue.push({ url: norm, depth: 0 });
    }
  }

  const pages = [];
  const skipped = [];
  const browser = await launchBrowser(true);
  const performanceSection = new PerformanceSection();
  const seoSection = new SeoSection();
  const a11ySection = new AccessibilitySection();

  try {
    while (queue.length && pages.length < maxPages) {
      const { url, depth } = queue.shift();

      if (respectRobots && !isAllowed(robots, url)) {
        skipped.push({ url, reason: 'robots.txt disallow' });
        continue;
      }

      logger('аудит: ' + url);
      let session = null;
      try {
        session = new AuditSession({ url, timeout: opts.timeout || 60000, waitAfterLoad: opts.waitAfterLoad || 1500 });
        // Браузер переиспользуем: один на весь обход.
        session.browser = browser;
        session.ownBrowser = false;
        await session.start();

        const context = { session };
        const [perf, seo, a11y] = await Promise.all([
          performanceSection.run(url, context),
          seoSection.run(url, context),
          a11ySection.run(url, context),
        ]);

        const score = Math.round((perf.score + seo.score + a11y.score) / 3);
        pages.push({
          url,
          depth,
          status: 'ok',
          score,
          scores: { performance: perf.score, seo: seo.score, accessibility: a11y.score },
          issues: [...perf.issues, ...seo.issues, ...a11y.issues],
          metrics: perf.raw && perf.raw.metrics ? perf.raw.metrics : {},
        });

        // Собираем внутренние ссылки для следующего уровня.
        if (depth < maxDepth) {
          const links = await session.page.evaluate(() =>
            [...document.querySelectorAll('a[href]')]
              .map((a) => a.getAttribute('href'))
              .filter((h) => h && !h.startsWith('#') && !h.startsWith('javascript:') && !h.startsWith('mailto:'))
          );
          for (const href of links) {
            const norm = normalizeUrl(href, url);
            if (!norm) continue;
            if (!sameHost(norm, startHost)) continue;
            if (seen.has(norm)) continue;
            seen.add(norm);
            queue.push({ url: norm, depth: depth + 1 });
          }
        }
      } catch (err) {
        pages.push({
          url,
          depth,
          status: 'failed',
          score: null,
          scores: { performance: null, seo: null, accessibility: null },
          issues: [],
          metrics: {},
          error: String(err && err.message || err).slice(0, 200),
        });
      } finally {
        if (session) await session.close();
      }

      if (delayMs > 0 && pages.length < maxPages) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return {
    schemaVersion: 2,
    tool: 'owa',
    type: 'crawl',
    startUrl: start,
    crawledAt: new Date().toISOString(),
    pages,
    skipped,
    queued: queue.length,
    aggregate: aggregate(pages),
  };
}

/**
 * Агрегаты по сайту: средние метрики, топ проблем по частоте, худшие страницы.
 * @param {Array} pages
 */
function aggregate(pages) {
  const ok = pages.filter((p) => p.status === 'ok' && typeof p.score === 'number');
  const avg = (fn) => {
    const values = ok.map(fn).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (!values.length) return null;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  };

  // Топ проблем по частоте: сколько страниц затронуто.
  const byRule = new Map();
  for (const page of ok) {
    for (const issue of page.issues || []) {
      const key = issue.rule || issue.id;
      const entry = byRule.get(key) || { rule: key, severity: issue.severity, count: 0, pages: [] };
      entry.count += 1;
      if (entry.pages.length < 10) entry.pages.push(page.url);
      if (entry.severity !== 'critical' && issue.severity === 'critical') entry.severity = 'critical';
      byRule.set(key, entry);
    }
  }
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  const topIssues = [...byRule.values()]
    .sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3) || b.count - a.count)
    .slice(0, 15);

  const worstPages = [...ok]
    .sort((a, b) => a.score - b.score)
    .slice(0, 10)
    .map((p) => ({ url: p.url, score: p.score }));

  return {
    pageCount: pages.length,
    okCount: ok.length,
    failedCount: pages.length - ok.length,
    avgScore: avg((p) => p.score),
    avgMetrics: {
      lcpMs: avg((p) => p.metrics && p.metrics.lcpMs),
      cls: avg((p) => p.metrics && p.metrics.cls),
      fcpMs: avg((p) => p.metrics && p.metrics.fcpMs),
      ttfbMs: avg((p) => p.metrics && p.metrics.ttfbMs),
      tbtMs: avg((p) => p.metrics && p.metrics.tbtMs),
      resources: avg((p) => p.metrics && p.metrics.resources),
    },
    topIssues,
    worstPages,
  };
}

module.exports = { crawlSite, aggregate, normalizeUrl, sameHost };