/**
 * Тесты обслуживания БД: ретеншен, чистка sources_gz, чекпоинт WAL.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb, migrate } = require('../src/db');
const { createMaintenance } = require('../src/db/maintenance');

const DAY = 24 * 60 * 60 * 1000;

function setup(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-maint-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  return { db, dir };
}

function cleanup({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('maintenance: старые анализы удаляются, свежие остаются', () => {
  const ctx = setup();
  try {
    const now = Date.now();
    ctx.db.prepare('INSERT INTO analyses (url, created_at, status, metrics_json, findings_json) VALUES (?,?,?,?,?)')
      .run('https://old.example', now - 40 * DAY, 'ok', '{}', '[]');
    ctx.db.prepare('INSERT INTO analyses (url, created_at, status, metrics_json, findings_json) VALUES (?,?,?,?,?)')
      .run('https://fresh.example', now - 1 * DAY, 'ok', '{}', '[]');

    const m = createMaintenance(ctx.db, { retentionDays: 30 });
    const r = m.prune({ now });

    assert.equal(r.analyses, 1, 'удалён только старый');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM analyses').get().n, 1, 'свежий остался');
    assert.equal(
      ctx.db.prepare('SELECT url FROM analyses').get().url,
      'https://fresh.example',
      'именно свежий',
    );
  } finally {
    cleanup(ctx);
  }
});

test('maintenance: sources_gz очищается у завершённых сессий, не у активных', () => {
  const ctx = setup();
  try {
    const now = Date.now();
    const analysisId = ctx.db
      .prepare('INSERT INTO analyses (url, created_at, status, metrics_json, findings_json) VALUES (?,?,?,?,?)')
      .run('https://session-host.example', now, 'ok', '{}', '[]').lastInsertRowid;

    const ins = ctx.db.prepare(
      'INSERT INTO code_sessions (analysis_id, url, created_at, updated_at, status, step, sources_gz, cursor_json) VALUES (?,?,?,?,?,?,?,?)'
    );
    ins.run(analysisId, 'https://done.example', now, now, 'done', 'done', Buffer.from('gzip-done'), '{}');
    ins.run(analysisId, 'https://error.example', now, now, 'error', 'js', Buffer.from('gzip-error'), '{}');
    ins.run(analysisId, 'https://active.example', now, now, 'in_progress', 'css', Buffer.from('gzip-active'), '{}');

    const m = createMaintenance(ctx.db, { retentionDays: 30 });
    const r = m.prune({ now });

    assert.equal(r.sourcesCleared, 2, 'очищены done и error');
    const rows = ctx.db.prepare('SELECT url, sources_gz FROM code_sessions').all();
    const active = rows.find((r) => r.url === 'https://active.example');
    assert.ok(active.sources_gz, 'у активной сессии исходники на месте');
    for (const url of ['https://done.example', 'https://error.example']) {
      assert.equal(rows.find((r) => r.url === url).sources_gz, null, `у ${url} очищено`);
    }
  } finally {
    cleanup(ctx);
  }
});

test('maintenance: retention 0 отключает удаление по возрасту', () => {
  const ctx = setup();
  try {
    const now = Date.now();
    ctx.db.prepare('INSERT INTO analyses (url, created_at, status, metrics_json, findings_json) VALUES (?,?,?,?,?)')
      .run('https://ancient.example', now - 400 * DAY, 'ok', '{}', '[]');

    const m = createMaintenance(ctx.db, { retentionDays: 0 });
    const r = m.prune({ now });

    assert.equal(r.analyses, 0, 'ничего не удалено');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM analyses').get().n, 1);
  } finally {
    cleanup(ctx);
  }
});

test('maintenance: чекпоинт WAL работает и не бросает исключений', () => {
  const ctx = setup();
  try {
    assert.equal(createMaintenance(ctx.db).checkpoint(), true);
    // повторный вызов тоже безопасен
    assert.equal(createMaintenance(ctx.db, { retentionDays: 30 }).checkpoint(), true);
  } finally {
    cleanup(ctx);
  }
});

test('maintenance: run() — чистка и чекпоинт вместе', () => {
  const ctx = setup();
  try {
    const now = Date.now();
    ctx.db.prepare('INSERT INTO analyses (url, created_at, status, metrics_json, findings_json) VALUES (?,?,?,?,?)')
      .run('https://stale.example', now - 90 * DAY, 'ok', '{}', '[]');
    const r = createMaintenance(ctx.db, { retentionDays: 30 }).run();
    assert.equal(r.analyses, 1);
  } finally {
    cleanup(ctx);
  }
});
