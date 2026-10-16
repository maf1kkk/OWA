/**
 * Null-провайдер: AI не настроен.
 *
 * Возвращает { ok:false, error:'AI_NOT_CONFIGURED' } без сетевых вызовов.
 * Используется когда AI_PROVIDER=none или ключ API не задан.
 */
'use strict';

function createNullProvider() {
  return {
    name: 'none',
    isConfigured: () => false,
    model: '',
    maxTokens: 0,
    temperature: 0,
    client: null,
    async complete() {
      return { ok: false, error: 'AI_NOT_CONFIGURED' };
    },
  };
}

module.exports = { createNullProvider };
