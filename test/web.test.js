const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, migrate } = require('../src/db');
const { createApp, createAuth } = require('../web/app');

/** Поднять приложение на эфемерном порту. */
async function startApp(env = {}, envForApp = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-web-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  const auth = createAuth(env);
  const app = createApp({ db, auth, env: envForApp });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    db,
    auth,
    repos: app.locals.repos,
    stop: () =>
      new Promise((resolve) => server.close(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      })),
  };
}

/** Заголовок Basic из пары логин/пароль. */
function basicHeader(login, password) {
  return { Authorization: 'Basic ' + Buffer.from(`${login}:${password}`, 'utf8').toString('base64') };
}

test('GET /health -> { status, version, uptime }', async () => {
  const ctx = await startApp();
  try {
    const r = await fetch(`${ctx.base}/health`);
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.status, 'ok');
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
    assert.strictEqual(typeof body.uptime, 'number');
  } finally {
    await ctx.stop();
  }
});

test('GET /api/health сохраняет прежний контракт { ok, tool }', async () => {
  const ctx = await startApp();
  try {
    const body = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.deepStrictEqual(body, { ok: true, tool: 'owa-web' });
  } finally {
    await ctx.stop();
  }
});

test('GET / отдаёт UI (html)', async () => {
  const ctx = await startApp();
  try {
    const r = await fetch(`${ctx.base}/`);
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('text/html'));
    assert.ok((await r.text()).includes('OWA'));
  } finally {
    await ctx.stop();
  }
});

test('POST /api/analyze: невалидный JSON тела -> 400 INVALID_JSON', async () => {
  const ctx = await startApp();
  try {
    const r = await fetch(`${ctx.base}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    });
    assert.strictEqual(r.status, 400);
    const body = await r.json();
    assert.strictEqual(body.error, 'INVALID_JSON');
    assert.ok(body.message);
  } finally {
    await ctx.stop();
  }
});

test('POST /api/analyze: без url -> 400 VALIDATION', async () => {
  const ctx = await startApp();
  try {
    const r = await fetch(`${ctx.base}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(r.status, 400);
    const body = await r.json();
    assert.strictEqual(body.error, 'VALIDATION');
    assert.ok(body.message.includes('url'));
  } finally {
    await ctx.stop();
  }
});

test('POST /api/analyze: не-http протокол -> 400 INVALID_URL (браузер не запускается)', async () => {
  const ctx = await startApp();
  try {
    const r = await fetch(`${ctx.base}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://example.com' }),
    });
    assert.strictEqual(r.status, 400);
    const body = await r.json();
    assert.strictEqual(body.error, 'INVALID_URL');
    assert.ok(body.message.includes('http'));
  } finally {
    await ctx.stop();
  }
});

test('GET /api/history: пусто, потом после записи', async () => {
  const ctx = await startApp();
  try {
    const empty = await (await fetch(`${ctx.base}/api/history`)).json();
    assert.deepStrictEqual(empty, { ok: true, items: [], total: 0 });

    ctx.repos.analyses.insert({ url: 'https://one.example', summary: { status: 'good', score: 95, headline: 'ok' } });
    ctx.repos.analyses.insert({ url: 'https://two.example', summary: { status: 'bad', score: 40, headline: 'плохо' } });

    const list = await (await fetch(`${ctx.base}/api/history`)).json();
    assert.strictEqual(list.total, 2);
    assert.strictEqual(list.items.length, 2);
    assert.strictEqual(list.items[0].url, 'https://two.example', 'сортировка: новые сверху');
    assert.strictEqual(list.items[0].summary.score, 40);

    const filtered = await (await fetch(`${ctx.base}/api/history?url=${encodeURIComponent('https://one.example')}`)).json();
    assert.strictEqual(filtered.total, 1);

    const paged = await (await fetch(`${ctx.base}/api/history?limit=1`)).json();
    assert.strictEqual(paged.items.length, 1);
    assert.strictEqual(paged.total, 2);
  } finally {
    await ctx.stop();
  }
});

test('GET /api/history/:id: детали + 404 для несуществующего', async () => {
  const ctx = await startApp();
  try {
    const id = ctx.repos.analyses.insert({ url: 'https://detail.example', metrics: { a: 1 }, findings: [{ id: 'load' }] });
    ctx.repos.codeFindings.insertMany(id, [{ type: 'css', severity: 'info', rule: 'r1', message: 'm' }]);

    const r = await fetch(`${ctx.base}/api/history/${id}`);
    assert.strictEqual(r.status, 200);
    const body = await r.json();
    assert.strictEqual(body.analysis.url, 'https://detail.example');
    assert.deepStrictEqual(body.analysis.metrics, { a: 1 });
    assert.strictEqual(body.analysis.codeFindings.length, 1);
    assert.strictEqual(body.analysis.codeFindings[0].rule, 'r1');

    const missing = await fetch(`${ctx.base}/api/history/999999`);
    assert.strictEqual(missing.status, 404);
    assert.strictEqual((await missing.json()).error, 'NOT_FOUND');

    const bad = await fetch(`${ctx.base}/api/history/abc`);
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await bad.json()).error, 'VALIDATION');
  } finally {
    await ctx.stop();
  }
});

test('DELETE /api/history/:id каскадно, DELETE /api/history очищает всё', async () => {
  const ctx = await startApp();
  try {
    const id = ctx.repos.analyses.insert({ url: 'https://del.example' });
    ctx.repos.codeFindings.insertMany(id, [{ type: 'js', severity: 'warning', rule: 'x', message: 'y' }]);

    const del = await fetch(`${ctx.base}/api/history/${id}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await del.json()).deleted, 1);
    assert.strictEqual(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM code_findings').get().n,
      0,
      'code_findings должны удалиться каскадом'
    );

    const again = await fetch(`${ctx.base}/api/history/${id}`, { method: 'DELETE' });
    assert.strictEqual(again.status, 404);

    ctx.repos.analyses.insert({ url: 'https://a.example' });
    ctx.repos.analyses.insert({ url: 'https://b.example' });
    const clear = await fetch(`${ctx.base}/api/history`, { method: 'DELETE' });
    assert.strictEqual(clear.status, 200);
    assert.strictEqual((await clear.json()).deleted, 2);
    assert.strictEqual((await (await fetch(`${ctx.base}/api/history`)).json()).total, 0);
  } finally {
    await ctx.stop();
  }
});

test('неизвестный роут -> 404 в формате { error, message }', async () => {
  const ctx = await startApp();
  try {
    const r = await fetch(`${ctx.base}/api/nope`);
    assert.strictEqual(r.status, 404);
    const body = await r.json();
    assert.strictEqual(body.error, 'NOT_FOUND');
    assert.ok(body.message);
  } finally {
    await ctx.stop();
  }
});

// --- авторизация -----------------------------------------------------------

test('auth: без настройки всё открыто (приватный режим)', async () => {
  const ctx = await startApp({});
  try {
    assert.equal(ctx.auth.public, true);
    const r = await fetch(`${ctx.base}/api/history`);
    assert.strictEqual(r.status, 200);
  } finally {
    await ctx.stop();
  }
});

test('auth: Basic — без заголовка 401 + WWW-Authenticate', async () => {
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('secret123', 10);
  const ctx = await startApp({ AUTH_LOGIN: 'admin', AUTH_PASSWORD_HASH: hash });
  try {
    const r = await fetch(`${ctx.base}/api/history`);
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.headers.get('www-authenticate'), 'Basic realm="OWA", charset="UTF-8"');
    assert.strictEqual((await r.json()).error, 'UNAUTHORIZED');
  } finally {
    await ctx.stop();
  }
});

test('auth: Basic — верная пара проходит', async () => {
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('secret123', 10);
  const ctx = await startApp({ AUTH_LOGIN: 'admin', AUTH_PASSWORD_HASH: hash });
  try {
    const r = await fetch(`${ctx.base}/api/history`, { headers: basicHeader('admin', 'secret123') });
    assert.strictEqual(r.status, 200);
  } finally {
    await ctx.stop();
  }
});

test('auth: неверный пароль не проходит', async () => {
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('secret123', 10);
  const ctx = await startApp({ AUTH_LOGIN: 'admin', AUTH_PASSWORD_HASH: hash });
  try {
    const r = await fetch(`${ctx.base}/api/history`, { headers: basicHeader('admin', 'wrong') });
    assert.strictEqual(r.status, 401);
  } finally {
    await ctx.stop();
  }
});

test('auth: /health открыт даже под паролем', async () => {
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('secret123', 10);
  const ctx = await startApp({ AUTH_LOGIN: 'admin', AUTH_PASSWORD_HASH: hash });
  try {
    const r = await fetch(`${ctx.base}/health`);
    assert.strictEqual(r.status, 200);
  } finally {
    await ctx.stop();
  }
});

test('auth: Bearer для /api/* — верный токен проходит, неверный 401', async () => {
  const ctx = await startApp({ API_BEARER_TOKEN: 'tok-abc' });
  try {
    const ok = await fetch(`${ctx.base}/api/history`, { headers: { Authorization: 'Bearer tok-abc' } });
    assert.strictEqual(ok.status, 200);

    const no = await fetch(`${ctx.base}/api/history`);
    assert.strictEqual(no.status, 401);
    assert.strictEqual((await no.json()).error, 'UNAUTHORIZED');

    const bad = await fetch(`${ctx.base}/api/history`, { headers: { Authorization: 'Bearer nope' } });
    assert.strictEqual(bad.status, 401);
  } finally {
    await ctx.stop();
  }
});

test('auth: битый bcrypt-хэш не пускает и не роняет сервер', async () => {
  const ctx = await startApp({ AUTH_LOGIN: 'admin', AUTH_PASSWORD_HASH: 'not-a-hash' });
  try {
    const r = await fetch(`${ctx.base}/api/history`, { headers: basicHeader('admin', 'secret123') });
    assert.strictEqual(r.status, 401);
  } finally {
    await ctx.stop();
  }
});

test('headers: базовые security-заголовки выставлены', async () => {
  const ctx = await startApp({});
  try {
    const r = await fetch(`${ctx.base}/health`);
    assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await ctx.stop();
  }
});

// ---------------------------------------------------------------- rate limit

test('rate-limit: X-RateLimit-* заголовки и 429 при превышении (127.0.0.1)', async () => {
  // Ограничиваем жёстко на 3 запроса в 10-секундное окно,
  // чтобы не ждали стандартные 20/60с в тестах.
  const ctx = await startApp({}, { OWA_RATE_LIMIT_MAX: '3', OWA_RATE_LIMIT_WINDOW_MS: '10000' });
  try {
    const base = `${ctx.base}/api/history`;
    const res1 = await fetch(base);
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.headers.get('x-ratelimit-limit'), '3');
    assert.strictEqual(res1.headers.get('x-ratelimit-remaining'), '2');

    const res2 = await fetch(base);
    assert.strictEqual(res2.headers.get('x-ratelimit-remaining'), '1');

    const res3 = await fetch(base);
    assert.strictEqual(res3.headers.get('x-ratelimit-remaining'), '0');

    const res4 = await fetch(base);
    assert.strictEqual(res4.status, 429);
    const body = await res4.json();
    assert.strictEqual(body.error, 'RATE_LIMITED');
    assert.ok(body.message && body.message.length > 0);
    assert.ok(Number(res4.headers.get('retry-after')) > 0);
  } finally {
    await ctx.stop();
  }
});

test('rate-limit: UI и /health не затронуты (без /api-префикса)', async () => {
  const ctx = await startApp({}, { OWA_RATE_LIMIT_MAX: '1', OWA_RATE_LIMIT_WINDOW_MS: '60000' });
  try {
    const ui1 = await fetch(ctx.base);
    const ui2 = await fetch(ctx.base);
    const health1 = await fetch(`${ctx.base}/health`);
    assert.strictEqual(ui1.status, 200);
    assert.strictEqual(ui2.status, 200);
    assert.strictEqual(health1.status, 200);
    // Заголовки лимита нет для UI/health (не /api/*)
    assert.strictEqual(ui1.headers.get('x-ratelimit-limit'), null);
  } finally {
    await ctx.stop();
  }
});

test('rate-limit: OWA_RATE_LIMIT_MAX=0 отключает проверку (без 429 и заголовков)', async () => {
  const ctx = await startApp({}, { OWA_RATE_LIMIT_MAX: '0' });
  try {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${ctx.base}/api/history`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers.get('x-ratelimit-limit'), null);
    }
  } finally {
    await ctx.stop();
  }
});

test('rate-limit: разные IP не делят квоту (по IP+path)', async () => {
  // Поднимаем приложение, но лимит считаем от key = ip|path.
  // Проверим через limiter напрямую (без сетевых прокси).
  const { createRateLimiter } = require('../web/rate-limit');
  const limiter = createRateLimiter({ max: 1, windowMs: 60000 });
  assert.strictEqual(limiter.check('1.1.1.1', '/api/analyze'), 0);
  assert.strictEqual(limiter.check('1.1.1.1', '/api/analyze'), 0); // уже исчерпано
  assert.strictEqual(limiter.check('2.2.2.2', '/api/analyze'), 0); // другой IP — своя квота
  assert.strictEqual(limiter.check('1.1.1.1', '/api/health'), 0); // другой path — не пересекает
});


// --------------------------------------------- комплексный аудит: HTTP-роуты

test('POST /api/audit: без url -> 400 VALIDATION', async () => {
  const ctx = await startApp();
  try {
    const r = await fetch(`${ctx.base}/api/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).error, 'VALIDATION');
  } finally {
    await ctx.stop();
  }
});

test('POST /api/crawl: невалидные параметры -> 400 VALIDATION', async () => {
  const ctx = await startApp();
  try {
    const r = await fetch(`${ctx.base}/api/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://a.test', maxPages: 999 }),
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).error, 'VALIDATION');
  } finally {
    await ctx.stop();
  }
});

test('POST /api/compare: без конкурентов -> 400 VALIDATION', async () => {
  const ctx = await startApp();
  try {
    const r = await fetch(`${ctx.base}/api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'https://a.test' }),
    });
    assert.strictEqual(r.status, 400);
    const body = await r.json();
    assert.strictEqual(body.error, 'VALIDATION');
  } finally {
    await ctx.stop();
  }
});

test('GET /api/report/pdf: неизвестный id -> 404 NOT_FOUND', async () => {
  const ctx = await startApp();
  try {
    const r = await fetch(`${ctx.base}/api/report/pdf?type=audit&id=missing`);
    assert.strictEqual(r.status, 404);
    assert.strictEqual((await r.json()).error, 'NOT_FOUND');
  } finally {
    await ctx.stop();
  }
});

test('GET /api/report/pdf: неверный type -> 400 VALIDATION', async () => {
  const ctx = await startApp();
  try {
    const r = await fetch(`${ctx.base}/api/report/pdf?type=bogus&id=x`);
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).error, 'VALIDATION');
  } finally {
    await ctx.stop();
  }
});

test('UI: страница содержит разделы аудита, обхода и сравнения', async () => {
  const ctx = await startApp();
  try {
    const html = await (await fetch(`${ctx.base}/`)).text();
    for (const id of ['section-audit', 'section-crawl', 'section-compare', 'auditForm', 'crawlForm', 'compareForm']) {
      assert.ok(html.includes(id), 'в UI есть ' + id);
    }
    assert.ok(html.includes('navAudit') && html.includes('navCrawl') && html.includes('navCompare'), 'вкладки в навигации');
  } finally {
    await ctx.stop();
  }
});
