/**
 * POST /api/code-analysis — статический анализ кода с продолжением.
 *
 * Тело: { url?, sessionId?, batch? }
 *   без sessionId  — создать сессию: fetch + анализ HTML (первый шаг);
 *   с sessionId    — продолжить: один батч CSS или JS за вызов;
 *   когда всё обработано — done: true + summary.
 *
 * Ответ: { ok, sessionId, analysisId, url, step, done, findings,
 *          totalFindings, truncated, summary, batch }
 */
'use strict';

const express = require('express');
const { z } = require('zod');
const {
  createSession,
  continueSession,
  CodeAnalysisError,
  DEFAULT_BATCH,
} = require('../../src/static-analyzer');
const { getAi, explainMissing } = require('../../src/ai');
const { validateBody, HttpError } = require('../middleware/validate');

const codeAnalysisSchema = z.object({
  url: z.string().min(1).optional(),
  sessionId: z.coerce.number().int().positive().optional(),
  batch: z.coerce.number().int().min(1).max(50).optional(),
  waitMs: z.coerce.number().int().min(0).max(30000).optional(),
  timeout: z.coerce.number().int().min(5000).max(120000).optional(),
  // explain: true — объяснить находки через GLM (кэш в ai_responses)
  explain: z.boolean().optional(),
});

function isValidTarget(url) {
  return /^(https?|file):\/\//i.test(url);
}

function createCodeAnalysisRouter({ repos }) {
  const router = express.Router();

  router.post('/api/code-analysis', validateBody(codeAnalysisSchema), async (req, res) => {
    const body = req.valid;
    const batch = body.batch || DEFAULT_BATCH;

    if (!body.sessionId && !body.url) {
      throw new HttpError(400, 'VALIDATION', 'Укажите url (новая сессия) или sessionId (продолжение)');
    }
    if (body.url && !isValidTarget(body.url)) {
      throw new HttpError(400, 'INVALID_URL', 'URL должен начинаться с http:// или https:// (допустим file://)');
    }

    let result;
    try {
      if (body.sessionId) {
        result = continueSession({ repos, sessionId: body.sessionId, batch });
      } else {
        result = await createSession({
          repos,
          url: body.url.trim(),
          batch,
          fetchOpts: {
            ...(body.waitMs !== undefined ? { waitMs: body.waitMs } : {}),
            ...(body.timeout !== undefined ? { timeout: body.timeout } : {}),
          },
        });
      }
    } catch (err) {
      if (err instanceof CodeAnalysisError) {
        throw new HttpError(err.status, err.code, err.message);
      }
      throw err;
    }

    // AI-объяснения (по флагу): кэш в ai_responses, без ключа — просто пропуск
    if (body.explain) {
      const ai = getAi();
      if (!ai.configured) {
        result.ai = { configured: false };
      } else {
        const rows = repos.codeFindings.listByAnalysis(result.analysisId);
        const ex = await explainMissing(rows, { ai, repos });
        result.ai = { configured: true, explained: ex.explained || 0, cached: ex.cached || 0 };
        if (!ex.ok) result.ai.error = ex.error;
        // обогатить новые находки этого шага
        const byKey = new Map(rows.map((r) => [`${r.rule}|${r.location}|${r.message}`, r.aiExplanation]));
        result.findings = result.findings.map((f) => {
          const aiText = byKey.get(`${f.rule}|${f.location}|${f.message}`);
          return aiText ? { ...f, aiExplanation: aiText } : f;
        });
      }
    }

    res.json({ ok: true, ...result });
  });

  return router;
}

module.exports = { createCodeAnalysisRouter };
