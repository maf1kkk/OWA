/**
 * Diff-режим: сравнение текущего отчёта с baseline (JSON, сохранённый через
 * --out или POST /api/analyze). Для порогового вывода регрессий.
 *
 * Метрики берутся из metrics (legacyTiming, vitals, resources, longTasks,
 * jsErrors). Регрессия — если метрика стала ХУЖЕ на threshold или более.
 * Exit-код: 0 — нет регрессий, 1 — есть.
 */
'use strict';

const METRICS = [
  // [ключ в baseline.metrics, доступ к текущему отчёту, инверсия (меньше=лучше)]
  ['loadMs', (m) => m.legacyTiming ? m.legacyTiming.loadTime : null, true],
  ['domContentLoadedMs', (m) => m.legacyTiming ? m.legacyTiming.domContentLoaded : null, true],
  ['fcpMs', (m) => m.paint && m.paint.firstContentfulPaint !== null ? Math.round(m.paint.firstContentfulPaint) : null, true],
  ['lcpMs', (m) => m.vitals ? m.vitals.lcpMs : null, true],
  ['cls', (m) => m.vitals ? m.vitals.cls : null, true],
  ['ttfbMs', (m) => m.navigation ? Math.round(m.navigation.ttfb) : null, true],
  ['resources', (m) => m.resources ? m.resources.count : null, true],
  ['longTasks', (m) => m.longTasks ? m.longTasks.count : null, true],
  ['tbtMs', (m) => m.longTasks ? Math.round(m.longTasks.totalBlockingTime) : null, true],
  ['jsErrors', (m) => Array.isArray(m.jsErrors) ? m.jsErrors.length : 0, true],
];

const LABELS = {
  loadMs: 'Load',
  domContentLoadedMs: 'DOM Ready',
  fcpMs: 'FCP',
  lcpMs: 'LCP',
  cls: 'CLS',
  ttfbMs: 'TTFB',
  resources: 'Resources',
  longTasks: 'Long tasks',
  tbtMs: 'TBT',
  jsErrors: 'JS errors',
};

/**
 * @param {object} current — полный отчёт OWA (с metrics)
 * @param {object} baseline — ранее сохранённый отчёт (с metrics или keyMetrics)
 * @param {number} [thresholdPct=5] — порог регрессии в %
 * @returns {{rows: Array<{metric, baseline, current, delta, pct, regression, status}>, regressions: number}}
 */
function diffWithBaseline(current, baseline, thresholdPct = 5) {
  const rows = [];
  let regressions = 0;

  // Поддерживаем два формата baseline: полный отчёт (с metrics) и компактный (keyMetrics)
  const hasMetrics = baseline && baseline.metrics;
  const baseObj = hasMetrics ? null : (baseline && baseline.keyMetrics) || baseline || {};

  for (const [key, accessor, _invert] of METRICS) {
    const cur = accessor(current.metrics || {});
    const base = hasMetrics ? accessor(baseline.metrics) : baseObj[key];

    if (cur === null || cur === undefined) {
      rows.push({ metric: LABELS[key], baseline: base, current: null, delta: null, pct: null, regression: false, status: 'no-data' });
      continue;
    }
    if (base === null || base === undefined) {
      rows.push({ metric: LABELS[key], baseline: null, current: cur, delta: null, pct: null, regression: false, status: 'new' });
      continue;
    }

    const delta = cur - base;
    const pct = base !== 0 ? Math.round((delta / base) * 1000) / 10 : null;
    // Регрессия: метрика стала хуже (больше, т.к. меньше=лучше) на threshold% или более
    const regression = delta > 0 && Math.abs(delta / base) * 100 >= thresholdPct;
    if (regression) regressions += 1;
    rows.push({
      metric: LABELS[key],
      baseline: base,
      current: cur,
      delta,
      pct,
      regression,
      status: regression ? 'regression' : delta === 0 ? 'same' : 'improved',
    });
  }

  return { rows, regressions };
}

/** Форматировать строку таблицы diff. */
function formatDiffLine(row) {
  const val = (v, unit = '') => v === null || v === undefined ? '—' : `${v}${unit}`;
  const deltaStr = row.delta === null ? '—' : `${row.delta > 0 ? '+' : ''}${row.delta}${row.metric === 'CLS' ? '' : ' ms'}`;
  const pctStr = row.pct === null ? '' : ` (${row.delta >= 0 ? '+' : ''}${row.pct}%)`;
  const mark = row.regression ? '  ✗' : row.status === 'improved' ? ' ✓' : '';
  return `${row.metric.padEnd(14)} ${val(row.baseline, ' ms').padStart(12)}  ${val(row.current, ' ms').padStart(12)}  ${deltaStr}${pctStr}${mark}`;
}

/**
 * Вывести таблицу diff в консоль (человекочитаемый вид).
 * @returns {number} сколько регрессий
 */
function printDiff(result, { thresholdPct = 5 } = {}) {
  console.log('\n■ Diff с baseline (порог регрессии: ' + thresholdPct + '%)');
  console.log('Metric          Baseline      Current     Δ');
  for (const row of result.rows) {
    console.log('  ' + formatDiffLine(row));
  }
  console.log('');
  if (result.regressions === 0) {
    console.log('Нет регрессий — все метрики в норме или улучшились.');
  } else {
    console.log(`Регрессий: ${result.regressions} — метрики стали хуже на ≥${thresholdPct}%`);
  }
  return result.regressions;
}

module.exports = { diffWithBaseline, printDiff, formatDiffLine, METRICS, LABELS };
