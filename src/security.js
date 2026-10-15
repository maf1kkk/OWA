/**
 * Валидация URL против SSRF и утечки локальных файлов.
 *
 * Два уровня, потому что источники URL разные:
 *
 *   1) Целевой URL (тело запроса, аргумент MCP, --url в CLI) — его задаёт
 *      пользователь. У OWA это чаще всего локальный адрес: «проверь сборку на
 *      localhost:8080». Поэтому приватные адреса разрешены, а для публичного
 *      развёртывания есть жёсткий режим: OWA_DENY_PRIVATE_TARGETS=1.
 *
 *   2) URL ресурсов из HTML анализируемой страницы (см. static-analyzer:
 *      fetch-sources.js собирает ссылки на CSS/JS со страницы) — их задаёт НЕ
 *      пользователь, а произвольный сайт. Здесь только http(s) и только тот же
 *      origin, что и страница. Иначе страница вида
 *      `<link rel=stylesheet href="file:///etc/shadow">` заставила бы сервер
 *      прочитать локальный файл и отправить его в LLM-промпт, а
 *      `<script src="http://169.254.169.254/...">` — сходить в облачный
 *      metadata-сервис.
 *
 * file:// запрещён всегда: чтение файлов с диска это не измерение
 * производительности. Проверка синхронная, по самой строке; DNS-rebinding
 * дополнительно ограничивается same-origin правилом для ресурсов.
 */
'use strict';

const DENY_PRIVATE = process.env.OWA_DENY_PRIVATE_TARGETS === '1';
const ALLOW_PRIVATE = process.env.OWA_ALLOW_PRIVATE_TARGETS === '1';

/** dotted-quad в массив октетов, либо null. */
function toIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m && m.slice(1).every((o) => Number(o) <= 255)) {
    return m.slice(1).map(Number);
  }
  return null;
}

/**
 * Нестандартные записи IPv4: десятичное целое, hex, octal.
 * http://2130706433/ и http://0x7f000001/ ведут на 127.0.0.1.
 * Любой хост из одних цифр трактуем как адрес — консервативно.
 */
function expandIPv4(host) {
  const plain = toIPv4(host);
  if (plain) return plain;

  let n = null;
  if (/^\d+$/.test(host)) {
    n = parseInt(host, host.length > 1 && host.startsWith('0') ? 8 : 10);
  } else if (/^0[xX][0-9a-fA-F]+$/.test(host)) {
    n = parseInt(host.slice(2), 16);
  }
  if (!Number.isFinite(n)) return null;

  // деление вместо побитовых сдвигов: корректно и для значений > 2^31
  const o = (v) => Math.floor(v / 16777216) % 256;
  const t = (v) => Math.floor(v / 65536) % 256;
  const th = (v) => Math.floor(v / 256) % 256;
  return [o(n), t(n), th(n), n % 256];
}

/** 0.0.0.0/8, 10/8, 127/8, CGNAT, link-local (вкл. metadata), частные, multicast, reserved. */
function isPrivateIPv4([a, b]) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && b === 0) ||
    (a === 192 && b === 0 && b === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

/** ::1, ::, link-local, ULA, а также IPv4-mapped частные адреса. */
function isPrivateIPv6(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    h === '::1' ||
    h === '::' ||
    h.startsWith('fe80:') ||
    h.startsWith('fc') ||
    h.startsWith('fd') ||
    /^::ffff:(127|10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254)/.test(h)
  );
}

/** Локальный/приватный хост? */
function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = expandIPv4(h);
  if (v4) return isPrivateIPv4(v4);
  if (h.includes(':')) return isPrivateIPv6(h);
  return false;
}

/**
 * Проверить целевой URL (уровень 1: задаёт пользователь).
 * @param {string} url
 * @returns {{ok:boolean, reason?:'scheme'|'private'|'parse'}}
 */
function checkTarget(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return { ok: false, reason: 'parse' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (DENY_PRIVATE && isPrivateHost(u.hostname)) return { ok: false, reason: 'private' };
  return { ok: true };
}

/**
 * Проверить URL ресурса со страницы (уровень 2: задаёт сайт).
 * Приватные адреса запрещены всегда, ALLOW_PRIVATE тут не помогает.
 * @param {string} url
 * @returns {{ok:boolean, reason?:'scheme'|'private'|'parse'}}
 */
function checkResourceUrl(url) {
  const verdict = checkTarget(url);
  if (!verdict.ok) return verdict;
  try {
    if (isPrivateHost(new URL(String(url)).hostname)) return { ok: false, reason: 'private' };
  } catch {
    return { ok: false, reason: 'parse' };
  }
  return { ok: true };
}

/** Сохранённое имя прежней функции для совместимости импортов. */
function checkTargetUrl(url) {
  return checkTarget(url);
}

/** Быстрая проверка «похож на целевой URL» для сообщений об ошибках. */
function isSafeTargetUrl(url) {
  return checkTarget(url).ok;
}

module.exports = {
  checkTarget,
  checkResourceUrl,
  checkTargetUrl,
  isSafeTargetUrl,
  isPrivateHost,
};

// флаг доступности приватных адресов наружу — для логов/диагностики
module.exports.ALLOW_PRIVATE = ALLOW_PRIVATE && !DENY_PRIVATE;