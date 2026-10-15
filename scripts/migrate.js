#!/usr/bin/env node
/**
 * Применить миграции SQLite вручную: node scripts/migrate.js
 * (при старте сервера миграции применяются автоматически — этот скрипт
 * нужен для деплоя/проверки без запуска сервера).
 */
'use strict';

const { openDb, migrate, DEFAULT_DB_PATH } = require('../src/db');

try {
  const db = openDb();
  const { version, applied } = migrate(db);
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  console.log(`[✓] БД: ${dbPath}`);
  console.log(applied > 0 ? `[✓] Применено миграций: ${applied}` : '[✓] Миграции уже применены');
  console.log(`[✓] user_version = ${version}`);
  db.close();
  process.exit(0);
} catch (err) {
  console.error(`[!] Ошибка миграции: ${err.message}`);
  process.exit(1);
}
