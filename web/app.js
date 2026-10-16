/**
 * Фабрика Express-приложения OWA.
 *
 * Вынесена из server.js, чтобы тесты могли поднимать роуты без порта
 * и управлять подключением к БД (инъекция db/repos).
 */
'use strict';

const path = require('path');
const express = require('express');
const { createRepos } = require('../src/db/repositories');
const { createApiRouter } = require('./routes/api');
const { createCodeAnalysisRouter } = require('./routes/code-analysis');
const { createAiRouter } = require('./routes/ai');
const { errorHandler, notFoundHandler, HttpError } = require('./middleware/validate');
const { requireAuth, attachHeader } = require('./middleware/auth');
const { createRateLimiter } = require('./rate-limit');
const { createAuth } = require('./auth');

const INDEX_HTML = path.join(__dirname, 'index.html');

/**
 * Лимиты по умолчанию — с учётом типовых сценариев:
 *   - каждый анализ = запуск Chromium (сотни МБ RAM, секунды CPU);
 *   - /api/history* — дешёвые SQLite-запросы, но тоже DDoS-вектор.
 * Максимум запросов на IP за окно; 0 — отключить (локальный режим).
 */
const DEFAULT_RL_MAX = 20;
const DEFAULT_RL_WINDOW_MS = 60000;

function createRateLimitMiddleware(env = process.env) {
  const max = Number(env.OWA_RATE_LIMIT_MAX ?? DEFAULT_RL_MAX);
  const windowMs = Number(env.OWA_RATE_LIMIT_WINDOW_MS ?? DEFAULT_RL_WINDOW_MS);
  if (!Number.isFinite(max) || !Number.isFinite(windowMs) || max <= 0 || windowMs <= 0) {
    return null; // отключено / мусор — не блокируем запросы
  }

  const limiter = createRateLimiter({
    max,
    windowMs,
    // Лимит только на /api/*: UI и health-эндпоинты открыты (мониторинг),
    // а /api/analyze — узкое место (Chromium).
    shouldLimit: (p) => p.startsWith('/api/'),
  });

  return function rateLimitMiddleware(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const remaining = limiter.check(ip, req.path);

    if (remaining === Infinity) return next(); // UI / health — без лимита

    // Заголовки — стандарт RFC 6585, чтобы клиенты (включая ИИ-агентов)
    // могли читать состояние лимита и планировать повторы.
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(remaining, 0)));

    if (remaining === 0) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      const err = new HttpError(429, 'RATE_LIMITED', 'Слишком много запросов, попробуйте позже');
      return next(err);
    }
    next();
  };
}

function createApp({ db, auth, env = process.env }) {
  const repos = createRepos(db);
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(securityHeaders);
  app.use(requireAuth(auth));

  const rateLimit = createRateLimitMiddleware(env);
  if (rateLimit) app.use(rateLimit);
  app.use(createApiRouter({ repos }));
  app.use(createCodeAnalysisRouter({ repos }));
  app.use(createAiRouter({ repos }));

  // UI (существующий одностраничник)
  app.get('/', (_req, res) => {
    res.type('html').sendFile(INDEX_HTML);
  });
  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  app.use(notFoundHandler);
  // Express 5: 4-аргументный обработчик считается error handler'ом
  app.use((err, req, res, _next) => {
    // 401 требует WWW-Authenticate, иначе браузер не покажет форму входа
    if (err && err.status === 401) attachHeader(res, err);
    errorHandler(err, req, res, _next);
  });

  app.locals.repos = repos;
  app.locals.auth = auth;
  return app;
}

/**
 * Базовая защита отклика/кликджекинга. Полноценный CSP — на UI,
 * который отдаёт только index.html без внешних ресурсов.
 */
function securityHeaders(_req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
}

module.exports = { createApp, createAuth, HttpError, createRateLimitMiddleware };
