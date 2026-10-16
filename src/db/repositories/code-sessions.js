/**
 * Репозиторий code_sessions — сессии статического анализа кода.
 * Собранные исходники (css/js) хранятся сжатыми (gzip) в sources_gz,
 * прогресс — в cursor_json: { css: N, js: M } — сколько файлов обработано.
 */
'use strict';

function createCodeSessionsRepo(db) {
  const insertStmt = db.prepare(
    `INSERT INTO code_sessions (analysis_id, url, created_at, updated_at, status, step, sources_gz, cursor_json, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const getStmt = db.prepare(`SELECT * FROM code_sessions WHERE id = ?`);
  const updateStmt = db.prepare(
    `UPDATE code_sessions
        SET updated_at = ?, status = ?, step = ?, sources_gz = ?, cursor_json = ?, error = ?
      WHERE id = ?`
  );
  const deleteStmt = db.prepare(`DELETE FROM code_sessions WHERE id = ?`);

  function rowToSession(r) {
    if (!r) return null;
    return {
      id: r.id,
      analysisId: r.analysis_id,
      url: r.url,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      status: r.status,
      step: r.step,
      sourcesGz: r.sources_gz, // Buffer | null
      cursor: r.cursor_json ? JSON.parse(r.cursor_json) : {},
      error: r.error,
    };
  }

  return {
    create({ analysisId, url, step = 'fetch', sourcesGz = null, cursor = {}, status = 'in_progress' }) {
      const now = Date.now();
      const info = insertStmt.run(
        analysisId,
        url,
        now,
        now,
        status,
        step,
        sourcesGz,
        JSON.stringify(cursor),
        null
      );
      return Number(info.lastInsertRowid);
    },

    get(id) {
      return rowToSession(getStmt.get(id));
    },

    update({ id, status, step, sourcesGz, cursor, error = null, updatedAt = Date.now() }) {
      const current = rowToSession(getStmt.get(id));
      if (!current) return 0;
      return updateStmt.run(
        updatedAt,
        status,
        step,
        sourcesGz === undefined ? current.sourcesGz : sourcesGz,
        JSON.stringify(cursor === undefined ? current.cursor : cursor),
        error,
        id
      ).changes;
    },

    remove(id) {
      return deleteStmt.run(id).changes;
    },
  };
}

module.exports = { createCodeSessionsRepo };
