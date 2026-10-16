/**
 * Базовый интерфейс AI-провайдера (JSDoc-типы, без внешних зависимостей).
 *
 * Провайдер — абстракция над конкретным LLM-вендором (OpenAI, Anthropic,
 * Ollama, GLM, Together и любой другой OpenAI-совместимый endpoint).
 * Конфигурация и логика повторных попыток живут в реализации провайдера.
 */
'use strict';

/**
 * @typedef {Object} AIProvider
 * @property {(messages: Array, opts: object) => Promise<{ok: boolean, text?: string, cached?: boolean, error?: string}>} complete
 * @property {() => boolean} isConfigured
 * @property {string} name
 * @property {string} model
 * @property {number} maxTokens
 * @property {number} temperature
 * @property {object|null} client — внутренний клиент (для обратной совместимости с explain.js)
 */

/**
 * Конфигурация провайдера, нормализованная из env.
 * @typedef {Object} ProviderConfig
 * @property {string} apiKey
 * @property {string} [baseURL]
 * @property {string} [model]
 * @property {number} [timeoutMs]
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 */

module.exports = {};
