/**
 * Единая точка исходящих запросов с защитой от SSRF.
 *
 * Основа — ssrf-guard:
 *   - validateUrl() резолвит DNS ОДИН раз и возвращает проверенные адреса;
 *   - createPinnedDispatcher() пинит эти адреса в сокет — DNS повторно не
 *     опрашивается, поэтому окно TOCTOU/DNS-rebinding закрыто;
 *   - редиректы обрабатываем сами: каждый следующий ход заново валидируется
 *     (и резолвится, и пинится), поэтому редирект в приватную сеть отсекается.
 *
 * Правила по умолчанию (коммерческий режим, модуль 3 ТЗ):
 *   - только http/https;
 *   - приватные диапазоны (127.0.0.0/8, 10/8, 172.16/12, 169.254/16 — включая
 *     cloud metadata 169.254.169.254, ::1, ULA, link-local) — ЗАБЛОКИРОВАНЫ;
 *   - localhost / *.localhost / *.local / *.internal — ЗАБЛОКИРОВАНЫ.
 * Локальная разработка ("аудит сборки на localhost:3000") — только через
 * явное OWA_ALLOW_PRIVATE_TARGETS=1.
 *
 * Каждая заблокированная попытка логируется: URL + причина.
 */
'use strict';

const path = require('path');
const { Agent, fetch: undiciFetch } = require('undici');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
} catch (e) {
  // .env нет — работаем на process.env
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = 'OWA-Audit/1.0 (+https://github.com/maf1kkk/OWA)';
const BLOCKED_HOSTNAMES = {
  exact: ['metadata.google.internal', 'metadata', 'instance-data'],
  suffixes: ['.internal', '.local'],
};

/** Ленивая загрузка ESM-модуля ssrf-guard (пакет ESM-only). */
let guardPromise = null;
function loadGuard() {
  if (!guardPromise) {
    guardPromise = (async () => {
      const core = await import('ssrf-guard');
      const node = await import('ssrf-guard/node');
      return { core, node };
    })();
  }
  return guardPromise;
}

/** Разрешён ли приватный адрес (локальная разработка)? */
function allowPrivate() {
  return process.env.OWA_ALLOW_PRIVATE_TARGETS === '1';
}

/** Хост-исключение для локальной разработки: разрешённые хосты. */
function allowedPrivateHosts() {
  return String(process.env.OWA_ALLOW_PRIVATE_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Разрешён ли конкретный хост в режиме локальной разработки. */
function isExplicitlyAllowedHost(hostname) {
  if (!allowPrivate()) return false;
  const allowList = allowedPrivateHosts();
  const h = String(hostname || '').toLowerCase();
  if (allowList.length === 0) return true;
  return allowList.includes(h);
}

/** Обработчики заблокированных попыток (для логов и метрик). */
const blockedListeners = new Set();

function onBlocked(listener) {
  blockedListeners.add(listener);
  return () => blockedListeners.delete(listener);
}

function reportBlocked(url, reason, err) {
  const entry = {
    url: String(url),
    reason,
    message: err && err.message ? err.message : String(err || reason),
    at: new Date().toISOString(),
  };
  console.warn('[ssrf] заблокирован запрос: ' + entry.url + ' — ' + entry.reason);
  for (const listener of blockedListeners) {
    try {
      listener(entry);
    } catch (e) {
      // слушатель не должен ломать запрос
    }
  }
  return entry;
}

/** Ошибка с понятным кодом — её отдают наружу (HTTP 400/403). */
class BlockedRequestError extends Error {
  constructor(url, reason, cause) {
    super('Запрос заблокирован политикой безопасности: ' + reason + ' (' + url + ')');
    this.name = 'BlockedRequestError';
    this.code = 'SSRF_BLOCKED';
    this.reason = reason;
    this.url = url;
    this.cause = cause;
  }
}

/**
 * Проверить URL: схема, хост, резолв адресов.
 * @returns {Promise<{url: string, addresses: Array<{address: string, family: number}>, pinned: boolean}>}
 */
async function assertSafeUrl(url) {
  const { node } = await loadGuard();
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    const err = new BlockedRequestError(url, 'некорректный URL');
    reportBlocked(url, 'некорректный URL', err);
    throw err;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new BlockedRequestError(url, 'схема не разрешена: ' + parsed.protocol);
    reportBlocked(url, 'схема не разрешена', err);
    throw err;
  }

  if (isExplicitlyAllowedHost(parsed.hostname)) {
    // Явное разрешение локальной разработки: адрес не резолвим и не пиним.
    return { url: parsed.toString(), addresses: [], pinned: false };
  }

  try {
    const addresses = await node.validateUrl(parsed.toString(), {
      blockedHostnames: BLOCKED_HOSTNAMES,
    });
    return { url: parsed.toString(), addresses, pinned: true };
  } catch (err) {
    const reason = err && err.code === 'DNS_NULL_ROUTE'
      ? 'DNS вернул только null-route адреса'
      : 'адрес в приватном диапазоне или заблокирован политикой';
    const wrapped = new BlockedRequestError(url, reason, err);
    reportBlocked(url, reason, err);
    throw wrapped;
  }
}

/**
 * Выполнить запрос с пинингом адреса (или без него, если адрес явно разрешён).
 * @returns {Promise<{status: number, headers: object, url: string}>}
 */
async function requestOnce(url, options = {}) {
  const { node } = await loadGuard();
  const checked = await assertSafeUrl(url);

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const headers = {
    'user-agent': options.userAgent || DEFAULT_USER_AGENT,
    ...(options.headers || {}),
  };

  let dispatcher;
  if (checked.pinned && checked.addresses.length) {
    dispatcher = node.createPinnedDispatcher(checked.addresses, {
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  }

  try {
    const resp = await undiciFetch(checked.url, {
      method: options.method || 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    });
    const respHeaders = {};
    // undici отдаёт Headers-объект: Object.entries() по нему пуст,
    // поэтому читаем через forEach/get.
    if (resp.headers && typeof resp.headers.forEach === 'function') {
      resp.headers.forEach((value, key) => {
        respHeaders[String(key).toLowerCase()] = value;
      });
    } else {
      for (const [k, v] of Object.entries(resp.headers || {})) respHeaders[k.toLowerCase()] = v;
    }
    const location = respHeaders.location || (resp.headers && resp.headers.get ? resp.headers.get('location') : null);
    return {
      status: resp.status,
      headers: respHeaders,
      location: location || null,
      url: checked.url,
      body: resp,
    };
  } finally {
    if (dispatcher) await dispatcher.close().catch(() => {});
  }
}

/**
 * Безопасный fetch: DNS резолвится один раз, адрес проверяется и пинится,
 * каждый редирект перепроверяется и пинится заново.
 *
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<object>} { status, headers, url, body }
 */
async function safeFetch(url, opts = {}) {
  const maxRedirects = Number.isFinite(opts.maxRedirects) ? opts.maxRedirects : DEFAULT_MAX_REDIRECTS;
  let current = String(url);
  let hops = 0;

  for (;;) {
    let resp;
    try {
      resp = await requestOnce(current, opts);
    } catch (err) {
      if (err instanceof BlockedRequestError) throw err;
      const reason = /private|not allowed|blocked/i.test(String(err && err.message))
        ? 'редирект или ответ ведёт в приватный диапазон'
        : String(err && err.message || err);
      const wrapped = new BlockedRequestError(current, reason, err);
      reportBlocked(current, reason, err);
      throw wrapped;
    }

    const isRedirect = resp.status >= 300 && resp.status < 400 && resp.location;
    if (!isRedirect) {
      return resp;
    }
    if (hops >= maxRedirects) {
      const err = new BlockedRequestError(url, 'слишком много редиректов (' + maxRedirects + ')');
      reportBlocked(current, 'слишком много редиректов', err);
      throw err;
    }

    let next;
    try {
      next = new URL(resp.location, current).toString();
    } catch {
      const err = new BlockedRequestError(resp.location, 'некорректный адрес редиректа');
      reportBlocked(resp.location, 'некорректный адрес редиректа', err);
      throw err;
    }
    hops += 1;
    current = next;
    // Следующая итерация вызовет assertSafeUrl для нового адреса:
    // приватная цель редиректа отсекается здесь.
  }
}

/**
 * safeFetch + чтение тела строкой.
 * @returns {Promise<{status: number, headers: object, body: string, url: string}>}
 */
async function safeFetchText(url, opts = {}) {
  const resp = await safeFetch(url, opts);
  let body = '';
  try {
    body = await resp.body ? await resp.body.text() : '';
  } catch {
    body = '';
  }
  return {
    status: resp.status,
    headers: resp.headers || {},
    body,
    url: resp.url || String(url),
  };
}

/**
 * Проверка IP-адреса без сети (для тестов и для проверки URL ресурсов).
 * @param {string} ip
 */
async function isPrivateAddress(ip) {
  const { core } = await loadGuard();
  return core.isPrivateIp(String(ip));
}

module.exports = {
  safeFetch,
  safeFetchText,
  assertSafeUrl,
  isPrivateAddress,
  onBlocked,
  BlockedRequestError,
  allowPrivate,
  allowedPrivateHosts,
  isExplicitlyAllowedHost,
};