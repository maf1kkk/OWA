/**
 * Клиент GLM (OpenAI-совместимый API) через официальный SDK `openai`.
 *
 * ТЗ: таймаут 30 с, retry ровно 1 раз только на 5xx,
 * ошибки нормализуются к { error: 'AI_TIMEOUT' | 'AI_ERROR' }.
 *
 * Никогда ничего не логирует: промпты и ответы LLM — секреты (ТЗ).
 */
'use strict';

const OpenAI = require('openai');

const DEFAULT_TIMEOUT_MS = 30000; // ТЗ: таймаут 30 с

/** Создать клиент (null, если ключ не задан). */
function createChatClient(cfg = {}) {
  const apiKey = cfg.apiKey !== undefined ? cfg.apiKey : process.env.GLM_API_KEY;
  if (!apiKey) return null;
  const baseURL = cfg.baseURL !== undefined ? cfg.baseURL : process.env.GLM_BASE_URL;
  const timeoutMs = Number(cfg.timeoutMs || process.env.GLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return new OpenAI({
    apiKey,
    baseURL: baseURL || undefined,
    timeout: timeoutMs,
    maxRetries: 0, // свои ретраи: ровно 1 раз на 5xx (ТЗ)
  });
}

function isTimeout(err) {
  if (!err) return false;
  if (err instanceof OpenAI.APIConnectionTimeoutError) return true;
  const name = String(err.name || '');
  const msg = String(err.message || '');
  return name.includes('Timeout') || name === 'AbortError' || /timed out|timeout/i.test(msg);
}

function is5xx(err) {
  return err instanceof OpenAI.APIError && typeof err.status === 'number' && err.status >= 500;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function okResult(res, model) {
  return {
    ok: true,
    text: (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || '',
    model: res.model || model,
    tokensIn: res.usage ? res.usage.prompt_tokens ?? null : null,
    tokensOut: res.usage ? res.usage.completion_tokens ?? null : null,
  };
}

/**
 * Один вызов chat.completions (+1 повтор на 5xx).
 * @returns {Promise<{ok:true, text, model, tokensIn, tokensOut}|{ok:false, error:'AI_TIMEOUT'|'AI_ERROR'}>}
 */
async function complete(client, { model, messages, maxTokens, temperature }) {
  if (!client) return { ok: false, error: 'AI_ERROR' };
  const call = () =>
    client.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    });

  try {
    return okResult(await call(), model);
  } catch (err) {
    if (isTimeout(err)) return { ok: false, error: 'AI_TIMEOUT' };
    if (is5xx(err)) {
      // ТЗ: повтор 1 раз на 5xx
      await sleep(400);
      try {
        return okResult(await call(), model);
      } catch (err2) {
        if (isTimeout(err2)) return { ok: false, error: 'AI_TIMEOUT' };
        return { ok: false, error: 'AI_ERROR' };
      }
    }
    // 4xx (в т.ч. 429 «нет баланса»), сетевые и прочие — без повтора
    return { ok: false, error: 'AI_ERROR' };
  }
}

module.exports = { createChatClient, complete, DEFAULT_TIMEOUT_MS, isTimeout, is5xx };
