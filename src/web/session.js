/**
 * Лог операций текущей сессии + кэш готовых результатов.
 *
 * Нужен, чтобы:
 *   - «Скачать PDF» отдавал отчёт по конкретной проверке, а не по всему UI;
 *   - «Отчёт за сессию» собирал сводку по всем выполненным операциям;
 *   - повторно скачивать тот же отчёт, не запуская анализ заново.
 *
 * Хранение в памяти процесса: при перезапуске сервера лог пуст — это осознанно
 * (история проверок лежит в БД, а лог сессии — про текущий рабочий день).
 */
'use strict';

const CACHE_TTL_MS = 60 * 60 * 1000; // час
const CACHE_MAX = 50;
const OPS_MAX = 200;

/** id -> { type, result, at } */
const results = new Map();
/** Лог операций: [{ id, type, url, at, score, issueCount, issues }] */
const operations = [];

function sweep() {
  const now = Date.now();
  for (const [id, entry] of results) {
    if (now - entry.at > CACHE_TTL_MS) results.delete(id);
  }
}

/**
 * Сохранить результат операции.
 * @param {string} type — 'analyze' | 'audit' | 'crawl' | 'compare'
 * @param {object} result — полный результат
 * @param {object} [meta] — { url, score, issueCount, issues }
 * @returns {string} id результата
 */
function put(type, result, meta = {}) {
  sweep();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const at = new Date().toISOString();
  results.set(id, { type, result, at });

  operations.push({
    id,
    type,
    url: meta.url || (result && result.url) || '',
    at,
    score: typeof meta.score === 'number' ? meta.score : null,
    issueCount: typeof meta.issueCount === 'number' ? meta.issueCount : 0,
    issues: Array.isArray(meta.issues) ? meta.issues : [],
  });
  while (operations.length > OPS_MAX) operations.shift();
  while (results.size > CACHE_MAX) results.delete(results.keys().next().value);

  return id;
}

/** Получить результат по id. */
function get(id) {
  sweep();
  return results.get(id) || null;
}

/** Лог операций (новые первыми). */
function listOperations() {
  return operations.slice().reverse();
}

/** Очистить лог и кэш (кнопка «очистить сессию»). */
function clear() {
  results.clear();
  operations.length = 0;
}

module.exports = { put, get, listOperations, clear, results, operations };
