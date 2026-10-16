/**
 * Запуск браузера для анализа.
 *
 * Основной путь — Chromium, скачанный Playwright (`npx playwright install chromium`).
 * Если его нет (нет интернета, CDN недоступен, CI без кэша браузеров), падать не
 * хочется: пробуем системный Chromium-браузер — Chrome или Edge (тот же движок).
 * Канал можно задать явно через OWA_BROWSER_CHANNEL=chrome|msedge.
 */

const path = require('node:path');

// CLI и MCP-сервер не поднимают web/server.js, поэтому .env грузим здесь —
// иначе OWA_BROWSER_CHANNEL из .env не виден им. Реальный env приоритетнее.
// Если .env нет (standalone-режим, CI без .env) — dotenv молча пропускает,
// browser.js падает не на .env, а на запуске браузера с понятным hint.
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
} catch (e) {
  // .env отсутствует или не читается — не критично, используем process.env
}

const { chromium } = require('playwright');

const FALLBACK_CHANNELS = ['chrome', 'msedge'];

/**
 * @param {boolean} [headless]
 * @returns {Promise<import('playwright').Browser>}
 */
async function launchBrowser(headless = true) {
  const preferred = (process.env.OWA_BROWSER_CHANNEL || '').trim();
  const attempts = [];

  if (preferred) {
    attempts.push({ channel: preferred });
  } else {
    attempts.push({});
  }
  for (const channel of FALLBACK_CHANNELS) {
    if (channel !== preferred) attempts.push({ channel });
  }

  const errors = [];
  for (const options of attempts) {
    try {
      return await chromium.launch({ headless, ...options });
    } catch (err) {
      const label = options.channel ? `channel=${options.channel}` : 'bundled chromium';
      errors.push(`${label}: ${(err && err.message ? err.message : String(err)).split('\n')[0]}`);
    }
  }

  const hint = [
    'Не удалось запустить браузер. Попробованы:',
    ...errors.map((e) => `  - ${e}`),
    '',
    'Что делать:',
    '  1) скачать Chromium Playwright:  npx playwright install chromium',
    '  2) или указать системный браузер: OWA_BROWSER_CHANNEL=chrome (или msedge)',
  ].join('\n');

  const error = new Error(hint);
  error.code = 'BROWSER_LAUNCH_FAILED';
  throw error;
}

module.exports = { launchBrowser };