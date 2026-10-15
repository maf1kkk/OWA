const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { openDb, migrate } = require('../src/db');
const { createApp } = require('../web/app');
const { resetAi } = require('../src/ai');

// ------------------------------------------------------------- локальный сайт

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

// Заведомо плохой CSS: 10 !important, дубли селекторов, пустое правило, неиспользуемый селектор
const STYLE_CSS = `
.s1 { color: red !important; margin: 0 !important; padding: 0 !important; border: 0 !important; }
.s1 { color: blue !important; background: white !important; display: block !important; position: relative !important; }
.s1 { color: green !important; width: 100% !important; }
.s2 { display: flex; }
.s2 { display: grid; }
.empty { }
.ghost { color: red; }
`;

// Синтаксическая ошибка CSS
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
  const app = createApp({ db });
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

// Мок GLM (OpenAI-совместимый) — чтобы флаг explain не ходил в сеть
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
        choices: [{ index: 0, message: { role: 'assistant', content: 'Краткое объяснение проблемы.' }, finish_reason: 'stop' }],
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

// ------------------------------------------------------------ интеграция

test('POST /api/code-analysis: полный цикл сессии на заведомо плохом сайте', async () => {
  const site = await startSite();
  const app = await startApp();
  const aiMock = await startAiMock();
  process.env.GLM_API_KEY = 'test-key-not-real';
  process.env.GLM_BASE_URL = aiMock.base;
  process.env.GLM_MODEL = 'glm-4.5';
  resetAi();
  try {
    // --- Шаг 1: создание сессии (fetch + анализ HTML)
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
    assert.ok(htmlRules.includes('html-no-lang'), 'нет html-no-lang: ' + htmlRules);
    assert.ok(htmlRules.includes('html-img-alt'), 'нет html-img-alt');
    assert.ok(htmlRules.includes('html-dup-id'), 'нет html-dup-id');
    assert.ok(htmlRules.includes('html-deprecated-tag'), 'нет html-deprecated-tag');
    // формат findings сохранён
    for (const f of first.findings) {
      assert.ok(f.id && f.metric && f.verdict && f.message, JSON.stringify(f));
      assert.ok(['good', 'warn', 'bad', 'info'].includes(f.verdict));
      assert.ok(['error', 'warning', 'info'].includes(f.severity));
      assert.ok(f.location);
    }

    // --- Шаг 2: продолжение (батч CSS)
    const r2 = await post(app.base, { sessionId: first.sessionId });
    const t2 = await r2.text();
    assert.strictEqual(r2.status, 200, t2);
    const cssStep = JSON.parse(t2);
    assert.strictEqual(cssStep.done, false);
    assert.strictEqual(cssStep.step, 'js');
    const cssRules = cssStep.findings.map((f) => f.rule);
    assert.ok(cssRules.includes('css-important'), 'нет css-important: ' + cssRules);
    assert.ok(cssRules.includes('css-duplicate-selector'), 'нет css-duplicate-selector');
    assert.ok(cssRules.includes('css-empty-rule'), 'нет css-empty-rule');
    assert.ok(cssRules.includes('css-unused-selector'), 'нет css-unused-selector');
    assert.ok(cssRules.includes('css-syntax'), 'нет css-syntax');

    // Приёмочный критерий ТЗ: на плохом CSS — минимум 3 finding
    const cssFindings = cssStep.findings.filter((f) => f.id.startsWith('css-'));
    assert.ok(cssFindings.length >= 3, `css-находок должно быть >= 3, получено ${cssFindings.length}`);

    // --- Шаг 3: продолжение (батч JS) -> done, с AI-объяснениями
    const r3 = await post(app.base, { sessionId: first.sessionId, explain: true });
    const t3 = await r3.text();
    assert.strictEqual(r3.status, 200, t3);
    const jsStep = JSON.parse(t3);
    assert.strictEqual(jsStep.done, true);
    const jsRules = jsStep.findings.map((f) => f.rule);
    assert.ok(jsRules.includes('js-console'), 'нет js-console: ' + jsRules);
    assert.ok(jsRules.includes('js-debugger'), 'нет js-debugger');
    assert.ok(jsRules.includes('js-eval'), 'нет js-eval');
    assert.ok(jsStep.summary, 'нет summary по завершении');
    assert.ok(['good', 'warn', 'bad'].includes(jsStep.summary.status));
    assert.strictEqual(typeof jsStep.summary.score, 'number');

    // AI: explain:true объяснил все накопленные находки (кэш + мок, без сети)
    assert.ok(jsStep.ai, 'нет блока ai');
    assert.strictEqual(jsStep.ai.configured, true);
    assert.strictEqual(jsStep.ai.error, undefined, 'не должно быть aiError');
    assert.strictEqual(jsStep.ai.explained, jsStep.totalFindings, 'объяснены все находки');
    assert.ok(aiMock.requests > 0, 'мок должен был получить запросы');
    assert.ok(jsStep.findings.every((f) => f.aiExplanation), 'новые findings получили aiExplanation');
    const aiRows = app.repos.codeFindings.listByAnalysis(first.analysisId);
    assert.ok(aiRows.every((r) => r.aiExplanation), 'ai_explanation сохранён в code_findings');
    // повторное объяснение того же шага — всё из кэша, новых запросов нет
    const before = aiMock.requests;
    const again = await post(app.base, { sessionId: first.sessionId, explain: true });
    const againBody = await again.json();
    assert.strictEqual(againBody.ai.explained, 0, 'повторять нечего');
    assert.strictEqual(aiMock.requests, before, 'кэш не должен пускать новые запросы');

    // --- Идемпотентность: вызов после done
    const r4 = await post(app.base, { sessionId: first.sessionId });
    assert.strictEqual(r4.status, 200);
    const after = await r4.json();
    assert.strictEqual(after.done, true);
    assert.strictEqual(after.findings.length, 0);

    // --- История: запись с summary
    const history = await (await fetch(`${app.base}/api/history`)).json();
    const item = history.items.find((i) => i.id === first.analysisId);
    assert.ok(item, 'нет записи в истории');
    assert.ok(item.summary, 'нет summary в истории');

    const details = await (await fetch(`${app.base}/api/history/${first.analysisId}`)).json();
    assert.strictEqual(details.analysis.codeFindings.length, jsStep.totalFindings);
    assert.ok(details.analysis.codeFindings.length >= 10, `всего находок: ${details.analysis.codeFindings.length}`);

    // --- Каскад: удаление истории чистит code_findings и code_sessions
    const del = await fetch(`${app.base}/api/history/${first.analysisId}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(app.db.prepare('SELECT COUNT(*) AS n FROM code_findings').get().n, 0, 'code_findings не удалены');
    assert.strictEqual(app.db.prepare('SELECT COUNT(*) AS n FROM code_sessions').get().n, 0, 'code_sessions не удалены');
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

// ---------------------------------------------------------------- ошибки

test('POST /api/code-analysis: ошибки валидации и сессий', async () => {
  const app = await startApp();
  try {
    // нет ни url, ни sessionId
    const r1 = await post(app.base, {});
    assert.strictEqual(r1.status, 400);
    const b1 = await r1.json();
    assert.strictEqual(b1.error, 'VALIDATION');
    assert.ok(b1.message.includes('url'));

    // невалидный протокол
    const r2 = await post(app.base, { url: 'ftp://example.com' });
    assert.strictEqual(r2.status, 400);
    assert.strictEqual((await r2.json()).error, 'INVALID_URL');

    // несуществующая сессия
    const r3 = await post(app.base, { sessionId: 999999 });
    assert.strictEqual(r3.status, 404);
    assert.strictEqual((await r3.json()).error, 'SESSION_NOT_FOUND');

    // недоступный сайт -> FETCH_FAILED (502), запись об ошибке в истории
    const r4 = await post(app.base, { url: 'http://127.0.0.1:9/', timeout: 5000 });
    const t4 = await r4.text();
    assert.strictEqual(r4.status, 502, t4);
    const b4 = JSON.parse(t4);
    assert.strictEqual(b4.error, 'FETCH_FAILED');
    const history = await (await fetch(`${app.base}/api/history`)).json();
    const failed = history.items.find((i) => i.url === 'http://127.0.0.1:9/');
    assert.ok(failed, 'ошибочный анализ должен попасть в историю');
    assert.strictEqual(failed.status, 'error');
  } finally {
    await app.stop();
  }
});

test('миграции: user_version = 2 (включая code_sessions)', async () => {
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
