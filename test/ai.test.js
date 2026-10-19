const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { openDb, migrate } = require('../src/db');
const { createAuth } = require('../web/app');
const { createRepos } = require('../src/db/repositories');
const { getAi, resetAi, explainFinding, explainMissing, buildMessages, promptHash } = require('../src/ai');
const { createApp } = require('../web/app');

// Тесты не должны зависеть от локального .env: ключи и адреса провайдера
// задаются в каждом тесте явно (иначе запрос уйдёт на реальный API).
for (const key of [
  'AI_API_KEY', 'AI_BASE_URL', 'AI_PROVIDER', 'AI_MODEL',
  'AI_MAX_TOKENS', 'AI_TEMPERATURE', 'AI_TIMEOUT_MS', 'AI_THINKING',
]) {
  delete process.env[key];
}

// ------------------------------------------------------------- РјРѕРє GLM-СЃРµСЂРІРµСЂР°

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
 * OpenAI-СЃРѕРІРјРµСЃС‚РёРјС‹Р№ РјРѕРє.
 * mode: 'ok' | 'flaky502' (РїРµСЂРІС‹Р№ Р·Р°РїСЂРѕСЃ вЂ” 502) | 'always500' | 'slow' (СЃРїРёС‚ 2.5 СЃ)
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
        /* РєР»РёРµРЅС‚ СѓР¶Рµ РѕС‚РІР°Р»РёР»СЃСЏ РїРѕ С‚Р°Р№РјР°СѓС‚Сѓ вЂ” РЅРµ РєСЂРёС‚РёС‡РЅРѕ */
      }
    };
    if (mode === 'ok') return send(200, completion('РћР±СЉСЏСЃРЅРµРЅРёРµ РѕС‚ GLM: РёСЃРїСЂР°РІСЊС‚Рµ СЃРµР»РµРєС‚РѕСЂ.'));
    if (mode === 'flaky502') {
      if (requests === 1) return send(502, '{"error":"bad gateway"}');
      return send(200, completion('РћР±СЉСЏСЃРЅРµРЅРёРµ РїРѕСЃР»Рµ РїРѕРІС‚РѕСЂР°.'));
    }
    if (mode === 'always500') return send(500, '{"error":"internal"}');
    if (mode === 'slow') {
      const t = setTimeout(() => send(200, completion('РїРѕР·РґРЅРёР№ РѕС‚РІРµС‚')), 2500);
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
  const apiKey = extra.apiKey !== undefined ? extra.apiKey : 'test-key-not-real';
  process.env.GLM_API_KEY = apiKey;
  process.env.GLM_BASE_URL = base;
  process.env.GLM_MODEL = 'glm-4.5';
  // AI_* имеют приоритет над GLM_* — задаём их тоже, иначе провайдер
  // возьмёт адрес из локального .env и уйдёт на реальный API.
  process.env.AI_PROVIDER = 'openai';
  process.env.AI_API_KEY = apiKey;
  process.env.AI_BASE_URL = base;
  process.env.AI_MODEL = 'glm-4.5';
  if (extra.timeoutMs) {
    process.env.GLM_TIMEOUT_MS = String(extra.timeoutMs);
    process.env.AI_TIMEOUT_MS = String(extra.timeoutMs);
  } else {
    delete process.env.GLM_TIMEOUT_MS;
    delete process.env.AI_TIMEOUT_MS;
  }
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
  message: 'Р”РµРєР»Р°СЂР°С†РёР№ СЃ !important: 12 С€С‚',
  suggestion: 'РЈР±РµСЂРёС‚Рµ !important, РїРѕРІС‹СЃСЊС‚Рµ СЃРїРµС†РёС„РёС‡РЅРѕСЃС‚СЊ СЃРµР»РµРєС‚РѕСЂР°.',
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

test('buildMessages РґРµС‚РµСЂРјРёРЅРёСЂРѕРІР°РЅ, hash СЃС‚Р°Р±РёР»РµРЅ (sha256, Р±РµР· РєР»СЋС‡Р° API)', () => {
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
  assert.strictEqual(h1, h2, 'С…СЌС€ РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ СЃС‚Р°Р±РёР»РµРЅ');
  assert.notStrictEqual(h1, h3, 'СЂР°Р·РЅР°СЏ РјРѕРґРµР»СЊ вЂ” РґСЂСѓРіРѕР№ РєР»СЋС‡ РєСЌС€Р°');
  assert.match(h1, /^[0-9a-f]{64}$/, 'sha256-С…СЌС€');
});

// ------------------------------------------------------- СѓСЃРїРµС… Рё РєСЌС€ (unit)

test('СѓСЃРїРµС… + РєСЌС€: РѕРґРёРЅ Р·Р°РїСЂРѕСЃ Рє GLM РЅР° РґРІР° РѕРґРёРЅР°РєРѕРІС‹С… РѕР±СЉСЏСЃРЅРµРЅРёСЏ', async () => {
  const mock = await startAiMock('ok');
  const ctx = tempRepos();
  try {
    useAiEnv(mock.base);
    const ai = getAi();
    assert.strictEqual(ai.configured, true);

    const analysisId = ctx.repos.analyses.insert({ url: 'https://site.test/' });
    ctx.repos.codeFindings.insertMany(analysisId, [FINDING]);

    // РїРµСЂРІС‹Р№ РїСЂРѕС…РѕРґ вЂ” Р¶РёРІРѕР№ РІС‹Р·РѕРІ
    let rows = ctx.repos.codeFindings.listByAnalysis(analysisId);
    const r1 = await explainMissing(rows, { ai, repos: ctx.repos });
    assert.deepStrictEqual({ ok: r1.ok, explained: r1.explained, cached: r1.cached }, { ok: true, explained: 1, cached: 0 });
    assert.strictEqual(mock.requests, 1);

    // РїРѕРІС‚РѕСЂ (force) вЂ” Р±РµСЂС‘С‚СЃСЏ РёР· РєСЌС€Р°, Р·Р°РїСЂРѕСЃРѕРІ Рє РјРѕРєСѓ РЅРµ РїСЂРёР±Р°РІРёР»РѕСЃСЊ
    rows = ctx.repos.codeFindings.listByAnalysis(analysisId);
    assert.strictEqual(rows[0].aiExplanation, 'РћР±СЉСЏСЃРЅРµРЅРёРµ РѕС‚ GLM: РёСЃРїСЂР°РІСЊС‚Рµ СЃРµР»РµРєС‚РѕСЂ.', 'СЃРѕС…СЂР°РЅРёР»РѕСЃСЊ РІ code_findings');
    const r2 = await explainMissing(rows, { ai, repos: ctx.repos, force: true });
    assert.deepStrictEqual({ ok: r2.ok, explained: r2.explained, cached: r2.cached }, { ok: true, explained: 1, cached: 1 });
    assert.strictEqual(mock.requests, 1, 'РєСЌС€ РґРѕР»Р¶РµРЅ СЌРєРѕРЅРѕРјРёС‚СЊ РІС‹Р·РѕРІС‹ GLM');

    // explainFinding РЅР°РїСЂСЏРјСѓСЋ: РІС‚РѕСЂРѕР№ РІС‹Р·РѕРІ вЂ” cached
    const direct = await explainFinding({ ...FINDING }, { ai, repos: ctx.repos });
    assert.strictEqual(direct.cached, true);
    assert.strictEqual(mock.requests, 1);
  } finally {
    await mock.close();
    ctx.cleanup();
  }
});

test('РїРѕРІС‚РѕСЂ 1 СЂР°Р· РЅР° 502 -> СѓСЃРїРµС… (СЂРѕРІРЅРѕ 2 Р·Р°РїСЂРѕСЃР°)', async () => {
  const mock = await startAiMock('flaky502');
  const ctx = tempRepos();
  try {
    useAiEnv(mock.base);
    const res = await explainFinding({ ...FINDING }, { ai: getAi(), repos: ctx.repos });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.text, 'РћР±СЉСЏСЃРЅРµРЅРёРµ РїРѕСЃР»Рµ РїРѕРІС‚РѕСЂР°.');
    assert.strictEqual(mock.requests, 2, 'СЂРѕРІРЅРѕ РѕРґРёРЅ РїРѕРІС‚РѕСЂ РЅР° 5xx');
  } finally {
    await mock.close();
    ctx.cleanup();
  }
});

test('500 РґРІР°Р¶РґС‹ -> AI_ERROR (СЂРѕРІРЅРѕ 2 РїРѕРїС‹С‚РєРё, Р±РµР· РєСЌС€Р° РѕС€РёР±РѕРє)', async () => {
  const mock = await startAiMock('always500');
  const ctx = tempRepos();
  try {
    useAiEnv(mock.base);
    const res = await explainFinding({ ...FINDING }, { ai: getAi(), repos: ctx.repos });
    assert.deepStrictEqual(res, { ok: false, error: 'AI_ERROR' });
    assert.strictEqual(mock.requests, 2);
    // РѕС€РёР±РєРё РЅРµ РєСЌС€РёСЂСѓСЋС‚СЃСЏ
    assert.strictEqual(ctx.repos.aiResponses.get(promptHash('glm-4.5', buildMessages(FINDING))), null);
  } finally {
    await mock.close();
    ctx.cleanup();
  }
});

test('С‚Р°Р№РјР°СѓС‚ -> AI_TIMEOUT', async () => {
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
  const auth = createAuth({});
  const app = createApp({ db, auth });
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

test('POST /api/ai/explain: СѓСЃРїРµС…, РїРѕРІС‚РѕСЂ Р±РµР· Р·Р°РїСЂРѕСЃРѕРІ, force РёР· РєСЌС€Р°', async () => {
  const mock = await startAiMock('ok');
  const app = await startServer();
  try {
    useAiEnv(mock.base);
    const analysisId = app.repos.analyses.insert({ url: 'https://site.test/' });
    app.repos.codeFindings.insertMany(analysisId, [
      FINDING,
      { ...FINDING, rule: 'html-dup-id', severity: 'error', message: 'Duplicate ID "x"', location: 'https://site.test/:5' },
    ]);

    // 1-Р№ РІС‹Р·РѕРІ: РґРІР° СЂР°Р·РЅС‹С… РїСЂРѕРјРїС‚Р° -> РґРІР° Р·Р°РїСЂРѕСЃР° Рє РјРѕРєСѓ
    const r1 = await readJson(await postExplain(app.base, { analysisId }));
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.explained, 2);
    assert.strictEqual(r1.cached, 0);
    assert.strictEqual(mock.requests, 2);
    assert.ok(r1.findings.every((f) => f.aiExplanation), 'РІСЃРµ findings РїРѕР»СѓС‡РёР»Рё aiExplanation');

    // РїРѕРІС‚РѕСЂ: РІСЃС‘ СѓР¶Рµ РѕР±СЉСЏСЃРЅРµРЅРѕ -> Р±РµР· РµРґРёРЅРѕРіРѕ Р·Р°РїСЂРѕСЃР° Рє GLM
    const r2 = await readJson(await postExplain(app.base, { analysisId }));
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.explained, 0);
    assert.strictEqual(mock.requests, 2);

    // force: РїРµСЂРµРѕР±СЉСЏСЃРЅРµРЅРёРµ Р±РµСЂС‘С‚СЃСЏ РёР· РєСЌС€Р° ai_responses -> Р·Р°РїСЂРѕСЃРѕРІ РїРѕ-РїСЂРµР¶РЅРµРјСѓ 2
    const r3 = await readJson(await postExplain(app.base, { analysisId, force: true }));
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(r3.explained, 2);
    assert.strictEqual(r3.cached, 2);
    assert.strictEqual(mock.requests, 2, 'РєСЌС€ РІ SQLite РґРѕР»Р¶РµРЅ РїРѕРєСЂС‹РІР°С‚СЊ force');

    // СЃРѕС…СЂР°РЅРµРЅРѕ РІ Р‘Р”
    const rows = app.repos.codeFindings.listByAnalysis(analysisId);
    assert.ok(rows.every((r) => r.aiExplanation));
  } finally {
    await mock.close();
    await app.stop();
  }
});

test('POST /api/ai/explain: 500 РѕС‚ API -> 502 { error: AI_ERROR }', async () => {
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
    assert.strictEqual(mock.requests, 2, 'РЅР° API вЂ” СЂРѕРІРЅРѕ 2 РїРѕРїС‹С‚РєРё');
  } finally {
    await mock.close();
    await app.stop();
  }
});

test('POST /api/ai/explain: Р·Р°РІРёСЃС€РёР№ API -> 504 { error: AI_TIMEOUT }', async () => {
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

test('POST /api/ai/explain: Р±РµР· РєР»СЋС‡Р° -> 400 AI_NOT_CONFIGURED', async () => {
  const app = await startServer();
  try {
    useAiEnv('http://127.0.0.1:1/v1', { apiKey: '' }); // РєР»СЋС‡Р° РЅРµС‚
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

test('POST /api/ai/explain: РЅРµС‚ РЅР°С…РѕРґРѕРє -> ok; РЅРµС‚ Р°РЅР°Р»РёР·Р° -> 404', async () => {
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
