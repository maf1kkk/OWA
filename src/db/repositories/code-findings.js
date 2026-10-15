/**
 * Репозиторий code_findings — находки статического анализа кода,
 * привязанные к анализу (каскадное удаление — через analyses).
 */
'use strict';

function createCodeFindingsRepo(db) {
  const insertStmt = db.prepare(
    `INSERT INTO code_findings (analysis_id, type, severity, rule, location, message, suggestion, ai_explanation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const listStmt = db.prepare(
    `SELECT id, analysis_id, type, severity, rule, location, message, suggestion, ai_explanation
       FROM code_findings
      WHERE analysis_id = ?
      ORDER BY id`
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM code_findings WHERE analysis_id = ?`);
  const setAiStmt = db.prepare(`UPDATE code_findings SET ai_explanation = ? WHERE id = ?`);

  /** Массовая вставка одной транзакцией. findings: {type,severity,rule,location?,message,suggestion?,aiExplanation?} */
  const insertMany = db.transaction((analysisId, findings) => {
    for (const f of findings) {
      insertStmt.run(
        analysisId,
        f.type,
        f.severity,
        f.rule,
        f.location ?? null,
        f.message,
        f.suggestion ?? null,
        f.aiExplanation ?? null
      );
    }
    return findings.length;
  });

  return {
    insertMany,
    listByAnalysis(analysisId) {
      return listStmt.all(analysisId).map((r) => ({
        id: r.id,
        analysisId: r.analysis_id,
        type: r.type,
        severity: r.severity,
        rule: r.rule,
        location: r.location,
        message: r.message,
        suggestion: r.suggestion,
        aiExplanation: r.ai_explanation,
      }));
    },

    countByAnalysis(analysisId) {
      return countStmt.get(analysisId).n;
    },

    /** Сохранить AI-объяснение находки. @returns {number} сколько обновлено */
    setAiExplanation(id, aiExplanation) {
      return setAiStmt.run(aiExplanation, id).changes;
    },
  };
}

module.exports = { createCodeFindingsRepo };
