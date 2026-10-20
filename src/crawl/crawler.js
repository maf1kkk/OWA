/**
 * Краулер сайта: очередь внутренних ссылок, ограничение доменом и глубины.
 *
 * Каждая страница проходит облегчённый аудит (Performance, SEO, Accessibility) —
 * Security и Content пропускаются ради экономии ресурсов.
 *
 * Скорость: страницы обрабатываются ПАРАЛЛЕЛЬНО пулом воркеров (по умолч. 3
 * одновременно) вместо строгой последовательности. Один браузер на весь обход,
 * но отдельный контекст на страницу (чистое состояние). Очередь пополняется
 * динамически: воркер, закончивший страницу, сразу берёт следующую.
 *
 * Вежливость к чужому сайту: пауза между запросами (delayMs) и ограничение
 * параллелизма. Для своего стенда их можно выставить в 0.
 */
'use strict';

const { launchBrowser } = require('../browser');
const { AuditSession } = require('../audit/session');
const { PerformanceSection, SeoSection, AccessibilitySection } = require('../audit/sections');
const { loadRobots, isAllowed } = require('./robots');

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_WAIT_MS = 700;
const DEFAULT_DELAY_MS = 200;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Обойти сайт и проаудитировать страницы.
 *
 * @param {string} startUrl
 * @param {object} [opts]
 * @param {number} [opts.maxPages=10]
 * @param {number} [opts.maxDepth=2]
 * @param {number} [opts.delayMs=200] — пауза между страницами (вежливость)
 * @param {number} [opts.concurrency=3] — сколько страниц одновременно
 * @param {number} [opts.waitAfterLoad=700] — ожидание после load на странице
 * @param {number} [opts.pageTimeoutMs=30000] — предел на одну страницу
 * @param {boolean} [opts.respectRobots=true]
 * @param {string[]} [opts.seedUrls] — дополнительные стартовые URL (режим sitemap)
 * @param {Function} [opts.logger]
 * @returns {Promise<object>} отчёт по сайту
 */
async function crawlSite(startUrl, opts = {}) {
  const maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages : 10;
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 2;
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : DEFAULT_DELAY_MS;
  const concurrency = Math.max(1, Number.isFinite(opts.concurrency) ? opts.concurrency : DEFAULT_CONCURRENCY);
  const waitAfterLoad = Number.isFinite(opts.waitAfterLoad) ? opts.waitAfterLoad : DEFAULT_WAIT_MS;
  const pageTimeoutMs = Number.isFinite(opts.pageTimeoutMs) ? opts.pageTimeoutMs : 30000;
  const maxDurationMs = Number.isFinite(opts.maxDurationMs) ? opts.maxDurationMs : 5 * 60 * 1000;
  const respectRobots = opts.respectRobots !== false;
  const logger = opts.logger || (() => {});

  const start = normalizeUrl(startUrl);
  if (!start) throw new Error('Некорректный стартовый URL: ' + startUrl);
  const startHost = new URL(start).hostname;

  const robots = respectRobots ? await loadRobots(start) : { parser: null, exists: false };

  const seen = new Set([start]);
  const pending = [{ url: start, depth: 0 }];
  for (const seed of opts.seedUrls || []) {
    const norm = normalizeUrl(seed);
    if (norm && sameHost(norm, startHost) && !seen.has(norm)) {
      seen.add(norm);
      pending.push({ url: norm, depth: 0 });
    }
  }

  const pages = [];
  const skipped = [];
  const browser = await launchBrowser(true);
  const performanceSection = new PerformanceSection();
  const seoSection = new SeoSection();
  const a11ySection = new AccessibilitySection();
  let cursor = 0;
  let busy = 0;

  /** Обработать одну страницу: открыть, собрать ссылки, провести облегчённый аудит. */
  async function processPage(item) {
    const { url, depth } = item;

    if (respectRobots && !isAllowed(robots, url)) {
      skipped.push({ url, reason: 'robots.txt disallow' });
      return [];
    }

    logger('аудит: ' + url);
    const startedAt = Date.now();
    let session = null;
    try {
      session = new AuditSession({
        url,
        timeout: pageTimeoutMs,
        waitAfterLoad,
        browser, // один браузер на весь обход
        // Для обхода не ждём полной загрузки всех ресурсов: берём ответ
        // сервера сразу, дальше ограниченно ждём DOM. Страница с зависшим
        // ресурсом не блокирует обход.
        waitUntil: opts.waitUntil || 'commit',
        domTimeoutMs: opts.domTimeoutMs || 8000,
      });
      await session.start();

      const context = { session, options: { checkLinks: false } };
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

      // Ссылки — только если есть куда идти дальше.
      if (depth >= maxDepth) return [];
      const links = await session.page.evaluate(() =>
        [...document.querySelectorAll('a[href]')]
          .map((a) => a.getAttribute('href'))
          .filter((h) => h && !h.startsWith('#') && !h.startsWith('javascript:') && !h.startsWith('mailto:'))
      );
      const next = [];
      for (const href of links) {
        const norm = normalizeUrl(href, url);
        if (!norm || !sameHost(norm, startHost) || seen.has(norm)) continue;
        seen.add(norm);
        next.push({ url: norm, depth: depth + 1 });
      }
      return next;
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
      return [];
    } finally {
      if (session) await session.close();
      logger('  готово: ' + url + ' за ' + (Date.now() - startedAt) + ' мс');
    }
  }

  try {
    // Пул воркеров: каждый берёт следующую страницу из общей очереди.
    // Очередь пополняется на ходу (ссылки найденной страницы), поэтому
    // воркеров всегда concurrency, даже если на старте в очереди одна страница.
    //
    // Выход: очередь пуста И никто не обрабатывает страницу (busy === 0) —
    // тогда новых ссылок уже не появится. Иначе ждём: страница в работе
    // может найти ещё ссылки.
    const deadline = Date.now() + maxDurationMs;
    let cursor = 0;
    let busy = 0;
    async function worker() {
      for (;;) {
        if (pages.length >= maxPages) return;
        if (Date.now() > deadline) return;
        if (cursor >= pending.length) {
          if (busy === 0) return; // очередь пуста и никто не в работе
          await sleep(25);
          continue;
        }
        const item = pending[cursor++];
        busy += 1;
        try {
          const links = await processPage(item);
          if (links.length) pending.push(...links);
        } finally {
          busy -= 1;
        }
        if (delayMs > 0) await sleep(delayMs);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    await browser.close().catch(() => {});
  }

  pages.sort((a, b) => a.url.localeCompare(b.url));

  return {
    schemaVersion: 2,
    tool: 'owa',
    type: 'crawl',
    startUrl: start,
    crawledAt: new Date().toISOString(),
    pages,
    skipped,
    queued: pending.length - cursor,
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

module.exports = { crawlSite, aggregate, normalizeUrl, sameHost, DEFAULT_CONCURRENCY, DEFAULT_WAIT_MS };
