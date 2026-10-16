/**
 * Правила статического анализа HTML (ТЗ):
 *   - нет lang, img без alt, дубли id, deprecated-теги — через html-validate
 *   - синтаксические/структурные ошибки разметки
 * Находки одного правила агрегируются (счётчик + первая строка).
 */
'use strict';

const { validateHtml } = require('./validators');

// ruleId html-validate -> наше правило и уровень
const RULE_MAP = {
  'element-required-attributes': null, // разделяем: lang или прочие атрибуты
  'wcag/h37': { rule: 'html-img-alt', severity: 'warning' },
  'no-dup-id': { rule: 'html-dup-id', severity: 'error' },
  deprecated: { rule: 'html-deprecated-tag', severity: 'warning' },
  'close-order': { rule: 'html-syntax', severity: 'error' },
  'no-implicit-close': { rule: 'html-syntax', severity: 'error' },
  'unrecognized-char-ref': { rule: 'html-syntax', severity: 'error' },
  'element-permitted-content': { rule: 'html-structure', severity: 'error' },
  'parse-error': { rule: 'html-syntax', severity: 'error' },
};

function shortUrl(url, max = 60) {
  return url.length > max ? url.slice(0, max - 3) + '...' : url;
}

/**
 * @param {string} html - содержимое документа
 * @param {string} fileUrl - URL страницы (для location)
 */
function analyzeHtml(html, fileUrl = 'index.html') {
  const messages = validateHtml(html, fileUrl);

  // Группировка: ключ = наше правило, значения: severity, первое сообщение, счётчик
  const groups = new Map();
  const push = (rule, severity, message, line) => {
    const g = groups.get(rule);
    if (g) {
      g.count += 1;
    } else {
      groups.set(rule, { rule, severity, message, line, count: 1 });
    }
  };

  for (const m of messages) {
    let target;
    if (m.ruleId === 'element-required-attributes') {
      target = /lang/i.test(m.message)
        ? { rule: 'html-no-lang', severity: 'warning' }
        : { rule: 'html-required-attr', severity: 'warning' };
    } else {
      target = RULE_MAP[m.ruleId] || { rule: `html-${m.ruleId}`, severity: m.severity === 2 ? 'error' : 'warning' };
    }
    push(target.rule, target.severity, m.message, m.line);
  }

  const loc = (line) => (line ? `${shortUrl(fileUrl)}:${line}` : shortUrl(fileUrl));

  return [...groups.values()].map((g) => ({
    rule: g.rule,
    severity: g.severity,
    message: g.count > 1 ? `${g.message} (и ещё ${g.count - 1} шт)` : g.message,
    location: loc(g.line),
    value: g.count,
    unit: 'шт',
  }));
}

module.exports = { analyzeHtml, RULE_MAP };
