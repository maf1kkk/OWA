/**
 * Точка входа AI-слоя: ленивая конфигурация из .env (GLM_*),
 * объяснения находок с кэшем в SQLite.
 */
'use strict';

const { createChatClient, complete } = require('./client');
const { buildMessages, promptHash, explainFinding, explainMissing, SYSTEM_PROMPT } = require('./explain');

let instance = null;

/**
 * Ленивый singleton-конфиг. cfg — только для тестов/точной настройки
 * (apiKey, baseURL, timeoutMs, model, maxTokens, temperature).
 */
function getAi(cfg = {}) {
  if (!instance) {
    const client = createChatClient(cfg);
    instance = {
      client,
      configured: !!client,
      model: cfg.model || process.env.GLM_MODEL || 'glm-4.5',
      maxTokens: Number(cfg.maxTokens || process.env.GLM_MAX_TOKENS || 2000),
      temperature: Number(cfg.temperature !== undefined ? cfg.temperature : process.env.GLM_TEMPERATURE ?? 0.3),
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
};
