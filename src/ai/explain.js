/**
 * AI-объяснения находок статического анализа (ТЗ 4.2):
 * - промпт детерминированный (данные находки, без секретов);
 * - кэш: sha256(model + prompt) -> таблица ai_responses (SQLite);
 * - повторный запрос тех же данных берётся из кэша без обращения к GLM.
 */
'use strict';

const crypto = require('crypto');
const { complete } = require('./client');

const SYSTEM_PROMPT =
  'Ты — помощник веб-разработчика. Кратко объясни (2-3 предложения, по-русски) найденную ' +
  'проблему: в чём её причина и как исправить. Опирайся только на переданные данные, ' +
  'без вступлений и без выдуманных деталей.';

/** Сообщения для одной находки (детерминированно). */
function buildMessages(finding) {
  const lines = [
    `Правило: ${finding.rule}`,
    `Уровень: ${finding.severity || 'info'}`,
    `Что найдено: ${finding.message}`,
    finding.location ? `Где: ${finding.location}` : null,
    finding.suggestion ? `Подсказка инструмента: ${finding.suggestion}` : null,
  ].filter(Boolean);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** sha256(model + prompt) — ключ кэша (ТЗ 4.2). */
function promptHash(model, messages) {
  return crypto.createHash('sha256').update(`${model}\n${JSON.stringify(messages)}`).digest('hex');
}

/**
 * Объяснить одну находку (сначала кэш, затем LLM-провайдер).
 * @returns {Promise<{ok:true, text, cached:boolean}|{ok:false, error:string}>}
 */
async function explainFinding(finding, { ai, repos }) {
  const messages = buildMessages(finding);
  const hash = promptHash(ai.model, messages);

  const cached = repos.aiResponses.get(hash);
  if (cached) return { ok: true, text: cached.response, cached: true };

  const res = await ai.complete(messages, {
    model: ai.model,
    maxTokens: ai.maxTokens,
    temperature: ai.temperature,
  });
  if (!res.ok) return res;

  repos.aiResponses.set({
    promptHash: hash,
    model: ai.model,
    response: res.text,
    tokensIn: null,
    tokensOut: null,
  });
  return { ok: true, text: res.text, cached: false };
}

/**
 * Объяснить строки code_findings без aiExplanation (или все, при force).
 * Успешные объяснения сразу сохраняются в code_findings.ai_explanation;
 * при первой ошибке процесс прекращается (повторный дозапустит остаток).
 *
 * @returns {Promise<{ok:true, explained, cached}|{ok:false, error, explained, cached}|{ok:false, error:'AI_NOT_CONFIGURED'}>}
 */
async function explainMissing(rows, { ai, repos, force = false }) {
  if (!ai || !ai.client) return { ok: false, error: 'AI_NOT_CONFIGURED', explained: 0, cached: 0 };
  const targets = force ? rows : rows.filter((r) => !r.aiExplanation);
  let explained = 0;
  let cached = 0;

  for (const row of targets) {
    const res = await explainFinding(row, { ai, repos });
    if (!res.ok) return { ok: false, error: res.error, explained, cached };
    repos.codeFindings.setAiExplanation(row.id, res.text);
    row.aiExplanation = res.text;
    explained += 1;
    if (res.cached) cached += 1;
  }
  return { ok: true, explained, cached };
}

module.exports = { buildMessages, promptHash, explainFinding, explainMissing, SYSTEM_PROMPT };
