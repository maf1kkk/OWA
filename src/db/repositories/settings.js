/**
 * Репозиторий settings — простые пары ключ/значение (обе строки).
 */
'use strict';

function createSettingsRepo(db) {
  const getStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
  const setStmt = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  const allStmt = db.prepare(`SELECT key, value FROM settings ORDER BY key`);
  const deleteStmt = db.prepare(`DELETE FROM settings WHERE key = ?`);

  return {
    get(key) {
      const row = getStmt.get(key);
      return row ? row.value : null;
    },

    set(key, value, updatedAt = Date.now()) {
      setStmt.run(String(key), String(value), updatedAt);
      return key;
    },

    all() {
      const out = {};
      for (const row of allStmt.all()) out[row.key] = row.value;
      return out;
    },

    remove(key) {
      return deleteStmt.run(key).changes;
    },
  };
}

module.exports = { createSettingsRepo };
