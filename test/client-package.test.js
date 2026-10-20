/**
 * Тесты пакета для клиента: выжимка, брендинг, тексты (все числа — из фактов).
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSummaryHtml } = require('../src/report/summary-pdf');
const { buildFullHtml } = require('../src/report/full-pdf');
const { buildTexts, collectNumbers, plural } = require('../src/report/client-package-texts');

const FACTS = {
  url: 'https://site.test/',
  date: '2026-10-21T10:00:00.000Z',
  integralScore: 78,
  sections: {
    performance: { score: 86, issues: 4 },
    seo: { score: 100, issues: 0 },
    security: { score: 62, issues: 6 },
    accessibility: { score: 40, issues: 2 },
    content: { score: 100, issues: 0 },
  },
  metrics: { lcpMs: 980, cls: 0.003, fcpMs: 980, ttfbMs: 24, loadMs: 2040, tbtMs: 344, longTasks: 3, resources: 218 },
  counts: { performance: 4, seo: 0, security: 6, accessibility: 2, content: 0, pages: 42 },
  findings: [
    { ruleId: 'resources', section: 'performance', severity: 'critical', message: 'Количество ресурсов: 218 шт — плохо' },
    { ruleId: 'csp', section: 'security', severity: 'warning', message: 'Нет Content-Security-Policy' },
    { ruleId: 'color-contrast', section: 'accessibility', severity: 'critical', message: '79 нарушений контраста' },
  ],
  crawl: {
    pageCount: 42,
    okCount: 42,
    failedCount: 0,
    avgScore: 78,
    avgMetrics: { lcpMs: 1105, cls: 0, fcpMs: 962, ttfbMs: 56, tbtMs: 171, resources: 174 },
    topIssues: [
      { ruleId: 'color-contrast', severity: 'critical', count: 42, pages: [] },
      { ruleId: 'resources', severity: 'critical', count: 41, pages: [] },
      { ruleId: 'seo-h1', severity: 'warning', count: 12, pages: [] },
      { ruleId: 'label-content-name-mismatch', severity: 'critical', count: 8, pages: [] },
    ],
    worstPages: [{ url: 'https://site.test/worst', score: 46 }],
  },
  comparison: {
    competitorAvg: 88,
    targetAvg: 78,
    sites: [
      { url: 'https://site.test/', label: 'site.test', role: 'target', avgSectionScore: 78, sections: { seo: { score: 100 } }, metrics: {} },
      { url: 'https://rival.test/', label: 'rival.test', role: 'competitor', avgSectionScore: 88, sections: { seo: { score: 80 } }, metrics: {} },
    ],
    sectionRows: [
      { label: 'Производительность', values: { 'https://site.test/': 86, 'https://rival.test/': 100 }, deltaToBest: 14, best: 'https://rival.test/' },
      { label: 'SEO', values: { 'https://site.test/': 100, 'https://rival.test/': 80 }, deltaToBest: 0, best: 'https://site.test/' },
    ],
    metricRows: [{ label: 'LCP', unit: ' мс', values: { 'https://site.test/': 980, 'https://rival.test/': 900 } }],
  },
  totals: { findings: 3, critical: 2, warning: 1 },
};

const NARRATIVE = {
  summary: 'Интегральная оценка 78 из 100: отставание в доступности 40 баллов.',
  focus: ['78 элементов с недостаточным контрастом текста на 42 страницах'],
  findings: [],
  plan: [
    { month: 1, title: 'Поднять контраст до 4.5:1', why: 'WCAG 2 AA', impact: 'контраст пройдёт', effort: 'M', ruleIds: ['color-contrast'] },
    { month: 2, title: 'Сократить 218 ресурсов', why: 'у конкурента меньше', impact: 'быстрее', effort: 'L', ruleIds: ['resources'] },
  ],
  limitations: ['Ссылочный профиль не снимался'],
};

const CLIENT = { name: 'ООО «Тест»', siteUrl: 'https://site.test', priceBudget: '20 000 ₽', contacts: '@test' };

test('числа для текстов берутся только из фактов', () => {
  const n = collectNumbers(FACTS);
  assert.strictEqual(n.pageCount, 42);
  assert.strictEqual(n.contrastPages, 42);
  assert.strictEqual(n.labelPages, 8);
  assert.strictEqual(n.h1Pages, 12);
  assert.strictEqual(n.securityHeaders, 6);
  assert.strictEqual(n.resourcesAvg, 174);
  assert.strictEqual(n.resourcesMain, 218);
  assert.strictEqual(n.loadMs, 2040);
  assert.strictEqual(n.tbtMs, 344);
});

test('русские склонения в числах', () => {
  assert.strictEqual(plural(1, 'страница', 'страницы', 'страниц'), 'страница');
  assert.strictEqual(plural(2, 'страница', 'страницы', 'страниц'), 'страницы');
  assert.strictEqual(plural(5, 'страница', 'страницы', 'страниц'), 'страниц');
  assert.strictEqual(plural(11, 'страница', 'страницы', 'страниц'), 'страниц');
  assert.strictEqual(plural(21, 'страница', 'страницы', 'страниц'), 'страница');
});

test('текст сообщения: числа совпадают с фактами, противоречий нет', () => {
  const t = buildTexts({ facts: FACTS, narrative: NARRATIVE, client: CLIENT });
  assert.ok(t.message.includes('42 страницы'), 'число страниц из фактов');
  assert.ok(t.message.includes('174 ресурсов'), 'ресурсы в среднем из фактов');
  assert.ok(t.message.includes('218'), 'ресурсы главной из фактов');
  assert.ok(t.message.includes('6 заголовков'), 'заголовки из фактов');
  assert.ok(!t.message.includes('__'), 'плейсхолдеров нет');
  assert.ok(t.message.includes('Полный отчёт'), 'есть предложение полного отчёта');
  assert.ok(t.message.includes('20 000 ₽'), 'указан бюджет клиента');
});

test('тексты пакета: README и смета на месте, с рекомендацией по оплате', () => {
  const t = buildTexts({ facts: FACTS, narrative: NARRATIVE, client: CLIENT });
  assert.ok(t.readme.includes('Не отправлять сейчас'), 'README предупреждает не отправлять полный отчёт сразу');
  assert.ok(t.readme.includes('50% аванс'), 'схема оплаты');
  assert.ok(t.estimate.includes('Вариант 1') && t.estimate.includes('Вариант 3'), 'три варианта в смете');
  assert.ok(t.estimate.includes('Ограничения') || t.estimate.includes('Условия'), 'условия в смете');
  assert.ok(t.estimate.includes('не гарантируем'), 'нет обещаний по результату');
});

test('выжимка: HTML собирается без плейсхолдеров, с брендингом', () => {
  const html = buildSummaryHtml({
    facts: FACTS,
    narrative: NARRATIVE,
    branding: { title: 'Анализ сайта site.test', client: 'ООО «Тест»', executor: 'Исполнитель', contacts: '@test' },
  });
  assert.ok(!/__[A-Z_]+__/.test(html), 'плейсхолдеров не осталось');
  assert.ok(html.includes('Анализ сайта site.test'), 'заголовок с брендингом');
  assert.ok(html.includes('ООО «Тест»'), 'заказчик');
  assert.ok(html.includes('Исполнитель'), 'исполнитель');
  assert.ok(html.includes('Сравнение с конкурентами'), 'сравнение');
});

test('полный отчёт: брендинг подставляется в титул и в футер PDF', () => {
  const { buildFooterTemplate } = require('../src/report/full-pdf');
  const html = buildFullHtml({
    facts: FACTS,
    narrative: NARRATIVE,
    branding: { title: 'Комплексный аудит сайта', client: 'ООО «Тест»', executor: 'Исполнитель', contacts: '@test', footerLeft: 'Аудит site.test' },
    charts: { compare: null },
  });
  assert.ok(!/__[A-Z_]+__/.test(html), 'плейсхолдеров не осталось');
  assert.ok(html.includes('ООО «Тест»'), 'заказчик в титуле');
  assert.ok(html.includes('Исполнитель'), 'исполнитель в титуле');
  // Футер рисует Chromium (нумерация страниц) — он собирается отдельно.
  const footer = buildFooterTemplate({ footerLeft: 'Аудит site.test', contacts: '@test' });
  assert.ok(footer.includes('Аудит site.test'), 'брендинг в футере');
  assert.ok(footer.includes('pageNumber') && footer.includes('totalPages'), 'нумерация страниц');
});
