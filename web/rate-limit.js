/**
 * Ограничение частоты запросов (rate limit) — в памяти, без зависимостей.
 *
 * Зачем: каждый анализ — запуск Chromium (сотни МБ RAM, секунды CPU).
 * Без лимита один клиент может завалить сервер запросами. Хранит счётчики
 * по IP, окно фиксированное (проще и дешевле sliding window).
 *
 * Для продакшена за прокси заменяется на распределённый вариант
 * (Redis и т.п.), контракт вызовов не меняется.
 */
'use strict';

/**
 * @param {object} opts
 * @param {number} opts.max максимум запросов за окно
 * @param {number} opts.windowMs длина окна, мс
 * @param {(path: string) => boolean} [opts.shouldLimit] — какой путь лимитировать (по умолч. все)
 */
function createRateLimiter({ max = 10, windowMs = 60000, shouldLimit = () => true } = {}) {
  const buckets = new Map();

  function key(ip, path) {
    return `${ip}|${path}`;
  }

  /**
   * Проверить запрос. Возвращает оставшиеся попытки (0 — отказ).
   * Если shouldLimit(path) === false — запрос не лимитируется (бесконечный remaining).
   */
  function check(ip, path) {
    if (!shouldLimit(path)) return Infinity;
    const now = Date.now();
    const k = key(ip, path);
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(k, b);
    }
    if (b.count >= max) return 0;
    b.count += 1;
    return max - b.count;
  }

  /** Сброс всех счётчиков (для тестов). */
  function reset() {
    buckets.clear();
  }

  // Чистим протухшие записи, чтобы карта не росла бесконечно
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  }, windowMs).unref();

  return { check, reset, max, windowMs };
}

module.exports = { createRateLimiter };
