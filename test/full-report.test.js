/**
 * Тесты полного отчёта (модуль 5.5 — полный аудит по сайту).
 * Без сети: собираем факт-лист из синтетических данных.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildFullFacts, validateFullNarrative, buildDeterministicPlan } = require('../src/ai/full-narrative');
const { buildFullHtml } = require('../src/report/full-pdf');
const { deriveAllowedNumbers, collectAllowedNumbers } = require('../src/ai/report-generator');

/** Синтетический результат аудита. */
function fakeAudit() {
  return {
    schemaVersion: 2,
    url: 'https://site.test/',
    timestamp: '2026-10-21T10:00:00.000Z',
    integralScore: 78,
    failedSections: [],
    issues: [
      { id: 'color-contrast', rule: 'color-contrast', severity: 'critical', message: '79 нарушений контраста', recommendation: 'поднять контраст' },
      { id: 'resources', rule: 'resources', severity: 'critical', message: '171 ресурсов', recommendation: 'сократить' },
      { id: 'csp', rule: 'csp', severity: 'warning', message: 'Нет Content-Security-Policy', recommendation: 'добавить' },
    ],
    scores: {
      performance: { status: 'ok', score: 88, issues: [{ id: 'resources', rule: 'resources', severity: 'critical', message: '171 ресурсов' }], durationMs: 100, raw: { metrics: { lcpMs: 1261, cls: 0, fcpMs: 1151, ttfbMs: 183, tbtMs: 187, resources: 171 } } },
      seo: { status: 'ok', score: 100, issues: [], durationMs: 50, raw: {} },
      security: { status: 'ok', score: 62, issues: [{ id: 'csp', rule: 'csp', severity: 'warning', message: 'Нет Content-Security-Policy' }], durationMs: 40, raw: {} },
      accessibility: { status: 'ok', score: 40, issues: [{ id: 'color-contrast', rule: 'color-contrast', severity: 'critical', message: '79 нарушений контраста' }], durationMs: 90, raw: {} },
      content: { status: 'ok', score: 100, issues: [], durationMs: 30, raw: {} },
    },
  };
}

function fakeCrawl() {
  return {
    aggregate: {
      pageCount: 41, okCount: 41, failedCount: 0, avgScore: 78,
      avgMetrics: { lcpMs: 1261, cls: 0, fcpMs: 1151, ttfbMs: 183, tbtMs: 187, resources: 171 },
      topIssues: [{ rule: 'color-contrast', severity: 'critical', count: 41, pages: [] }],
      worstPages: [{ url: 'https://site.test/worst', score: 46 }],
    },
  };
}

test('факт-лист: собирает разделы, находки, метрики и агрегаты обхода', () => {
  const facts = buildFullFacts({ audit: fakeAudit(), crawl: fakeCrawl() });
  assert.strictEqual(facts.url, 'https://site.test/');
  assert.strictEqual(facts.integralScore, 78);
  assert.strictEqual(facts.sections.seo.score, 100);
  assert.strictEqual(facts.findings.length, 3);
  assert.strictEqual(facts.crawl.pageCount, 41);
  assert.strictEqual(facts.crawl.topIssues[0].ruleId, 'color-contrast');
  assert.strictEqual(facts.totals.critical, 2);
  assert.ok(facts.metrics.lcpMs === 1261);
});

test('факт-лист: сравнение с конкурентами попадает в факты', () => {
  const facts = buildFullFacts({
    audit: fakeAudit(),
    compare: {
      competitorAvg: 87,
      target: { avgSectionScore: 78 },
      sites: [
        { url: 'https://site.test/', label: 'site.test', role: 'target', avgSectionScore: 78, sections: { seo: { score: 100 } }, metrics: {} },
        { url: 'https://rival.test/', label: 'rival.test', role: 'competitor', avgSectionScore: 87, sections: { seo: { score: 80 } }, metrics: {} },
      ],
      sectionRows: [{ label: 'SEO', values: { 'https://site.test/': 100, 'https://rival.test/': 80 }, deltaToBest: 0, best: 'https://site.test/' }],
      metricRows: [{ label: 'LCP', unit: ' мс', values: { 'https://site.test/': 1000 } }],
    },
  });
  assert.strictEqual(facts.comparison.competitorAvg, 87);
  assert.strictEqual(facts.comparison.sites.length, 2);
  assert.strictEqual(facts.comparison.sectionRows[0].values['https://rival.test/'], 80);
});

test('валидация: неизвестный ruleId отклоняется', () => {
  const facts = buildFullFacts({ audit: fakeAudit() });
  const allowed = collectAllowedNumbers(facts, []);
  const res = validateFullNarrative({
    summary: 'Сайт проверен, найдено несколько проблем, которые нужно устранить в первую очередь.',
    findings: [{ ruleId: 'выдуманное-правило', impact: 'что-то', recommendation: 'что-то' }],
    plan: [{ month: 1, title: 'x', why: 'y', impact: 'z', effort: 'M', ruleIds: ['color-contrast'] }],
    limitations: [],
  }, facts, allowed);
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.join(' ').includes('выдуманное-правило'));
});

test('валидация: пункт плана без ruleIds отклоняется (общие слова не проходят)', () => {
  const facts = buildFullFacts({ audit: fakeAudit() });
  const allowed = collectAllowedNumbers(facts, []);
  const res = validateFullNarrative({
    summary: 'Сайт проверен, найдено несколько проблем, которые нужно устранить в первую очередь.',
    findings: [],
    plan: [{ month: 1, title: 'Оптимизировать производительность', why: 'y', impact: 'z', effort: 'M' }],
    limitations: [],
  }, facts, allowed);
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.join(' ').includes('ruleIds'));
});

test('валидация: корректный текст принимается', () => {
  const facts = buildFullFacts({
    audit: fakeAudit(),
    crawl: fakeCrawl(),
    compare: {
      competitorAvg: 87,
      target: { avgSectionScore: 78 },
      sites: [
        { url: 'https://site.test/', label: 'site.test', role: 'target', avgSectionScore: 78, sections: { seo: { score: 100 } }, metrics: { resources: 171 } },
        { url: 'https://rival.test/', label: 'rival.test', role: 'competitor', avgSectionScore: 87, sections: { seo: { score: 80 } }, metrics: { resources: 43 } },
      ],
      sectionRows: [{ label: 'SEO', values: { 'https://site.test/': 100, 'https://rival.test/': 80 }, deltaToBest: 0, best: 'https://site.test/' }],
      metricRows: [{ label: 'Ресурсов', unit: ' шт', values: { 'https://site.test/': 171, 'https://rival.test/': 43 } }],
    },
  });
  // Порог контраста 4.5:1 приходит из базы знаний — так же, как в реальном прогоне.
  const knowledge = [{ text: 'WCAG 2 AA: контраст обычного текста не ниже 4.5:1, крупного — 3:1.' }];
  const allowed = collectAllowedNumbers(facts, knowledge);
  const res = validateFullNarrative({
    summary: 'Интегральная оценка 78 из 100: отставание в доступности 40 баллов и 41 страница с нарушениями контраста.',
    findings: [{ ruleId: 'color-contrast', impact: 'пользователи с нарушениями зрения не читают текст', recommendation: 'поднять контраст до 4.5:1', priority: 'P1', effort: 'S' }],
    plan: [
      { month: 1, title: 'Поднять контраст до 4.5:1 — 79 элементов', why: 'WCAG 2 AA требует 4.5:1', impact: 'контраст пройдёт проверку', effort: 'M', ruleIds: ['color-contrast'] },
      { month: 2, title: 'Сократить 171 ресурс', why: 'конкурент грузит 43', impact: 'быстрее загрузка', effort: 'M', ruleIds: ['resources'] },
      { month: 3, title: 'Настроить заголовки безопасности', why: 'нет базовой гигиены', impact: 'защита', effort: 'S', ruleIds: ['csp'] },
    ],
    limitations: ['Ссылочный профиль не снимался'],
  }, facts, allowed);
  assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
});

test('производные числа: разности и средние разрешены, выдуманные — нет', () => {
  const facts = buildFullFacts({ audit: fakeAudit() });
  const allowed = collectAllowedNumbers(facts, []);
  const derived = deriveAllowedNumbers(allowed);
  const { numberAllowed } = require('../src/ai/report-generator');
  // 100 - 78 = 22 — производное от фактов
  assert.ok(numberAllowed(22, allowed, derived), 'разность разрешена');
  // 3141 — нет ни в фактах, ни как производная
  assert.ok(!numberAllowed(3141, allowed, derived), 'выдуманное число отклонено');
});

test('детерминированный план: строится без LLM и ссылается на правила', () => {
  const facts = buildFullFacts({ audit: fakeAudit(), crawl: fakeCrawl() });
  const plan = buildDeterministicPlan(facts);
  assert.ok(plan.plan.length >= 1);
  assert.ok(plan.plan[0].ruleIds && plan.plan[0].ruleIds.length >= 1);
  assert.ok(plan.summary.includes('78'));
});

test('HTML полного отчёта: собирается без незаполненных плейсхолдеров', () => {
  const facts = buildFullFacts({ audit: fakeAudit(), crawl: fakeCrawl() });
  const narrative = buildDeterministicPlan(facts);
  const html = buildFullHtml({ facts, narrative, charts: { compare: null } });
  assert.ok(!/__[A-Z_]+__/.test(html), 'плейсхолдеров не осталось');
  assert.ok(html.includes('План работ на 3 месяца'), 'есть план');
  assert.ok(html.includes('Проблемы по частоте'), 'есть частота проблем');
  assert.ok(html.includes('Страницы с худшими показателями'), 'есть худшие страницы');
  assert.ok(html.includes('Ограничения проверки'), 'есть ограничения');
});
