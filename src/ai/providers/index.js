/**
 * Реестр AI-провайдеров. Выбор по AI_PROVIDER (дефолт: none).
 *
 * Поддерживаемые значения:
 *   - openai       — OpenAI-совместимый endpoint (OpenAI, GLM, Together, Ollama и т.д.)
 *   - anthropic    — alias для openai-compatible (Anthropic имеет OpenAI-совместимый
 *                    endpoint через /v1/chat/completions на некоторых прокси)
 *   - ollama       — локальный Ollama (OpenAI-совместимый endpoint на localhost:11434)
 *   - glm          — GLM (Zhipu), OpenAI-совместимый
 *   - none         — AI выключен (дефолт)
 *
 * Для обратной совместимости: GLM_* поддерживаются как алиасы.
 * Если задан GLM_API_KEY и не задан AI_API_KEY — используем GLM_* как openai-compatible.
 */
'use strict';

const { createOpenAICompatibleProvider } = require('./openai-compatible');
const { createNullProvider } = require('./null');

const KNOWN = ['openai', 'anthropic', 'ollama', 'glm', 'none'];

/**
 * Создать провайдер из env.
 * @param {object} [env] — объект с переменными окружения (по умолчанию process.env).
 * @returns {AIProvider}
 */
function createProvider(env = process.env) {
  const providerName = (env.AI_PROVIDER || 'none').trim().toLowerCase();

  // GLM_* — алиасы для обратной совместимости:
  // если GLM_API_KEY задан, но AI_PROVIDER не переопределён явно — включаем GLM.
  if (env.GLM_API_KEY && providerName === 'none') {
    console.error('[ai] GLM_* заданы, но AI_PROVIDER не переопределён — включен openai-compatible (GLM)');
    return createOpenAICompatibleProvider({
      apiKey: env.GLM_API_KEY,
      baseURL: env.GLM_BASE_URL || undefined,
      model: env.GLM_MODEL || 'glm-4.5',
      timeoutMs: Number(env.GLM_TIMEOUT_MS || 30000),
      maxTokens: Number(env.GLM_MAX_TOKENS || 2000),
      temperature: Number(env.GLM_TEMPERATURE !== undefined ? env.GLM_TEMPERATURE : 0.3),
    });
  }

  if (!KNOWN.includes(providerName)) {
    // Неизвестный провайдер — warning + none
    console.error(`[ai] AI_PROVIDER="${providerName}" неизвестно, использую none`);
    return createNullProvider();
  }

  if (providerName === 'none') {
    return createNullProvider();
  }

  // openai / anthropic / ollama / glm — все OpenAI-совместимые endpoint'ы.
  // Базовый URL по умолчанию зависит от провайдера.
  const defaults = {
    openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    anthropic: { baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514' },
    ollama: { baseURL: 'http://localhost:11434/v1', model: 'llama3' },
    glm: { baseURL: 'https://api.z.ai/api/paas/v4', model: 'glm-4.5' },
  };
  const d = defaults[providerName];

  return createOpenAICompatibleProvider({
    apiKey: env.AI_API_KEY || '',
    baseURL: env.AI_BASE_URL || d.baseURL,
    model: env.AI_MODEL || d.model,
    timeoutMs: Number(env.AI_TIMEOUT_MS || 30000),
    maxTokens: Number(env.AI_MAX_TOKENS || 2000),
    temperature: Number(env.AI_TEMPERATURE !== undefined ? env.AI_TEMPERATURE : 0.3),
  });
}

module.exports = { createProvider, KNOWN };
