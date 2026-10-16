/**
 * Тесты diff-режима: сравнение текущего отчёта с baseline.
 *
 * Метрики берутся из metrics (legacyTiming, vitals, resources, longTasks,
 * jsErrors). Регрессия — если метрика стала хуже на threshold или более.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diffWithBaseline, formatDiffLine } = require('../src/diff');

/** Минимальный отчёт OWA с нужными метриками. */
function makeReport(overrides = {}) {
  return {
    schemaVersion: 1,
    tool: 'owa',
    meta: { url: 'https://example.com', analyzedAt: new Date().toISOString() },
    metrics: {
      legacyTiming: { loadTime: 3200, domContentLoaded: 1500 },
      navigation: { ttfb: 200, domInteractive: 1000, domComplete: 3000 },
      paint: { firstPaint: 800, firstContentfulPaint: 1200 },
      vitals: { lcpMs: 2400, cls: 0.05 },
      resources: { count: 40, byType: {}, top10Slowest: [], top5Heaviest: [] },
      longTasks: { supported: true, count: 3, maxDuration: 120, totalBlockingTime: 80, tasks: [] },
      jsErrors: [],
      memory: null,
      customWidgets: { results: {} },
    },
    interpretation: { summary: { status: 'good', score: 100, headline: 'ok' }, findings: [] },
    ...overrides,
  };
}

test('diff: метрики улучшились — нет регрессий', () => {
  const baseline = makeReport();
  const current = makeReport();
  // Улучшение: loadTime 3200 -> 2800, lcpMs 2400 -> 2000, longTasks 3 -> 1
  current.metrics.legacyTiming.loadTime = 2800;
  current.metrics.vitals.lcpMs = 2000;
  current.metrics.longTasks.count = 1;

  const res = diffWithBaseline(current, baseline, 5);
  assert.strictEqual(res.regressions, 0, 'нет регрессий при улучшении');
  // Проверим конкретные строки
  const loadRow = res.rows.find((r) => r.metric === 'Load');
  assert.strictEqual(loadRow.baseline, 3200);
  assert.strictEqual(loadRow.current, 2800);
  assert.strictEqual(loadRow.delta, -400);
  assert.strictEqual(loadRow.status, 'improved');
  assert.strictEqual(loadRow.regression, false);
});

test('diff: метрика ухудшилась на 10% — регрессия', () => {
  const baseline = makeReport();
  const current = makeReport();
  // Ухудшение: loadTime 3200 -> 3520 (+10%)
  current.metrics.legacyTiming.loadTime = 3520;

  const res = diffWithBaseline(current, baseline, 5);
  assert.strictEqual(res.regressions, 1, 'одна регрессия (loadTime)');
  const loadRow = res.rows.find((r) => r.metric === 'Load');
  assert.strictEqual(loadRow.regression, true);
  assert.strictEqual(loadRow.status, 'regression');
  assert.strictEqual(loadRow.delta, 320);
  assert.strictEqual(loadRow.pct, 10);
});

test('diff: порог threshold — ухудшение на 3% при пороге 5% не регрессия', () => {
  const baseline = makeReport();
  const current = makeReport();
  // loadTime 3200 -> 3296 (+3%)
  current.metrics.legacyTiming.loadTime = 3296;

  const res = diffWithBaseline(current, baseline, 5);
  assert.strictEqual(res.regressions, 0, '+3% < порога 5% — не регрессия');

  const res2 = diffWithBaseline(current, baseline, 2);
  assert.strictEqual(res2.regressions, 1, '+3% >= порога 2% — регрессия');
});

test('diff: несколько регрессий подсчитываются', () => {
  const baseline = makeReport();
  const current = makeReport();
  // Ухудшение: loadTime +20%, lcpMs +15%, longTasks +2
  current.metrics.legacyTiming.loadTime = 3840;   // +20%
  current.metrics.vitals.lcpMs = 2760;            // +15%
  current.metrics.longTasks.count = 5;            // +2

  const res = diffWithBaseline(current, baseline, 5);
  assert.strictEqual(res.regressions, 3, 'три регрессии');
});

test('diff: null в baseline — статус new, не регрессия', () => {
  const baseline = makeReport();
  delete baseline.metrics.legacyTiming; // baseline без legacyTiming
  const current = makeReport();

  const res = diffWithBaseline(current, baseline, 5);
  const loadRow = res.rows.find((r) => r.metric === 'Load');
  assert.strictEqual(loadRow.baseline, null);
  assert.strictEqual(loadRow.status, 'new');
  assert.strictEqual(loadRow.regression, false);
});

test('diff: форматирование строки таблицы', () => {
  const row = {
    metric: 'Load',
    baseline: 3200,
    current: 2800,
    delta: -400,
    pct: -12.5,
    regression: false,
    status: 'improved',
  };
  const line = formatDiffLine(row);
  assert.ok(line.includes('Load'), 'имя метрики на месте');
  assert.ok(line.includes('3200'), 'baseline');
  assert.ok(line.includes('2800'), 'current');
  assert.ok(line.includes('-400'), 'delta');
  assert.ok(line.includes('✓'), 'маркер улучшения');
});

test('diff: компактный baseline (keyMetrics) тоже работает', () => {
  const baseline = {
    schemaVersion: 1,
    url: 'https://example.com',
    keyMetrics: {
      loadMs: 3200,
      lcpMs: 2400,
      longTasks: 3,
      jsErrors: 0,
    },
  };
  const current = makeReport();
  current.metrics.legacyTiming.loadTime = 3840; // +20%

  const res = diffWithBaseline(current, baseline, 5);
  const loadRow = res.rows.find((r) => r.metric === 'Load');
  assert.strictEqual(loadRow.baseline, 3200);
  assert.strictEqual(loadRow.regression, true);
  assert.strictEqual(res.regressions, 1);
});
