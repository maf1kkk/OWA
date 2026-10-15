/**
 * Правила статического анализа JS (ТЗ):
 *   - console.log / debugger (счётчик)
 *   - eval / new Function
 *   - файл > 500 КБ
 *   - синтаксические ошибки (espree)
 */
'use strict';

const { validateJsSyntax, parseJsAst } = require('./validators');

const LARGE_FILE_BYTES = 500 * 1024;
const CONSOLE_METHODS = new Set(['log', 'debug', 'info', 'warn', 'error', 'dir', 'table', 'trace']);

function shortUrl(url, max = 60) {
  return url.length > max ? url.slice(0, max - 3) + '...' : url;
}

/** Обход AST без внешних зависимостей (estraverse не нужен). */
function walkAst(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walkAst(n, fn);
    return;
  }
  if (typeof node.type === 'string') fn(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent' || key === 'tokens' || key === 'comments') continue;
    const v = node[key];
    if (v && typeof v === 'object') walkAst(v, fn);
  }
}

function isConsoleCall(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'console' &&
    node.callee.property &&
    node.callee.property.type === 'Identifier' &&
    CONSOLE_METHODS.has(node.callee.property.name)
  );
}

function isEvalCall(node) {
  if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier' && node.callee.name === 'eval') {
    return true;
  }
  if (node.type === 'NewExpression' && node.callee && node.callee.type === 'Identifier' && node.callee.name === 'Function') {
    return true;
  }
  return false;
}

/**
 * @param {string} code - содержимое JS
 * @param {string} fileUrl - откуда скрипт (для location)
 * @param {{inline?: boolean}} [opts] - инлайновый скрипт (метка в location)
 */
function analyzeJs(code, fileUrl, opts = {}) {
  const raws = [];
  const label = opts.inline ? `${shortUrl(fileUrl)} <inline script>` : shortUrl(fileUrl);

  // 1. Размер файла (для внешних; инлайновые считаем тоже — полезно)
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > LARGE_FILE_BYTES) {
    raws.push({
      rule: 'js-large-file',
      severity: 'warning',
      message: `JS-файл больше 500 КБ: ${(bytes / 1024).toFixed(0)} КБ`,
      location: label,
      value: Math.round(bytes / 1024),
      unit: 'КБ',
    });
  }

  // 2. Синтаксис
  const syntaxIssue = validateJsSyntax(code, fileUrl);
  if (syntaxIssue) {
    raws.push({
      rule: 'js-syntax',
      severity: 'error',
      message: `Синтаксическая ошибка JS: ${syntaxIssue.message}`,
      location: syntaxIssue.line ? `${label}:${syntaxIssue.line}` : label,
      value: 1,
      unit: 'шт',
    });
    return raws; // дальше AST не разбираем
  }

  const ast = parseJsAst(code);
  if (!ast) return raws;

  // 3-5. Счётчики по AST
  let consoleCount = 0;
  let consoleLine = null;
  let debuggerCount = 0;
  let debuggerLine = null;
  let evalCount = 0;
  let evalLine = null;

  walkAst(ast, (node) => {
    if (isConsoleCall(node)) {
      consoleCount += 1;
      if (consoleLine === null && node.loc) consoleLine = node.loc.start.line;
    } else if (node.type === 'DebuggerStatement') {
      debuggerCount += 1;
      if (debuggerLine === null && node.loc) debuggerLine = node.loc.start.line;
    } else if (isEvalCall(node)) {
      evalCount += 1;
      if (evalLine === null && node.loc) evalLine = node.loc.start.line;
    }
  });

  if (consoleCount > 0) {
    raws.push({
      rule: 'js-console',
      severity: 'info',
      message: `Вызовов console.*: ${consoleCount} шт`,
      location: consoleLine ? `${label}:${consoleLine}` : label,
      value: consoleCount,
      unit: 'шт',
    });
  }
  if (debuggerCount > 0) {
    raws.push({
      rule: 'js-debugger',
      severity: 'warning',
      message: `Statements debugger: ${debuggerCount} шт`,
      location: debuggerLine ? `${label}:${debuggerLine}` : label,
      value: debuggerCount,
      unit: 'шт',
    });
  }
  if (evalCount > 0) {
    raws.push({
      rule: 'js-eval',
      severity: 'error',
      message: `Использований eval/new Function: ${evalCount} шт`,
      location: evalLine ? `${label}:${evalLine}` : label,
      value: evalCount,
      unit: 'шт',
    });
  }

  return raws;
}

module.exports = { analyzeJs, walkAst, CONSOLE_METHODS };
