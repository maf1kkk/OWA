/**
 * Middleware авторизации OWA.
 *
 * Порядок: Health-эндпоинты открыты (мониторинг), всё остальное — под авторизацией,
 * если она включена. Приватный режим (ничего не настроено) пускает всех, но
 * web/server.js в этом режиме откажется слушать 0.0.0.0.
 */
'use strict';

const { HttpError } = require('./validate');
const { parseBasic } = require('../auth');

/** Здоровье/мониторинг: открыто всегда, чтобы проверки связности не падали. */
const PUBLIC_PATHS = new Set(['/health', '/api/health', '/favicon.ico']);

function isPublic(pathname) {
  return PUBLIC_PATHS.has(pathname);
}

/**
 * @param {ReturnType<import('../auth').createAuth>} auth
 * @returns {import('express').RequestHandler}
 */
function requireAuth(auth) {
  // async: bcrypt.compare асинхронный, "забыть" await — пустить всех
  return async (req, res, next) => {
    if (auth.public || isPublic(req.path)) return next();

    // Bearer приоритетнее для /api/* (для агентов и скриптов),
    // для остального (UI) — Basic, если включён
    if (auth.bearerEnabled && req.path.startsWith('/api/')) {
      if (auth.verifyBearer(req.get('authorization'))) return next();
      throw unauthorized('Нужен заголовок Authorization: Bearer <API_BEARER_TOKEN>', true);
    }

    if (auth.basicEnabled) {
      const creds = parseBasic(req.get('authorization'));
      if (creds && (await auth.verifyLogin(creds.login, creds.password))) return next();
    }

    throw unauthorized('Нужна Basic-авторизация (AUTH_LOGIN / AUTH_PASSWORD_HASH)', false);
  };
}

function unauthorized(message, bearerRealm) {
  const err = new HttpError(401, 'UNAUTHORIZED', message);
  // Bearer — для скриптов есть причина ретраить с токеном; Basic — форма браузера
  err.wwwAuthenticate = bearerRealm
    ? 'Bearer realm="OWA"'
    : 'Basic realm="OWA", charset="UTF-8"';
  return err;
}

/** Чтобы errorHandler мог отработать заголовок из ошибки. */
function attachHeader(res, err) {
  if (err && err.wwwAuthenticate) res.set('WWW-Authenticate', err.wwwAuthenticate);
}

module.exports = { requireAuth, isPublic, unauthorized, attachHeader };