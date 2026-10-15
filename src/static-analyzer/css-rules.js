/**
 * Правила статического анализа CSS (ТЗ):
 *   - синтаксис (csstree-validator)
 *   - счётчик !important
 *   - дублирующиеся селекторы
 *   - неиспользуемые селекторы (сверка с HTML)
 *   - пустые правила
 *   - файл > 5000 строк
 * Возвращает сырые находки { rule, severity, message, location?, value?, unit? }.
 */
'use strict';

const csstree = require('css-tree');
const { validateCssSyntax } = require('./validators');

const LONG_FILE_LINES = 5000;
const IMPORTANT_WARNING_AT = 10;

function shortUrl(url, max = 60) {
  return url.length > max ? url.slice(0, max - 3) + '...' : url;
}

/** Множества class/id/тегов, реально встречающихся в HTML. */
function htmlRefs(html) {
  const classes = new Set();
  const ids = new Set();
  const tags = new Set();
  if (!html) return { classes, ids, tags };
  for (const m of html.matchAll(/class\s*=\s*["']([^"']*)["']/gi)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add(c);
  }
  for (const m of html.matchAll(/id\s*=\s*["']([^"']*)["']/gi)) {
    if (m[1]) ids.add(m[1]);
  }
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)) tags.add(m[1].toLowerCase());
  return { classes, ids, tags };
}

/** Извлечь из селектора классы/ид/теги для сверки с HTML. */
function selectorRefs(selector) {
  const classes = [...selector.matchAll(/\.([a-zA-Z_-][\w-]*)/g)].map((m) => m[1]);
  const ids = [...selector.matchAll(/#([a-zA-Z_-][\w-]*)/g)].map((m) => m[1]);
  const tags = [...selector.matchAll(/(?:^|[\s>+~(])([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase());
  return { classes, ids, tags };
}

/**
 * @param {string} css - текст CSS
 * @param {string} fileUrl - откуда файл (для location)
 * @param {{html?: string}} [ctx] - HTML страницы для проверки неиспользуемых селекторов
 */
function analyzeCss(css, fileUrl, ctx = {}) {
  const raws = [];
  const loc = (line, column) =>
    line ? `${shortUrl(fileUrl)}:${line}${column ? ':' + column : ''}` : shortUrl(fileUrl);

  // 1. Синтаксис
  const syntaxIssues = validateCssSyntax(css, fileUrl);
  if (syntaxIssues.length) {
    const first = syntaxIssues[0];
    raws.push({
      rule: 'css-syntax',
      severity: 'error',
      message: `Синтаксические ошибки CSS: ${syntaxIssues.length} шт. Первая: ${first.message}`,
      location: loc(first.line, first.column),
      value: syntaxIssues.length,
      unit: 'шт',
    });
  }

  // 2. Очень длинный файл
  const lineCount = css.split(/\r\n|\r|\n/).length;
  if (lineCount > LONG_FILE_LINES) {
    raws.push({
      rule: 'css-long-file',
      severity: 'warning',
      message: `CSS-файл очень длинный: ${lineCount} строк (порог ${LONG_FILE_LINES})`,
      location: shortUrl(fileUrl),
      value: lineCount,
      unit: 'строк',
    });
  }

  // Дальше — структурный анализ (если css-tree смог разобрать)
  let ast = null;
  try {
    ast = csstree.parse(css, { positions: true });
  } catch {
    ast = null; // синтаксис уже зафиксирован выше
  }
  if (!ast) return raws;

  // 3. Счётчик !important
  let important = 0;
  let importantLine = null;
  csstree.walk(ast, {
    visit: 'Declaration',
    enter(node) {
      if (node.important) {
        important += 1;
        if (importantLine === null && node.loc) {
          importantLine = node.loc.start.line;
        }
      }
    },
  });
  if (important > 0) {
    raws.push({
      rule: 'css-important',
      severity: important >= IMPORTANT_WARNING_AT ? 'warning' : 'info',
      message: `Деклараций с !important: ${important} шт${important >= IMPORTANT_WARNING_AT ? ` (порог ${IMPORTANT_WARNING_AT})` : ''}`,
      location: loc(importantLine),
      value: important,
      unit: 'шт',
    });
  }

  // 4. Дублирующиеся селекторы
  const selectorCount = new Map(); // selector -> {count, line}
  csstree.walk(ast, {
    visit: 'Rule',
    enter(node) {
      if (!node.prelude || node.prelude.type !== 'SelectorList') return;
      const selector = csstree.generate(node.prelude).trim();
      const line = node.loc ? node.loc.start.line : null;
      const prev = selectorCount.get(selector);
      if (prev) prev.count += 1;
      else selectorCount.set(selector, { count: 1, line });
    },
  });
  const dups = [...selectorCount.entries()].filter(([, v]) => v.count > 1);
  if (dups.length) {
    const total = dups.reduce((s, [, v]) => s + v.count - 1, 0);
    const preview = dups.slice(0, 3).map(([sel]) => `${sel} (${dups.find(([s]) => s === sel)[1].count}x)`);
    raws.push({
      rule: 'css-duplicate-selector',
      severity: 'warning',
      message: `Дублирующиеся селекторы: ${dups.length} шт (${total} лишних правил). Например: ${preview.join('; ')}`,
      location: loc(dups[0][1].line),
      value: dups.length,
      unit: 'шт',
    });
  }

  // 5. Пустые правила
  let emptyRules = 0;
  let emptyLine = null;
  csstree.walk(ast, {
    visit: 'Rule',
    enter(node) {
      const empty = !node.block || !node.block.children || node.block.children.isEmpty;
      if (empty) {
        emptyRules += 1;
        if (emptyLine === null && node.loc) emptyLine = node.loc.start.line;
      }
    },
  });
  if (emptyRules > 0) {
    raws.push({
      rule: 'css-empty-rule',
      severity: 'info',
      message: `Пустые CSS-правила: ${emptyRules} шт`,
      location: loc(emptyLine),
      value: emptyRules,
      unit: 'шт',
    });
  }

  // 6. Неиспользуемые селекторы (сверка с HTML — консервативно: если найден ХОТЯ БЫ ОДИН
  //    класс/ид селектора в HTML, селектор считается используемым)
  if (ctx.html) {
    const refs = htmlRefs(ctx.html);
    const unused = [];
    let unusedLine = null;
    const seen = new Set();
    csstree.walk(ast, {
      visit: 'Rule',
      enter(node) {
        if (!node.prelude || node.prelude.type !== 'SelectorList') return;
        const selector = csstree.generate(node.prelude).trim();
        if (seen.has(selector)) return;
        seen.add(selector);
        const r = selectorRefs(selector);
        if (!r.classes.length && !r.ids.length) return; // без class/id не проверяем (псевдоселекторы и т.п.)
        const used =
          r.classes.some((c) => refs.classes.has(c)) ||
          r.ids.some((i) => refs.ids.has(i));
        if (!used) {
          unused.push(selector);
          if (unusedLine === null && node.loc) unusedLine = node.loc.start.line;
        }
      },
    });
    if (unused.length) {
      raws.push({
        rule: 'css-unused-selector',
        severity: 'warning',
        message: `Неиспользуемые селекторы: ${unused.length} шт (нет в текущем HTML). Например: ${unused.slice(0, 3).join('; ')}`,
        location: loc(unusedLine),
        value: unused.length,
        unit: 'шт',
      });
    }
  }

  return raws;
}

module.exports = { analyzeCss, htmlRefs, selectorRefs };
