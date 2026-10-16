/**
 * Тесты безопасности: валидация URL (SSRF / локальные файлы).
 *
 * Главный принцип, который здесь проверяется:
 *   - целевой URL задаёт пользователь — localhost разрешён (это основной
 *     сценарий OWA: «проверь мою локальную сборку»);
 *   - URL ресурсов со страницы задаёт произвольный сайт — только http(s),
 *     только свой origin, file:// запрещён.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkTarget, checkResourceUrl, isPrivateHost } = require('../src/security');

test('security: целевой URL — схемы, кроме http(s), запрещены', () => {
  for (const url of [
    'file:///C:/Windows/win.ini',
    'ftp://example.com',
    'data:text/html,hi',
    'javascript:alert(1)',
    'chrome://settings',
    'not a url at all',
    '',
  ]) {
    const v = checkTarget(url);
    assert.equal(v.ok, false, `ожидали отказ для ${url}`);
  }
});

test('security: целевой URL — обычные http(s) проходят', () => {
  for (const url of [
    'https://example.com',
    'http://example.com/path?q=1',
    'https://sub.example.co.uk:8443/x',
    'http://xn--80ak6aa92e.com/', // punycode
  ]) {
    assert.equal(checkTarget(url).ok, true, `ожидали пропуск для ${url}`);
  }
});

test('security: локальные адреса доступны для целевого URL (сценарий локальной сборки)', () => {
  for (const url of [
    'http://localhost:8080/',
    'http://127.0.0.1:3210/',
    'http://192.168.1.10/',
    'http://[::1]:3000/',
    'http://10.0.0.1:8080/',
  ]) {
    assert.equal(checkTarget(url).ok, true, `ожидали пропуск для ${url}`);
  }
});

test('security: обфускация приватных адресов распознаётся', () => {
  // все эти записи ведут на 127.0.0.1
  for (const host of ['localhost', '127.0.0.1', '2130706433', '0x7f000001', '017700000001']) {
    assert.equal(isPrivateHost(host), true, `ожидали private для ${host}`);
    assert.equal(checkResourceUrl(`http://${host}/`).ok, false, `ресурсы: отказ для ${host}`);
  }
  // облачный metadata и link-local
  for (const host of ['169.254.169.254', 'fe80::1', 'fd00::1']) {
    assert.equal(isPrivateHost(host), true, `ожидали private для ${host}`);
  }
});

test('security: ресурсы со страницы — приватные адреса запрещены всегда', () => {
  for (const url of [
    'http://127.0.0.1:5222/metrics',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:9000/secret',
    'http://192.168.0.1/router-config',
    'http://[::1]:631/print',
  ]) {
    const v = checkResourceUrl(url);
    assert.equal(v.ok, false, `ожидали отказ для ${url}`);
    assert.equal(v.reason, 'private');
  }
});

test('security: ресурсы со страницы — file:// запрещён', () => {
  for (const url of ['file:///etc/passwd', 'file://C:/Windows/win.ini']) {
    assert.equal(checkResourceUrl(url).ok, false, `ожидали отказ для ${url}`);
  }
});

test('security: ресурсы со страницы — публичные http(s) проходят', () => {
  for (const url of ['https://cdn.example.com/a.css', 'http://example.com/b.js', 'https://a.b-c.d/x.css']) {
    assert.equal(checkResourceUrl(url).ok, true, `ожидали пропуск для ${url}`);
  }
});

test('security: OWA_DENY_PRIVATE_TARGETS — режим для публичного развёртывания', () => {
  // Флаги читаются лениво при каждом вызове checkTarget, поэтому
  // просто меняем env без перезагрузки модуля.
  const saved = process.env.OWA_DENY_PRIVATE_TARGETS;
  try {
    process.env.OWA_DENY_PRIVATE_TARGETS = '1';
    const fresh = require('../src/security');
    assert.equal(fresh.checkTarget('http://127.0.0.1:8080/').ok, false, 'в жёстком режиме localhost запрещён');
    assert.equal(fresh.checkTarget('https://example.com').ok, true, 'публичный адрес всё ещё доступен');
  } finally {
    process.env.OWA_DENY_PRIVATE_TARGETS = saved;
    require('../src/security');
  }
});
