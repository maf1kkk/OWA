/**
 * Обслуживание БД: ретеншн истории и чекпоинт WAL.
 *
 * Без этого `analyses` растёт бесконечно (в том числе на упавших анализах),
 * `sources_gz` (gzip всех исходников, до 15 МБ) остаётся после завершения
 * сессии, а WAL-файл раздувается, пока БД не закрыть.
 *
 * Всё вызывается из веб-сервера по расписанию — CLI его не требует
 * (у него одна задача на процесс).
 */
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {number} [opts.retentionDays]  сколько дней хранить анализы (0 = без лимита)
 * @param {number} [opts.tzPadMs]       запас на часовые пояса/дрейф часов
 */
function createMaintenance(db, opts = {}) {
  const retentionDays = Number.isFinite(opts.retentionDays)
    ? opts.retentionDays
    : Number(process.env.OWA_RETENTION_DAYS ?? 30);

  const deleteOldAnalyses = db.prepare(`DELETE FROM analyses WHERE created_at < ?`);
  const deleteDeadSessions = db.prepare(
    `DELETE FROM code_sessions WHERE status NOT IN ('in_progress') AND updated_at < ?`
  );
  const clearSourcesGz = db.prepare(
    `UPDATE code_sessions SET sources_gz = NULL
      WHERE sources_gz IS NOT NULL AND status <> 'in_progress'`
  );
  const aiCacheOld = db.prepare(`DELETE FROM ai_responses WHERE created_at < ?`);

  /**
   * Удалить просроченное.
   * @returns {{analyses:number, aiResponses:number, sessions:number, sourcesCleared:number}}
   */
  function prune({ now = Date.now() } = {}) {
    const horizon = now - retentionDays * DAY_MS;
    const tx = db.transaction(() => ({
      analyses: retentionDays > 0 ? deleteOldAnalyses.run(horizon).changes : 0,
      aiResponses: retentionDays > 0 ? aiCacheOld.run(horizon).changes : 0,
      sessions: retentionDays > 0 ? deleteDeadSessions.run(horizon).changes : 0,
      // gzip чистим всегда: после done он больше не нужен, но весит мегабайты
      sourcesCleared: clearSourcesGz.run().changes,
    }));
    return tx();
  }

  /** Транкейт WAL: отдать страницы основному файлу, обнулить -wal. */
  function checkpoint() {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      return true;
    } catch {
      return false;
    }
  }

  /** Полный прогон: чистка + чекпоинт. */
  function run() {
    const result = prune();
    checkpoint();
    return result;
  }

  return { prune, checkpoint, run, retentionDays };
}

module.exports = { createMaintenance };
