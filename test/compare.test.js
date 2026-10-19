/**
 * Тесты сравнительного аудита (модуль 5).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildComparison, summarizeSite, labelFor } = require('../src/compare');
const { buildCompareHtml, barsChartPng, metricsChartPng } = require('../src/report/compare-pdf');

/** Готовый результат аудита для суммаризации. */
function fakeAudit(scores) {
  const resultScores = {};
  for (const [name, score] of Object.entries(scores)) {
    resultScores[name] = {
      status: 'ok',
      score,
      issues: [{ id: name + '-issue', rule: name + '-rule', severity: 'warning', message: name + ' problem' }],
      durationMs: 100,
      raw: name === 'performance' ? { metrics: { lcpMs: 1000, cls: 0.05, ttfbMs: 200, tbtMs: 50, fcpMs: 800, resources: 20 } } : {},
    };
  }
  return {
    scores: resultScores,
    integralScore: Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length),
    issues: Object.keys(scores).map((n) => ({ id: n, rule: n, severity: 'warning', message: n + ' problem' })),
    failedSections: [],
  };
}

const TARGET = 'https://client.test/';
const COMP1 = 'https://rival-a.test/';
const COMP2 = 'https://rival-b.test/';

function buildFixture() {
  const sites = [
    summarizeSite(TARGET, fakeAudit({ performance: 60, seo: 40, security: 50, accessibility: 70, content: 80 }), 'target'),
    summarizeSite(COMP1, fakeAudit({ performance: 90, seo: 85, security: 80, accessibility: 95, content: 90 }), 'competitor'),
    summarizeSite(COMP2, fakeAudit({ performance: 75, seo: 70, security: 60, accessibility: 65, content: 75 }), 'competitor'),
  ];
  return { sites, comparison: buildComparison(sites) };
}

test('compare: сводка сайта собирает оценки и метрики', () => {
  const site = summarizeSite(TARGET, fakeAudit({ performance: 60, seo: 40, security: 50, accessibility: 70, content: 80 }), 'target');
  assert.strictEqual(site.role, 'target');
  assert.strictEqual(site.avgSectionScore, 60);
  assert.strictEqual(site.sections.seo.score, 40);
  assert.strictEqual(site.sections.seo.label, 'SEO');
  assert.strictEqual(site.metrics.lcpMs, 1000);
  assert.ok(site.issueCount > 0);
});

test('compare: labelFor даёт короткую подпись сайта', () => {
  assert.strictEqual(labelFor('https://www.example.com/'), 'example.com');
  assert.strictEqual(labelFor('https://example.com/blog/'), 'example.com/blog');
});

test('compare: таблица по разделам содержит значения всех сайтов и лидера', () => {
  const { comparison } = buildFixture();
  const seo = comparison.sectionRows.find((r) => r.key === 'seo');
  assert.strictEqual(seo.values[TARGET], 40);
  assert.strictEqual(seo.values[COMP1], 85);
  assert.strictEqual(seo.values[COMP2], 70);
  assert.strictEqual(seo.best, COMP1);
  assert.strictEqual(seo.bestValue, 85);
  assert.strictEqual(seo.deltaToBest, 45);
});

test('compare: таблица по метрикам помечает лучшее значение', () => {
  const { comparison } = buildFixture();
  const lcp = comparison.metricRows.find((r) => r.key === 'lcpMs');
  assert.strictEqual(lcp.values[TARGET], 1000);
  assert.strictEqual(lcp.bestValue, 1000);
  assert.strictEqual(lcp.lowerIsBetter, true);
});

test('compare: выводы говорят, где клиент проигрывает и на сколько', () => {
  const { comparison } = buildFixture();
  assert.ok(comparison.conclusions.length >= 3, 'выводов достаточно');
  const seoText = comparison.conclusions.find((c) => c.text.includes('SEO'));
  assert.ok(seoText, 'есть вывод по SEO');
  assert.match(seoText.text, /отставание 45 баллов/i);
  const avgText = comparison.conclusions.find((c) => c.text.includes('Средняя оценка'));
  assert.ok(avgText, 'есть вывод по средней оценке');
  assert.match(avgText.text, /отставание/i);
});

test('compare: выводы фиксируют лидерство клиента', () => {
  const sites = [
    summarizeSite(TARGET, fakeAudit({ performance: 95, seo: 95, security: 90, accessibility: 95, content: 95 }), 'target'),
    summarizeSite(COMP1, fakeAudit({ performance: 50, seo: 40, security: 45, accessibility: 60, content: 55 }), 'competitor'),
  ];
  const comparison = buildComparison(sites);
  assert.ok(comparison.conclusions.some((c) => /опережаете конкурентов/i.test(c.text)));
});

test('compare: PDF-шаблон собирается с графиками, таблицами и выводами', async () => {
  const { sites, comparison } = buildFixture();
  const result = {
    schemaVersion: 2,
    tool: 'owa',
    type: 'compare',
    createdAt: new Date('2026-10-19T10:00:00Z').toISOString(),
    target: sites[0],
    competitors: sites.slice(1),
    sites,
    sectionRows: comparison.sectionRows,
    metricRows: comparison.metricRows,
    conclusions: comparison.conclusions,
  };
  const charts = { bars: await barsChartPng(result), metrics: await metricsChartPng(result) };
  const html = buildCompareHtml(result, charts);

  assert.ok(html.includes('Сравнительный аудит'), 'заголовок');
  assert.ok(html.includes('Ваш сайт'), 'цель выделена');
  assert.ok(html.includes('rival-a.test'), 'конкурент в таблице');
  assert.ok(html.includes('data:image/png;base64,'), 'графики встроены');
  assert.ok(html.includes('Выводы'), 'раздел выводов');
  assert.ok(html.includes('отставание 45 баллов'), 'текстовые выводы в PDF');
  assert.ok(!html.includes('__'), 'все плейсхолдеры подставлены');
});

test('compare: PDF создаётся, не больше 10 МБ', async () => {
  const { generateComparePdf } = require('../src/report/compare-pdf');
  const { sites, comparison } = buildFixture();
  const result = {
    schemaVersion: 2,
    tool: 'owa',
    type: 'compare',
    createdAt: new Date().toISOString(),
    target: sites[0],
    competitors: sites.slice(1),
    sites,
    sectionRows: comparison.sectionRows,
    metricRows: comparison.metricRows,
    conclusions: comparison.conclusions,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-compare-'));
  const out = path.join(dir, 'compare.pdf');
  try {
    const info = await generateComparePdf(result, out);
    assert.ok(fs.existsSync(out));
    assert.ok(info.bytes > 1000);
    assert.ok(info.bytes <= 10 * 1024 * 1024);
    assert.equal(fs.readFileSync(out).slice(0, 5).toString(), '%PDF-');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
