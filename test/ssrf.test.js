'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { safeFetch, safeFetchText, assertSafeUrl, onBlocked, BlockedRequestError } = require('../src/security/safe-fetch');

test('SSRF: запрос на 127.0.0.1 блокируется и не выполняется', async () => {
  let hit = false;
  const server = http.createServer((req, res) => { hit = true; res.end('secret'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => assertSafeUrl(`http://127.0.0.1:${port}/`),
      (err) => err instanceof BlockedRequestError && err.code === 'SSRF_BLOCKED',
    );
    await assert.rejects(() => safeFetch(`http://127.0.0.1:${port}/`), /заблокирован/i);
    assert.equal(hit, false, 'запрос не должен был дойти до сервера');
  } finally {
    server.close();
  }
});

test('SSRF: cloud metadata 169.254.169.254 блокируется', async () => {
  await assert.rejects(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/'), BlockedRequestError);
  await assert.rejects(() => assertSafeUrl('http://10.0.0.1/'), BlockedRequestError);
  await assert.rejects(() => assertSafeUrl('http://192.168.1.1/'), BlockedRequestError);
  await assert.rejects(() => assertSafeUrl('http://[::1]/'), BlockedRequestError);
});

test('SSRF: разрешены только http и https', async () => {
  await assert.rejects(() => assertSafeUrl('file:///etc/passwd'), BlockedRequestError);
  await assert.rejects(() => assertSafeUrl('ftp://example.com/'), BlockedRequestError);
});

test('SSRF: localhost и .local блокируются', async () => {
  await assert.rejects(() => assertSafeUrl('http://localhost:3000/'), BlockedRequestError);
  await assert.rejects(() => assertSafeUrl('http://service.internal/'), BlockedRequestError);
});

test('SSRF: заблокированные попытки логируются с URL и причиной', async () => {
  const events = [];
  const off = onBlocked((e) => events.push(e));
  try {
    await assert.rejects(() => assertSafeUrl('http://127.0.0.1:9/'), BlockedRequestError);
    assert.ok(events.length >= 1, 'событие блокировки зарегистрировано');
    assert.match(events[0].url, /127\.0\.0\.1/);
    assert.ok(events[0].reason && events[0].reason.length > 3, 'указана причина');
  } finally {
    off();
  }
});

test('SSRF: редирект с публичного URL на приватный блокируется', async () => {
  // Публичный URL редиректит на приватный адрес: safeFetch обязан
  // перепроверить каждый ход редиректа и не выполнить переход в частную сеть.
  const targets = [
    'https://httpbin.org/redirect-to?url=http://10.0.0.1/private',
    'https://httpbin.org/redirect-to?url=http://169.254.169.254/latest/meta-data/',
  ];
  for (const target of targets) {
    await assert.rejects(
      () => safeFetch(target, { timeoutMs: 20000, maxRedirects: 5 }),
      (err) => err instanceof BlockedRequestError && err.code === 'SSRF_BLOCKED',
      'редирект в приватный диапазон должен быть заблокирован: ' + target,
    );
  }
});

test('SSRF: легитимный публичный сайт работает без изменений', async () => {
  const res = await safeFetch('https://example.com/', { timeoutMs: 20000 });
  assert.equal(res.status, 200);
  const text = await safeFetchText('https://example.com/', { timeoutMs: 20000 });
  assert.ok(text.body.length > 0);
  assert.equal(text.status, 200);
});
