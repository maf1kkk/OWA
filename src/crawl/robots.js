/**
 * robots.txt: соблюдение правил роботов (robots-parser).
 *
 * Файл необязателен: если его нет — обход разрешён целиком.
 * Если robots.txt есть и правило Disallow покрывает путь — страницу
 * не обходим (иначе получаем блок от поисковиков и жалобы).
 */
'use strict';

const robotsParser = require('robots-parser');

/**
 * Загрузить и разобрать robots.txt.
 * @param {string} baseUrl — origin сайта (robots.txt берётся с корня)
 * @returns {Promise<{parser: object|null, raw: string, exists: boolean}>}
 */
async function loadRobots(baseUrl) {
  const { safeFetchText } = require('../security/safe-fetch');
  let origin;
  try {
    const u = new URL(baseUrl);
    origin = u.origin + '/robots.txt';
  } catch {
    return { parser: null, raw: '', exists: false };
  }

  try {
    const res = await safeFetchText(origin, { timeoutMs: 10000, maxRedirects: 2 });
    if (res.status >= 400) {
      return { parser: robotsParser(origin, ''), raw: '', exists: false };
    }
    return { parser: robotsParser(origin, res.body), raw: res.body, exists: true };
  } catch (err) {
    // robots.txt недоступен (в т.ч. заблокирован SSRF-политикой) —
    // считаем, что ограничений нет, но факт фиксируем.
    return { parser: null, raw: '', exists: false, error: String(err && err.message || err).slice(0, 120) };
  }
}

/**
 * Разрешён ли обход URL по robots.txt.
 * @param {object|null} robots — результат loadRobots
 * @param {string} url
 */
function isAllowed(robots, url) {
  if (!robots || !robots.parser) return true;
  try {
    // Второй аргумент isAllowed — user-agent, а не URL robots.txt.
    // Без него применяются правила для '*'.
    return robots.parser.isAllowed(url) !== false;
  } catch {
    return true;
  }
}

module.exports = { loadRobots, isAllowed };