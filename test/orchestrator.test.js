'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuditOrchestrator, normalizeSectionResult } = require('../src/core/orchestrator');

function section(name, opts = {}) {
  const { score = 80, fail = false, attempts = [], log = () => {} } = opts;
  const run = async (url, context) => {
    attempts.push({ url, context });
    log(name + ' run');
    if (fail) throw new Error('artificial failure: ' + name);
    return {
      score,
      issues: [{ severity: 'warning', message: name + ' issue' }],
      raw: { section: name },
    };
  };
  return { name, run, attempts, log };
}

test('оркестратор: все секции выполняются и собираются в единую схему', async () => {
  const sections = ['performance', 'seo', 'security', 'accessibility', 'content'].map((name) => section(name, { score: 90 }));
  const o = new AuditOrchestrator({ url: 'https://a.test', sections });
  const result = await o.run();

  assert.strictEqual(result.schemaVersion, 2);
  assert.strictEqual(result.url, 'https://a.test');
  assert.ok(Array.isArray(result.issues));
  assert.strictEqual(result.integralScore, 90);
  assert.strictEqual(result.failedSections.length, 0);
  assert.strictEqual(result.summary.status, 'ok');
  assert.ok(result.scores.performance && result.scores.seo && result.scores.security && result.scores.accessibility && result.scores.content);
  for (const name of sections.map((s) => s.name)) {
    assert.strictEqual(result.scores[name].status, 'ok');
    assert.strictEqual(typeof result.scores[name].durationMs, 'number');
    assert.ok(result.scores[name].issues.length >= 1);
  }
});

test('оркестратор: падение одной секции не роняет остальные', async () => {
  const log = [];
  const s = ['performance', 'seo', 'security', 'accessibility', 'content'].map((name) =>
    section(name, { score: 70, fail: name === 'security', log: (m) => log.push(m) })
  );
  const o = new AuditOrchestrator({
    url: 'https://b.test',
    sections: s,
    retries: 0,
    logger: (m) => log.push('LOG ' + m),
  });
  const result = await o.run();

  assert.strictEqual(result.failedSections.length, 1);
  assert.strictEqual(result.failedSections[0], 'security');
  assert.strictEqual(result.scores.security.status, 'failed');
  assert.strictEqual(result.scores.security.error, 'секция завершилась ошибкой');
  assert.ok(result.scores.performance.status === 'ok');
  assert.ok(result.scores.seo.status === 'ok');
  assert.ok(result.scores.accessibility.status === 'ok');
  assert.ok(result.scores.content.status === 'ok');
  assert.strictEqual(result.summary.status, 'partial');
  assert.ok(log.some((m) => m.includes('security')), 'время/ошибка секции логируется');
});

test('оркестратор: повторные попытки при временных сбоях', async () => {
  let calls = 0;
  const flaky = {
    name: 'flaky',
    run: async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return { score: 50, issues: [], raw: {} };
    },
  };
  const o = new AuditOrchestrator({
    url: 'https://c.test',
    sections: [flaky],
    retries: 4,
  });
  const result = await o.run();
  assert.strictEqual(result.scores.flaky.status, 'ok');
  assert.strictEqual(calls, 3);
});

test('оркестратор: таймаут секции помечает failed, остальные идут', async () => {
  const slow = {
    name: 'slow',
    run: async () => new Promise((resolve) => setTimeout(() => resolve({ score: 99 }), 2000)),
  };
  const fast = section('fast', { score: 88 });
  const o = new AuditOrchestrator({
    url: 'https://d.test',
    sections: [slow, fast],
    timeoutMs: 80,
    retries: 0,
  });
  const result = await o.run();
  assert.strictEqual(result.scores.slow.status, 'failed');
  assert.match(result.scores.slow.error, /таймаут|ошибк/i);
  assert.strictEqual(result.scores.fast.status, 'ok');
});

test('оркестратор: ограниченная параллельность не превышает concurrency', async () => {
  let running = 0;
  let max = 0;
  const mk = (n) => ({
    name: 's' + n,
    run: async () => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 60));
      running--;
      return { score: 60, issues: [], raw: {} };
    },
  });
  const o = new AuditOrchestrator({
    url: 'https://e.test',
    sections: [mk(1), mk(2), mk(3), mk(4)],
    concurrency: 2,
    retries: 0,
  });
  await o.run();
  assert.ok(max <= 2, 'максимальный параллелизм не превышен: ' + max);
});

test('normalizeSectionResult: верные формы выходного объекта', () => {
  assert.strictEqual(normalizeSectionResult(null, { score: 5, issues: [], raw: {} }).status, 'ok');
  assert.strictEqual(normalizeSectionResult(null, { status: 'failed', error: 'x' }).status, 'failed');
  assert.strictEqual(normalizeSectionResult(null, null).status, 'failed');
  assert.strictEqual(normalizeSectionResult(null, 'oops').status, 'failed');
});

test('оркестратор: без URL — бросает ошибку', async () => {
  await assert.rejects(() => new AuditOrchestrator({ sections: [section('x')] }).run(), /URL не задан/i);
});