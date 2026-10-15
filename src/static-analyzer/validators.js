/**
 * Обёртки над валидаторами: csstree-validator (CSS), html-validate (HTML),
 * espree (JS). Возвращают нормализованные issues:
 *   { rule, message, line?, column? }
 * без severity — уровень присваивают модули правил.
 */
'use strict';

const { validate: validateCssSyntaxRaw } = require('csstree-validator');
const { HtmlValidate } = require('html-validate');
const espree = require('espree');

// Только правила, нужные ТЗ: синтаксис/структура + lang, alt, дубли id, deprecated.
// Явный список вместо пресета — чтобы не ловить стилистический шум (doctype-style, attr-quotes).
const HTML_CONFIG = {
  extends: [],
  rules: {
    'element-required-attributes': 'error', // <html> без lang и др. обязательные атрибуты
    'wcag/h37': 'error', // <img> без alt
    'no-dup-id': 'error', // дублирующиеся id
    deprecated: 'error', // устаревшие теги (<font> и т.п.)
    'close-order': 'error', // синтаксис: неверный порядок закрытия
    'no-implicit-close': 'error', // синтаксис: неявное закрытие
    'element-permitted-content': 'error', // структура: запрещённое содержимое
    'unrecognized-char-ref': 'error', // синтаксис: неизвестная HTML-сущность
  },
};

let htmlValidator = null;
function getHtmlValidator() {
  if (!htmlValidator) htmlValidator = new HtmlValidate(HTML_CONFIG);
  return htmlValidator;
}

/** Синтаксис CSS. @returns {{rule:string,message:string,line?:number,column?:number}[]} */
function validateCssSyntax(css, filename = 'style.css') {
  try {
    const errors = validateCssSyntaxRaw(css, filename) || [];
    return errors.map((e) => ({
      rule: 'css-syntax',
      message: e.message,
      line: e.line,
      column: e.column,
    }));
  } catch (err) {
    return [
      {
        rule: 'css-syntax',
        message: String(err.message || err),
        line: err.line || err.lineNumber,
      },
    ];
  }
}

/**
 * Разбор и правила HTML (html-validate).
 * @returns {{ruleId:string, severity:number, message:string, line?:number, column?:number}[]}
 */
function validateHtml(html, filename = 'index.html') {
  try {
    const report = getHtmlValidator().validateStringSync(html, filename);
    const results = report.results || [];
    return results.flatMap((r) => r.messages || []).map((m) => ({
      ruleId: m.ruleId,
      severity: m.severity, // 2 = ERROR, 1 = WARN (Severity enum html-validate)
      message: m.message,
      line: m.line,
      column: m.column,
    }));
  } catch (err) {
    return [
      {
        ruleId: 'parse-error',
        severity: 2,
        message: String(err.message || err),
      },
    ];
  }
}

/**
 * Попытка разобрать JS: сначала как script (обычные <script>), затем как module
 * (import/export, top-level await). Бросает последнюю ошибку, если не вышло.
 */
function parseJsTry(code, loc) {
  let lastErr = null;
  for (const sourceType of ['script', 'module']) {
    try {
      return espree.parse(code, {
        ecmaVersion: 'latest',
        sourceType,
        loc,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowHashBang: true,
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Синтаксис JS через espree.
 * @returns {{rule:string,message:string,line?:number,column?:number}|null} null — если синтаксис в порядке
 */
function validateJsSyntax(code, filename = 'script.js') {
  try {
    parseJsTry(code, false);
    return null;
  } catch (err) {
    return {
      rule: 'js-syntax',
      message: String(err.message || err),
      line: err.lineNumber,
      column: err.column,
    };
  }
}

/** Разобрать JS в AST для дальнейшего обхода (null — синтаксическая ошибка). */
function parseJsAst(code) {
  try {
    return parseJsTry(code, true);
  } catch {
    return null;
  }
}

module.exports = {
  validateCssSyntax,
  validateHtml,
  validateJsSyntax,
  parseJsAst,
  HTML_CONFIG,
};
