/**
 * OpenAI-совместимый провайдер: OpenAI, GLM (Zhipu), Together, Ollama,
 * любой самохост с /chat/completions.
 *
 * Использует официальный SDK `openai` — совместим со всеми, кто следует
 * OpenAI-протоколу. Повтор ровно 1 раз на 5xx, таймаут нормализуется
 * в { ok:false, error:'AI_TIMEOUT' }.
 *
 * Никогда не логирует промпты/ответы (ТЗ: секреты).
 */
'use strict';

const { complete: completeRaw, createChatClient } = require('../client');

/**
 * @param {object} cfg
 * @param {string} cfg.apiKey
 * @param {string} [cfg.baseURL]
 * @param {string} [cfg.model]
 * @param {number} [cfg.timeoutMs]
 * @param {number} [cfg.maxTokens]
 * @param {number} [cfg.temperature]
 * @returns {AIProvider}
 */
function createOpenAICompatibleProvider(cfg = {}) {
  const c = createChatClient({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    timeoutMs: cfg.timeoutMs,
  });

  const model = cfg.model || 'gpt-4o-mini';
  const maxTokens = Number(cfg.maxTokens || 2000);
  const temperature = Number(cfg.temperature !== undefined ? cfg.temperature : 0.3);
  // GLM-4.5: режим размышления по умолчанию включён — он медленный и тратит
  // токены. AI_THINKING=0 выключает его (по умолчанию выключаем для отчётов).
  const thinkingEnabled = String(cfg.thinking !== undefined ? cfg.thinking : process.env.AI_THINKING || '0') === '1';
  const extraBody = thinkingEnabled ? undefined : { thinking: { type: 'disabled' } };

  const provider = {
    name: cfg.providerName || 'openai-compatible',
    isConfigured: () => c !== null,
    get model() { return model; },
    get maxTokens() { return maxTokens; },
    get temperature() { return temperature; },
    get thinkingEnabled() { return thinkingEnabled; },
    client: c,
    async complete(messages, opts = {}) {
      const res = await completeRaw(c, {
        model: opts.model || model,
        messages,
        maxTokens: opts.maxTokens || maxTokens,
        temperature: opts.temperature !== undefined ? opts.temperature : temperature,
        extraBody: opts.extraBody !== undefined ? opts.extraBody : extraBody,
      });
      // Нормализуем к интерфейсу провайдера, сохраняя токены для кэша
      if (res.ok) {
        return { ok: true, text: res.text, cached: false, tokensIn: res.tokensIn, tokensOut: res.tokensOut };
      }
      return { ok: false, error: res.error };
    },
  };

  // Обратная совместимость: статическое поле configured
  provider.configured = provider.isConfigured();
  return provider;
}

module.exports = { createOpenAICompatibleProvider };
