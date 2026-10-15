/**
 * Статический анализ кода — оркестрация (ТЗ, итерация 3).
 *
 * Два режима:
 *  1) analyzeCode(url) — весь анализ за один вызов (для CLI, отчётов).
 *  2) Сессии для HTTP — «продолжение анализа» (согласовано с заказчиком):
 *     createSession() -> этап fetch + html (сбор исходников + анализ разметки),
 *     continueSession() -> один батч за вызов: css, затем js,
 *     когда всё обработано — финализация (summary, статус done).
 *     Прогресс хранится в SQLite (code_sessions: step, cursor, sources_gz).
 *
 * Исходные находки (raw) приводятся к формату findings из src/interpret.js
 * через to-findings.js (+ аддитивные поля severity, rule, location, suggestion).
 */
'use strict';

const { gzipSync, gunzipSync } = require('zlib');
const { fetchSources } = require('./fetch-sources');
const { analyzeHtml } = require('./html-rules');
const { analyzeCss } = require('./css-rules');
const { analyzeJs } = require('./js-rules');
const { toFindings, SEVERITY_TO_VERDICT } = require('./to-findings');
const { buildSummary } = require('../interpret');

const DEFAULT_BATCH = 10; // файлов CSS/JS за один вызов (батч продолжения)

/** Ошибка статического анализа со статусом/кодом для HTTP. */
class CodeAnalysisError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- чистые шаги

function analyzeHtmlPhase(sources) {
  return toFindings(analyzeHtml(sources.html, sources.finalUrl));
}

function typeOfRule(rule) {
  if (rule.startsWith('css-')) return 'css';
  if (rule.startsWith('html-')) return 'html';
  if (rule.startsWith('js-')) return 'js';
  return 'code';
}

/** Finding (формат interpret.js) -> строка code_findings. */
function toRow(analysisId, f) {
  return {
    type: typeOfRule(f.rule),
    severity: f.severity,
    rule: f.rule,
    location: f.location,
    message: f.message,
    suggestion: f.suggestion,
  };
}

/**
 * Один шаг продолжения: проматывает пустые фазы, иначе обрабатывает батч.
 * МУТИРУЕТ state: { step: 'css'|'js'|..., cursor: {css, js} }.
 * @returns {{findings: object[], done: boolean}} — findings в формате interpret.js
 */
function processStep(sources, state, batch = DEFAULT_BATCH) {
  const findings = [];
  for (;;) {
    if (state.step === 'fetch') state.step = 'css'; // fetch+html выполняется при создании сессии
    if (state.step === 'css') {
      if (state.cursor.css >= sources.css.length) {
        state.step = 'js';
        continue;
      }
      const chunk = sources.css.slice(state.cursor.css, state.cursor.css + batch);
      for (const f of chunk) findings.push(...toFindings(analyzeCss(f.content, f.url, { html: sources.html })));
      state.cursor.css += chunk.length;
      if (state.cursor.css >= sources.css.length) state.step = 'js';
      return { findings, done: false };
    }
    if (state.step === 'js') {
      if (state.cursor.js >= sources.js.length) {
        state.step = 'done';
        continue;
      }
      const chunk = sources.js.slice(state.cursor.js, state.cursor.js + batch);
      for (const f of chunk) findings.push(...toFindings(analyzeJs(f.content, f.url, { inline: f.inline })));
      state.cursor.js += chunk.length;
      if (state.cursor.js >= sources.js.length) state.step = 'done';
      return { findings, done: state.step === 'done' };
    }
    if (state.step === 'done') return { findings, done: true };
    throw new Error(`Неизвестный этап анализа: ${state.step}`);
  }
}

// ------------------------------------------------- режим 1: всё за один раз

/**
 * Полный статический анализ URL за один вызов (без БД).
 * @returns {Promise<{url, findings, truncated, summary, counts}>}
 */
async function analyzeCode(url, opts = {}) {
  const sources = await fetchSources(url, opts);
  const findings = analyzeHtmlPhase(sources);
  const state = { step: 'css', cursor: { css: 0, js: 0 } };
  let guard = 0;
  let step;
  do {
    step = processStep(sources, state, opts.batch || DEFAULT_BATCH);
    findings.push(...step.findings);
    guard += 1;
  } while (!step.done && guard < 10000);

  return {
    url: sources.finalUrl,
    findings,
    truncated: sources.truncated,
    summary: buildSummary(findings),
    counts: sources.counts,
  };
}

// ---------------------------------------------- режим 2: сессии (HTTP-шаги)

function gunzipSources(session) {
  if (!session.sourcesGz) return null;
  return JSON.parse(gunzipSync(session.sourcesGz).toString('utf8'));
}

function finalizeSession({ repos, session }) {
  const rows = repos.codeFindings.listByAnalysis(session.analysisId);
  const findings = rows.map((r) => ({ ...r, verdict: SEVERITY_TO_VERDICT[r.severity] || 'info' }));
  const summary = buildSummary(findings);
  repos.analyses.finalize({ id: session.analysisId, summary, status: 'ok' });
  repos.codeSessions.update({
    id: session.id,
    status: 'done',
    step: 'done',
    cursor: session.cursor,
    sourcesGz: session.sourcesGz,
  });
  return summary;
}

/**
 * Создать сессию: fetch + анализ HTML. Источники сохраняются сжато в БД.
 * @throws {CodeAnalysisError} 502 FETCH_FAILED — если страницу не удалось открыть/собрать
 */
async function createSession({ repos, url, batch = DEFAULT_BATCH, fetchOpts = {} }) {
  const analysisId = repos.analyses.insert({
    url,
    metrics: {},
    findings: [],
    interpretation: null,
    summary: null, // null = анализ ещё не завершён
    status: 'ok',
  });
  const sessionId = repos.codeSessions.create({ analysisId, url, step: 'fetch' });

  let sources;
  try {
    sources = await fetchSources(url, { waitMs: 1500, ...fetchOpts });
  } catch (err) {
    const message = String(err.message || err);
    repos.codeSessions.update({
      id: sessionId,
      status: 'error',
      step: 'fetch',
      cursor: {},
      error: message,
    });
    repos.analyses.finalize({
      id: analysisId,
      summary: { status: 'error', score: 0, headline: `Не удалось собрать исходники: ${message}` },
      status: 'error',
    });
    throw new CodeAnalysisError(502, 'FETCH_FAILED', `Не удалось открыть страницу: ${message}`);
  }

  // Анализ HTML — сразу при создании
  const htmlFindings = analyzeHtmlPhase(sources);
  repos.codeFindings.insertMany(analysisId, htmlFindings.map((f) => toRow(analysisId, f)));

  const state = { step: 'css', cursor: { css: 0, js: 0 } };
  let done = false;
  let summary = null;
  if (sources.css.length === 0 && sources.js.length === 0) {
    // Не обрабатывать дальше — сразу финализация
    done = true;
    state.step = 'done';
    repos.codeSessions.update({
      id: sessionId,
      status: 'in_progress',
      step: 'done',
      sourcesGz: gzipSync(Buffer.from(JSON.stringify(sources), 'utf8')),
      cursor: state.cursor,
    });
    summary = finalizeSession({
      repos,
      session: { ...repos.codeSessions.get(sessionId), cursor: state.cursor },
    });
  } else {
    repos.codeSessions.update({
      id: sessionId,
      status: 'in_progress',
      step: state.step,
      sourcesGz: gzipSync(Buffer.from(JSON.stringify(sources), 'utf8')),
      cursor: state.cursor,
    });
  }

  return {
    sessionId,
    analysisId,
    url: sources.finalUrl,
    step: state.step,
    done,
    findings: htmlFindings,
    totalFindings: repos.codeFindings.countByAnalysis(analysisId),
    truncated: sources.truncated,
    summary,
    batch,
  };
}

/**
 * Продолжить сессию: один батч (css или js) за вызов.
 * @throws {CodeAnalysisError} 404 SESSION_NOT_FOUND | 409 SESSION_ERROR
 */
function continueSession({ repos, sessionId, batch = DEFAULT_BATCH }) {
  const session = repos.codeSessions.get(sessionId);
  if (!session) {
    throw new CodeAnalysisError(404, 'SESSION_NOT_FOUND', `Сессия #${sessionId} не найдена`);
  }
  if (session.status === 'error') {
    throw new CodeAnalysisError(409, 'SESSION_ERROR', `Сессия в ошибке: ${session.error || 'неизвестно'}`);
  }
  if (session.status === 'done') {
    // идемпотентно: отдаём уже готовый результат
    const all = repos.codeFindings.listByAnalysis(session.analysisId);
    return {
      sessionId: session.id,
      analysisId: session.analysisId,
      url: session.url,
      step: 'done',
      done: true,
      findings: [],
      totalFindings: all.length,
      truncated: [],
      summary: (repos.analyses.get(session.analysisId) || {}).summary || null,
      batch,
    };
  }

  const sources = gunzipSources(session);
  if (!sources) {
    throw new CodeAnalysisError(500, 'SESSION_CORRUPT', 'Исходники сессии не найдены (sources_gz пуст)');
  }

  const state = { step: session.step, cursor: { ...session.cursor } };
  const step = processStep(sources, state, batch);

  repos.codeFindings.insertMany(session.analysisId, step.findings.map((f) => toRow(session.analysisId, f)));

  let summary = null;
  if (step.done) {
    summary = finalizeSession({ repos, session: { ...session, cursor: state.cursor } });
  } else {
    repos.codeSessions.update({
      id: session.id,
      status: 'in_progress',
      step: state.step,
      sourcesGz: session.sourcesGz,
      cursor: state.cursor,
    });
  }

  return {
    sessionId: session.id,
    analysisId: session.analysisId,
    url: session.url,
    step: step.done ? 'done' : state.step,
    done: step.done,
    findings: step.findings,
    totalFindings: repos.codeFindings.countByAnalysis(session.analysisId),
    truncated: sources.truncated,
    summary,
    batch,
  };
}

module.exports = {
  analyzeCode,
  createSession,
  continueSession,
  processStep,
  analyzeHtmlPhase,
  CodeAnalysisError,
  DEFAULT_BATCH,
};
