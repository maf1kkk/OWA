#!/usr/bin/env node
/**
 * OWA Web — локальный веб-интерфейс и API.
 *
 * Запуск: node web/server.js  (или start.bat / start.sh)
 * UI:     http://localhost:3210
 * Health: GET /health  → { status, version, uptime }
 *
 * Настройки берутся из .env (PORT, HOST, AUTH_*, API_BEARER_TOKEN).
 *
 * Доступность (ТЗ 4.1):
 *   - без AUTH_PASSWORD_HASH/API_BEARER_TOKEN — только 127.0.0.1 (защита по
 *     умолчанию: открытого доступа без пароля не будет);
 *   - с авторизацией — 0.0.0.0 разрешён.
 *
 * Для ИИ-агентов: POST /api/analyze возвращает тот же JSON, что и CLI --json.
 * MCP-сервер и CLI продолжают работать как раньше.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { getDb, closeDb } = require('../src/db');
const { createApp, createAuth } = require('./app');

const PORT = parseInt(process.env.PORT, 10) || 3210;
const HOST = process.env.HOST || '127.0.0.1';
const WEEKDAYS = 7; // для расчёта uptime, если понадобится

const auth = createAuth(process.env);

// Слушать все интерфейсы без пароля нельзя: отказ при старте, а не доступ в сеть
if (HOST === '0.0.0.0' || HOST === '::') {
  if (auth.public) {
    console.error('HOST=0.0.0.0 без авторизации запрещён (ТЗ 4.1).');
    console.error('Задайте в .env: AUTH_LOGIN + AUTH_PASSWORD_HASH (Basic) или API_BEARER_TOKEN (Bearer),');
    console.error('либо оставьте HOST=127.0.0.1 для локального доступа.');
    process.exit(1);
  }
}

// Открытие БД + миграции при старте (ТЗ 7.6)
const db = getDb();
const app = createApp({ db, auth });

// Обслуживание БД: ретеншен и чекпоинт WAL (по умолчанию раз в 6 часов)
const { createMaintenance } = require('../src/db/maintenance');
const maintenance = createMaintenance(db);
const maintenanceEveryMs = Number(process.env.OWA_MAINTENANCE_EVERY_MS ?? 6 * 60 * 60 * 1000);
const maintenanceTimer = setInterval(() => {
  try {
    const r = maintenance.run();
    console.log(
      `[maintenance] retention ${maintenance.retentionDays} дн.: ` +
        `удалено analyses=${r.analyses}, ai_responses=${r.aiResponses}, сессий=${r.sessions}; ` +
        `очищено sources_gz=${r.sourcesCleared}`,
    );
  } catch (err) {
    console.error('[maintenance] не выполнилось:', err && err.message);
  }
}, maintenanceEveryMs);
maintenanceTimer.unref();

const server = app.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`OWA Web: http://${shown}:${PORT}`);
  console.log(`Health:  http://${shown}:${PORT}/health`);
  console.log('Для ИИ: POST /api/analyze {"url":"https://example.com"}');
  if (auth.basicEnabled || auth.bearerEnabled) {
    const kinds = [auth.basicEnabled ? 'Basic' : null, auth.bearerEnabled ? 'Bearer' : null].filter(Boolean);
    console.log(`Авторизация: ${kinds.join(' + ')}`);
  } else {
    console.log('Авторизация: выключена — слушаю только localhost (HOST=127.0.0.1)');
  }
});

/** Корректное завершение: закрыть БД (чекпоинт WAL), затем процесс. */
function shutdown(signal) {
  console.log(`\n${signal} — останавливаю OWA Web...`);
  server.close(async () => {
    try {
      closeDb();
    } catch (err) {
      console.error('[shutdown] не удалось закрыть БД:', err && err.message);
    }
    process.exit(0);
  });
  // Если соединения не закроются — не висим вечно
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});

// метка, чтобы не ругался линтер на неиспользуемые константы при рефакторе
void WEEKDAYS;
