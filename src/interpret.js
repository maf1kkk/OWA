/**
 * Детерминированная интерпретация метрик.
 * Все выводы (verdict/recommendation) вычисляются ЗДЕСЬ, по фиксированным правилам.
 * ИИ-агент должен использовать эти выводы как есть — это исключает галлюцинации.
 */

const RECOMMENDATIONS = {
  load: 'Сократите объём критических ресурсов: сжатие (brotli/gzip), кэширование, отложенная загрузка скриптов (defer/async).',
  domContentLoaded: 'Уменьшите размер HTML и число блокирующих скриптов в <head>.',
  fcp: 'Инлайньте критический CSS, уберите блокирующие стили и шрифты.',
  lcp: 'Оптимизируйте главный контент: preload ключевого изображения/текста, CDN, приоритет загрузки.',
  cls: 'Задайте размеры (width/height или aspect-ratio) для изображений и рекламных блоков, резервируйте место под динамику.',
  ttfb: 'Ускорьте сервер: кэширование на сервере, CDN, оптимизация бэкенда.',
  longTasks: 'Разбейте длинные JS-задачи на чанки, вынесите в Web Worker, отложите сторонние скрипты (аналитика, реклама).',
  tbt: 'Уменьшите объём JS, исполняемого при старте: code-splitting, tree-shaking, отложенная инициализация.',
  resources: 'Много запросов: объедините мелкие файлы, используйте HTTP/2, ленивую загрузку изображений.',
  jsErrors: 'Исправьте JS-ошибки: они могут ломать функциональность и замедлять страницу.',
  widgets: 'Виджеты не найдены: задайте точные CSS-селекторы через --selector для замера времени появления критических элементов.',
};

function fmt(value, unit) {
  if (value === null || value === undefined) return 'нет данных';
  return `${value} ${unit}`;
}

/**
 * Правило: меньше — лучше (invert=false) или больше — лучше (invert=true).
 */
function rule(id, metric, value, unit, good, poor, invert = false) {
  if (value === null || value === undefined) {
    return { id, metric, value: null, unit, verdict: 'info', message: `${metric}: нет данных` };
  }
  // invert=false: меньше — лучше. invert=true: больше — лучше.
  let verdict;
  if (invert ? value >= good : value <= good) verdict = 'good';
  else if (invert ? value >= poor : value <= poor) verdict = 'warn';
  else verdict = 'bad';

  const labels = { good: 'хорошо', warn: 'средне', bad: 'плохо' };
  const finding = {
    id,
    metric,
    value,
    unit,
    verdict,
    message: `${metric}: ${fmt(value, unit)} — ${labels[verdict]}`,
  };
  if (verdict !== 'good' && RECOMMENDATIONS[id]) {
    finding.recommendation = RECOMMENDATIONS[id];
  }
  return finding;
}

function buildFindings(m) {
  if (!m || typeof m !== 'object') return [];
  const F = [];

  if (m.legacyTiming) {
    F.push(rule('load', 'Полная загрузка', m.legacyTiming.loadTime, 'мс', 2000, 5000));
    F.push(rule('domContentLoaded', 'DOMContentLoaded', m.legacyTiming.domContentLoaded, 'мс', 1000, 3000));
  }

  if (m.navigation) {
    F.push(rule('ttfb', 'TTFB', Math.round(m.navigation.ttfb), 'мс', 800, 1800));
  }

  if (m.paint && m.paint.firstContentfulPaint !== null && m.paint.firstContentfulPaint !== undefined) {
    F.push(rule('fcp', 'FCP', Math.round(m.paint.firstContentfulPaint), 'мс', 1800, 3000));
  }

  if (m.vitals) {
    F.push(rule('lcp', 'LCP', m.vitals.lcpMs, 'мс', 2500, 4000));
    // CLS: меньше — лучше (invert=false)
    F.push(rule('cls', 'CLS', m.vitals.cls, '', 0.1, 0.25));
  }

  if (m.longTasks && m.longTasks.supported) {
    // Количество задач: 0-5 хорошо, >5 плохо. Больше — хуже => good=5, poor=1, invert=true
    // Смысл: value<=5 -> good; value>=1 (всё, что не good) -> warn если >=1... 
    // Для count инверсия даёт: 0 -> bad (неверно!), поэтому используем прямую шкалу:
    // good если <=good... но count=0 должен быть good. Прямая шкала: good=5? нет.
    // Правильно: чем меньше, тем лучше => good: count<=1, poor: count<=5
    F.push(rule('longTasks', 'Долгих задач (>50 мс)', m.longTasks.count, 'шт', 1, 5));
    F.push(rule('tbt', 'Total Blocking Time (оценка)', Math.round(m.longTasks.totalBlockingTime), 'мс', 200, 600));
  }

  if (m.resources) {
    // Чем меньше, тем лучше: good <=50, warn <=150
    F.push(rule('resources', 'Количество ресурсов', m.resources.count, 'шт', 50, 150));
  }

  if (m.jsErrors) {
    const n = m.jsErrors.length;
    if (n === 0) {
      F.push({ id: 'jsErrors', metric: 'JS-ошибки', value: 0, unit: 'шт', verdict: 'good', message: 'JS-ошибки: 0 шт — хорошо' });
    } else {
      F.push({
        id: 'jsErrors',
        metric: 'JS-ошибки',
        value: n,
        unit: 'шт',
        verdict: 'bad',
        message: `JS-ошибки: ${n} шт — плохо. Первая: ${m.jsErrors[0].message}`,
        recommendation: RECOMMENDATIONS.jsErrors,
      });
    }
  }

  if (m.customWidgets && m.customWidgets.results) {
    const entries = Object.entries(m.customWidgets.results);
    const found = entries.filter(([, t]) => t !== null);
    if (entries.length && found.length === 0) {
      F.push({
        id: 'widgets',
        metric: 'Виджеты',
        value: null,
        unit: '',
        verdict: 'info',
        message: `Ни один из ${entries.length} селекторов не найден за время наблюдения`,
        recommendation: RECOMMENDATIONS.widgets,
      });
    } else if (found.length) {
      const worst = Math.max(...found.map(([, t]) => t));
      // Чем меньше, тем лучше
      F.push(rule('widgets', 'Самый медленный виджет', worst, 'мс', 1000, 3000));
    }
  }

  return F;
}

const ORDER = { bad: 3, warn: 2, info: 1, good: 0 };

function buildSummary(findings) {
  const bad = findings.filter((f) => f.verdict === 'bad').length;
  const warn = findings.filter((f) => f.verdict === 'warn').length;
  const status = bad > 0 ? 'bad' : warn > 0 ? 'warn' : 'good';
  const score = Math.max(0, 100 - bad * 20 - warn * 5);
  const worst = findings
    .filter((f) => f.verdict === 'bad' || f.verdict === 'warn')
    .sort((a, b) => ORDER[b.verdict] - ORDER[a.verdict]);
  return {
    status,
    score,
    headline:
      status === 'bad'
        ? `Обнаружены серьёзные проблемы: ${worst.map((f) => f.metric).join(', ')}`
        : status === 'warn'
          ? `Есть что улучшить: ${worst.map((f) => f.metric).join(', ')}`
          : 'Критических проблем не обнаружено',
  };
}

function buildCompact(data) {
  const m = data.metrics;
  const interpretation = data.interpretation || {
    summary: buildSummary(buildFindings(m)),
    findings: buildFindings(m),
  };
  return {
    schemaVersion: 1,
    tool: 'owa',
    url: data.meta.url,
    analyzedAt: data.meta.analyzedAt,
    summary: interpretation.summary,
    findings: interpretation.findings.map((f) => ({
      id: f.id,
      verdict: f.verdict,
      message: f.message,
      ...(f.recommendation ? { recommendation: f.recommendation } : {}),
    })),
    keyMetrics: {
      loadMs: m.legacyTiming ? m.legacyTiming.loadTime : null,
      domContentLoadedMs: m.legacyTiming ? m.legacyTiming.domContentLoaded : null,
      fcpMs: m.paint && m.paint.firstContentfulPaint !== null ? Math.round(m.paint.firstContentfulPaint) : null,
      lcpMs: m.vitals ? m.vitals.lcpMs : null,
      cls: m.vitals ? m.vitals.cls : null,
      ttfbMs: m.navigation ? Math.round(m.navigation.ttfb) : null,
      resources: m.resources ? m.resources.count : null,
      longTasks: m.longTasks ? m.longTasks.count : null,
      tbtMs: m.longTasks ? Math.round(m.longTasks.totalBlockingTime) : null,
      jsErrors: Array.isArray(m.jsErrors) ? m.jsErrors.length : 0,
      widgets: m.customWidgets ? m.customWidgets.results : {},
    },
    slowestResources: m.resources ? m.resources.top10Slowest.slice(0, 3) : [],
  };
}

module.exports = { buildFindings, buildSummary, buildCompact, rule };
