/**
 * Тесты генерации клиентского PDF-отчёта (модуль 2).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildHtml, generatePdfReport, issuesChartPng, radarChartPng } = require('../src/report/pdf');

process.env.OWA_ALLOW_PRIVATE_TARGETS = '1';

const FAKE_RESULT = {
  schemaVersion: 2,
  tool: 'owa',
  url: 'https://example.com/',
  timestamp: new Date('2026-10-19T10:00:00Z').toISOString(),
  finishedAt: new Date('2026-10-19T10:01:00Z').toISOString(),
  integralScore: 72,
  failedSections: [],
  issues: [
    { id: 'sec-no-csp', rule: 'csp', severity: 'critical', message: 'Нет Content-Security-Policy', recommendation: 'Добавьте заголовок CSP' },
    { id: 'seo-no-title', rule: 'seo-title', severity: 'warning', message: 'Отсутствует <title>', recommendation: 'Задайте <title>' },
    { id: 'a11y-image-alt', rule: 'image-alt', severity: 'warning', message: 'Изображения без alt', recommendation: 'Добавьте alt', location: ['img.logo'] },
    { id: 'content-empty-links', rule: 'empty-links', severity: 'info', message: 'Пустые ссылки', recommendation: 'Уберите' },
  ],
  scores: {
    performance: { status: 'ok', score: 88, issues: [], durationMs: 1200, raw: { metrics: { lcpMs: 2100, cls: 0.02, fcpMs: 1500, ttfbMs: 300, tbtMs: 90 } } },
    seo: { status: 'ok', score: 65, issues: [{ id: 'seo-no-title', rule: 'seo-title', severity: 'warning', message: 'Отсутствует <title>' }], durationMs: 900, raw: {} },
    security: { status: 'ok', score: 55, issues: [{ id: 'sec-no-csp', rule: 'csp', severity: 'critical', message: 'Нет Content-Security-Policy' }], durationMs: 700, raw: {} },
    accessibility: { status: 'ok', score: 80, issues: [{ id: 'a11y-image-alt', rule: 'image-alt', severity: 'warning', message: 'Изображения без alt' }], durationMs: 1500, raw: {} },
    content: { status: 'ok', score: 90, issues: [{ id: 'content-empty-links', rule: 'empty-links', severity: 'info', message: 'Пустые ссылки' }], durationMs: 500, raw: {} },
  },
};

test('PDF: HTML-отчёт содержит оценку, метрики, проблемы и графики', async () => {
  const charts = { issues: await issuesChartPng(FAKE_RESULT), radar: await radarChartPng(FAKE_RESULT) };
  const html = buildHtml(FAKE_RESULT, charts);

  assert.ok(html.includes('72'), 'интегральная оценка');
  assert.ok(html.includes('Core Web Vitals'), 'раздел Core Web Vitals');
  assert.ok(html.includes('Топ-10 проблем'), 'раздел топ проблем');
  assert.ok(html.includes('Content-Security-Policy'), 'проблема в отчёте');
  assert.ok(html.includes('data:image/png;base64,'), 'графики встроены как PNG');
  assert.ok(!html.includes('__'), 'все плейсхолдеры подставлены');
  assert.ok(html.includes('example.com'), 'URL в отчёте');
});

test('PDF: графики рендерятся в непустой PNG', async () => {
  const uri = await issuesChartPng(FAKE_RESULT);
  assert.ok(uri.startsWith('data:image/png;base64,'));
  const base64 = uri.replace('data:image/png;base64,', '');
  const buf = Buffer.from(base64, 'base64');
  assert.ok(buf.length > 1000, 'PNG не пустой: ' + buf.length + ' байт');
  assert.equal(buf.slice(1, 4).toString(), 'PNG');
});

test('PDF: файл отчёта создаётся, не больше 10 МБ и быстрее 30 секунд', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-pdf-test-'));
  const out = path.join(dir, 'report.pdf');
  try {
    const info = await generatePdfReport(FAKE_RESULT, out);
    assert.ok(fs.existsSync(out), 'PDF создан');
    assert.ok(info.bytes > 1000, 'PDF не пустой');
    assert.ok(info.bytes <= 10 * 1024 * 1024, 'PDF меньше 10 МБ: ' + info.bytes);
    assert.ok(info.durationMs < 30000, 'PDF быстрее 30 секунд: ' + info.durationMs + ' мс');
    const header = fs.readFileSync(out).slice(0, 5).toString();
    assert.equal(header, '%PDF-');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
