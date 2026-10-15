/**
 * API-роуты OWA (ТЗ 7.2).
 *
 *   GET    /health             { status, version, uptime }
 *   GET    /api/health         { ok, tool }            — существующий контракт UI
 *   POST   /api/analyze        синхронный анализ (+сохранение в историю)
 *   GET    /api/history        список анализов
 *   GET    /api/history/:id    детали анализа
 *   DELETE /api/history/:id    удалить (каскадно)
 *   DELETE /api/history        очистить историю целиком
 */
'use strict';

const express = require('express');
const { z } = require('zod');
const { analyze } = require('../../src/engine');
const { buildCompact } = require('../../src/interpret');
const {
  HttpError,
  validateBody,
  validateQuery,
  validateParams,
} = require('../middleware/validate');

const VERSION = require('../../package.json').version;

const analyzeSchema = z.object({
  url: z.string().min(1, 'URL обязателен'),
  selectors: z.array(z.string()).optional(),
  waitMs: z.coerce.number().int().optional(),
  timeoutMs: z.coerce.number().int().optional(),
  headed: z.boolean().optional(),
  consoleLogs: z.boolean().optional(),
  compact: z.boolean().optional(),
  // save: false — не сохранять этот запуск в историю (по умолчанию сохраняем)
  save: z.boolean().optional(),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  url: z.string().min(1).optional(),
});

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const clamp = (v, min, max, dflt) =>
  Number.isFinite(v) ? Math.min(Math.max(v, min), max) : dflt;

/** URL анализа: http(s):// включая localhost, 127.0.0.1, file:// (ТЗ 7.3). */
function isValidTarget(url) {
  return /^(https?|file):\/\//i.test(url);
}

function createApiRouter({ repos }) {
  const router = express.Router();
  const running = new Set();

  // ------------------------------------------------------------ health
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION, uptime: Math.round(process.uptime()) });
  });

  router.get('/api/health', (_req, res) => {
    res.json({ ok: true, tool: 'owa-web' });
  });

  // ----------------------------------------------------------- analyze
  router.post('/api/analyze', validateBody(analyzeSchema), async (req, res) => {
    const body = req.valid;
    const url = body.url.trim();

    if (!isValidTarget(url)) {
      throw new HttpError(400, 'INVALID_URL', 'URL должен начинаться с http:// или https://');
    }
    if (running.has(url)) {
      throw new HttpError(409, 'ALREADY_RUNNING', 'Этот URL уже анализируется');
    }

    running.add(url);
    const startedAt = Date.now();
    const save = body.save !== false;

    try {
      const data = await analyze(url, {
        waitAfterLoad: clamp(body.waitMs, 0, 60000, 5000),
        timeout: clamp(body.timeoutMs, 5000, 120000, 60000),
        widgetSelectors: Array.isArray(body.selectors) && body.selectors.length
          ? body.selectors.map(String)
          : null,
        headless: body.headed !== true,
        consoleLogs: body.consoleLogs === true,
      });
      const compact = body.compact === true ? buildCompact(data) : undefined;

      let analysisId = null;
      if (save) {
        analysisId = repos.analyses.insert({
          url,
          durationMs: Date.now() - startedAt,
          metrics: data.metrics,
          findings: data.interpretation.findings,
          interpretation: data.interpretation,
          summary: data.interpretation.summary,
          status: 'ok',
        });
      }

      return res.json({ ok: true, report: data, compact, analysisId });
    } catch (err) {
      const message = String((err && err.message) || err);
      if (save) {
        try {
          repos.analyses.insert({
            url,
            durationMs: Date.now() - startedAt,
            metrics: {},
            findings: [],
            interpretation: null,
            summary: { status: 'error', score: 0, headline: message },
            status: 'error',
          });
        } catch { /* не маскируем основную ошибку */ }
      }
      throw new HttpError(500, 'ANALYSIS_FAILED', message);
    } finally {
      running.delete(url);
    }
  });

  // ----------------------------------------------------------- history
  router.get('/api/history', validateQuery(historyQuerySchema), (req, res) => {
    const { limit = 50, offset = 0, url } = req.valid;
    const { items, total } = repos.analyses.list({ limit, offset, url: url ?? null });
    res.json({ ok: true, items, total });
  });

  router.get('/api/history/:id', validateParams(idParamSchema), (req, res) => {
    const analysis = repos.analyses.get(req.valid.id);
    if (!analysis) {
      throw new HttpError(404, 'NOT_FOUND', `Анализ #${req.valid.id} не найден`);
    }
    analysis.codeFindings = repos.codeFindings.listByAnalysis(analysis.id);
    res.json({ ok: true, analysis });
  });

  router.delete('/api/history/:id', validateParams(idParamSchema), (req, res) => {
    const deleted = repos.analyses.remove(req.valid.id); // каскад через FK
    if (!deleted) {
      throw new HttpError(404, 'NOT_FOUND', `Анализ #${req.valid.id} не найден`);
    }
    res.json({ ok: true, deleted });
  });

  router.delete('/api/history', (_req, res) => {
    res.json({ ok: true, deleted: repos.analyses.clear() });
  });

  return router;
}

module.exports = { createApiRouter, isValidTarget };
