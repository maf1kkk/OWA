/**
 * Точка входа AI-слоя: ленивая конфигурация из .env (AI_* / GLM_*),
 * объяснения находок с кэшем в SQLite.
 *
 * AI_PROVIDER (дефолт none): openai | anthropic | ollama | glm | none.
 * GLM_* — алиасы для обратной совместимости (если AI_* не заданы).
 */
'use strict';

const { createChatClient, complete } = require('./client');
const { createProvider } = require('./providers');
const { buildMessages, promptHash, explainFinding, explainMissing, SYSTEM_PROMPT } = require('./explain');

let instance = null;

/**
 * Ленивый singleton-конфиг. cfg — только для тестов/точной настройки
 * (apiKey, baseURL, timeoutMs, model, maxTokens, temperature).
 *
 * Возвращает объект с полями, совместимыми со старым контрактом:
 *   { client, configured, model, maxTokens, temperature, provider, complete }
 *
 * @param {object} [cfg] — переопределение (для тестов)
 * @param {object} [env] — переменные окружения (для тестов)
 */
function getAi(cfg = {}, env = process.env) {
  if (!instance) {
    let provider;
    if (cfg.apiKey !== undefined || cfg.baseURL !== undefined) {
      // Явное переопределение для тестов — создаём провайдер напрямую
      provider = createProvider({
        ...env,
        AI_API_KEY: cfg.apiKey,
        AI_BASE_URL: cfg.baseURL,
        AI_MODEL: cfg.model,
        AI_TIMEOUT_MS: cfg.timeoutMs !== undefined ? String(cfg.timeoutMs) : undefined,
        AI_MAX_TOKENS: cfg.maxTokens !== undefined ? String(cfg.maxTokens) : undefined,
        AI_TEMPERATURE: cfg.temperature !== undefined ? String(cfg.temperature) : undefined,
      });
    } else {
      provider = createProvider(env);
    }

    instance = {
      provider,
      client: provider.client,
      configured: provider.isConfigured(),
      model: provider.model,
      maxTokens: provider.maxTokens,
      temperature: provider.temperature,
      complete: provider.complete.bind(provider),
      // Обратная совместимость: поле provider.name
      get providerName() { return provider.name; },
    };
  }
  return instance;
}

/** Сбросить конфиг (нужно тестам после смены env). */
function resetAi() {
  instance = null;
}

module.exports = {
  getAi,
  resetAi,
  createChatClient,
  complete,
  explainFinding,
  explainMissing,
  buildMessages,
  promptHash,
  SYSTEM_PROMPT,
  createProvider,
};
