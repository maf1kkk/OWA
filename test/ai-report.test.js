/**
 * Тесты AI-слоя: RAG, факт-лист, проверка ответа модели, fallback.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { retrieve, loadCorpus, tokenize } = require('../src/ai/rag');
const {
  buildFacts,
  validateNarrative,
  parseModelJson,
  buildFallbackNarrative,
  collectAllowedNumbers,
  extractNumbers,
  generateNarrative,
} = require('../src/ai/report-generator');
const { loadProfile, normalizeProfile } = require('../src/ai/client-profile');

/** Готовый результат аудита для тестов. */
function fakeAudit() {
  const mk = (score, issues) => ({
    status: 'ok',
    score,
    issues,
    durationMs: 100,
    raw: { metrics: { lcpMs: 1200, cls: 0.02, fcpMs: 900, ttfbMs: 250, tbtMs: 100, resources: 20 } },
  });
  return {
    schemaVersion: 2,
    tool: 'owa',
    url: 'https://client.test/',
    timestamp: '2026-10-19T10:00:00.000Z',
    integralScore: 61,
    failedSections: [],
    issues: [
      { id: 'seo-no-title', rule: 'seo-title', severity: 'critical', message: 'Отсутствует <title>', recommendation: 'Задайте title' },
      { id: 'sec-no-csp', rule: 'csp', severity: 'warning', message: 'Нет Content-Security-Policy', recommendation: 'Добавьте CSP' },
    ],
    scores: {
      performance: mk(95, []),
      seo: mk(40, [{ id: 'seo-no-title', rule: 'seo-title', severity: 'critical', message: 'Отсутствует <title>', recommendation: 'Задайте title' }]),
      security: mk(55, [{ id: 'sec-no-csp', rule: 'csp', severity: 'warning', message: 'Нет Content-Security-Policy', recommendation: 'Добавьте CSP' }]),
      accessibility: mk(80, []),
      content: mk(90, []),
    },
  };
}

test('RAG: корпус загружается и режется на чанки', () => {
  const chunks = loadCorpus();
  assert.ok(chunks.length >= 10, 'чанков достаточно: ' + chunks.length);
  assert.ok(chunks.every((c) => c.id && c.text && c.tokens.length > 0));
});

test('RAG: поиск по SEO-правилам находит верные выдержки', () => {
  const hits = retrieve('seo-no-title canonical description битые ссылки', {
    topK: 4,
    boostTerms: ['seo-no-title', 'canonical'],
  });
  assert.ok(hits.length > 0, 'есть выдача');
  const text = hits.map((h) => h.text + ' ' + h.heading).join(' ').toLowerCase();
  assert.ok(text.includes('title') || text.includes('canonical'), 'выдержка про SEO');
});

test('RAG: запрос без совпадений не ломается', () => {
  assert.deepStrictEqual(retrieve('', { topK: 3 }), []);
  assert.ok(Array.isArray(retrieve('квантовая физика', { topK: 3 })));
});

test('tokenize: стоп-слова и нормализация окончаний', () => {
  const tokens = tokenize('Отсутствует заголовки и мета-теги');
  assert.ok(!tokens.includes('и'), 'стоп-слово убрано');
  assert.ok(tokens.length > 0);
});

test('факт-лист: содержит измерения, находки и явные счётчики', () => {
  const facts = buildFacts(fakeAudit());
  assert.strictEqual(facts.url, 'https://client.test/');
  assert.strictEqual(facts.integralScore, 61);
  assert.strictEqual(facts.sectionsCount, 5);
  assert.strictEqual(facts.totalIssues, 2);
  assert.strictEqual(facts.criticalIssues, 1);
  assert.strictEqual(facts.findings.length, 2);
  assert.strictEqual(facts.findings[0].ruleId, 'seo-no-title');
  assert.strictEqual(facts.metrics.lcpMs, 1200);
});

test('extractNumbers: дефис в диапазоне не считается минусом', () => {
  const nums = extractNumbers('Расширьте title до 50-60 символов');
  assert.ok(!nums.some((n) => n.value < 0), 'нет отрицательных чисел');
  assert.ok(nums.some((n) => n.value === 60));
});

test('collectAllowedNumbers: числа из строк-фактов тоже разрешены', () => {
  const facts = buildFacts(fakeAudit());
  facts.findings[0].message = 'Короткий title (14 симв.)';
  const allowed = collectAllowedNumbers(facts, []);
  assert.ok(allowed.has(14), 'число из строки разрешено');
});

test('валидация: неизвестный ruleId отклоняется', () => {
  const facts = buildFacts(fakeAudit());
  const allowed = collectAllowedNumbers(facts, []);
  const res = validateNarrative({
    summary: 'Сайт проверен, найдены проблемы в разделах SEO и безопасность.',
    findings: [{ ruleId: 'несуществующее-правило', impact: 'влияние', recommendation: 'рекомендация' }],
    plan: [],
    limitations: [],
  }, facts, allowed);
  assert.strictEqual(res.ok, false);
  assert.ok(res.unknownRules.includes('несуществующее-правило'));
});

test('валидация: число не из фактов отклоняется', () => {
  const facts = buildFacts(fakeAudit());
  const allowed = collectAllowedNumbers(facts, []);
  const res = validateNarrative({
    summary: 'Сайт проверен: найдено 999 проблем, которые нужно закрыть как можно скорее.',
    findings: [],
    plan: [],
    limitations: [],
  }, facts, allowed);
  assert.strictEqual(res.ok, false);
  assert.ok(res.badNumbers.includes('999'));
});

test('валидация: корректный ответ принимается', () => {
  const facts = buildFacts(fakeAudit());
  const allowed = collectAllowedNumbers(facts, []);
  const res = validateNarrative({
    summary: 'Проверен сайт client.test: интегральная оценка 61 из 100, найдено 2 проблемы, одна из них критическая.',
    findings: [{ ruleId: 'seo-no-title', impact: 'Поиск формирует сниппет произвольно', recommendation: 'Задайте уникальный title', priority: 'P1', confidence: 'high' }],
    plan: [{ title: 'Задать title', why: 'Без title сниппет случайный', effort: 'S' }],
    limitations: ['Авторизация не проверялась'],
  }, facts, allowed);
  assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
});

test('parseModelJson: переживает ```-обёртку и мусор вокруг JSON', () => {
  assert.deepStrictEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(parseModelJson('Вот ответ: {"a":1} — готово'), { a: 1 });
  assert.strictEqual(parseModelJson('совсем не json'), null);
});

test('fallback-текст: содержит оценку, находки и ограничения', () => {
  const facts = buildFacts(fakeAudit());
  const n = buildFallbackNarrative(facts);
  assert.ok(n.summary.includes('61'), 'оценка в тексте');
  assert.ok(n.findings.length >= 1);
  assert.ok(Array.isArray(n.limitations) && n.limitations.length >= 1);
  assert.strictEqual(n.generatedBy, 'deterministic');
});

test('generateNarrative: без AI возвращается шаблонный текст', async () => {
  const facts = buildFacts(fakeAudit());
  const res = await generateNarrative({ facts, ai: null });
  assert.strictEqual(res.source, 'fallback');
  assert.ok(res.narrative.summary);
});

test('generateNarrative: валидный ответ модели принимается', async () => {
  const facts = buildFacts(fakeAudit());
  const ai = {
    client: {},
    model: 'test-model',
    maxTokens: 1000,
    temperature: 0,
    complete: async () => ({
      ok: true,
      text: JSON.stringify({
        summary: 'Проверен сайт client.test: интегральная оценка 61 из 100, найдено 2 проблемы, одна критическая.',
        focus: ['Отсутствует title'],
        findings: [{ ruleId: 'seo-no-title', impact: 'сниппет произвольный', recommendation: 'Задайте title', priority: 'P1', confidence: 'high' }],
        plan: [{ title: 'Задать title', why: 'сниппет', effort: 'S' }],
        limitations: ['Авторизация не проверялась'],
      }),
    }),
  };
  const res = await generateNarrative({ facts, ai });
  assert.strictEqual(res.source, 'ai');
  assert.strictEqual(res.validation.ok, true);
  assert.strictEqual(res.narrative.findings[0].ruleId, 'seo-no-title');
});

test('generateNarrative: ответ с выдуманными числами отклоняется', async () => {
  const facts = buildFacts(fakeAudit());
  const ai = {
    client: {},
    model: 'test-model',
    maxTokens: 1000,
    temperature: 0,
    complete: async () => ({
      ok: true,
      text: JSON.stringify({
        summary: 'Проверен сайт client.test: найдено 7777 проблем и потеря 55 процентов трафика.',
        findings: [],
        plan: [],
        limitations: [],
      }),
    }),
  };
  const res = await generateNarrative({ facts, ai });
  assert.strictEqual(res.source, 'fallback');
  assert.strictEqual(res.validation.ok, false);
  assert.ok(res.narrative.summary.includes('61'), 'использован шаблонный текст с фактами');
});

test('профиль клиента: нормализация и загрузка из clients/', () => {
  const p = normalizeProfile({ name: ' ООО Ромашка ', focus: ['seo', 'bogus'], tone: 'weird', competitors: ['https://a.test', 'не-ссылка'] }, 'demo');
  assert.strictEqual(p.name, 'ООО Ромашка');
  assert.deepStrictEqual(p.focus, ['seo']);
  assert.strictEqual(p.tone, 'business');
  assert.deepStrictEqual(p.competitors, ['https://a.test']);

  const loaded = loadProfile('example');
  assert.ok(loaded, 'пример профиля читается');
  assert.strictEqual(loaded.language, 'ru');
  assert.strictEqual(loadProfile('несуществующий'), null);
});
