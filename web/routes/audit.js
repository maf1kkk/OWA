/**
 * Роуты комплексного аудита для веб-интерфейса (ручной сценарий).
 *
 *   POST /api/audit      полный аудит (5 секций) -> JSON
 *   POST /api/crawl      обход сайта -> JSON (агрегаты по сайту)
 *   POST /api/compare    сравнение с конкурентами -> JSON
 *   GET  /api/report/pdf?type=analysis|audit|crawl|compare|session[&id=<id>]
 *   GET  /api/session    лог операций текущей сессии
 *
 * Результаты кладутся в лог сессии (src/web/session.js): PDF строится по
 * уже готовому отчёту, без повторного запуска Chromium.
 */
'use strict';

const express = require('express');
const { z } = require('zod');
const { runFullAudit } = require('../../src/audit');
const { crawlSite } = require('../../src/crawl/crawler');
const { compareSites } = require('../../src/compare');
const { generatePdfReport } = require('../../src/report/pdf');
const { generateComparePdf } = require('../../src/report/compare-pdf');
const { generateAnalysisPdf } = require('../../src/report/analysis-pdf');
const { generateCrawlPdf } = require('../../src/report/crawl-pdf');
const { generateSessionPdf } = require('../../src/report/session-pdf');
const { renderPdf } = require('../../src/report/render');
const session = require('../../src/web/session');
const { HttpError, validateBody, validateQuery, validateParams } = require('../middleware/validate');

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

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
  type: z.enum(['analysis', 'audit', 'crawl', 'compare', 'session']),
  id: z.string().min(1).optional(),
});

/** Урезанная версия аудита для хранения в истории (без тяжёлого raw). */
function slimAudit(result) {
  const perf = result.scores.performance;
  return {
    schemaVersion: result.schemaVersion,
    url: result.url,
    timestamp: result.timestamp,
    integralScore: result.integralScore,
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
            section: name,
          })),
        },
      ])
    ),
    issues: result.issues || [],
    failedSections: result.failedSections || [],
  };
}

/** Имя файла для выгрузки. */
function fileName(type, url) {
  const host = String(url || 'report')
    .replace(/^https?:\/\//i, '')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 60) || 'report';
  return `owa-${type}-${host}.pdf`;
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
    const id = session.put('audit', slim, {
      url,
      score: result.integralScore,
      issueCount: (result.issues || []).length,
      issues: (result.issues || []).map((i) => ({
        rule: i.rule || i.id,
        section: i.section || '—',
        severity: i.severity,
      })),
    });

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

    const issues = (result.pages || []).flatMap((p) => (p.issues || []).map((i) => ({
      rule: i.rule || i.id,
      section: '—',
      severity: i.severity,
    })));
    const id = session.put('crawl', result, {
      url,
      score: result.aggregate ? result.aggregate.avgScore : null,
      issueCount: issues.length,
      issues,
    });

    return res.json({ ok: true, report: result, resultId: id });
  });

  // ------------------------------------------------------------ сравнение
  router.post('/api/compare', validateBody(compareSchema), async (req, res) => {
    const body = req.valid;
    const result = await compareSites(body.target.trim(), body.competitors.map((s) => s.trim()), {
      delayMs: body.delayMs ?? 3000,
      timeout: body.timeoutMs ?? 60000,
    });
    const issues = (result.sites || []).flatMap((s) => (s.topIssues || []).map((i) => ({
      rule: i.rule || i.id,
      section: '—',
      severity: i.severity,
    })));
    const id = session.put('compare', result, {
      url: result.target.url,
      score: result.target.avgSectionScore,
      issueCount: issues.length,
      issues,
    });
    return res.json({ ok: true, report: result, resultId: id });
  });

  // --------------------------------------------------------- лог сессии
  router.get('/api/session', (_req, res) => {
    res.json({ ok: true, operations: session.listOperations() });
  });

  // ------------------------------------------------------------------ PDF
  router.get('/api/report/pdf', validateQuery(pdfQuerySchema), async (req, res) => {
    const { type, id } = req.valid;

    if (type === 'session') {
      const ops = session.listOperations();
      if (!ops.length) {
        throw new HttpError(404, 'NOT_FOUND', 'В этой сессии ещё не было проверок');
      }
      const tmp = tmpPath('session');
      try {
        await generateSessionPdf(ops, tmp);
        return sendPdf(res, tmp, fileName('session', 'session'));
      } finally {
        cleanup(tmp);
      }
    }

    if (!id) {
      throw new HttpError(400, 'BAD_REQUEST', 'Нужен id результата');
    }
    const entry = session.get(id);
    if (!entry) {
      throw new HttpError(404, 'NOT_FOUND', 'Отчёт устарел или сервер перезапущен — выполните проверку заново');
    }
    if (entry.type !== type) {
      throw new HttpError(400, 'BAD_REQUEST', 'Тип отчёта не совпадает с результатом');
    }

    const tmp = tmpPath(type);
    try {
      if (type === 'audit') {
        await generatePdfReport(entry.result, tmp);
      } else if (type === 'compare') {
        await generateComparePdf(entry.result, tmp);
      } else if (type === 'crawl') {
        await generateCrawlPdf(entry.result, tmp);
      } else {
        await generateAnalysisPdf(entry.result, tmp);
      }
      return sendPdf(res, tmp, fileName(type, entry.result && entry.result.url));
    } finally {
      cleanup(tmp);
    }
  });

  // ------------------------------------------------- PDF по записи истории
  router.get('/api/history/:id/pdf', validateParams(idParamSchema), async (req, res) => {
    const analysis = repos.analyses.get(req.valid.id);
    if (!analysis) {
      throw new HttpError(404, 'NOT_FOUND', 'Анализ не найден');
    }
    const tmp = tmpPath('history');
    try {
      if (analysis.status === 'audit' && analysis.interpretation && analysis.interpretation.audit) {
        await generatePdfReport(analysis.interpretation.audit, tmp);
      } else {
        // Запись performance-анализа: собираем полный отчёт из БД.
        await generateAnalysisPdf({
          metrics: analysis.metrics,
          meta: { url: analysis.url, analyzedAt: new Date(analysis.createdAt).toISOString() },
          interpretation: analysis.interpretation || { summary: { score: 0, headline: '' }, findings: [] },
        }, tmp);
      }
      return sendPdf(res, tmp, fileName('history', analysis.url));
    } finally {
      cleanup(tmp);
    }
  });

  return router;
}

const os = require('os');
const nodePath = require('path');
const fs = require('fs');

function tmpPath(type) {
  return nodePath.join(os.tmpdir(), `owa-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
}

function cleanup(file) {
  try { fs.unlinkSync(file); } catch { /* уже удалён */ }
}

function sendPdf(res, file, name) {
  const buffer = fs.readFileSync(file);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  return res.send(buffer);
}

module.exports = { createAuditRouter, slimAudit, fileName };
