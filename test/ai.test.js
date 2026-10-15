const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { openDb, migrate } = require('../src/db');
const { createRepos } = require('../src/db/repositories');
const { getAi, resetAi, explainFinding, explainMissing, buildMessages, promptHash } = require('../src/ai');
const { createApp } = require('../web/app');

// ------------------------------------------------------------- мок GLM-сервера

function completion(content) {
  return JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'glm-4.5',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

/**
 * OpenAI-совместимый мок.
 * mode: 'ok' | 'flaky502' (первый запрос — 502) | 'always500' | 'slow' (спит 2.5 с)
 */
function startAiMock(mode = 'ok') {
  let requests = 0;
  const pending = new Set();
  const server = http.createServer((req, res) => {
    if (!String(req.url).endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    requests += 1;
    const send = (code, body) => {
      try {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(body);
      } catch {
        /* клиент уже отвалился по таймауту — не критично */
      }
    };
    if (mode === 'ok') return send(200, completion('Объяснение от GLM: исправьте селектор.'));
    if (mode === 'flaky502') {
      if (requests === 1) return send(502, '{"error":"bad gateway"}');
      return send(200, completion('Объяснение после повтора.'));
    }
    if (mode === 'always500') return send(500, '{"error":"internal"}');
    if (mode === 'slow') {
      const t = setTimeout(() => send(200, completion('поздний ответ')), 2500);
      pending.add(t);
      return undefined;
    }
    return undefined;
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}/v1`,
        get requests() {
          return requests;
        },
        close: () =>
          new Promise((r) => {
            for (const t of pending) clearTimeout(t);
            server.close(r);
          }),
      });
    });
  });
}

function useAiEnv(base, extra = {}) {
  process.env.GLM_API_KEY = extra.apiKey !== undefined ? extra.apiKey : 'test-key-not-real';
  process.env.GLM_BASE_URL = base;
  process.env.GLM_MODEL = 'glm-4.5';
  if (extra.timeoutMs) process.env.GLM_TIMEOUT_MS = String(extra.timeoutMs);
  else delete process.env.GLM_TIMEOUT_MS;
  resetAi();
}

function tempRepos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-ai-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  return {
    db,
    repos: createRepos(db),
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const FINDING = {
  type: 'css',
  severity: 'warning',
  rule: 'css-important',
  location: 'https://site.test/style.css:10',
  message: 'Деклараций с !important: 12 шт',
  suggestion: 'Уберите !important, повысьте специфичность селектора.',
};

async function readJson(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

// ------------------------------------------------------------------ unit

test('buildMessages детерминирован, hash стабилен (sha256, без ключа API)', () => {
  const f = { ...FINDING };
  const m1 = buildMessages(f);
  const m2 = buildMessages({ ...FINDING });
  assert.deepStrictEqual(m1, m2);
  assert.strictEqual(m1[0].role, 'system');
  assert.ok(m1[1].content.includes('css-important'));
  assert.ok(m1[1].content.includes('!important'));

  const h1 = promptHash('glm-4.5', m1);
  const h2 = promptHash('glm-4.5', m2);
  const h3 = promptHash('glm-4.6', m1);
  assert.strictEqual(h1, h2, 'хэш должен быть стабилен');
  assert.notStrictEqual(h1, h3, 'разная модель — другой ключ кэша');
  assert.match(h1, /^[0-9a-f]{64}$/, 'sha256-хэш');
});

// ------------------------------------------------------- успех и кэш (unit)

test('успех + кэш: один запрос к GLM на два одинаковых объяснения', async () => {
  const mock = await startAiMock('ok');
  const ctx = tempRepos();
  try {
    useAiEnv(mock.base);
    const ai = getAi();
    assert.strictEqual(ai.configured, true);

    const analysisId = ctx.repos.analyses.insert({ url: 'https://site.test/' });
    ctx.repos.codeFindings.insertMany(analysisId, [FINDING]);

    // первый проход — живой вызов
    let rows = ctx.repos.codeFindings.listByAnalysis(analysisId);
    const r1 = await explainMissing(rows, { ai, repos: ctx.repos });
    assert.deepStrictEqual({ ok: r1.ok, explained: r1.explained, cached: r1.cached }, { ok: true, explained: 1, cached: 0 });
    assert.strictEqual(mock.requests, 1);

    // повтор (force) — берётся из кэша, запросов к моку не прибавилось
    rows = ctx.repos.codeFindings.listByAnalysis(analysisId);
    assert.strictEqual(rows[0].aiExplanation, 'Объяснение от GLM: исправьте селектор.', 'сохранилось в code_findings');
    const r2 = await explainMissing(rows, { ai, repos: ctx.repos, force: true });
    assert.deepStrictEqual({ ok: r2.ok, explained: r2.explained, cached: r2.cached }, { ok: true, explained: 1, cached: 1 });
    assert.strictEqual(mock.requests, 1, 'кэш должен экономить вызовы GLM');

    // explainFinding напрямую: второй вызов — cached
    const direct = await explainFinding({ ...FINDING }, { ai, repos: ctx.repos });
    assert.strictEqual(direct.cached, true);
    assert.strictEqual(mock.requests, 1);
  } finally {
    await mock.close();
    ctx.cleanup();
  }
});

test('повтор 1 раз на 502 -> успех (ровно 2 запроса)', async () => {
  const mock = await startAiMock('flaky502');
  const ctx = tempRepos();
  try {
    useAiEnv(mock.base);
    const res = await explainFinding({ ...FINDING }, { ai: getAi(), repos: ctx.repos });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.text, 'Объяснение после повтора.');
    assert.strictEqual(mock.requests, 2, 'ровно один повтор на 5xx');
  } finally {
    await mock.close();
    ctx.cleanup();
  }
});

test('500 дважды -> AI_ERROR (ровно 2 попытки, без кэша ошибок)', async () => {
  const mock = await startAiMock('always500');
  const ctx = tempRepos();
  try {
    useAiEnv(mock.base);
    const res = await explainFinding({ ...FINDING }, { ai: getAi(), repos: ctx.repos });
    assert.deepStrictEqual(res, { ok: false, error: 'AI_ERROR' });
    assert.strictEqual(mock.requests, 2);
    // ошибки не кэшируются
    assert.strictEqual(ctx.repos.aiResponses.get(promptHash('glm-4.5', buildMessages(FINDING))), null);
  } finally {
    await mock.close();
    ctx.cleanup();
  }
});

test('таймаут -> AI_TIMEOUT', async () => {
  const mock = await startAiMock('slow');
  const ctx = tempRepos();
  try {
    useAiEnv(mock.base, { timeoutMs: 150 });
    const res = await explainFinding({ ...FINDING }, { ai: getAi(), repos: ctx.repos });
    assert.deepStrictEqual(res, { ok: false, error: 'AI_TIMEOUT' });
  } finally {
    await mock.close();
    ctx.cleanup();
  }
});

// ------------------------------------------------------------------ HTTP

function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-ai-app-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  const app = createApp({ db });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        db,
        repos: app.locals.repos,
        stop: () =>
          new Promise((r) =>
            server.close(() => {
              db.close();
              fs.rmSync(dir, { recursive: true, force: true });
              r();
            })
          ),
      });
    });
  });
}

function postExplain(base, body) {
  return fetch(`${base}/api/ai/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /api/ai/explain: успех, повтор без запросов, force из кэша', async () => {
  const mock = await startAiMock('ok');
  const app = await startServer();
  try {
    useAiEnv(mock.base);
    const analysisId = app.repos.analyses.insert({ url: 'https://site.test/' });
    app.repos.codeFindings.insertMany(analysisId, [
      FINDING,
      { ...FINDING, rule: 'html-dup-id', severity: 'error', message: 'Duplicate ID "x"', location: 'https://site.test/:5' },
    ]);

    // 1-й вызов: два разных промпта -> два запроса к моку
    const r1 = await readJson(await postExplain(app.base, { analysisId }));
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.explained, 2);
    assert.strictEqual(r1.cached, 0);
    assert.strictEqual(mock.requests, 2);
    assert.ok(r1.findings.every((f) => f.aiExplanation), 'все findings получили aiExplanation');

    // повтор: всё уже объяснено -> без единого запроса к GLM
    const r2 = await readJson(await postExplain(app.base, { analysisId }));
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.explained, 0);
    assert.strictEqual(mock.requests, 2);

    // force: переобъяснение берётся из кэша ai_responses -> запросов по-прежнему 2
    const r3 = await readJson(await postExplain(app.base, { analysisId, force: true }));
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(r3.explained, 2);
    assert.strictEqual(r3.cached, 2);
    assert.strictEqual(mock.requests, 2, 'кэш в SQLite должен покрывать force');

    // сохранено в БД
    const rows = app.repos.codeFindings.listByAnalysis(analysisId);
    assert.ok(rows.every((r) => r.aiExplanation));
  } finally {
    await mock.close();
    await app.stop();
  }
});

test('POST /api/ai/explain: 500 от API -> 502 { error: AI_ERROR }', async () => {
  const mock = await startAiMock('always500');
  const app = await startServer();
  try {
    useAiEnv(mock.base);
    const analysisId = app.repos.analyses.insert({ url: 'https://site.test/' });
    app.repos.codeFindings.insertMany(analysisId, [FINDING]);

    const res = await postExplain(app.base, { analysisId });
    assert.strictEqual(res.status, 502);
    const body = await readJson(res);
    assert.strictEqual(body.error, 'AI_ERROR');
    assert.ok(body.message);
    assert.strictEqual(body.explained, 0);
    assert.strictEqual(mock.requests, 2, 'на API — ровно 2 попытки');
  } finally {
    await mock.close();
    await app.stop();
  }
});

test('POST /api/ai/explain: зависший API -> 504 { error: AI_TIMEOUT }', async () => {
  const mock = await startAiMock('slow');
  const app = await startServer();
  try {
    useAiEnv(mock.base, { timeoutMs: 150 });
    const analysisId = app.repos.analyses.insert({ url: 'https://site.test/' });
    app.repos.codeFindings.insertMany(analysisId, [FINDING]);

    const res = await postExplain(app.base, { analysisId });
    assert.strictEqual(res.status, 504);
    const body = await readJson(res);
    assert.strictEqual(body.error, 'AI_TIMEOUT');
  } finally {
    await mock.close();
    await app.stop();
  }
});

test('POST /api/ai/explain: без ключа -> 400 AI_NOT_CONFIGURED', async () => {
  const app = await startServer();
  try {
    useAiEnv('http://127.0.0.1:1/v1', { apiKey: '' }); // ключа нет
    const analysisId = app.repos.analyses.insert({ url: 'https://site.test/' });
    app.repos.codeFindings.insertMany(analysisId, [FINDING]);

    const res = await postExplain(app.base, { analysisId });
    assert.strictEqual(res.status, 400);
    const body = await readJson(res);
    assert.strictEqual(body.error, 'AI_NOT_CONFIGURED');
  } finally {
    await app.stop();
  }
});

test('POST /api/ai/explain: нет находок -> ok; нет анализа -> 404', async () => {
  const mock = await startAiMock('ok');
  const app = await startServer();
  try {
    useAiEnv(mock.base);
    const emptyId = app.repos.analyses.insert({ url: 'https://site.test/empty' });
    const r1 = await readJson(await postExplain(app.base, { analysisId: emptyId }));
    assert.deepStrictEqual(r1, { ok: true, analysisId: emptyId, findings: [], explained: 0, cached: 0 });
    assert.strictEqual(mock.requests, 0);

    const res404 = await postExplain(app.base, { analysisId: 999999 });
    assert.strictEqual(res404.status, 404);
    assert.strictEqual((await readJson(res404)).error, 'NOT_FOUND');
  } finally {
    await mock.close();
    await app.stop();
  }
});
