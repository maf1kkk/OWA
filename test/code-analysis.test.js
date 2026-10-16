const test = require('node:test');
const assert = require('node:assert');

const { toFinding, toFindings, METRICS, SUGGESTIONS } = require('../src/static-analyzer/to-findings');
const { analyzeCss } = require('../src/static-analyzer/css-rules');
const { analyzeHtml } = require('../src/static-analyzer/html-rules');
const { analyzeJs } = require('../src/static-analyzer/js-rules');
const { validateHtml, validateCssSyntax, validateJsSyntax } = require('../src/static-analyzer/validators');
const { processStep } = require('../src/static-analyzer');
const { buildSummary } = require('../src/interpret');

// ------------------------------------------------------------- to-findings

test('toFinding: severity -> verdict, аддитивные поля на месте', () => {
  const f = toFinding({ rule: 'css-important', severity: 'warning', message: 'много !important', location: 'a.css:3', value: 12 });
  assert.strictEqual(f.verdict, 'warn');
  assert.strictEqual(f.severity, 'warning');
  assert.strictEqual(f.rule, 'css-important');
  assert.strictEqual(f.id, 'css-important');
  assert.strictEqual(f.location, 'a.css:3');
  assert.strictEqual(f.value, 12);
  assert.strictEqual(f.unit, 'шт');
  assert.strictEqual(f.metric, METRICS['css-important']);
  assert.strictEqual(f.recommendation, SUGGESTIONS['css-important']);
  // поля формата interpret.js сохранены
  assert.ok(f.message && typeof f.message === 'string');
});

test('toFinding: error -> bad, info -> info', () => {
  assert.strictEqual(toFinding({ rule: 'js-eval', severity: 'error', message: 'm' }).verdict, 'bad');
  assert.strictEqual(toFinding({ rule: 'js-console', severity: 'info', message: 'm' }).verdict, 'info');
});

test('toFinding: без value юнит пустой', () => {
  const f = toFinding({ rule: 'html-no-lang', severity: 'warning', message: 'm' });
  assert.strictEqual(f.value, null);
  assert.strictEqual(f.unit, '');
});

test('findings проходят через buildSummary (итоговый summary считается)', () => {
  const fs = toFindings([
    { rule: 'js-eval', severity: 'error', message: 'eval' },
    { rule: 'js-console', severity: 'info', message: 'console' },
  ]);
  const s = buildSummary(fs);
  assert.strictEqual(s.status, 'bad');
  assert.ok(s.score < 100);
});

// --------------------------------------------------------------- css-rules

test('css-rules: !important, дубли селекторов, пустые правила, неиспользуемые', () => {
  const css = `
.a { color: red !important; margin: 0 !important; }
.a { color: blue !important; padding: 0 !important; }
.a { color: green !important; border: 0 !important; }
.a { color: yellow !important; outline: 0 !important; }
.a { color: pink !important; width: 0 !important; }
.b { display: block; }
.b { display: inline; }
.empty { }
.unused-class { color: red; }
`;
  const html = '<html><body><div class="b">ok</div></body></html>';
  const raws = analyzeCss(css, 'https://site.test/style.css', { html });

  const rules = raws.map((r) => r.rule);
  assert.ok(rules.includes('css-important'), 'нет css-important');
  assert.ok(rules.includes('css-duplicate-selector'), 'нет css-duplicate-selector');
  assert.ok(rules.includes('css-empty-rule'), 'нет css-empty-rule');
  assert.ok(rules.includes('css-unused-selector'), 'нет css-unused-selector');

  const important = raws.find((r) => r.rule === 'css-important');
  assert.strictEqual(important.value, 10);
  assert.strictEqual(important.severity, 'warning', '10 !important -> warning');
  assert.ok(important.location.includes('style.css'));

  const unused = raws.find((r) => r.rule === 'css-unused-selector');
  assert.ok(unused.message.includes('.unused-class'));
  assert.ok(!unused.message.includes('.b'), '.b используется в HTML — не должен попасть');
});

test('css-rules: синтаксическая ошибка CSS', () => {
  const raws = analyzeCss('a { color: blah } .x { !!! }', 'https://site.test/bad.css', {});
  const syntax = raws.find((r) => r.rule === 'css-syntax');
  assert.ok(syntax, 'нет css-syntax');
  assert.strictEqual(syntax.severity, 'error');
  assert.ok(syntax.location.includes('bad.css'));
});

test('css-rules: длинный файл (> 5000 строк)', () => {
  const css = Array.from({ length: 5100 }, (_, i) => `.c${i} { color: red }`).join('\n');
  const raws = analyzeCss(css, 'big.css', {});
  const long = raws.find((r) => r.rule === 'css-long-file');
  assert.ok(long, 'нет css-long-file');
  assert.strictEqual(long.unit, 'строк');
});

test('validators: html-validate не даёт стилистического шума (doctype-style и т.п.)', () => {
  // строчная дата !doctype и одинарные кавычки — раньше давали бы attr-quotes/doctype-style
  const msgs = validateHtml("<!doctype html><html lang='ru'><head><title>t</title></head><body><p>ok</p></body></html>");
  assert.strictEqual(msgs.length, 0, JSON.stringify(msgs));
});

// --------------------------------------------------------------- html-rules

test('html-rules: нет lang, img без alt, дубли id, deprecated-тег', () => {
  const html = `<!doctype html><html><head><title>t</title></head><body>
    <img src="a.png">
    <div id="x">1</div><div id="x">2</div>
    <font size="2">старый тег</font>
  </body></html>`;
  const raws = analyzeHtml(html, 'https://site.test/');
  const rules = raws.map((r) => r.rule);
  assert.ok(rules.includes('html-no-lang'), 'нет html-no-lang');
  assert.ok(rules.includes('html-img-alt'), 'нет html-img-alt');
  assert.ok(rules.includes('html-dup-id'), 'нет html-dup-id');
  assert.ok(rules.includes('html-deprecated-tag'), 'нет html-deprecated-tag');
  assert.strictEqual(raws.find((r) => r.rule === 'html-dup-id').severity, 'error');
  assert.ok(raws.every((r) => r.location && r.location.includes('site.test')));
});

test('html-rules: битая разметка -> html-syntax (ошибка)', () => {
  const raws = analyzeHtml('<!doctype html><html><body><div><span></div></body></html>', 'https://site.test/broken');
  const syntax = raws.find((r) => r.rule === 'html-syntax');
  assert.ok(syntax, JSON.stringify(raws));
  assert.strictEqual(syntax.severity, 'error');
});

test('html-rules: валидная разметка не даёт находок', () => {
  const html = '<!doctype html><html lang="ru"><head><title>t</title></head><body><img src="a.png" alt="a"><p>ok</p></body></html>';
  assert.strictEqual(analyzeHtml(html, 'https://site.test/').length, 0);
});

// ----------------------------------------------------------------- js-rules

test('js-rules: console/debugger/eval', () => {
  const code = `
    console.log('a'); console.debug('b'); console.error('c');
    debugger;
    eval('1+1');
    const F = new Function('return 1');
  `;
  const raws = analyzeJs(code, 'https://site.test/app.js', {});
  const rules = raws.map((r) => r.rule);
  assert.ok(rules.includes('js-console'), 'нет js-console');
  assert.ok(rules.includes('js-debugger'), 'нет js-debugger');
  assert.ok(rules.includes('js-eval'), 'нет js-eval');
  assert.strictEqual(raws.find((r) => r.rule === 'js-console').value, 3);
  assert.strictEqual(raws.find((r) => r.rule === 'js-eval').severity, 'error');
});

test('js-rules: синтаксическая ошибка -> js-syntax, дальше AST не разбираем', () => {
  const raws = analyzeJs('const x = ;', 'https://site.test/bad.js', {});
  assert.strictEqual(raws.length, 1);
  assert.strictEqual(raws[0].rule, 'js-syntax');
  assert.strictEqual(raws[0].severity, 'error');
  assert.ok(raws[0].location.includes(':1'));
});

test('js-rules: чистый код без находок, module-синтаксис разбирается', () => {
  const code = "import { x } from './x.js'; export const y = x + 1;";
  assert.strictEqual(analyzeJs(code, 'https://site.test/m.js', {}).length, 0);
});

test('js-rules: файл > 500 КБ', () => {
  const code = `// ${'x'.repeat(520 * 1024)}\n`;
  const raws = analyzeJs(code, 'https://site.test/big.js', {});
  const large = raws.find((r) => r.rule === 'js-large-file');
  assert.ok(large, 'нет js-large-file');
  assert.strictEqual(large.unit, 'КБ');
});

test('validators: validateJsSyntax возвращает null для валидного кода', () => {
  assert.strictEqual(validateJsSyntax('let a = 1'), null);
  const issue = validateJsSyntax('let a = ;');
  assert.ok(issue && issue.rule === 'js-syntax');
});

// -------------------------------------------------------------- processStep

function makeSources(cssN, jsN) {
  return {
    finalUrl: 'https://site.test/',
    html: '<html lang="ru"></html>',
    css: Array.from({ length: cssN }, (_, i) => ({ url: `https://site.test/c${i}.css`, content: `.c${i}{color:red}` })),
    js: Array.from({ length: jsN }, (_, i) => ({ url: `https://site.test/j${i}.js`, content: `console.log(${i})` })),
    truncated: [],
  };
}

test('processStep: батчи по 10 файлов, затем js, затем done', () => {
  const sources = makeSources(25, 3);
  const state = { step: 'css', cursor: { css: 0, js: 0 } };

  const s1 = processStep(sources, state, 10);
  assert.strictEqual(s1.done, false);
  assert.strictEqual(state.cursor.css, 10);
  assert.strictEqual(state.step, 'css');

  processStep(sources, state, 10);
  assert.strictEqual(state.cursor.css, 20);
  processStep(sources, state, 10);
  assert.strictEqual(state.cursor.css, 25);
  assert.strictEqual(state.step, 'js', 'после css шаг переходит на js');

  const s4 = processStep(sources, state, 10);
  assert.strictEqual(s4.done, true);
  assert.strictEqual(state.cursor.js, 3);
  assert.strictEqual(state.step, 'done');
  // js-файлы дают находки js-console
  assert.ok(s4.findings.length >= 3);
});

test('processStep: пустые фазы проматываются автоматически', () => {
  const sources = makeSources(0, 2);
  const state = { step: 'css', cursor: { css: 0, js: 0 } };
  const s1 = processStep(sources, state, 10);
  assert.strictEqual(state.cursor.js, 2, 'css пуст -> сразу js-батч');
  const s2 = processStep(sources, state, 10);
  assert.strictEqual(s2.done, true);
});

test('processStep: нечего обрабатывать -> сразу done', () => {
  const sources = makeSources(0, 0);
  const state = { step: 'css', cursor: { css: 0, js: 0 } };
  const s = processStep(sources, state, 10);
  assert.strictEqual(s.done, true);
  assert.strictEqual(s.findings.length, 0);
});
