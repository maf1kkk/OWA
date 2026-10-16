/**
 * Репозиторий ai_responses — кэш ответов LLM.
 * Ключ — sha256(prompt + model). Повторный запрос с теми же данными берётся отсюда
 * без обращения к GLM (см. ТЗ 4.2).
 */
'use strict';

function createAiResponsesRepo(db) {
  const getStmt = db.prepare(
    `SELECT prompt_hash, model, response, tokens_in, tokens_out, created_at
       FROM ai_responses WHERE prompt_hash = ?`
  );
  const setStmt = db.prepare(
    `INSERT INTO ai_responses (prompt_hash, model, response, tokens_in, tokens_out, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(prompt_hash) DO UPDATE SET
       model = excluded.model,
       response = excluded.response,
       tokens_in = excluded.tokens_in,
       tokens_out = excluded.tokens_out,
       created_at = excluded.created_at`
  );

  return {
    get(promptHash) {
      const r = getStmt.get(promptHash);
      if (!r) return null;
      return {
        promptHash: r.prompt_hash,
        model: r.model,
        response: r.response,
        tokensIn: r.tokens_in,
        tokensOut: r.tokens_out,
        createdAt: r.created_at,
      };
    },

    set({ promptHash, model, response, tokensIn = null, tokensOut = null, createdAt = Date.now() }) {
      setStmt.run(promptHash, model, response, tokensIn, tokensOut, createdAt);
      return promptHash;
    },
  };
}

module.exports = { createAiResponsesRepo };
