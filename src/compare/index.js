/**
 * Сравнительный аудит: клиент против конкурентов.
 *
 * Тот же оркестратор, но по списку URL. Обход последовательный с паузой:
 * чужие сайты не нагружаем (это не наш инфраструктурный хост).
 *
 * Результат: единая таблица «метрика на сайт» + текстовые выводы
 * «где клиент проигрывает и на сколько».
 */
'use strict';

const { runFullAudit } = require('../audit');

const SECTION_LABELS = {
  performance: 'Производительность',
  seo: 'SEO',
  security: 'Безопасность',
  accessibility: 'Доступность',
  content: 'Контент',
};

const METRIC_ROWS = [
  { key: 'lcpMs', label: 'LCP', unit: ' мс', lowerIsBetter: true },
  { key: 'cls', label: 'CLS', unit: '', lowerIsBetter: true },
  { key: 'fcpMs', label: 'FCP', unit: ' мс', lowerIsBetter: true },
  { key: 'ttfbMs', label: 'TTFB', unit: ' мс', lowerIsBetter: true },
  { key: 'tbtMs', label: 'TBT', unit: ' мс', lowerIsBetter: true },
  { key: 'resources', label: 'Ресурсов', unit: ' шт', lowerIsBetter: true },
];

const DEFAULT_DELAY_MS = 3000;
const MAX_COMPETITORS = 5;

/** Короткая подпись сайта: host + первый путь. */
function labelFor(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return u.hostname.replace(/^www\./, '') + path;
  } catch {
    return String(url);
  }
}

/** Русское склонение: 1 балл, 2 балла, 5 баллов. */
function plural(count, one, few, many) {
  const n = Math.abs(Math.round(count));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function balls(count) {
  return count + ' ' + plural(count, 'балл', 'балла', 'баллов');
}

/**
 * Собрать сводку по одному сайту из результата аудита.
 * @param {string} url
 * @param {object} result — результат runFullAudit
 * @param {string} role — 'target' | 'competitor'
 */
function summarizeSite(url, result, role) {
  const sections = {};
  let total = 0;
  let counted = 0;
  for (const [name, sec] of Object.entries(result.scores || {})) {
    sections[name] = {
      label: SECTION_LABELS[name] || name,
      score: sec.score === null ? null : sec.score,
      status: sec.status,
      issues: Array.isArray(sec.issues) ? sec.issues.length : 0,
    };
    if (sec.score !== null && sec.score !== undefined) {
      total += sec.score;
      counted += 1;
    }
  }
  const perf = result.scores && result.scores.performance;
  const metrics = (perf && perf.raw && perf.raw.metrics) || {};
  return {
    url,
    label: labelFor(url),
    role,
    status: result.failedSections && result.failedSections.length ? 'partial' : 'ok',
    failedSections: result.failedSections || [],
    integralScore: result.integralScore,
    avgSectionScore: counted ? Math.round(total / counted) : null,
    sections,
    metrics,
    issueCount: Array.isArray(result.issues) ? result.issues.length : 0,
    topIssues: (result.issues || [])
      .slice()
      .sort((a, b) => {
        const order = { critical: 0, warning: 1, info: 2 };
        return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
      })
      .slice(0, 5),
  };
}

/**
 * Построить сравнительную таблицу и выводы.
 * @param {object[]} sites — сводки сайтов (первая — клиент)
 */
function buildComparison(sites) {
  const target = sites[0];
  const competitors = sites.slice(1);

  // Таблица по секциям
  const sectionRows = Object.keys(SECTION_LABELS).map((name) => {
    const values = {};
    let best = null;
    let bestUrl = null;
    for (const site of sites) {
      const value = site.sections[name] ? site.sections[name].score : null;
      values[site.url] = value;
      if (typeof value === 'number' && (best === null || value > best)) {
        best = value;
        bestUrl = site.url;
      }
    }
    const targetValue = values[target.url];
    const delta = typeof targetValue === 'number' && best !== null ? best - targetValue : null;
    return {
      key: name,
      label: SECTION_LABELS[name],
      values,
      best: bestUrl,
      bestValue: best,
      targetValue: targetValue === undefined ? null : targetValue,
      deltaToBest: delta,
    };
  });

  // Таблица по метрикам (меньше — лучше)
  const metricRows = METRIC_ROWS.map((row) => {
    const values = {};
    let best = null;
    let bestUrl = null;
    for (const site of sites) {
      const value = site.metrics ? site.metrics[row.key] : null;
      values[site.url] = value === undefined ? null : value;
      if (typeof value === 'number' && (best === null || (row.lowerIsBetter ? value < best : value > best))) {
        best = value;
        bestUrl = site.url;
      }
    }
    const targetValue = values[target.url];
    return {
      key: row.key,
      label: row.label,
      unit: row.unit,
      lowerIsBetter: row.lowerIsBetter,
      values,
      best: bestUrl,
      bestValue: best,
      targetValue: targetValue === undefined ? null : targetValue,
    };
  });

  // Текстовые выводы: где клиент проигрывает и на сколько
  const conclusions = [];
  const competitorAvg = competitors.length
    ? Math.round(competitors.reduce((s, c) => s + (c.avgSectionScore ?? 0), 0) / competitors.length)
    : null;

  if (competitors.length && typeof target.avgSectionScore === 'number' && competitorAvg !== null) {
    const diff = competitorAvg - target.avgSectionScore;
    if (diff > 0) {
      conclusions.push({
        severity: diff >= 20 ? 'critical' : 'warning',
        text: 'Средняя оценка по разделам: ваш сайт — ' + target.avgSectionScore + ' из 100, среднее по конкурентам — ' + competitorAvg + '. Отставание ' + balls(diff) + '.',
      });
    } else if (diff < 0) {
      conclusions.push({
        severity: 'info',
        text: 'Средняя оценка по разделам: ваш сайт — ' + target.avgSectionScore + ' из 100, среднее по конкурентам — ' + competitorAvg + '. Вы опережаете конкурентов на ' + balls(Math.abs(diff)) + '.',
      });
    } else {
      conclusions.push({
        severity: 'info',
        text: 'Средняя оценка по разделам одинакова с конкурентами: ' + target.avgSectionScore + ' из 100.',
      });
    }
  }

  for (const row of sectionRows) {
    if (typeof row.targetValue !== 'number' || row.bestValue === null) continue;
    const diff = row.bestValue - row.targetValue;
    if (diff > 0) {
      const bestSite = competitors.find((c) => c.url === row.best);
      conclusions.push({
        severity: diff >= 25 ? 'critical' : 'warning',
        text: row.label + ': ' + row.targetValue + ' из 100 против ' + row.bestValue + ' у лидера'
          + (bestSite ? ' (' + bestSite.label + ')' : '') + ' — отставание ' + balls(diff) + '.',
      });
    } else if (diff < 0) {
      conclusions.push({
        severity: 'info',
        text: row.label + ': ' + row.targetValue + ' из 100 — вы лучше лучшего конкурента на ' + balls(Math.abs(diff)) + '.',
      });
    }
  }

  for (const row of metricRows) {
    if (typeof row.targetValue !== 'number' || row.bestValue === null) continue;
    const diff = row.targetValue - row.bestValue;
    if (row.lowerIsBetter && diff > 0) {
      conclusions.push({
        severity: 'warning',
        text: row.label + ': ' + row.targetValue + row.unit + ' против ' + row.bestValue + row.unit + ' у лучшего конкурента — хуже на '
          + (Math.round(diff * 100) / 100) + row.unit + '.',
      });
    }
  }

  if (target.topIssues.length) {
    conclusions.push({
      severity: 'critical',
      text: 'Главные проблемы вашего сайта: ' + target.topIssues.slice(0, 3).map((i) => i.message).join('; ') + '.',
    });
  }

  return {
    sectionRows,
    metricRows,
    conclusions,
    competitorAvg,
  };
}

/**
 * Сравнить сайт клиента с конкурентами.
 *
 * @param {string} targetUrl
 * @param {string[]} competitorUrls
 * @param {object} [opts]
 * @param {number} [opts.delayMs=3000] — пауза между аудитами (нагрузка на чужие сайты)
 * @param {Function} [opts.logger]
 * @returns {Promise<object>}
 */
async function compareSites(targetUrl, competitorUrls, opts = {}) {
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : DEFAULT_DELAY_MS;
  const logger = opts.logger || (() => {});
  const competitors = (competitorUrls || [])
    .filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
    .slice(0, MAX_COMPETITORS);

  if (!/^https?:\/\//i.test(String(targetUrl))) {
    throw new Error('Некорректный URL цели: ' + targetUrl);
  }
  if (!competitors.length) {
    throw new Error('Не указаны конкуренты (--with <url1>,<url2>)');
  }

  const urls = [targetUrl, ...competitors];
  const sites = [];
  const errors = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const role = i === 0 ? 'target' : 'competitor';
    logger('аудит ' + (role === 'target' ? 'цели' : 'конкурента') + ': ' + url);
    try {
      const result = await runFullAudit(url, {
        timeout: opts.timeout || 60000,
        waitAfterLoad: opts.waitAfterLoad ?? 2500,
      });
      sites.push(summarizeSite(url, result, role));
    } catch (err) {
      errors.push({ url, error: String(err && err.message || err).slice(0, 200) });
      sites.push({
        url,
        label: labelFor(url),
        role,
        status: 'failed',
        failedSections: ['all'],
        integralScore: 0,
        avgSectionScore: null,
        sections: {},
        metrics: {},
        issueCount: 0,
        topIssues: [],
        error: String(err && err.message || err).slice(0, 200),
      });
    }

    // Пауза между аудитами: чужие сайты не нагружаем.
    if (i < urls.length - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const comparison = buildComparison(sites);
  return {
    schemaVersion: 2,
    tool: 'owa',
    type: 'compare',
    createdAt: new Date().toISOString(),
    target: sites[0],
    competitors: sites.slice(1),
    sites,
    errors,
    sectionRows: comparison.sectionRows,
    metricRows: comparison.metricRows,
    conclusions: comparison.conclusions,
    competitorAvg: comparison.competitorAvg,
  };
}

module.exports = { compareSites, buildComparison, summarizeSite, labelFor, balls, SECTION_LABELS };