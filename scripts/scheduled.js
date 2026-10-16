/**
 * Scheduled-анализ списка сайтов (CLI-сценарий для cron / GitHub Actions).
 *
 * Для каждого URL из OWA_SCHEDULE_URLS:
 *   1. Запускает analyse() — те же метрики, что и в веб-UI / MCP.
 *   2. Сохраняет результат в SQLite (таблица analyses).
 *   3. Сравнивает с предыдущим запуском того же URL (diffWithBaseline).
 *   4. При регрессии (метрика стала хуже на >= OWA_SCHEDULE_THRESHOLD_PCT)
 *      фиксирует её в итоговом JSON.
 *
 * Выход:
 *   stdout — JSON { url: { ok, score, status, regressions: [...] }, ... }
 *   exit-код — 0 если регрессий нет, 1 если есть (удобно для Actions).
 *
 * Переменные окружения (.env):
 *   OWA_SCHEDULE_URLS        — URL через запятую (обязательно)
 *   OWA_SCHEDULE_SELECTORS   — CSS-селекторы виджетов через запятую (опционально)
 *   OWA_SCHEDULE_WAIT_MS     — ожидание после load, мс (по умолч. 5000)
 *   OWA_SCHEDULE_TIMEOUT_MS  — таймаут навигации, мс (по умолч. 60000)
 *   OWA_SCHEDULE_THRESHOLD_PCT — порог регрессии в % (по умолч. 5)
 *   DB_PATH                  — путь к SQLite (по умолч. data/owa.db)
 */
'use strict';

require('dotenv').config();
const { analyze } = require('../src/engine');
const { openDb, migrate } = require('../src/db');
const { createRepos } = require('../src/db/repositories');
const { diffWithBaseline } = require('../src/diff');

function listEnv(name, dflt = '') {
  const v = process.env[name] || dflt;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function clampRange(v, min, max, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
}

(async () => {
  const urls = listEnv('OWA_SCHEDULE_URLS');
  if (urls.length === 0) {
    console.error('OWA_SCHEDULE_URLS не задан: перечислите URL через запятую');
    process.exit(2);
  }

  const selectors = listEnv('OWA_SCHEDULE_SELECTORS');
  const waitMs = clampRange(process.env.OWA_SCHEDULE_WAIT_MS, 0, 60000, 5000);
  const timeoutMs = clampRange(process.env.OWA_SCHEDULE_TIMEOUT_MS, 5000, 120000, 60000);
  const thresholdPct = clampRange(process.env.OWA_SCHEDULE_THRESHOLD_PCT, 1, 100, 5);

  const dbPath = process.env.DB_PATH;
  const db = openDb(dbPath);
  migrate(db);
  const repos = createRepos(db);

  const results = {};
  let hasRegression = false;

  try {
    for (const url of urls) {
      const entry = { url, regressions: [], score: null, status: null, error: null };

      let current;
      try {
        current = await analyze(url, {
          waitAfterLoad: waitMs,
          timeout: timeoutMs,
          widgetSelectors: selectors.length ? selectors : null,
          headless: true,
        });
        entry.score = current.interpretation.summary.score;
        entry.status = current.interpretation.summary.status;

        repos.analyses.insert({
          url,
          metrics: current.metrics,
          findings: current.interpretation.findings,
          interpretation: current.interpretation,
          summary: current.interpretation.summary,
          status: 'ok',
        });
      } catch (err) {
        entry.error = String(err && err.message || err);
        results[url] = entry;
        hasRegression = true;
        continue;
      }

      // Сравнение с предыдущим запуском того же URL
      const history = repos.analyses.list({ url, limit: 2, offset: 0 });
      if (history.items.length >= 2) {
        const previous = repos.analyses.get(history.items[1].id);
        if (previous && previous.metrics) {
          const diff = diffWithBaseline(
            { metrics: current.metrics },
            { metrics: previous.metrics },
            thresholdPct
          );
          for (const row of diff.rows) {
            if (row.regression) {
              entry.regressions.push({
                metric: row.metric,
                baseline: row.baseline,
                current: row.current,
                delta: row.delta,
                pct: row.pct,
              });
              hasRegression = true;
            }
          }
        }
      }

      results[url] = entry;
    }

    console.log(JSON.stringify(results, null, 2));
  } finally {
    db.close();
  }

  process.exit(hasRegression ? 1 : 0);
})().catch((err) => {
  console.error(String(err && err.stack || err));
  process.exit(2);
});
