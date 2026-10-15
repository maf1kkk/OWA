const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, migrate } = require('../src/db');
const { createApp, createAuth } = require('../web/app');

/** Поднять приложение на эфемерном порту. */
async function startApp(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-web-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  const auth = createAuth(env);
  const app = createApp({ db, auth });
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
