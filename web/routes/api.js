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
const { checkTargetUrl } = require('../../src/security');
const {
  HttpError,
  validateBody,
  validateQuery,
  validateParams,
} = require('../middleware/validate');

const VERSION = require('../../package.json').version;

// Сколько анализов считаем разумным максимумом параллельно: каждый — отдельный
// Chromium с сотнями МБ памяти. Дальше — 429 вместо падения по OOM.
const MAX_CONCURRENT = Number(process.env.OWA_MAX_CONCURRENT ?? 2);

const analyzeSchema = z.object({
  url: z.string().min(1, 'URL обязателен'),
  // лимиты: каждый селектор — querySelector на странице
  selectors: z.array(z.string().max(200)).max(20).optional(),
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
  offset: z.coerce.number().int().min(0).max(10000).optional(),
  url: z.string().min(1, 'URL обязателен').optional(),
});

const historyMetricsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  url: z.string().min(1, 'URL обязателен').optional(),
});

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const clamp = (v, min, max, dflt) =>
  Number.isFinite(v) ? Math.min(Math.max(v, min), max) : dflt;

/** URL анализа: http(s)://, но не приватные адреса (SSRF/LFI). */
function isValidTarget(url) {
  const verdict = checkTargetUrl(url);
  if (verdict.ok) return true;
  throw new HttpError(400, 'INVALID_URL', reasonMessage(verdict));
}

function reasonMessage(verdict) {
  if (verdict.reason === 'scheme') return 'URL должен начинаться с http:// или https://';
  if (verdict.reason === 'private') {
    return 'Приватные/локальные адреса запрещены (OWA_ALLOW_PRIVATE_TARGETS=1 — отключить проверку)';
  }
  return 'Некорректный URL';
}

function createApiRouter({ repos }) {
  const router = express.Router();
  const running = new Set();
  let inFlight = 0;

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

    isValidTarget(url);

    if (running.has(url)) {
      throw new HttpError(409, 'ALREADY_RUNNING', 'Этот URL уже анализируется');
    }
    if (inFlight >= MAX_CONCURRENT) {
      throw new HttpError(429, 'TOO_MANY_REQUESTS', 'Слишком много одновременных анализов, попробуйте позже');
    }

    running.add(url);
    inFlight += 1;
    const startedAt = Date.now();
    const save = body.save !== false;

    try {
      const data = await analyze(url, {
        waitAfterLoad: clamp(body.waitMs, 0, 60000, 5000),
        timeout: clamp(body.timeoutMs, 5000, 120000, 60000),
        widgetSelectors: Array.isArray(body.selectors) && body.selectors.length
          ? body.selectors.map(String)
          : null,
        // headed через API — только локально и только с явным разрешением:
        // иначе команда из сети открывает окно браузера на машине сервера
        headless: !(body.headed === true && process.env.OWA_ALLOW_HEADED === '1'),
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
      const message = 'Анализ не удался';
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
        } catch (dbErr) {
          console.error('[history] не удалось сохранить ошибку анализа:', dbErr && dbErr.message);
        }
      }
      // В историю и наружу — нейтральное сообщение: в err.message от Playwright
      // бывают полные URL и внутрисистемные детали.
      throw new HttpError(500, 'ANALYSIS_FAILED', message);
    } finally {
      running.delete(url);
      inFlight -= 1;
    }
  });

  // ----------------------------------------------------------- history
  router.get('/api/history', validateQuery(historyQuerySchema), (req, res) => {
    const { limit = 50, offset = 0, url } = req.valid;
    const { items, total } = repos.analyses.list({ limit, offset, url: url ?? null });
    res.json({ ok: true, items, total });
  });

  // ----------------------------------------------------------- метрики во времени (графики)
  router.get('/api/history/metrics', validateQuery(historyMetricsSchema), async (req, res) => {
    const { limit = 30, url } = req.valid;
    const series = repos.analyses.metricsSeries({ url: url ?? null, limit });
    res.json({ ok: true, url: url ?? null, series });
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

  // ----------------------------------------------------------- метрики во времени (графики)
  router.get('/api/history/metrics', validateQuery(historyMetricsSchema), async (req, res) => {
    const { limit = 30, url } = req.valid;
    const series = repos.analyses.metricsSeries({ url: url ?? null, limit });
    res.json({ ok: true, url: url ?? null, series });
  });

  return router;
}

module.exports = { createApiRouter, isValidTarget };
