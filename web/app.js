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
const { createAuth } = require('./auth');

const INDEX_HTML = path.join(__dirname, 'index.html');

function createApp({ db, auth }) {
  const repos = createRepos(db);
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(securityHeaders);
  app.use(requireAuth(auth));

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

module.exports = { createApp, createAuth, HttpError };