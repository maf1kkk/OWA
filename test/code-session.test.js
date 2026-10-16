const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { openDb, migrate } = require('../src/db');
const { createAuth } = require('../web/app');
const { createApp } = require('../web/app');
const { resetAi } = require('../src/ai');

// ------------------------------------------------------------- Р»РѕРєР°Р»СЊРЅС‹Р№ СЃР°Р№С‚

const INDEX_HTML = `<!doctype html>
<html>
<head>
  <title>Bad page</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/bad.css">
</head>
<body>
  <h1>Test</h1>
  <img src="/x.png">
  <div id="dup">1</div><div id="dup">2</div>
  <font size="2">old</font>
  <div class="s1 s2">styled</div>
  <script src="/app.js"></script>
</body>
</html>`;

// Р—Р°РІРµРґРѕРјРѕ РїР»РѕС…РѕР№ CSS: 10 !important, РґСѓР±Р»Рё СЃРµР»РµРєС‚РѕСЂРѕРІ, РїСѓСЃС‚РѕРµ РїСЂР°РІРёР»Рѕ, РЅРµРёСЃРїРѕР»СЊР·СѓРµРјС‹Р№ СЃРµР»РµРєС‚РѕСЂ
const STYLE_CSS = `
.s1 { color: red !important; margin: 0 !important; padding: 0 !important; border: 0 !important; }
.s1 { color: blue !important; background: white !important; display: block !important; position: relative !important; }
.s1 { color: green !important; width: 100% !important; }
.s2 { display: flex; }
.s2 { display: grid; }
.empty { }
.ghost { color: red; }
`;

// РЎРёРЅС‚Р°РєСЃРёС‡РµСЃРєР°СЏ РѕС€РёР±РєР° CSS
const BAD_CSS = 'a { color: blah } .y { !!! }';

const APP_JS = `
console.log('start');
console.debug('dbg');
debugger;
eval('1+1');
`;

function startSite() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const map = {
        '/': ['text/html; charset=utf-8', INDEX_HTML],
        '/style.css': ['text/css', STYLE_CSS],
        '/bad.css': ['text/css', BAD_CSS],
        '/app.js': ['text/javascript', APP_JS],
      };
      const hit = map[req.url];
      if (!hit) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': hit[0] });
      res.end(hit[1]);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-code-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  const auth = createAuth({});
  const app = createApp({ db, auth });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    db,
    repos: app.locals.repos,
    stop: () =>
      new Promise((resolve) =>
        server.close(() => {
          db.close();
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        })
      ),
  };
}

function post(base, body) {
  return fetch(`${base}/api/code-analysis`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// РњРѕРє GLM (OpenAI-СЃРѕРІРјРµСЃС‚РёРјС‹Р№) вЂ” С‡С‚РѕР±С‹ С„Р»Р°Рі explain РЅРµ С…РѕРґРёР» РІ СЃРµС‚СЊ
function startAiMock() {
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (!String(req.url).endsWith('/chat/completions')) return void res.writeHead(404).end();
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 1,
        model: 'glm-4.5',
        choices: [{ index: 0, message: { role: 'assistant', content: 'РљСЂР°С‚РєРѕРµ РѕР±СЉСЏСЃРЅРµРЅРёРµ РїСЂРѕР±Р»РµРјС‹.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}/v1`,
        get requests() {
          return requests;
        },
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

// ------------------------------------------------------------ РёРЅС‚РµРіСЂР°С†РёСЏ

test('POST /api/code-analysis: РїРѕР»РЅС‹Р№ С†РёРєР» СЃРµСЃСЃРёРё РЅР° Р·Р°РІРµРґРѕРјРѕ РїР»РѕС…РѕРј СЃР°Р№С‚Рµ', async () => {
  const site = await startSite();
  const app = await startApp();
  const aiMock = await startAiMock();
  process.env.GLM_API_KEY = 'test-key-not-real';
  process.env.GLM_BASE_URL = aiMock.base;
  process.env.GLM_MODEL = 'glm-4.5';
  resetAi();
  try {
    // --- РЁР°Рі 1: СЃРѕР·РґР°РЅРёРµ СЃРµСЃСЃРёРё (fetch + Р°РЅР°Р»РёР· HTML)
    const r1 = await post(app.base, { url: site.url });
    const t1 = await r1.text();
    assert.strictEqual(r1.status, 200, t1);
    const first = JSON.parse(t1);
    assert.strictEqual(first.ok, true);
    assert.ok(first.sessionId > 0);
    assert.ok(first.analysisId > 0);
    assert.strictEqual(first.done, false);
    assert.strictEqual(first.step, 'css');

    const htmlRules = first.findings.map((f) => f.rule);
    assert.ok(htmlRules.includes('html-no-lang'), 'РЅРµС‚ html-no-lang: ' + htmlRules);
    assert.ok(htmlRules.includes('html-img-alt'), 'РЅРµС‚ html-img-alt');
    assert.ok(htmlRules.includes('html-dup-id'), 'РЅРµС‚ html-dup-id');
    assert.ok(htmlRules.includes('html-deprecated-tag'), 'РЅРµС‚ html-deprecated-tag');
    // С„РѕСЂРјР°С‚ findings СЃРѕС…СЂР°РЅС‘РЅ
    for (const f of first.findings) {
      assert.ok(f.id && f.metric && f.verdict && f.message, JSON.stringify(f));
      assert.ok(['good', 'warn', 'bad', 'info'].includes(f.verdict));
      assert.ok(['error', 'warning', 'info'].includes(f.severity));
      assert.ok(f.location);
    }

    // --- РЁР°Рі 2: РїСЂРѕРґРѕР»Р¶РµРЅРёРµ (Р±Р°С‚С‡ CSS)
    const r2 = await post(app.base, { sessionId: first.sessionId });
    const t2 = await r2.text();
    assert.strictEqual(r2.status, 200, t2);
    const cssStep = JSON.parse(t2);
    assert.strictEqual(cssStep.done, false);
    assert.strictEqual(cssStep.step, 'js');
    const cssRules = cssStep.findings.map((f) => f.rule);
    assert.ok(cssRules.includes('css-important'), 'РЅРµС‚ css-important: ' + cssRules);
    assert.ok(cssRules.includes('css-duplicate-selector'), 'РЅРµС‚ css-duplicate-selector');
    assert.ok(cssRules.includes('css-empty-rule'), 'РЅРµС‚ css-empty-rule');
    assert.ok(cssRules.includes('css-unused-selector'), 'РЅРµС‚ css-unused-selector');
    assert.ok(cssRules.includes('css-syntax'), 'РЅРµС‚ css-syntax');

    // РџСЂРёС‘РјРѕС‡РЅС‹Р№ РєСЂРёС‚РµСЂРёР№ РўР—: РЅР° РїР»РѕС…РѕРј CSS вЂ” РјРёРЅРёРјСѓРј 3 finding
    const cssFindings = cssStep.findings.filter((f) => f.id.startsWith('css-'));
    assert.ok(cssFindings.length >= 3, `css-РЅР°С…РѕРґРѕРє РґРѕР»Р¶РЅРѕ Р±С‹С‚СЊ >= 3, РїРѕР»СѓС‡РµРЅРѕ ${cssFindings.length}`);

    // --- РЁР°Рі 3: РїСЂРѕРґРѕР»Р¶РµРЅРёРµ (Р±Р°С‚С‡ JS) -> done, СЃ AI-РѕР±СЉСЏСЃРЅРµРЅРёСЏРјРё
    const r3 = await post(app.base, { sessionId: first.sessionId, explain: true });
    const t3 = await r3.text();
    assert.strictEqual(r3.status, 200, t3);
    const jsStep = JSON.parse(t3);
    assert.strictEqual(jsStep.done, true);
    const jsRules = jsStep.findings.map((f) => f.rule);
    assert.ok(jsRules.includes('js-console'), 'РЅРµС‚ js-console: ' + jsRules);
    assert.ok(jsRules.includes('js-debugger'), 'РЅРµС‚ js-debugger');
    assert.ok(jsRules.includes('js-eval'), 'РЅРµС‚ js-eval');
    assert.ok(jsStep.summary, 'РЅРµС‚ summary РїРѕ Р·Р°РІРµСЂС€РµРЅРёРё');
    assert.ok(['good', 'warn', 'bad'].includes(jsStep.summary.status));
    assert.strictEqual(typeof jsStep.summary.score, 'number');

    // AI: explain:true РѕР±СЉСЏСЃРЅРёР» РІСЃРµ РЅР°РєРѕРїР»РµРЅРЅС‹Рµ РЅР°С…РѕРґРєРё (РєСЌС€ + РјРѕРє, Р±РµР· СЃРµС‚Рё)
    assert.ok(jsStep.ai, 'РЅРµС‚ Р±Р»РѕРєР° ai');
    assert.strictEqual(jsStep.ai.configured, true);
    assert.strictEqual(jsStep.ai.error, undefined, 'РЅРµ РґРѕР»Р¶РЅРѕ Р±С‹С‚СЊ aiError');
    assert.strictEqual(jsStep.ai.explained, jsStep.totalFindings, 'РѕР±СЉСЏСЃРЅРµРЅС‹ РІСЃРµ РЅР°С…РѕРґРєРё');
    assert.ok(aiMock.requests > 0, 'РјРѕРє РґРѕР»Р¶РµРЅ Р±С‹Р» РїРѕР»СѓС‡РёС‚СЊ Р·Р°РїСЂРѕСЃС‹');
    assert.ok(jsStep.findings.every((f) => f.aiExplanation), 'РЅРѕРІС‹Рµ findings РїРѕР»СѓС‡РёР»Рё aiExplanation');
    const aiRows = app.repos.codeFindings.listByAnalysis(first.analysisId);
    assert.ok(aiRows.every((r) => r.aiExplanation), 'ai_explanation СЃРѕС…СЂР°РЅС‘РЅ РІ code_findings');
    // РїРѕРІС‚РѕСЂРЅРѕРµ РѕР±СЉСЏСЃРЅРµРЅРёРµ С‚РѕРіРѕ Р¶Рµ С€Р°РіР° вЂ” РІСЃС‘ РёР· РєСЌС€Р°, РЅРѕРІС‹С… Р·Р°РїСЂРѕСЃРѕРІ РЅРµС‚
    const before = aiMock.requests;
    const again = await post(app.base, { sessionId: first.sessionId, explain: true });
    const againBody = await again.json();
    assert.strictEqual(againBody.ai.explained, 0, 'РїРѕРІС‚РѕСЂСЏС‚СЊ РЅРµС‡РµРіРѕ');
    assert.strictEqual(aiMock.requests, before, 'РєСЌС€ РЅРµ РґРѕР»Р¶РµРЅ РїСѓСЃРєР°С‚СЊ РЅРѕРІС‹Рµ Р·Р°РїСЂРѕСЃС‹');

    // --- РРґРµРјРїРѕС‚РµРЅС‚РЅРѕСЃС‚СЊ: РІС‹Р·РѕРІ РїРѕСЃР»Рµ done
    const r4 = await post(app.base, { sessionId: first.sessionId });
    assert.strictEqual(r4.status, 200);
    const after = await r4.json();
    assert.strictEqual(after.done, true);
    assert.strictEqual(after.findings.length, 0);

    // --- РСЃС‚РѕСЂРёСЏ: Р·Р°РїРёСЃСЊ СЃ summary
    const history = await (await fetch(`${app.base}/api/history`)).json();
    const item = history.items.find((i) => i.id === first.analysisId);
    assert.ok(item, 'РЅРµС‚ Р·Р°РїРёСЃРё РІ РёСЃС‚РѕСЂРёРё');
    assert.ok(item.summary, 'РЅРµС‚ summary РІ РёСЃС‚РѕСЂРёРё');

    const details = await (await fetch(`${app.base}/api/history/${first.analysisId}`)).json();
    assert.strictEqual(details.analysis.codeFindings.length, jsStep.totalFindings);
    assert.ok(details.analysis.codeFindings.length >= 10, `РІСЃРµРіРѕ РЅР°С…РѕРґРѕРє: ${details.analysis.codeFindings.length}`);

    // --- РљР°СЃРєР°Рґ: СѓРґР°Р»РµРЅРёРµ РёСЃС‚РѕСЂРёРё С‡РёСЃС‚РёС‚ code_findings Рё code_sessions
    const del = await fetch(`${app.base}/api/history/${first.analysisId}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(app.db.prepare('SELECT COUNT(*) AS n FROM code_findings').get().n, 0, 'code_findings РЅРµ СѓРґР°Р»РµРЅС‹');
    assert.strictEqual(app.db.prepare('SELECT COUNT(*) AS n FROM code_sessions').get().n, 0, 'code_sessions РЅРµ СѓРґР°Р»РµРЅС‹');
  } finally {
    delete process.env.GLM_API_KEY;
    delete process.env.GLM_BASE_URL;
    delete process.env.GLM_MODEL;
    resetAi();
    await aiMock.close();
    await app.stop();
    await site.close();
  }
});

// ---------------------------------------------------------------- РѕС€РёР±РєРё

test('POST /api/code-analysis: РѕС€РёР±РєРё РІР°Р»РёРґР°С†РёРё Рё СЃРµСЃСЃРёР№', async () => {
  const app = await startApp();
  try {
    // РЅРµС‚ РЅРё url, РЅРё sessionId
    const r1 = await post(app.base, {});
    assert.strictEqual(r1.status, 400);
    const b1 = await r1.json();
    assert.strictEqual(b1.error, 'VALIDATION');
    assert.ok(b1.message.includes('url'));

    // РЅРµРІР°Р»РёРґРЅС‹Р№ РїСЂРѕС‚РѕРєРѕР»
    const r2 = await post(app.base, { url: 'ftp://example.com' });
    assert.strictEqual(r2.status, 400);
    assert.strictEqual((await r2.json()).error, 'INVALID_URL');

    // РЅРµСЃСѓС‰РµСЃС‚РІСѓСЋС‰Р°СЏ СЃРµСЃСЃРёСЏ
    const r3 = await post(app.base, { sessionId: 999999 });
    assert.strictEqual(r3.status, 404);
    assert.strictEqual((await r3.json()).error, 'SESSION_NOT_FOUND');

    // РЅРµРґРѕСЃС‚СѓРїРЅС‹Р№ СЃР°Р№С‚ -> FETCH_FAILED (502), Р·Р°РїРёСЃСЊ РѕР± РѕС€РёР±РєРµ РІ РёСЃС‚РѕСЂРёРё
    const r4 = await post(app.base, { url: 'http://127.0.0.1:9/', timeout: 5000 });
    const t4 = await r4.text();
    assert.strictEqual(r4.status, 502, t4);
    const b4 = JSON.parse(t4);
    assert.strictEqual(b4.error, 'FETCH_FAILED');
    const history = await (await fetch(`${app.base}/api/history`)).json();
    const failed = history.items.find((i) => i.url === 'http://127.0.0.1:9/');
    assert.ok(failed, 'РѕС€РёР±РѕС‡РЅС‹Р№ Р°РЅР°Р»РёР· РґРѕР»Р¶РµРЅ РїРѕРїР°СЃС‚СЊ РІ РёСЃС‚РѕСЂРёСЋ');
    assert.strictEqual(failed.status, 'error');
  } finally {
    await app.stop();
  }
});

test('РјРёРіСЂР°С†РёРё: user_version = 2 (РІРєР»СЋС‡Р°СЏ code_sessions)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-mig-test-'));
  try {
    const db = openDb(path.join(dir, 'test.db'));
    const { version } = migrate(db);
    assert.strictEqual(version, 2);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes('code_sessions'));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
