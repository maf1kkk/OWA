/**
 * Тесты генерации PDF-отчётов: вёрстка шаблонов, подстановка плейсхолдеров,
 * отсутствие наложения футера на контент.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const { buildHtml } = require('../src/report/pdf');
const { buildCompareHtml } = require('../src/report/compare-pdf');
const { buildAnalysisHtml } = require('../src/report/analysis-pdf');
const { buildCrawlHtml } = require('../src/report/crawl-pdf');
const { buildSessionHtml, summarize } = require('../src/report/session-pdf');

const TEMPLATES = ['report.html', 'compare.html', 'analysis.html', 'crawl.html', 'session.html'];

test('шаблоны: теги сбалансированы (table/div)', () => {
  for (const file of TEMPLATES) {
    const html = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8');
    const t = [(html.match(/<table\b/g) || []).length, (html.match(/<\/table>/g) || []).length];
    assert.deepStrictEqual(t[0], t[1], file + ': <table> и </table> не сбалансированы');
    const d = [(html.match(/<div\b/g) || []).length, (html.match(/<\/div>/g) || []).length];
    assert.deepStrictEqual(d[0], d[1], file + ': <div> и </div> не сбалансированы');
  }
});

test('шаблоны: футер не fixed (иначе накладывается на текст в PDF)', () => {
  const styles = fs.readFileSync(path.join(TEMPLATES_DIR, 'styles.css'), 'utf8');
  const footerRule = styles.match(/\.footer\s*\{[^}]*\}/);
  assert.ok(footerRule, 'правило .footer найдено');
  assert.ok(!/position\s*:\s*fixed/.test(footerRule[0]), 'футер не должен быть fixed');
});

/** Проверить, что в готовом HTML не осталось плейсхолдеров. */
function assertNoPlaceholders(html, label) {
  const left = [...new Set(html.match(/__[A-Z_]+__/g) || [])];
  assert.deepStrictEqual(left, [], label + ': остались плейсхолдеры ' + left.join(', '));
}

test('отчёт по аудиту: плейсхолдеры подставлены, футер в конце документа', () => {
  const result = {
    schemaVersion: 2,
    url: 'https://client.test/',
    timestamp: '2026-10-20T10:00:00.000Z',
    integralScore: 72,
    failedSections: [],
    issues: [{ id: 'seo-no-title', rule: 'seo-title', severity: 'critical', message: 'Нет title', recommendation: 'Задайте title' }],
    scores: {
      performance: { status: 'ok', score: 100, issues: [], durationMs: 100, raw: { metrics: { lcpMs: 340, cls: 0.01, fcpMs: 260, ttfbMs: 60, tbtMs: 0 } } },
      seo: { status: 'ok', score: 38, issues: [{ id: 'seo-no-title', rule: 'seo-title', severity: 'critical', message: 'Нет title' }], durationMs: 50, raw: {} },
      security: { status: 'ok', score: 62, issues: [], durationMs: 50, raw: {} },
      accessibility: { status: 'ok', score: 70, issues: [], durationMs: 50, raw: {} },
      content: { status: 'ok', score: 97, issues: [], durationMs: 50, raw: {} },
    },
  };
  const html = buildHtml(result, { issues: 'data:image/png;base64,AAA', radar: 'data:image/png;base64,AAA' }, {});
  assertNoPlaceholders(html, 'отчёт по аудиту');
  assert.ok(html.indexOf('class="footer"') > html.indexOf('class="disclaimer"'), 'футер после дисклеймера');
});

test('отчёт по анализу: плейсхолдеры подставлены', () => {
  const report = {
    meta: { url: 'https://client.test/', analyzedAt: '2026-10-20T10:00:00.000Z' },
    metrics: {
      legacyTiming: { loadTime: 437 },
      navigation: { dns: 1, tcp: 10, ssl: 5, ttfb: 50, domInteractive: 400, domComplete: 430, loadEvent: 437 },
      paint: { firstPaint: 240, firstContentfulPaint: 260 },
      vitals: { lcpMs: 340, cls: 0.006 },
      resources: { count: 1, byType: { script: { count: 1, totalDuration: 82, totalTransferSize: 1679 } }, top10Slowest: [], waterfall: [] },
      longTasks: { supported: true, count: 0, maxDuration: 0, totalBlockingTime: 0, tasks: [] },
    },
    interpretation: { summary: { score: 100, headline: 'Критических проблем не обнаружено' }, findings: [] },
  };
  const html = buildAnalysisHtml(report, { waterfall: null });
  assertNoPlaceholders(html, 'отчёт по анализу');
});

test('отчёт по обходу: плейсхолдеры подставлены (в т.ч. дважды)', () => {
  const result = {
    startUrl: 'https://client.test/',
    crawledAt: '2026-10-20T10:00:00.000Z',
    pages: [{ url: 'https://client.test/', status: 'ok', score: 72, scores: { performance: 100, seo: 38, accessibility: 70 }, issues: [], metrics: {} }],
    aggregate: {
      pageCount: 1, okCount: 1, failedCount: 0, avgScore: 72,
      avgMetrics: { lcpMs: 340, cls: 0.006, fcpMs: 260, ttfbMs: 61, tbtMs: 0, resources: 1 },
      topIssues: [{ rule: 'seo-no-title', severity: 'critical', count: 1, pages: ['https://client.test/'] }],
      worstPages: [{ url: 'https://client.test/', score: 72 }],
    },
  };
  const html = buildCrawlHtml(result);
  assertNoPlaceholders(html, 'отчёт по обходу');
  assert.ok(!html.includes('__PAGE_COUNT__'), 'счётчик страниц подставлен везде');
});

test('отчёт за сессию: плейсхолдеры подставлены, сводка считается', () => {
  const ops = [
    { id: '1', type: 'analyze', url: 'https://a.test/', at: '2026-10-20T10:00:00.000Z', score: 100, issueCount: 0, issues: [] },
    {
      id: '2', type: 'audit', url: 'https://a.test/', at: '2026-10-20T10:05:00.000Z', score: 72, issueCount: 2,
      issues: [{ rule: 'seo-no-title', section: 'seo', severity: 'critical' }, { rule: 'csp', section: 'security', severity: 'warning' }],
    },
  ];
  const stats = summarize(ops);
  assert.strictEqual(stats.opCount, 2);
  assert.strictEqual(stats.siteCount, 1);
  assert.strictEqual(stats.issueCount, 2);
  assert.strictEqual(stats.bySection.seo, 1);
  assert.strictEqual(stats.bySection.security, 1);
  assert.strictEqual(stats.topIssues[0].rule, 'seo-no-title');

  const html = buildSessionHtml(ops, { issues: 'data:image/png;base64,AAA' });
  assertNoPlaceholders(html, 'отчёт за сессию');
});

test('отчёт по сравнению: плейсхолдеры подставлены', () => {
  const sites = [
    { url: 'https://a.test/', label: 'a.test', role: 'target', avgSectionScore: 60, issueCount: 2 },
    { url: 'https://b.test/', label: 'b.test', role: 'competitor', avgSectionScore: 80, issueCount: 1 },
  ];
  const result = {
    createdAt: '2026-10-20T10:00:00.000Z',
    target: sites[0], competitors: [sites[1]], sites,
    sectionRows: [{ key: 'seo', label: 'SEO', values: { 'https://a.test/': 40, 'https://b.test/': 78 }, best: 'https://b.test/', bestValue: 78, targetValue: 40, deltaToBest: 38 }],
    metricRows: [{ key: 'lcpMs', label: 'LCP', unit: ' мс', values: { 'https://a.test/': 1200, 'https://b.test/': 900 }, bestValue: 900, best: 'https://b.test/' }],
    conclusions: [{ severity: 'critical', text: 'SEO: 40 против 78 — отставание 38 баллов.' }],
  };
  const html = buildCompareHtml(result, { bars: 'data:image/png;base64,AAA', metrics: 'data:image/png;base64,AAA' }, {});
  assertNoPlaceholders(html, 'отчёт по сравнению');
});
