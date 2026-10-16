const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, migrate } = require('../src/db');
const { createRepos } = require('../src/db/repositories');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-db-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  const result = migrate(db);
  return { dir, db, result, repos: createRepos(db) };
}

function cleanup(ctx) {
  ctx.db.close();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

test('миграции: свежая БД получает user_version = 2, повторный вызов — 0 применённых', () => {
  const ctx = tempDb();
  try {
    assert.strictEqual(ctx.result.version, 2);
    assert.strictEqual(ctx.result.applied, 2);

    const again = migrate(ctx.db);
    assert.strictEqual(again.version, 2);
    assert.strictEqual(again.applied, 0);

    const tables = ctx.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const t of ['analyses', 'code_findings', 'code_sessions', 'ai_responses', 'settings']) {
      assert.ok(tables.includes(t), `нет таблицы ${t}`);
    }
  } finally {
    cleanup(ctx);
  }
});

test('PRAGMA: WAL и foreign_keys включены', () => {
  const ctx = tempDb();
  try {
    assert.strictEqual(String(ctx.db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
    assert.strictEqual(ctx.db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    cleanup(ctx);
  }
});

test('analyses: insert -> list -> get (JSON распарсен)', () => {
  const ctx = tempDb();
  try {
    const id = ctx.repos.analyses.insert({
      url: 'https://example.com',
      durationMs: 1234,
      metrics: { legacyTiming: { loadTime: 900 } },
      findings: [{ id: 'load', verdict: 'good' }],
      interpretation: { summary: { status: 'good', score: 100, headline: 'ok' }, findings: [] },
      summary: { status: 'good', score: 100, headline: 'ok' },
      status: 'ok',
    });
    assert.ok(id > 0);

    const { items, total } = ctx.repos.analyses.list();
    assert.strictEqual(total, 1);
    assert.strictEqual(items[0].url, 'https://example.com');
    assert.strictEqual(items[0].summary.score, 100);
    // в списке нет тяжёлых JSON-полей
    assert.strictEqual(items[0].metrics, undefined);

    const full = ctx.repos.analyses.get(id);
    assert.strictEqual(full.metrics.legacyTiming.loadTime, 900);
    assert.strictEqual(full.findings[0].id, 'load');
    assert.strictEqual(full.interpretation.summary.status, 'good');
  } finally {
    cleanup(ctx);
  }
});

test('analyses: фильтр по url, limit/offset, clear', () => {
  const ctx = tempDb();
  try {
    ctx.repos.analyses.insert({ url: 'https://a.example' });
    ctx.repos.analyses.insert({ url: 'https://a.example' });
    ctx.repos.analyses.insert({ url: 'https://b.example' });

    assert.strictEqual(ctx.repos.analyses.list({ url: 'https://a.example' }).total, 2);
    assert.strictEqual(ctx.repos.analyses.list({ limit: 2 }).items.length, 2);
    assert.strictEqual(ctx.repos.analyses.list({ limit: 2, offset: 2 }).items.length, 1);

    assert.strictEqual(ctx.repos.analyses.clear(), 3);
    assert.strictEqual(ctx.repos.analyses.list().total, 0);
  } finally {
    cleanup(ctx);
  }
});

test('code_findings: каскадное удаление вместе с анализом', () => {
  const ctx = tempDb();
  try {
    const id = ctx.repos.analyses.insert({ url: 'https://x.example' });
    ctx.repos.codeFindings.insertMany(id, [
      { type: 'css', severity: 'warning', rule: 'css-important', location: 'a.css:10', message: 'много !important', suggestion: 'убрать' },
      { type: 'html', severity: 'error', rule: 'html-dup-id', location: 'index.html:5', message: 'дубль id' },
    ]);

    const findings = ctx.repos.codeFindings.listByAnalysis(id);
    assert.strictEqual(findings.length, 2);
    assert.strictEqual(findings[0].rule, 'css-important');
    assert.strictEqual(findings[0].suggestion, 'убрать');
    assert.strictEqual(findings[1].severity, 'error');

    assert.strictEqual(ctx.repos.analyses.remove(id), 1);
    assert.strictEqual(ctx.repos.codeFindings.listByAnalysis(id).length, 0, 'каскад не сработал');
    const left = ctx.db.prepare('SELECT COUNT(*) AS n FROM code_findings').get().n;
    assert.strictEqual(left, 0);
  } finally {
    cleanup(ctx);
  }
});

test('ai_responses: кэш get/set, перезапись по ключу', () => {
  const ctx = tempDb();
  try {
    assert.strictEqual(ctx.repos.aiResponses.get('hash1'), null);

    ctx.repos.aiResponses.set({ promptHash: 'hash1', model: 'glm-4.5', response: 'объяснение', tokensIn: 100, tokensOut: 50 });
    const hit = ctx.repos.aiResponses.get('hash1');
    assert.strictEqual(hit.response, 'объяснение');
    assert.strictEqual(hit.tokensIn, 100);
    assert.strictEqual(hit.model, 'glm-4.5');

    ctx.repos.aiResponses.set({ promptHash: 'hash1', model: 'glm-4.5', response: 'новое', tokensIn: 10, tokensOut: 5 });
    assert.strictEqual(ctx.repos.aiResponses.get('hash1').response, 'новое');
    assert.strictEqual(ctx.db.prepare('SELECT COUNT(*) AS n FROM ai_responses').get().n, 1);
  } finally {
    cleanup(ctx);
  }
});

test('settings: set/get/all/remove', () => {
  const ctx = tempDb();
  try {
    assert.strictEqual(ctx.repos.settings.get('missing'), null);
    ctx.repos.settings.set('theme', 'dark');
    ctx.repos.settings.set('theme', 'light');
    assert.strictEqual(ctx.repos.settings.get('theme'), 'light');

    ctx.repos.settings.set('other', 'x');
    const all = ctx.repos.settings.all();
    assert.deepStrictEqual(Object.keys(all), ['other', 'theme']);

    assert.strictEqual(ctx.repos.settings.remove('other'), 1);
    assert.strictEqual(ctx.repos.settings.get('other'), null);
  } finally {
    cleanup(ctx);
  }
});
