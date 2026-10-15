-- 002_code_sessions.sql — сессии статического анализа кода (продолжение анализа).
-- Одна сессия = один анализ URL: этапы fetch -> css -> js -> done,
-- прогресс хранится в step/cursor_json, собранные исходники — в sources_gz.
-- code_findings привязаны к analyses (см. 001_init.sql).

CREATE TABLE code_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',   -- in_progress | done | error
  step TEXT NOT NULL DEFAULT 'fetch',           -- fetch | css | js | done
  sources_gz BLOB,                              -- gzip(JSON): css/js исходники
  cursor_json TEXT NOT NULL DEFAULT '{}',       -- {"css": N, "js": M} — сколько обработано
  error TEXT
);
CREATE INDEX idx_code_sessions_analysis ON code_sessions(analysis_id);
CREATE INDEX idx_code_sessions_status ON code_sessions(status);
