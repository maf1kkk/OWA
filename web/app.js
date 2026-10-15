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
const { errorHandler, notFoundHandler } = require('./middleware/validate');

const INDEX_HTML = path.join(__dirname, 'index.html');

function createApp({ db }) {
  const repos = createRepos(db);
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use(createApiRouter({ repos }));
  app.use(createCodeAnalysisRouter({ repos }));
  app.use(createAiRouter({ repos }));

  // UI (существующий одностраничник)
  app.get('/', (_req, res) => {
    res.type('html').sendFile(INDEX_HTML);
  });
  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  app.use(notFoundHandler);
  app.use(errorHandler);

  app.locals.repos = repos;
  return app;
}

module.exports = { createApp };
