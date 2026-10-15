/**
 * Открытие SQLite, PRAGMA, миграции по PRAGMA user_version.
 *
 * Миграции — SQL-файлы в src/db/migrations/NNN_имя.sql.
 * Версия миграции = числовой префикс имени файла. Применяются по порядку,
 * только те, чей номер больше текущего user_version, каждая — в транзакции.
 *
 * Никаких ORM: только better-sqlite3 (см. ТЗ).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'owa.db');

/** Открыть (и при необходимости создать) БД с нужными PRAGMA. */
function openDb(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');   // ТЗ: режим WAL
  db.pragma('foreign_keys = ON');    // нужен для ON DELETE CASCADE в code_findings
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Применить недостающие миграции. Возвращает { version, applied }. */
function migrate(db) {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const current = db.pragma('user_version', { simple: true });
  let applied = 0;

  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (Number.isNaN(version)) {
      throw new Error(`Имя миграции должно начинаться с номера: ${file}`);
    }
    if (version <= current) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    });
    apply();
    applied += 1;
  }

  return { version: db.pragma('user_version', { simple: true }), applied };
}

let instance = null;

/** Ленивый singleton: открыть БД и применить миграции (при старте сервера). */
function getDb() {
  if (!instance) {
    instance = openDb();
    migrate(instance);
  }
  return instance;
}

function closeDb() {
  if (instance) {
    instance.close();
    instance = null;
  }
}

module.exports = { openDb, migrate, getDb, closeDb, DEFAULT_DB_PATH, MIGRATIONS_DIR };
