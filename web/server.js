#!/usr/bin/env node
/**
 * OWA Web — локальный веб-интерфейс и API.
 *
 * Запуск: node web/server.js  (или start.bat / start.sh)
 * UI:     http://localhost:3210
 * Health: GET /health  → { status, version, uptime }
 *
 * Настройки берутся из .env (PORT, HOST).
 * До итерации 5 (Basic Auth) слушаем только 127.0.0.1 — открытого
 * доступа без авторизации быть не должно (ТЗ 4.1).
 *
 * Для ИИ-агентов: POST /api/analyze возвращает тот же JSON, что и CLI --json.
 * MCP-сервер и CLI продолжают работать как раньше.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { getDb } = require('../src/db');
const { createApp } = require('./app');

const PORT = parseInt(process.env.PORT, 10) || 3210;
const HOST = process.env.HOST || '127.0.0.1';

// Открытие БД + миграции при старте (ТЗ 7.6)
const db = getDb();
const app = createApp({ db });

app.listen(PORT, HOST, () => {
  console.log(`OWA Web: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Health:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/health`);
  console.log('Для ИИ: POST /api/analyze {"url":"https://example.com"}');
});
