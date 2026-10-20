/**
 * Текст полного отчёта по сайту: резюме для руководства + план работ на N месяцев.
 *
 * Как и в обычном отчёте, модель НЕ выдумывает факты: ей отдаётся
 * факт-лист (агрегаты обхода, находки по частоте, оценки разделов, сравнение
 * с конкурентами, метрики) и выдержки из базы знаний. Ответ проверяется:
 * числа — только из фактов, ruleId — только среди реальных находок.
 */
'use strict';

const crypto = require('crypto');
const { retrieve } = require('./rag');
const { profileToPromptText } = require('./client-profile');
const { collectAllowedNumbers, deriveAllowedNumbers, parseModelJson, extractNumbers, numberAllowed } = require('./report-generator');

const SYSTEM_PROMPT = [
  'Ты — технический директор, который готовит итог комплексного аудита сайта для владельца бизнеса и его подрядчика.',
  '',
  'ЖЁСТКИЕ ПРАВИЛА (нарушение = ответ отклоняется):',
  '1. Опирайся ТОЛЬКО на блок FACTS. Не выдумывай числа, правила, сроки внедрения и факты о клиенте.',
  '2. Каждая находка в findings должна ссылаться на ruleId из FACTS.findings. Других ruleId быть не может.',
  '3. Числа в тексте — только из FACTS или из KNOWLEDGE.',
  '4. Не обещай результат («конверсия вырастет на 30%», «гарантируем»). Формулируй как «устранение X уберёт Y».',
  '5. Не заявляй соответствие стандартам и регуляторам, не обещай юридическую защиту.',
  '6. Говори с владельцем бизнеса понятно, но без приукрашивания: сначала что мешает заработать, потом технические детали.',
  '7. План разбивай по месяцам (месяц 1/2/3). В каждом пункте: что сделать, зачем, ожидаемый эффект, трудоёмкость (S/M/L).',
  '8. Если данных не хватает для вывода — напиши, что нужно проверить дополнительно, и не выдумывай.',
  '9. КАЖДЫЙ пункт плана обязан быть конкретным: назовите действие (что именно менять), объём (сколько элементов или страниц — только числа из FACTS), применимое ruleId из FACTS и критерий приёмки.',
  '   Запрещены формулировки без конкретики: «оптимизировать производительность», «улучшить SEO», «повысить безопасность».',
  '   Правильно: «поднять контраст текста до 4.5:1 в палитре темы — 81 элемент на 41 странице (правило color-contrast)».',
  '',
  'ФОРМАТ ОТВЕТА — строго JSON:',
  '{',
  '  "summary": "3-5 предложений для руководства: состояние сайта, главные потери, что делать первым",',
  '  "focus": ["3 главные проблемы одной строкой каждая — с цифрами"],',
  '  "findings": [',
  '    { "ruleId": "...", "impact": "влияние на бизнес или пользователя", "recommendation": "что делать", "priority": "P1|P2|P3", "effort": "S|M|L" }',
  '  ],',
  '  "plan": [',
  '    { "month": 1, "title": "что сделать (конкретно)", "why": "зачем", "impact": "что изменится и критерий приёмки", "effort": "S|M|L", "ruleIds": ["правило"] }',
  '  ],',
  '  "limitations": ["что не проверялось и что стоит проверить дополнительно"]',
  '}',
].join('\n');

/**
 * Собрать факт-лист полного отчёта.
 * @param {object} args
 * @param {object} args.audit — результат runFullAudit
 * @param {object} [args.crawl] — результат crawlSite
 * @param {object} [args.scan] — результат локального сканера (опционально)
 * @param {object} [args.compare] — результат compareSites
 * @returns {object}
 */
function buildFullFacts(args) {
  const { audit, crawl = null, scan = null, compare = null } = args;
  const facts = {
    url: audit.url,
    date: audit.timestamp,
    tool: 'OWA (headless Chromium: Performance API, axe-core, обход сайта)',
    integralScore: audit.integralScore,
    sections: {},
    metrics: {},
    findings: [],
    totals: {},
  };

  for (const [name, sec] of Object.entries(audit.scores || {})) {
    facts.sections[name] = {
      score: sec.score,
      issues: (sec.issues || []).length,
    };
    for (const issue of sec.issues || []) {
      facts.findings.push({
        ruleId: issue.rule || issue.id,
        section: name,
        severity: issue.severity,
        message: issue.message,
        occurrences: (issue.occurrences !== undefined ? issue.occurrences : null),
      });
    }
  }
  const perf = audit.scores && audit.scores.performance;
  facts.metrics = (perf && perf.raw && perf.raw.metrics) || {};

  if (crawl) {
    const a = crawl.aggregate || {};
    facts.crawl = {
      pageCount: a.pageCount,
      failedCount: a.failedCount,
      avgScore: a.avgScore,
      avgMetrics: a.avgMetrics,
      topIssues: (a.topIssues || []).slice(0, 15).map((i) => ({
        ruleId: i.rule,
        severity: i.severity,
        pages: i.count,
      })),
      worstPages: (a.worstPages || []).slice(0, 8).map((p) => ({ url: p.url, score: p.score })),
    };
  }

  if (scan) {
    facts.security = {
      edge: scan.edge || null,
      rateLimit: scan.rateLimit || null,
      findings: (scan.findings || []).map((f) => ({
        ruleId: f.rule,
        severity: f.severity,
        message: f.desc,
      })),
    };
  }

  if (compare) {
    facts.comparison = {
      competitorAvg: compare.competitorAvg === undefined ? null : compare.competitorAvg,
      targetAvg: compare.target && compare.target.avgSectionScore !== undefined ? compare.target.avgSectionScore : null,
      sites: (compare.sites || []).map((s) => ({
        url: s.url,
        label: s.label,
        role: s.role,
        avgSectionScore: s.avgSectionScore,
        sections: Object.fromEntries(
          Object.entries(s.sections || {}).map(([k, v]) => [k, v.score])
        ),
        metrics: s.metrics || {},
      })),
      sectionRows: (compare.sectionRows || []).map((r) => ({
        label: r.label,
        values: r.values,
        deltaToBest: r.deltaToBest,
        best: r.best,
      })),
      metricRows: (compare.metricRows || []).map((r) => ({
        label: r.label,
        unit: r.unit,
        values: r.values,
      })),
    };
  }

  facts.totals = {
    findings: facts.findings.length,
    critical: facts.findings.filter((f) => f.severity === 'critical').length,
    warning: facts.findings.filter((f) => f.severity === 'warning').length,
  };

  // Счётчики по разделам: нужны, чтобы формулировки вида «6 отсутствующих
  // заголовков» были обоснованы фактами, а не выдумкой модели.
  facts.counts = {};
  for (const [name, sec] of Object.entries(facts.sections)) {
    facts.counts[name] = facts.findings.filter((f) => f.section === name).length;
  }
  if (facts.crawl) {
    facts.counts.pagesWithIssues = facts.crawl.pageCount;
    facts.counts.pages = facts.crawl.pageCount;
  }

  return facts;
}

/** Поисковый запрос для RAG: по частым находкам и разделам. */
function buildFullQuery(facts) {
  const parts = [];
  for (const i of facts.findings.slice(0, 20)) parts.push(i.ruleId, i.message);
  if (facts.crawl) for (const i of facts.crawl.topIssues.slice(0, 10)) parts.push(i.ruleId);
  for (const name of Object.keys(facts.sections)) parts.push(name);
  return parts.join(' ');
}

/**
 * Проверить ответ модели.
 * @returns {{ok: boolean, errors: string[], badNumbers: string[]}}
 */
function validateFullNarrative(narrative, facts, allowedNumbers, derivedNumbers = null) {
  const errors = [];
  const badNumbers = [];

  if (!narrative || typeof narrative !== 'object') {
    return { ok: false, errors: ['ответ не объект'], badNumbers };
  }
  if (typeof narrative.summary !== 'string' || narrative.summary.trim().length < 40) {
    errors.push('пустое summary');
  }
  if (!Array.isArray(narrative.plan) || narrative.plan.length < 3) {
    errors.push('план короче 3 пунктов');
  }
  if (!Array.isArray(narrative.findings)) {
    errors.push('findings не массив');
  }

  const known = new Set(facts.findings.map((f) => f.ruleId));
  for (const f of narrative.findings || []) {
    if (!f || !f.ruleId) { errors.push('находка без ruleId'); continue; }
    if (!known.has(f.ruleId)) errors.push('неизвестный ruleId: ' + f.ruleId);
    if (!f.impact || String(f.impact).length < 10) errors.push('находка ' + f.ruleId + ': пустое влияние');
    if (!f.recommendation || String(f.recommendation).length < 10) errors.push('находка ' + f.ruleId + ': пустая рекомендация');
  }
  for (const p of narrative.plan || []) {
    if (!p || !p.title) errors.push('пункт плана без названия');
    if (!p || !p.why) errors.push('пункт плана без обоснования');
    if (p && p.month !== undefined && !(p.month >= 1 && p.month <= 12)) errors.push('неверный месяц плана');
    // Пункт плана должен ссылаться на реальные правила: иначе это общие слова.
    const refs = Array.isArray(p && p.ruleIds) ? p.ruleIds : [];
    if (!refs.length) errors.push('пункт плана без ruleIds');
    for (const r of refs) {
      if (!known.has(r)) errors.push('пункт плана: неизвестный ruleId ' + r);
    }
  }

  const text = JSON.stringify(narrative);
  for (const { raw, value } of extractNumbers(text)) {
    if (!numberAllowed(value, allowedNumbers, derivedNumbers)) badNumbers.push(raw);
  }
  if (badNumbers.length) errors.push('числа не из фактов: ' + [...new Set(badNumbers)].join(', '));

  return { ok: errors.length === 0, errors, badNumbers: [...new Set(badNumbers)] };
}

/**
 * Сгенерировать текст полного отчёта.
 * @param {object} args
 * @param {object} args.facts
 * @param {object} [args.ai]
 * @param {object} [args.profile]
 * @param {object} [args.repos]
 * @param {Function} [args.logger]
 */
async function generateFullNarrative(args) {
  const { facts, ai = null, profile = null, repos = null } = args;
  const logger = args.logger || (() => {});

  const chunks = retrieve(buildFullQuery(facts), {
    topK: 8,
    boostTerms: facts.findings.map((f) => f.ruleId).concat((facts.crawl ? facts.crawl.topIssues.map((i) => i.ruleId) : [])),
    maxChars: 10000,
  });
  const allowed = collectAllowedNumbers(facts, chunks);
  // Производные числа (разности, средние, отношения) — арифметика над фактами.
  const derived = deriveAllowedNumbers(allowed);

  if (!ai || !ai.client) {
    return { ok: true, narrative: buildDeterministicPlan(facts), source: 'fallback', validation: { ok: true, errors: [], badNumbers: [] } };
  }

  const knowledge = chunks.map((c, i) => `[${i + 1}] ${c.heading}\n${c.text}`).join('\n\n');
  const user = [
    'FACTS:',
    JSON.stringify(facts, null, 2),
    '',
    'KNOWLEDGE:',
    knowledge || '(нет)',
    '',
    'CLIENT:',
    profileToPromptText(profile) || '(профиль не задан)',
    '',
    'Составь план работ на 3 месяца. Верни только JSON по схеме.',
  ].join('\n');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];

  const hash = crypto.createHash('sha256').update(`${ai.model}\n${JSON.stringify(messages)}`).digest('hex');
  if (repos && repos.aiResponses) {
    const cached = repos.aiResponses.get(hash);
    if (cached) {
      const parsed = parseModelJson(cached.response);
      const validation = validateFullNarrative(parsed, facts, allowed, derived);
      if (validation.ok) return { ok: true, narrative: parsed, source: 'cache', validation };
    }
  }

  const res = await ai.complete(messages, {
    model: ai.model,
    maxTokens: Math.max(ai.maxTokens || 2000, 4000),
    temperature: 0.2,
  });
  if (!res.ok) {
    logger('AI недоступен: ' + res.error);
    return { ok: true, narrative: buildDeterministicPlan(facts), source: 'fallback', validation: { ok: false, errors: [res.error], badNumbers: [] } };
  }

  const parsed = parseModelJson(res.text);
  if (!parsed) {
    logger('AI вернул невалидный JSON');
    return { ok: true, narrative: buildDeterministicPlan(facts), source: 'fallback', validation: { ok: false, errors: ['невалидный JSON'], badNumbers: [] } };
  }

  const validation = validateFullNarrative(parsed, facts, allowed, derived);
  if (!validation.ok) {
    logger('ответ AI отклонён: ' + validation.errors.join('; '));
    return { ok: true, narrative: buildDeterministicPlan(facts), source: 'fallback', validation };
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
    } catch (err) { /* кэш не критичен */ }
  }

  return { ok: true, narrative: parsed, source: 'ai', validation };
}

/**
 * Детерминированный план (без LLM): по частоте находок и разделам.
 * @param {object} facts
 */
function buildDeterministicPlan(facts) {
  const byRule = new Map();
  for (const f of facts.findings) {
    const e = byRule.get(f.ruleId) || { ruleId: f.ruleId, severity: f.severity, count: 0, section: f.section, message: f.message };
    e.count += 1;
    byRule.set(f.ruleId, e);
  }
  if (facts.crawl) {
    for (const i of facts.crawl.topIssues) {
      const e = byRule.get(i.ruleId) || { ruleId: i.ruleId, severity: i.severity, count: 0, section: '—', message: i.ruleId };
      e.count = Math.max(e.count, i.pages);
      byRule.set(i.ruleId, e);
    }
  }
  const top = [...byRule.values()]
    .sort((a, b) => (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1) || b.count - a.count)
    .slice(0, 6);

  const plan = top.map((t, i) => ({
    month: Math.min(3, i + 1),
    title: t.ruleId,
    why: t.message,
    impact: 'затрагивает ' + t.count + ' стр.',
    effort: 'M',
    ruleIds: [t.ruleId],
  }));

  return {
    summary: 'Интегральная оценка ' + facts.integralScore + ' из 100. Найдено проблем: ' + facts.totals.findings + '.',
    focus: top.slice(0, 3).map((t) => t.message + ' (' + t.count + ' стр.)'),
    findings: top.slice(0, 3).map((t) => ({
      ruleId: t.ruleId,
      impact: t.message,
      recommendation: 'Устранить: ' + t.ruleId,
      priority: t.severity === 'critical' ? 'P1' : 'P2',
      effort: 'M',
    })),
    plan: plan.length ? plan : [{ month: 1, title: 'Устранить критичные находки', why: 'Блокируют работу сайта', impact: 'Рост стабильности', effort: 'M' }],
    limitations: ['Ссылочный профиль и нагрузочное тестирование не выполнялись'],
  };
}

module.exports = {
  buildFullFacts,
  buildFullQuery,
  validateFullNarrative,
  generateFullNarrative,
  buildDeterministicPlan,
  SYSTEM_PROMPT,
};
