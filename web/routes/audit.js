/**
 * Роуты комплексного аудита для веб-интерфейса (ручной сценарий).
 *
 *   POST /api/audit      полный аудит (5 секций) -> JSON
 *   POST /api/crawl      обход сайта -> JSON (агрегаты по сайту)
 *   POST /api/compare    сравнение с конкурентами -> JSON
 *   GET  /api/report/pdf?type=audit|crawl|compare&id=<id>  -> PDF
 *
 * Результаты кладутся в короткоживущий кэш: PDF строится по уже готовому
 * отчёту, без повторного запуска Chromium.
 */
'use strict';

const express = require('express');
const { z } = require('zod');
const { runFullAudit } = require('../../src/audit');
const { crawlSite } = require('../../src/crawl/crawler');
const { compareSites } = require('../../src/compare');
const { generatePdfReport } = require('../../src/report/pdf');
const { generateComparePdf } = require('../../src/report/compare-pdf');
const { HttpError, validateBody, validateQuery } = require('../middleware/validate');

/** Кэш готовых отчётов: id -> { type, result, createdAt }. TTL 30 минут. */
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 20;
const cache = new Map();

function cachePut(type, result) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  cache.set(id, { type, result, createdAt: Date.now() });
  // Чистим протухшее и ограничиваем размер.
  for (const [key, entry] of cache) {
    if (Date.now() - entry.createdAt > CACHE_TTL_MS) cache.delete(key);
  }
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  return id;
}

const auditSchema = z.object({
  url: z.string().min(1, 'URL обязателен'),
  selectors: z.array(z.string().max(200)).max(20).optional(),
  waitMs: z.coerce.number().int().min(0).max(60000).optional(),
  timeoutMs: z.coerce.number().int().min(5000).max(120000).optional(),
});

const crawlSchema = z.object({
  url: z.string().min(1, 'URL обязателен'),
  maxPages: z.coerce.number().int().min(1).max(100).optional(),
  maxDepth: z.coerce.number().int().min(0).max(5).optional(),
  delayMs: z.coerce.number().int().min(0).max(60000).optional(),
  respectRobots: z.boolean().optional(),
});

const compareSchema = z.object({
  target: z.string().min(1, 'URL цели обязателен'),
  competitors: z.array(z.string().min(1)).min(1, 'нужен хотя бы один конкурент').max(5),
  delayMs: z.coerce.number().int().min(0).max(60000).optional(),
  timeoutMs: z.coerce.number().int().min(5000).max(120000).optional(),
});

const pdfQuerySchema = z.object({
  type: z.enum(['audit', 'compare']),
  id: z.string().min(1),
});

/** Урезанная версия аудита для хранения в истории (без тяжёлого raw). */
function slimAudit(result) {
  const perf = result.scores.performance;
  return {
    schemaVersion: result.schemaVersion,
    url: result.url,
    timestamp: result.timestamp,
    integralScore: result.integralScore,
    // Метрики производительности нужны для таблицы Core Web Vitals в PDF.
    metrics: perf && perf.raw && perf.raw.metrics ? perf.raw.metrics : {},
    scores: Object.fromEntries(
      Object.entries(result.scores).map(([name, sec]) => [
        name,
        {
          status: sec.status,
          score: sec.score,
          durationMs: sec.durationMs ?? null,
          error: sec.error ?? null,
          issues: (sec.issues || []).map((i) => ({
            id: i.id,
            rule: i.rule,
            severity: i.severity,
            message: i.message,
            recommendation: i.recommendation ?? null,
            location: i.location ?? null,
          })),
        },
      ])
    ),
    issues: result.issues || [],
    failedSections: result.failedSections || [],
  };
}

function createAuditRouter({ repos }) {
  const router = express.Router();

  // ------------------------------------------------------------- аудит
  router.post('/api/audit', validateBody(auditSchema), async (req, res) => {
    const body = req.valid;
    const url = body.url.trim();

    const result = await runFullAudit(url, {
      waitAfterLoad: body.waitMs ?? 2500,
      timeout: body.timeoutMs ?? 60000,
    });

    const slim = slimAudit(result);
    const id = cachePut('audit', slim);

    // Сохраняем в историю: чтобы результат не потерялся.
    let analysisId = null;
    try {
      const perf = result.scores.performance;
      analysisId = repos.analyses.insert({
        url,
        metrics: perf && perf.raw && perf.raw.metrics ? perf.raw.metrics : {},
        findings: result.issues || [],
        interpretation: { summary: { status: 'audit', score: result.integralScore, headline: 'Комплексный аудит' }, audit: slim },
        summary: { status: 'audit', score: result.integralScore, headline: 'Комплексный аудит' },
        status: 'audit',
      });
    } catch (err) {
      console.error('[audit] не удалось сохранить в историю:', err && err.message);
    }

    return res.json({ ok: true, report: slim, resultId: id, analysisId });
  });

  // ------------------------------------------------------------- обход
  router.post('/api/crawl', validateBody(crawlSchema), async (req, res) => {
    const body = req.valid;
    const url = body.url.trim();

    const result = await crawlSite(url, {
      maxPages: body.maxPages ?? 10,
      maxDepth: body.maxDepth ?? 2,
      delayMs: body.delayMs ?? 300,
      respectRobots: body.respectRobots !== false,
      timeout: body.timeoutMs ?? 60000,
    });

    const id = cachePut('crawl', result);
    return res.json({ ok: true, report: result, resultId: id });
  });

  // ------------------------------------------------------------ сравнение
  router.post('/api/compare', validateBody(compareSchema), async (req, res) => {
    const body = req.valid;
    const result = await compareSites(body.target.trim(), body.competitors.map((s) => s.trim()), {
      delayMs: body.delayMs ?? 3000,
      timeout: body.timeoutMs ?? 60000,
    });
    const id = cachePut('compare', result);
    return res.json({ ok: true, report: result, resultId: id });
  });

  // ------------------------------------------------------------------ PDF
  router.get('/api/report/pdf', validateQuery(pdfQuerySchema), async (req, res) => {
    const { type, id } = req.valid;
    const entry = cache.get(id);
    if (!entry) {
      throw new HttpError(404, 'NOT_FOUND', 'Отчёт устарел — запустите аудит заново');
    }
    if (entry.type !== type) {
      throw new HttpError(400, 'BAD_REQUEST', 'Тип отчёта не совпадает');
    }

    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const tmp = path.join(os.tmpdir(), `owa-${type}-${Date.now()}.pdf`);

    try {
      if (type === 'audit') {
        // Отчёту нужен полный результат: восстанавливаем минимальный каркас.
        const report = entry.result;
        await generatePdfReport(toPdfAuditResult(report), tmp);
      } else {
        await generateComparePdf(entry.result, tmp);
      }
      const buffer = fs.readFileSync(tmp);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="owa-${type}.pdf"`);
      return res.send(buffer);
    } finally {
      fs.unlink(tmp, () => {});
    }
  });

  return router;
}

/** Собрать результат в формате, который понимает генератор обычного PDF. */
function toPdfAuditResult(slim) {
  const scores = {};
  const issues = [];
  for (const [name, sec] of Object.entries(slim.scores || {})) {
    scores[name] = {
      status: sec.status,
      score: sec.score,
      issues: sec.issues || [],
      durationMs: sec.durationMs,
      raw: name === 'performance' ? { metrics: slim.metrics || {} } : {},
    };
    for (const i of sec.issues || []) issues.push(i);
  }
  return {
    schemaVersion: 2,
    tool: 'owa',
    url: slim.url,
    timestamp: slim.timestamp,
    integralScore: slim.integralScore,
    scores,
    issues,
    failedSections: slim.failedSections || [],
  };
}

module.exports = { createAuditRouter, slimAudit, cachePut };
