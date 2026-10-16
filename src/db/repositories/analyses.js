/**
 * Репозиторий analyses — тонкая обёртка над prepared statements.
 * Тяжёлые поля (metrics/findings/interpretation) хранятся как JSON-строки,
 * наружу отдаются распарсенными.
 */
'use strict';

function safeParse(json, fallback = null) {
  if (json === null || json === undefined) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function createAnalysesRepo(db) {
  const insertStmt = db.prepare(
    `INSERT INTO analyses (url, created_at, duration_ms, metrics_json, findings_json, interpretation_json, summary, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const listStmt = db.prepare(
    `SELECT id, url, created_at, duration_ms, summary, status
       FROM analyses
      WHERE (? IS NULL OR url = ?)
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`
  );
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM analyses WHERE (? IS NULL OR url = ?)`
  );
  const getStmt = db.prepare(`SELECT * FROM analyses WHERE id = ?`);
  const finalizeStmt = db.prepare(`UPDATE analyses SET summary = ?, status = ? WHERE id = ?`);
  const deleteStmt = db.prepare(`DELETE FROM analyses WHERE id = ?`);
  const clearStmt = db.prepare(`DELETE FROM analyses`);

  return {
    /** @returns {number} id новой записи */
    insert({
      url,
      createdAt = Date.now(),
      durationMs = null,
      metrics = {},
      findings = [],
      interpretation = null,
      summary = null,
      status = 'ok',
    }) {
      const info = insertStmt.run(
        String(url),
        createdAt,
        durationMs,
        JSON.stringify(metrics ?? {}),
        JSON.stringify(findings ?? []),
        interpretation ? JSON.stringify(interpretation) : null,
        summary ? JSON.stringify(summary) : null,
        status
      );
      return Number(info.lastInsertRowid);
    },

    /** Список без тяжёлых JSON-полей (для GET /api/history) */
    list({ limit = 50, offset = 0, url = null } = {}) {
      const rows = listStmt.all(url, url, limit, offset);
      return {
        items: rows.map((r) => ({
          id: r.id,
          url: r.url,
          createdAt: r.created_at,
          durationMs: r.duration_ms,
          summary: safeParse(r.summary),
          status: r.status,
        })),
        total: countStmt.get(url, url).n,
      };
    },

    /** Полная запись + распарсенные JSON (для GET /api/history/:id) */
    get(id) {
      const r = getStmt.get(id);
      if (!r) return null;
      return {
        id: r.id,
        url: r.url,
        createdAt: r.created_at,
        durationMs: r.duration_ms,
        status: r.status,
        summary: safeParse(r.summary),
        metrics: safeParse(r.metrics_json, {}),
        findings: safeParse(r.findings_json, []),
        interpretation: safeParse(r.interpretation_json),
      };
    },

    /** Метрики во времени для графиков: по URL или все, по.created_at по возрастанию. */
    metricsSeries({ url = null, limit = 30 } = {}) {
      const stmt = db.prepare(
        `SELECT id, created_at, summary, metrics_json FROM analyses
         WHERE (? IS NULL OR url = ?)
         ORDER BY created_at DESC, id DESC LIMIT ?`
      );
      const rows = stmt.all(url, url, limit).reverse();
      return rows.map((r) => {
        const s = safeParse(r.summary);
        const m = safeParse(r.metrics_json, {});
        const vitals = m.vitals || {};
        const lt = m.legacyTiming || {};
        const rt = m.resources || {};
        const lts = m.longTasks || {};
        return {
          id: r.id,
          createdAt: r.created_at,
          score: s && typeof s.score === 'number' ? s.score : null,
          status: s && s.status,
          lcpMs: vitals.lcpMs ?? null,
          cls: vitals.cls ?? null,
          fcpMs: (m.paint && m.paint.firstContentfulPaint) ?? null,
          tbtMs: lts.totalBlockingTime ?? null,
          resources: rt.count ?? null,
          loadMs: lt.loadTime ?? null,
          longTasks: lts.count ?? null,
          jsErrors: Array.isArray(m.jsErrors) ? m.jsErrors.length : null,
        };
      });
    },

    /** @returns {number} сколько удалено */
    remove(id) {
      return deleteStmt.run(id).changes;
    },

    /** Полная очистка истории. @returns {number} сколько удалено */
    clear() {
      return clearStmt.run().changes;
    },

    /** Обновить итог/статус записи (финализация сессии статанализа). */
    finalize({ id, summary = null, status = 'ok' }) {
      return finalizeStmt.run(summary ? JSON.stringify(summary) : null, status, id).changes;
    },
  };
}

module.exports = { createAnalysesRepo };
