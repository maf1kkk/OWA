/**
 * Интеграционные тесты комплексного аудита (модули 1 и 2).
 * Локальный HTTP-сервер вместо внешней сети.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runFullAudit } = require('../src/audit');

// Локальный сервер — приватный адрес: разрешаем для тестов.
process.env.OWA_ALLOW_PRIVATE_TARGETS = '1';

function startServer(html, extra = {}) {
  const server = http.createServer((req, res) => {
    if (extra[req.url]) {
      res.writeHead(extra[req.url].status || 404, extra[req.url].headers || {});
      res.end(extra[req.url].body || '');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

const BAD_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title></title></head>
<body>
  <img src="no-alt.png">
  <a href="/missing">broken</a>
  <a href="#">empty</a>
  <h2>dup</h2>
  <h2>dup</h2>
  <img src="http://insecure.example/mixed.png">
</body>
</html>`;

test('аудит: полный прогон возвращает пять секций и интегральный балл', { timeout: 120000 }, async () => {
  const { server, url } = await startServer(BAD_PAGE);
  try {
    const result = await runFullAudit(url, { timeout: 20000, waitAfterLoad: 200 });
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.url, url);
    const names = Object.keys(result.scores);
    for (const expected of ['performance', 'seo', 'security', 'accessibility', 'content']) {
      assert.ok(names.includes(expected), 'есть секция ' + expected);
      assert.equal(result.scores[expected].status, 'ok', expected + ' отработала');
      assert.equal(typeof result.scores[expected].score, 'number');
    }
    assert.ok(Number.isFinite(result.integralScore));
    assert.ok(result.integralScore >= 0 && result.integralScore <= 100);
    assert.ok(Array.isArray(result.issues));
    assert.ok(result.issues.length > 0, 'найдены проблемы');
    assert.equal(result.failedSections.length, 0);
  } finally {
    server.close();
  }
});

test('аудит: SEO находит отсутствующий title и битую ссылку', { timeout: 120000 }, async () => {
  const { server, url } = await startServer(BAD_PAGE, { '/missing': { status: 404 } });
  try {
    const result = await runFullAudit(url, { timeout: 20000, waitAfterLoad: 200 });
    const seo = result.scores.seo;
    assert.equal(seo.status, 'ok');
    assert.ok(seo.issues.some((i) => i.id === 'seo-no-title'), 'нет title');
    assert.ok(seo.issues.some((i) => i.id === 'seo-broken-links'), 'битая ссылка');
  } finally {
    server.close();
  }
});

test('аудит: Security предупреждает об отсутствии CSP и ловит mixed content', { timeout: 120000 }, async () => {
  const { server, url } = await startServer(BAD_PAGE);
  try {
    const result = await runFullAudit(url, { timeout: 20000, waitAfterLoad: 200 });
    const sec = result.scores.security;
    assert.equal(sec.status, 'ok');
    assert.ok(sec.issues.some((i) => i.id === 'sec-no-csp'), 'нет CSP');
    assert.ok(sec.issues.some((i) => i.id === 'sec-mixed'), 'mixed content');
  } finally {
    server.close();
  }
});

test('аудит: A11y выдаёт violation для img без alt', { timeout: 120000 }, async () => {
  const { server, url } = await startServer(BAD_PAGE);
  try {
    const result = await runFullAudit(url, { timeout: 20000, waitAfterLoad: 200 });
    const a11y = result.scores.accessibility;
    assert.equal(a11y.status, 'ok');
    assert.ok(a11y.issues.length >= 1, 'есть violations');
    assert.ok(a11y.issues.some((i) => i.rule === 'image-alt'), 'нарушение image-alt');
    assert.ok(a11y.raw.violations.length >= 1);
  } finally {
    server.close();
  }
});

test('аудит: Content находит пустые ссылки и дубли заголовков', { timeout: 120000 }, async () => {
  const { server, url } = await startServer(BAD_PAGE);
  try {
    const result = await runFullAudit(url, { timeout: 20000, waitAfterLoad: 200 });
    const content = result.scores.content;
    assert.equal(content.status, 'ok');
    assert.ok(content.issues.some((i) => i.id === 'content-empty-links'), 'пустые ссылки');
    assert.ok(content.issues.some((i) => i.id === 'content-dup-headings'), 'дубли заголовков');
  } finally {
    server.close();
  }
});

test('аудит: Performance отдаёт Core Web Vitals', { timeout: 120000 }, async () => {
  const { server, url } = await startServer(BAD_PAGE);
  try {
    const result = await runFullAudit(url, { timeout: 20000, waitAfterLoad: 200 });
    const perf = result.scores.performance;
    assert.equal(perf.status, 'ok');
    const m = perf.raw.metrics;
    assert.ok('lcpMs' in m && 'cls' in m && 'ttfbMs' in m && 'tbtMs' in m);
    assert.ok(typeof m.ttfbMs === 'number', 'TTFB измерена');
    assert.ok(typeof m.tbtMs === 'number', 'TBT оценен');
  } finally {
    server.close();
  }
});
