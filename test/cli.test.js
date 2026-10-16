const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CLI = path.join(__dirname, '..', 'bin', 'owa.js');

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 90000,
    ...opts,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('CLI: --help не падает и exit 0', () => {
  const r = run(['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('Использование'));
});

test('CLI: без аргументов показывает help, exit 0', () => {
  const r = run([]);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('OWA'));
});

test('CLI: URL без протокола -> exit 2 с ошибкой', () => {
  const r = run(['example.com']);
  assert.strictEqual(r.code, 2);
  assert.ok(r.stderr.includes('http'));
});

test('CLI: неизвестная опция -> exit 2', () => {
  const r = run(['https://example.com', '--несуществующая']);
  assert.strictEqual(r.code, 2);
});

test('CLI: недоступный домен -> exit 2, JSON содержит error (не крэш)', () => {
  const r = run(['https://nonexistent-domain-owa-test-12345.invalid', '--json', '--timeout', '8000']);
  assert.strictEqual(r.code, 2);
  const parsed = JSON.parse(r.stdout);
  assert.ok(parsed.error);
});

test('CLI: --json на живом сайте -> валидный JSON со стабильной схемой', { timeout: 120000 }, () => {
  const r = run(['https://example.com', '--json', '--wait', '500']);
  assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`);
  const data = JSON.parse(r.stdout);
  assert.strictEqual(data.schemaVersion, 1);
  assert.strictEqual(data.tool, 'owa');
  assert.ok(data.meta && data.meta.url);
  assert.ok(data.metrics.legacyTiming && typeof data.metrics.legacyTiming.loadTime === 'number');
  assert.ok(data.interpretation && data.interpretation.summary);
  assert.ok(Array.isArray(data.interpretation.findings));
});

test('CLI: обычный вывод содержит интерпретацию и оценку', { timeout: 120000 }, () => {
  const r = run(['https://example.com', '--wait', '500']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('Отчёт о производительности'));
  assert.ok(r.stdout.includes('Итог:'));
  assert.ok(/оценка \d+\/100/.test(r.stdout));
});

test('CLI: --out сохраняет файл, --md сохраняет Markdown', { timeout: 120000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-test-'));
  const jsonPath = path.join(dir, 'r.json');
  const mdPath = path.join(dir, 'r.md');
  const r = run(['https://example.com', '--wait', '500', '--out', jsonPath, '--md', mdPath]);
  assert.strictEqual(r.code, 0);
  assert.ok(fs.existsSync(jsonPath), 'JSON не создан');
  assert.ok(fs.existsSync(mdPath), 'Markdown не создан');
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.strictEqual(parsed.schemaVersion, 1);
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.ok(md.includes('| Метрика |'));
  assert.ok(md.includes('## Виджеты'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: --selector с несуществующим селектором не падает', { timeout: 120000 }, () => {
  const r = run(['https://example.com', '--wait', '300', '--selector', '#totally-not-exists-owa']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout.includes('#totally-not-exists-owa'));
  assert.ok(r.stdout.includes('не найден'));
});
