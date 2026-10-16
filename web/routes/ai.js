/**
 * POST /api/ai/explain — AI-объяснения находок статанализа (GLM 4.5).
 *
 * Тело: { analysisId, force? }
 *   force: false (по умолчанию) — объясняются только находки без ai_explanation;
 *   force: true — все (но кэш в ai_responses всё равно экономит вызовы GLM).
 *
 * Успех: { ok, analysisId, findings, explained, cached }
 * Ошибки: 400 AI_NOT_CONFIGURED | 504 AI_TIMEOUT | 502 AI_ERROR (ТЗ),
 *         частично объяснённое уже сохранено в БД — повтор дозаполняет.
 */
'use strict';

const express = require('express');
const { z } = require('zod');
const { getAi, explainMissing } = require('../../src/ai');
const { validateBody, HttpError } = require('../middleware/validate');

const explainSchema = z.object({
  analysisId: z.coerce.number().int().positive(),
  force: z.boolean().optional(),
});

function createAiRouter({ repos }) {
  const router = express.Router();

  router.post('/api/ai/explain', validateBody(explainSchema), async (req, res) => {
    const { analysisId, force } = req.valid;

    const analysis = repos.analyses.get(analysisId);
    if (!analysis) {
      throw new HttpError(404, 'NOT_FOUND', `Анализ #${analysisId} не найден`);
    }

    const rows = repos.codeFindings.listByAnalysis(analysisId);
    if (rows.length === 0) {
      return res.json({ ok: true, analysisId, findings: [], explained: 0, cached: 0 });
    }

    const ai = getAi();
    const result = await explainMissing(rows, { ai, repos, force });

    if (!result.ok) {
      if (result.error === 'AI_NOT_CONFIGURED') {
        throw new HttpError(400, 'AI_NOT_CONFIGURED', 'AI-провайдер не настроен (AI_API_KEY или GLM_API_KEY)');
      }
      const status = result.error === 'AI_TIMEOUT' ? 504 : 502;
      return res.status(status).json({
        error: result.error,
        message: `AI не ответил (${result.explained} из ${rows.length} уже объяснено) — повторите запрос`,
        explained: result.explained,
        cached: result.cached,
      });
    }

    res.json({
      ok: true,
      analysisId,
      findings: rows,
      explained: result.explained,
      cached: result.cached,
    });
  });

  return router;
}

module.exports = { createAiRouter };
