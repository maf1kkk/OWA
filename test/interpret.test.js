const test = require('node:test');
const assert = require('node:assert');

const { buildFindings, buildSummary, buildCompact, rule } = require('../src/interpret');

// Фикстура: «идеальный» сайт
const idealMetrics = {
  legacyTiming: { loadTime: 1200, domContentLoaded: 800 },
  navigation: { ttfb: 200, dns: 20, tcp: 40, ssl: 30 },
  paint: { firstPaint: 500, firstContentfulPaint: 900 },
  vitals: { lcpMs: 1500, cls: 0.02 },
  resources: { count: 30, byType: {}, top10Slowest: [], top5Heaviest: [] },
  longTasks: { supported: true, count: 0, maxDuration: 0, totalBlockingTime: 0, tasks: [] },
  customWidgets: { note: '', autoDetectedSelectors: [], results: { '#chat': 600 } },
  jsErrors: [],
  memory: null,
};

test('rule: хорошее значение -> good без рекомендации', () => {
  const f = rule('load', 'Полная загрузка', 1500, 'мс', 2000, 5000);
  assert.strictEqual(f.verdict, 'good');
  assert.strictEqual(f.recommendation, undefined);
});

test('rule: среднее значение -> warn с рекомендацией', () => {
  const f = rule('load', 'Полная загрузка', 3500, 'мс', 2000, 5000);
  assert.strictEqual(f.verdict, 'warn');
  assert.ok(f.recommendation && f.recommendation.length > 10);
});

test('rule: плохое значение -> bad с рекомендацией', () => {
  const f = rule('load', 'Полная загрузка', 9000, 'мс', 2000, 5000);
  assert.strictEqual(f.verdict, 'bad');
  assert.ok(f.recommendation);
});

test('rule: null/undefined -> info, не падает', () => {
  const f1 = rule('load', 'Полная загрузка', null, 'мс', 2000, 5000);
  const f2 = rule('load', 'Полная загрузка', undefined, 'мс', 2000, 5000);
  assert.strictEqual(f1.verdict, 'info');
  assert.strictEqual(f2.verdict, 'info');
  assert.strictEqual(f1.value, null);
});

test('rule: invert-режим (count-метрика: больше порога = хуже)', () => {
  // invert=true означает "больше — лучше" (например, для особых шкал).
  // Для count-метрик "меньше — лучше" используется прямая шкала:
  assert.strictEqual(rule('x', 'X', 0, 'шт', 1, 5).verdict, 'good');
  assert.strictEqual(rule('x', 'X', 3, 'шт', 1, 5).verdict, 'warn');
  assert.strictEqual(rule('x', 'X', 10, 'шт', 1, 5).verdict, 'bad');
});

test('buildFindings: на идеальных метриках нет bad', () => {
  const findings = buildFindings(idealMetrics);
  assert.ok(findings.length > 5);
  assert.ok(!findings.some((f) => f.verdict === 'bad'), JSON.stringify(findings));
});

test('buildFindings: не падает на пустых/битых метриках', () => {
  assert.doesNotThrow(() => buildFindings({}));
  assert.doesNotThrow(() => buildFindings(null));
  assert.doesNotThrow(() => buildFindings(undefined));
  assert.doesNotThrow(() => buildFindings({ legacyTiming: null, navigation: null, vitals: null }));
});

test('buildFindings: долгие задачи и ошибки помечаются bad', () => {
  const metrics = {
    ...idealMetrics,
    longTasks: { supported: true, count: 8, maxDuration: 500, totalBlockingTime: 900, tasks: [] },
    jsErrors: [{ message: 'TypeError: x is undefined', source: 'app.js', line: 1 }],
  };
  const findings = buildFindings(metrics);
  assert.ok(findings.some((f) => f.id === 'longTasks' && f.verdict === 'bad'));
  assert.ok(findings.some((f) => f.id === 'jsErrors' && f.verdict === 'bad'));
});

test('buildFindings: несуществующие виджеты -> info с рекомендацией', () => {
  const metrics = {
    ...idealMetrics,
    customWidgets: { note: '', autoDetectedSelectors: [], results: { '#a': null, '#b': null } },
  };
  const findings = buildFindings(metrics);
  const w = findings.find((f) => f.id === 'widgets');
  assert.strictEqual(w.verdict, 'info');
  assert.ok(w.recommendation);
});

test('buildSummary: статусы good/warn/bad и оценка 0..100', () => {
  const good = buildSummary(buildFindings(idealMetrics));
  assert.strictEqual(good.status, 'good');
  assert.strictEqual(good.score, 100);

  const badMetrics = { ...idealMetrics, jsErrors: [{ message: 'e', source: '', line: 0 }] };
  const bad = buildSummary(buildFindings(badMetrics));
  assert.strictEqual(bad.status, 'bad');
  assert.ok(bad.score >= 0 && bad.score < 100);
  assert.ok(bad.headline.includes('JS-ошибки'));
});

test('buildSummary: не падает на пустых findings', () => {
  const s = buildSummary([]);
  assert.strictEqual(s.status, 'good');
  assert.strictEqual(s.score, 100);
});

test('buildCompact: стабильная схема и отсутствие сырых массивов', () => {
  const data = {
    schemaVersion: 1,
    tool: 'owa',
    meta: { url: 'https://test.local', analyzedAt: '2026-01-01T00:00:00Z' },
    metrics: idealMetrics,
  };
  const c = buildCompact(data);
  assert.strictEqual(c.schemaVersion, 1);
  assert.strictEqual(c.tool, 'owa');
  assert.ok(c.summary && c.summary.status);
  assert.ok(Array.isArray(c.findings) && c.findings.length > 0);
  for (const f of c.findings) {
    assert.ok(f.id && f.verdict && f.message);
  }
  assert.strictEqual(typeof c.keyMetrics.loadMs, 'number');
  // Токен-эффективность: нет сырых списков ресурсов/задач
  assert.ok(!('resources' in c) || c.slowestResources.length <= 3);
  const s = JSON.stringify(c);
  assert.ok(s.length < 4000, `компактный JSON слишком большой: ${s.length} байт`);
});

test('buildCompact: долгие задачи попадают в keyMetrics', () => {
  const data = {
    schemaVersion: 1,
    tool: 'owa',
    meta: { url: 'https://t', analyzedAt: 'x' },
    metrics: { ...idealMetrics, longTasks: { supported: true, count: 3, maxDuration: 200, totalBlockingTime: 400, tasks: [] } },
  };
  const c = buildCompact(data);
  assert.strictEqual(c.keyMetrics.longTasks, 3);
  assert.strictEqual(c.keyMetrics.tbtMs, 400);
});
