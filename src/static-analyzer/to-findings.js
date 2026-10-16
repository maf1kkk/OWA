/**
 * Приведение находок статического анализа к формату findings из src/interpret.js:
 *   { id, metric, value, unit, verdict, message, recommendation? }
 * плюс АДДИТИВНЫЕ поля (согласовано): severity, rule, location, suggestion.
 *
 * severity -> verdict: error -> bad, warning -> warn, info -> info.
 */
'use strict';

// Человекочитаемые названия метрик по id правила
const METRICS = {
  'css-important': 'Слишком много !important',
  'css-duplicate-selector': 'Дублирующиеся селекторы',
  'css-unused-selector': 'Неиспользуемые селекторы',
  'css-empty-rule': 'Пустые CSS-правила',
  'css-long-file': 'Очень длинный CSS-файл',
  'css-syntax': 'Синтаксические ошибки CSS',
  'html-no-lang': 'Атрибут lang у <html>',
  'html-img-alt': 'Alt у изображений',
  'html-dup-id': 'Дублирующиеся id',
  'html-deprecated-tag': 'Устаревшие HTML-теги',
  'html-required-attr': 'Обязательные атрибуты элементов',
  'html-syntax': 'Синтаксические ошибки HTML',
  'html-structure': 'Структура HTML',
  'js-syntax': 'Синтаксические ошибки JS',
  'js-console': 'Вызовы console.* в коде',
  'js-debugger': 'Отладочные statements debugger',
  'js-eval': 'eval / new Function',
  'js-large-file': 'Очень большой JS-файл',
  'code-limit': 'Лимиты статического анализа',
};

// Рекомендации (детерминированные, без ИИ — ИИ добавит объяснение в итерации 4)
const SUGGESTIONS = {
  'css-important': 'Уберите !important, повысьте специфичность селектора или перепишите CSS на методологию (БЭМ, CSS-модули).',
  'css-duplicate-selector': 'Объедините дублирующиеся правила в одно, чтобы уменьшить объём CSS.',
  'css-unused-selector': 'Удалите неиспользуемые правила или проверьте, что селекторы действительно не нужны (проверка только по текущему HTML).',
  'css-empty-rule': 'Удалите правила без объявлений.',
  'css-long-file': 'Разбейте файл на модули и подключайте только нужные.',
  'css-syntax': 'Исправьте синтаксические ошибки — браузер игнорирует всё правило с ошибкой.',
  'html-no-lang': 'Добавьте <html lang="..."> — это требование доступности и корректного переноса текста.',
  'html-img-alt': 'Добавьте атрибут alt (пустой alt="", если изображение декоративное).',
  'html-dup-id': 'Оставьте уникальные id: дубли ломают якоря, label и JS-селекторы.',
  'html-deprecated-tag': 'Замените устаревший тег на современный + CSS-стилизацию.',
  'html-required-attr': 'Добавьте обязательный атрибут элементу.',
  'html-syntax': 'Исправьте разметку: неверный порядок/неявное закрытие тегов ломает DOM.',
  'html-structure': 'Исправьте структуру: элемент содержит недопустимое содержимое.',
  'js-syntax': 'Исправьте синтаксическую ошибку — файл целиком может не выполниться.',
  'js-console': 'Уберите console.* перед релизом или оставьте только в debug-сборке.',
  'js-debugger': 'Удалите statements debugger — он останавливает выполнение.',
  'js-eval': 'Не используйте eval/new Function: проблемы с безопасностью и производительностью (CSP).',
  'js-large-file': 'Разбейте бандл: code-splitting, tree-shaking, отложенная загрузка.',
  'code-limit': 'Проанализируйте оставшиеся файлы точечно — аналитик не берёт файлы сверх лимита.',
};

const SEVERITY_TO_VERDICT = { error: 'bad', warning: 'warn', info: 'info' };

/**
 * Сырая находка модуля правил -> finding формата interpret.js (+ аддитивные поля).
 * raw: { rule, severity, message, location?, value?, unit?, suggestion? }
 */
function toFinding(raw) {
  const severity = raw.severity || 'info';
  const verdict = SEVERITY_TO_VERDICT[severity] || 'info';
  const id = raw.rule;
  const finding = {
    id,
    metric: raw.metric || METRICS[id] || id,
    value: raw.value !== undefined ? raw.value : null,
    unit: raw.unit !== undefined ? raw.unit : raw.value !== undefined && raw.value !== null ? 'шт' : '',
    verdict,
    message: raw.message,
    // аддитивные поля
    severity,
    rule: id,
    location: raw.location || null,
    suggestion: raw.suggestion || SUGGESTIONS[id] || null,
  };
  if (finding.suggestion) finding.recommendation = finding.suggestion;
  return finding;
}

function toFindings(raws) {
  return raws.map(toFinding);
}

module.exports = { toFinding, toFindings, METRICS, SUGGESTIONS, SEVERITY_TO_VERDICT };
