-- 001_init.sql — начальная схема OWA
-- Версия миграции берётся из числового префикса имени файла (001 -> user_version = 1).

CREATE TABLE analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  duration_ms INTEGER,
  metrics_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  interpretation_json TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX idx_analyses_url ON analyses(url);
CREATE INDEX idx_analyses_created ON analyses(created_at DESC);

CREATE TABLE code_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  rule TEXT NOT NULL,
  location TEXT,
  message TEXT NOT NULL,
  suggestion TEXT,
  ai_explanation TEXT
);
CREATE INDEX idx_code_findings_analysis ON code_findings(analysis_id);

CREATE TABLE ai_responses (
  prompt_hash TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  response TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
