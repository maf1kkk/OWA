/**
 * Авторизация для веб-интерфейса OWA (ТЗ 4.1, итерация 5).
 *
 * Два независимых механизма, включаются через .env:
 *
 *   1) Basic Auth — по паре AUTH_LOGIN / AUTH_PASSWORD_HASH (bcrypt-хэш).
 *      Нужен для доступа к UI и API извне.
 *   2) Bearer-токен — по API_BEARER_TOKEN. Альтернатива Basic: клиент присылает
 *      заголовок "Authorization: Bearer <token>". Сравнение тайминг-защищённое.
 *
 * Без всякой настройки (обе переменные пустые) сервер считается приватным:
 * доступ разрешён, но web/server.js откажется слушать 0.0.0.0 — открытый
 * доступ без авторизации запрещён.
 *
 * Переменные читаются один раз при старте процесса (createAuth), поэтому
 * изменение .env требует перезапуска сервера — это осознанное решение:
 * никаких гонок между потоками и случайной «половины применённой» конфигурации.
 */
'use strict';

const bcrypt = require('bcrypt');
const crypto = require('node:crypto');

/** Сравнение строк за постоянное время. Длины точно решаются в фиксированное окно. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Извлечь Basic-креды из заголовка. null — заголовка нет или он не Basic. */
function parseBasic(header) {
  if (typeof header !== 'string' || !/^basic /i.test(header)) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { login: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

/**
 * @param {object} [env]
 * @returns {{basicEnabled:boolean, bearerEnabled:boolean, public:boolean,
 *            verifyLogin:(u:string,p:string)=>boolean, verifyBearer:(h:string)=>boolean}}
 */
function createAuth(env = process.env) {
  const login = (env.AUTH_LOGIN || '').trim();
  const hash = (env.AUTH_PASSWORD_HASH || '').trim();
  const token = (env.API_BEARER_TOKEN || '').trim();

  const basicEnabled = Boolean(login && hash);
  const bearerEnabled = Boolean(token);

  return {
    basicEnabled,
    bearerEnabled,
    /** true — авторизации нет вообще (приватный режим, наружу не смотреть) */
    public: !basicEnabled && !bearerEnabled,

    async verifyLogin(user, password) {
      if (!basicEnabled) return false;
      if (user !== login) return false;
      try {
        return await bcrypt.compare(password, hash);
      } catch {
        // битый хэш = отказ (логируем, но без самого хэша)
        console.error('[auth] AUTH_PASSWORD_HASH не является корректным bcrypt-хэшем');
        return false;
      }
    },

    verifyBearer(header) {
      if (!bearerEnabled) return false;
      const m = /^bearer (.+)$/i.exec(String(header || ''));
      if (!m) return false;
      return safeEqual(m[1].trim(), token);
    },
  };
}

module.exports = { createAuth, parseBasic, safeEqual };