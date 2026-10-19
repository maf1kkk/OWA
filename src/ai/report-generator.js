/**
 * Генерация клиентского текста отчёта на основе измерений + базы знаний (RAG).
 *
 * Ключевое правило: модель НЕ придумывает факты. Ей отдаётся:
 *   - факт-лист (только измеренные значения и реальные находки);
 *   - выдержки из базы знаний (пороги, приёмы, юридические ограничения);
 *   - профиль клиента (влияет только на формулировки).
 * Ответ проверяется: все числа должны находиться в фактах или в базе знаний,
 * все ruleId — среди реальных находок. Не прошёл проверку — берётся
 * детерминированный текст (fallback), а отчёт всё равно формируется.
 */
'use strict';

const crypto = require('crypto');
const { retrieve } = require('./rag');
const { profileToPromptText } = require('./client-profile');

const SECTION_LABELS = {
  performance: 'Производительность',
  seo: 'SEO',
  security: 'Безопасность',
  accessibility: 'Доступность',
  content: 'Контент',
};

const SEVERITY_WEIGHT = { critical: 0, warning: 1, info: 2 };

const SYSTEM_PROMPT = [
  'Ты — аналитик веб-разработчик, который готовит КЛИЕНТСКИЙ отчёт по аудиту сайта.',
  '',
  'ЖЁСТКИЕ ПРАВИЛА (нарушение = отчёт отклоняется):',
  '1. Опирайся ТОЛЬКО на переданные факты. Не выдумывай числа, названия правил, ссылки, версии и факты о клиенте.',
  '2. Каждое утверждение о проблеме должно сопровождаться ruleId из списка находок. Неизвестные ruleId запрещены.',
  '3. Числа в тексте разрешены только из блока FACTS или из блока KNOWLEDGE. Других чисел быть не должно.',
  '4. Не обещай результат: запрещены формулировки вроде «вы получите +30% конверсии», «гарантируем», «полностью решит».',
  '5. Не заявляй соответствие стандартам и регуляторам («соответствует ГОСТ», «PCI DSS», «защищён»). Можно: «проверено N критериев».',
  '6. Не раскрывай готовые инструкции по эксплуатации уязвимостей и не добавляй персональные данные.',
  '7. Различай: наблюдение (измеренный факт), влияние (что это значит для пользователя/бизнеса), гипотеза о причине (если не подтверждена — пиши «предположительно»), рекомендация (что делать).',
  '8. Не выдумывай «уверенность» в причинах: confidence high только если причина подтверждена измерением.',
  '9. facts.sectionsCount — количество РАЗДЕЛОВ проверки (называй их разделами, не критериями);',
  '   facts.totalIssues — количество находок; facts.criticalIssues — из них критических.',
  '',
  'ФОРМАТ ОТВЕТА — строго JSON без пояснений:',
  '{',
  '  "summary": "2-4 предложения для руководства: что проверяли, что нашли в цифрах, что делать первым",',
  '  "focus": ["3 главные проблемы одной строкой каждая, с влиянием"],',
  '  "findings": [',
  '    { "ruleId": "...", "impact": "почему это важно", "recommendation": "как исправить конкретно", "priority": "P1|P2|P3|P4", "confidence": "high|medium|low" }',
  '  ],',
  '  "plan": [ { "title": "что сделать", "why": "зачем", "effort": "S|M|L" } ],',
  '  "limitations": ["что не проверялось, 1-3 пункта"]',
  '}',
].join('\n');

/**
 * Собрать факт-лист из результата аудита.
 * @param {object} result — результат runFullAudit
 * @param {object} [opts]
 * @param {object} [opts.comparison] — результат compareSites (для сравнительного отчёта)
 * @returns {object}
 */
function buildFacts(result, opts = {}) {
  const scores = {};
  const findings = [];
  for (const [name, sec] of Object.entries(result.scores || {})) {
    const label = SECTION_LABELS[name] || name;
    scores[name] = {
      label,
      score: sec.score === null ? null : sec.score,
      status: sec.status,
      issuesCount: Array.isArray(sec.issues) ? sec.issues.length : 0,
    };
    for (const issue of sec.issues || []) {
      findings.push({
        ruleId: issue.id || issue.rule || 'unknown',
        section: name,
        sectionLabel: label,
        severity: issue.severity || 'info',
        message: issue.message,
        toolRecommendation: issue.recommendation || null,
      });
    }
  }
  findings.sort((a, b) => (SEVERITY_WEIGHT[a.severity] ?? 3) - (SEVERITY_WEIGHT[b.severity] ?? 3));

  const perf = result.scores && result.scores.performance;
  const metrics = (perf && perf.raw && perf.raw.metrics) || {};

  const facts = {
    url: result.url,
    date: result.timestamp,
    tool: 'OWA (headless Chromium, Performance API, axe-core)',
    integralScore: result.integralScore,
    scores,
    metrics,
    findings,
    totalIssues: findings.length,
    criticalIssues: findings.filter((f) => f.severity === 'critical').length,
    warningIssues: findings.filter((f) => f.severity === 'warning').length,
    infoIssues: findings.filter((f) => f.severity === 'info').length,
    // Явные счётчики: модель часто пишет «по N критериям в M категориях» —
    // эти числа должны быть в фактах, иначе проверка отклонит верный текст.
    sectionsCount: Object.keys(scores).length,
    failedSections: result.failedSections || [],
  };

  if (opts.comparison) {
    const cmp = opts.comparison;
    facts.comparison = {
      target: { url: cmp.target.url, label: cmp.target.label, avgSectionScore: cmp.target.avgSectionScore },
      competitors: cmp.competitors.map((c) => ({ url: c.url, label: c.label, avgSectionScore: c.avgSectionScore })),
      sectionRows: cmp.sectionRows.map((r) => ({
        label: r.label,
        values: r.values,
        deltaToBest: r.deltaToBest,
      })),
      metricRows: cmp.metricRows.map((r) => ({
        label: r.label,
        unit: r.unit,
        values: r.values,
        bestValue: r.bestValue,
      })),
    };
  }

  return facts;
}

/** Собрать поисковый запрос для RAG из находок. */
function buildQuery(facts) {
  const parts = [];
  for (const f of facts.findings.slice(0, 25)) {
    parts.push(f.ruleId, f.sectionLabel, f.message);
  }
  for (const [name, s] of Object.entries(facts.scores)) {
    parts.push(name, s.label);
  }
  return parts.join(' ');
}

/** Разрешённые числа: из фактов + из выдержек базы знаний. */
function collectAllowedNumbers(facts, chunks) {
  const allowed = new Set();
  const add = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) allowed.add(v);
  };
  // Числа есть и в значениях, и внутри строк (например, «Короткий title (14 симв.)»).
  const walk = (value) => {
    if (typeof value === 'number') {
      add(value);
    } else if (typeof value === 'string') {
      for (const m of value.matchAll(/(?<![\d.,])-?\d+(?:[.,]\d+)?/g)) {
        const n = parseFloat(m[0].replace(',', '.'));
        if (Number.isFinite(n)) allowed.add(n);
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(facts);
  for (const c of chunks) {
    for (const m of String(c.text).matchAll(/(?<![\d.,])-?\d+(?:[.,]\d+)?/g)) {
      const n = parseFloat(m[0].replace(',', '.'));
      if (Number.isFinite(n)) allowed.add(n);
    }
  }
  return allowed;
}

/** Все числа, встречающиеся в тексте ответа модели. */
function extractNumbers(text) {
  const out = [];
  // Минус считается знаком только когда перед ним не цифра:
  // иначе «50-60» читалось бы как «-60».
  for (const m of String(text || '').matchAll(/(?<![\d.,])-?\d+(?:[.,]\d+)?/g)) {
    const raw = m[0].replace(',', '.');
    const n = parseFloat(raw);
    if (Number.isFinite(n)) out.push({ raw: m[0], value: n });
  }
  return out;
}

/** Число допустимо, если совпадает с фактом (с допуском мс↔с). */
function numberAllowed(value, allowed) {
  const near = (target) => {
    for (const a of allowed) {
      if (Math.abs(a - target) < 0.001) return true;
      if (target !== 0 && Math.abs(a - target / 1000) < 0.001) return true; // мс -> с
      if (a !== 0 && Math.abs(a / 1000 - target) < 0.001) return true;    // с -> мс
      if (a !== 0 && Math.abs(a * 100 - target) < 0.01) return true;     // проценты
    }
    return false;
  };
  return near(value);
}

/**
 * Проверить ответ модели.
 * @returns {{ok: boolean, errors: string[], unknownRules: string[], badNumbers: string[]}}
 */
function validateNarrative(narrative, facts, allowedNumbers) {
  const errors = [];
  const unknownRules = [];
  const badNumbers = [];

  if (!narrative || typeof narrative !== 'object') {
    return { ok: false, errors: ['ответ не является объектом'], unknownRules, badNumbers };
  }
  if (typeof narrative.summary !== 'string' || narrative.summary.trim().length < 20) {
    errors.push('нет содержательного summary');
  }
  if (!Array.isArray(narrative.findings)) {
    errors.push('findings не массив');
  }

  const known = new Set(facts.findings.map((f) => f.ruleId));
  if (Array.isArray(narrative.findings)) {
    for (const f of narrative.findings) {
      if (!f || !f.ruleId) {
        errors.push('находка без ruleId');
        continue;
      }
      if (!known.has(f.ruleId)) unknownRules.push(f.ruleId);
      if (!f.impact || String(f.impact).trim().length < 5) errors.push(`находка ${f.ruleId}: пустое влияние`);
      if (!f.recommendation || String(f.recommendation).trim().length < 5) errors.push(`находка ${f.ruleId}: пустая рекомендация`);
      if (f.priority && !/^P[1-4]$/.test(String(f.priority))) errors.push(`находка ${f.ruleId}: некорректный приоритет`);
    }
  }

  // Проверка чисел по всему тексту ответа.
  const text = JSON.stringify(narrative);
  for (const { raw, value } of extractNumbers(text)) {
    if (!numberAllowed(value, allowedNumbers)) badNumbers.push(raw);
  }

  if (unknownRules.length) errors.push('неизвестные ruleId: ' + unknownRules.join(', '));
  if (badNumbers.length) errors.push('числа не из фактов: ' + [...new Set(badNumbers)].join(', '));

  return { ok: errors.length === 0, errors, unknownRules, badNumbers: [...new Set(badNumbers)] };
}

/** Разобрать JSON из ответа модели (терпимо к ```-обёрткам и «лишнему» тексту). */
function parseModelJson(text) {
  if (!text) return null;
  let raw = String(text).trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return null;
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

/** Собрать сообщения для модели. */
function buildMessages(facts, chunks, profile, opts = {}) {
  const knowledge = chunks
    .map((c, i) => `[${i + 1}] ${c.heading}\n${c.text}`)
    .join('\n\n');

  const user = [
    'FACTS (измерения — единственный источник фактов):',
    JSON.stringify(facts, null, 2),
    '',
    'KNOWLEDGE (пороги, приёмы и ограничения — используй как справочник):',
    knowledge || '(нет)',
    '',
    'CLIENT (профиль клиента — влияет только на тон и фокус):',
    profileToPromptText(profile) || '(профиль не задан — пиши нейтрально, для владельца бизнеса)',
    '',
    opts.comparisonTask
      ? 'ЗАДАЧА: сравнительный отчёт. В summary обязательно скажи, где клиент отстаёт от конкурентов и на сколько (только по числам из FACTS.comparison).'
      : 'ЗАДАЧА: обычный отчёт по аудиту одной страницы.',
    '',
    'Верни ТОЛЬКО JSON по схеме из системного промпта.',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/**
 * Детерминированный текст без LLM — используется, если модель недоступна,
 * ответила некорректно или не прошёл проверку фактов.
 * @param {object} facts
 * @returns {object} в формате narrative
 */
function buildFallbackNarrative(facts) {
  const parts = [];
  const critical = facts.findings.filter((f) => f.severity === 'critical');
  const warning = facts.findings.filter((f) => f.severity === 'warning');

  parts.push(
    `Проверен сайт ${facts.url} ${facts.date ? 'на дату ' + String(facts.date).slice(0, 10) : ''}. `
    + `Интегральная оценка — ${facts.integralScore} из 100. `
    + `Обнаружено проблем: ${facts.totalIssues} (критичных — ${facts.criticalIssues}).`
  );

  const sectionLine = Object.entries(facts.scores)
    .map(([, s]) => `${s.label} ${s.score === null ? 'н/д' : s.score}`)
    .join(', ');
  parts.push(`Оценки по разделам: ${sectionLine}.`);

  const focus = (critical.length ? critical : warning).slice(0, 3);
  const findings = focus.map((f) => ({
    ruleId: f.ruleId,
    impact: f.message,
    recommendation: f.toolRecommendation || 'Устранить находку по рекомендации инструмента.',
    priority: f.severity === 'critical' ? 'P1' : f.severity === 'warning' ? 'P2' : 'P3',
    confidence: 'medium',
  }));

  const plan = findings.map((f) => ({
    title: f.impact,
    why: f.recommendation,
    effort: 'M',
  }));

  return {
    summary: parts.join(' '),
    focus: focus.map((f) => `${f.message} (${f.sectionLabel})`),
    findings,
    plan,
    limitations: [
      'Проверка выполнена в headless Chromium без авторизации в аккаунт.',
      'Нагрузочное тестирование, платёжные сценарии и реальные пользовательские тесты не проводились.',
    ],
    generatedBy: 'deterministic',
  };
}

/**
 * Сгенерировать клиентский текст отчёта.
 *
 * @param {object} args
 * @param {object} args.facts — факт-лист (buildFacts)
 * @param {object} [args.ai] — AI-провайдер (null -> только детерминированный текст)
 * @param {object} [args.profile] — профиль клиента
 * @param {object} [args.comparison] — данные сравнения (для сравнительного отчёта)
 * @param {object} [args.repos] — репозитории (для кэша ответов)
 * @param {Function} [args.logger]
 * @returns {Promise<{ok: boolean, narrative: object, source: 'ai'|'fallback'|'cache', validation?: object, error?: string}>}
 */
async function generateNarrative(args) {
  const { facts, ai, profile = null, comparison = null, repos = null } = args;
  const logger = args.logger || (() => {});

  const chunks = retrieve(buildQuery(facts), {
    topK: 6,
    boostTerms: facts.findings.map((f) => f.ruleId),
    maxChars: 9000,
  });

  const fallback = buildFallbackNarrative(facts);

  if (!ai || !ai.client) {
    return { ok: true, narrative: fallback, source: 'fallback', validation: { ok: true, errors: ['AI не настроен'], unknownRules: [], badNumbers: [] } };
  }

  const messages = buildMessages(facts, chunks, profile, { comparisonTask: !!comparison });
  const hash = crypto.createHash('sha256').update(`${ai.model}\n${JSON.stringify(messages)}`).digest('hex');

  if (repos && repos.aiResponses) {
    const cached = repos.aiResponses.get(hash);
    if (cached) {
      const parsed = parseModelJson(cached.response);
      const allowed = collectAllowedNumbers(facts, chunks);
      const validation = validateNarrative(parsed, facts, allowed);
      if (validation.ok) {
        return { ok: true, narrative: parsed, source: 'cache', validation };
      }
      logger('кэш отклонён проверкой фактов: ' + validation.errors.join('; '));
    }
  }

  const res = await ai.complete(messages, {
    model: ai.model,
    maxTokens: Math.max(ai.maxTokens || 2000, 3000),
    temperature: 0.2,
  });

  if (!res.ok) {
    logger('AI недоступен: ' + res.error);
    return { ok: true, narrative: fallback, source: 'fallback', validation: { ok: false, errors: [res.error], unknownRules: [], badNumbers: [] }, error: res.error };
  }

  const parsed = parseModelJson(res.text);
  if (!parsed) {
    logger('AI вернул невалидный JSON');
    return { ok: true, narrative: fallback, source: 'fallback', validation: { ok: false, errors: ['невалидный JSON'], unknownRules: [], badNumbers: [] } };
  }

  const allowed = collectAllowedNumbers(facts, chunks);
  const validation = validateNarrative(parsed, facts, allowed);
  if (!validation.ok) {
    logger('ответ AI отклонён: ' + validation.errors.join('; '));
    return {
      ok: true,
      narrative: fallback,
      source: 'fallback',
      validation,
    };
  }

  if (repos && repos.aiResponses) {
    try {
      repos.aiResponses.set({
        promptHash: hash,
        model: ai.model,
        response: JSON.stringify(parsed),
        tokensIn: res.tokensIn || null,
        tokensOut: res.tokensOut || null,
      });
    } catch (err) {
      logger('не удалось сохранить в кэш: ' + err.message);
    }
  }

  return { ok: true, narrative: parsed, source: 'ai', validation };
}

module.exports = {
  buildFacts,
  buildMessages,
  buildFallbackNarrative,
  collectAllowedNumbers,
  validateNarrative,
  parseModelJson,
  extractNumbers,
  numberAllowed,
  generateNarrative,
  SYSTEM_PROMPT,
  SECTION_LABELS,
};
