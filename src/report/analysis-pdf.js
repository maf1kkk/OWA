/**
 * PDF-отчёт по performance-анализу (одна страница, без аудита по разделам).
 *
 * Отдельный отчёт от комплексного аудита: здесь только метрики загрузки,
 * ресурсы, Long Tasks и найденные проблемы — без SEO/Security/A11y/Content.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { Chart, registerables } = require('chart.js');
const { renderPdf } = require('./render');

Chart.register(...registerables);

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const chartCanvas = new ChartJSNodeCanvas({ width: 900, height: 260, backgroundColour: 'white' });

const TYPE_COLORS = {
  script: '#f85149', link: '#d29922', img: '#3fb950', font: '#a371f7',
  fetch: '#6cb6ff', xhr: '#ff7b72', beacon: '#8b949e', css: '#d29922', other: '#8b949e',
};

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scoreClass(score) {
  if (score === null || score === undefined) return 'bad';
  if (score >= 85) return 'good';
  if (score >= 60) return 'warn';
  return 'bad';
}

function kb(bytes) {
  if (!bytes) return '0 Б';
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / 1048576).toFixed(2) + ' МБ';
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Карточки ключевых метрик на титуле. */
function metricCards(metrics) {
  const items = [
    ['LCP', metrics.lcpMs, 'мс'],
    ['CLS', metrics.cls, ''],
    ['FCP', metrics.fcpMs, 'мс'],
    ['TTFB', metrics.ttfbMs, 'мс'],
    ['TBT', metrics.tbtMs, 'мс'],
    ['Ресурсов', metrics.resources, 'шт'],
  ];
  return items.map(([name, value, unit]) => '<div class="site-card">'
    + '<div class="name">' + esc(name) + '</div>'
    + '<div class="val">' + (value === null || value === undefined ? '—' : esc(value) + ' ' + esc(unit)) + '</div>'
    + '</div>').join('\n      ');
}

/** Таблица Core Web Vitals с порогами. */
function vitalsRows(metrics) {
  const rows = [
    { label: 'LCP (Largest Contentful Paint)', value: metrics.lcpMs, unit: ' мс', good: 2500, poor: 4000 },
    { label: 'CLS (Cumulative Layout Shift)', value: metrics.cls, unit: '', good: 0.1, poor: 0.25 },
    { label: 'FCP (First Contentful Paint)', value: metrics.fcpMs, unit: ' мс', good: 1800, poor: 3000 },
    { label: 'TTFB (Time to First Byte)', value: metrics.ttfbMs, unit: ' мс', good: 800, poor: 1800 },
    { label: 'TBT (Total Blocking Time)', value: metrics.tbtMs, unit: ' мс', good: 200, poor: 600 },
  ];
  return rows.map((r) => {
    let cls = 'none';
    let verdict = 'нет данных';
    if (typeof r.value === 'number') {
      if (r.value <= r.good) { cls = 'good'; verdict = 'Good'; }
      else if (r.value <= r.poor) { cls = 'warn'; verdict = 'Needs Improvement'; }
      else { cls = 'bad'; verdict = 'Poor'; }
    }
    const fmt = (v) => (typeof v === 'number' ? v + r.unit : '—');
    return '<tr>'
      + '<td class="indicator"><span class="dot ' + cls + '"></span></td>'
      + '<td>' + esc(r.label) + '</td>'
      + '<td class="num">' + esc(fmt(r.value)) + '</td>'
      + '<td class="num">' + esc(fmt(r.good)) + '</td>'
      + '<td class="num">' + esc(fmt(r.poor)) + '</td>'
      + '<td>' + esc(verdict) + '</td>'
      + '</tr>';
  }).join('\n');
}

function navRows(navigation) {
  if (!navigation) return '<tr><td colspan="2">Нет данных navigation entry</td></tr>';
  const items = [
    ['DNS', Math.round(navigation.dns)], ['TCP', Math.round(navigation.tcp)], ['SSL', Math.round(navigation.ssl)],
    ['TTFB', Math.round(navigation.ttfb)], ['DOM interactive', Math.round(navigation.domInteractive)],
    ['DOM complete', Math.round(navigation.domComplete)], ['Load event', Math.round(navigation.loadEvent)],
  ];
  return items.map(([k, v]) => '<tr><td>' + esc(k) + '</td><td class="num">' + esc(v) + ' мс</td></tr>').join('\n');
}

function resourceRows(byType) {
  const entries = Object.entries(byType || {});
  if (!entries.length) return '<tr><td colspan="4">Нет данных</td></tr>';
  return entries.map(([type, st]) => '<tr>'
    + '<td>' + esc(type) + '</td>'
    + '<td class="num">' + esc(st.count) + '</td>'
    + '<td class="num">' + esc(kb(st.totalTransferSize)) + '</td>'
    + '<td class="num">' + esc(Math.round(st.totalDuration / Math.max(1, st.count))) + ' мс</td>'
    + '</tr>').join('\n');
}

function slowRows(resources) {
  const list = (resources && resources.top10Slowest) || [];
  if (!list.length) return '<tr><td colspan="4">Нет данных</td></tr>';
  return list.map((r) => '<tr>'
    + '<td style="font-size:8.5pt">' + esc(String(r.name).slice(0, 90)) + '</td>'
    + '<td>' + esc(r.type || '—') + '</td>'
    + '<td class="num">' + esc(r.duration) + '</td>'
    + '<td class="num">' + esc(kb(r.size)) + '</td>'
    + '</tr>').join('\n');
}

function longTaskRows(longTasks) {
  if (!longTasks) return '<tr><td colspan="2">Нет данных</td></tr>';
  if (longTasks.supported === false) {
    return '<tr><td colspan="2">PerformanceObserver longtask не поддерживается этим браузером</td></tr>';
  }
  return [
    ['Долгих задач (&gt;50 мс)', longTasks.count],
    ['Максимальная длительность', longTasks.maxDuration + ' мс'],
    ['Total Blocking Time (оценка)', Math.round(longTasks.totalBlockingTime) + ' мс'],
  ].map(([k, v]) => '<tr><td>' + k + '</td><td class="num">' + esc(v) + '</td></tr>').join('\n');
}

function findingsRows(findings) {
  if (!findings || !findings.length) return '<p>Критичных проблем не обнаружено.</p>';
  const labels = { bad: 'плохо', warn: 'средне', info: 'инфо', good: 'хорошо' };
  return '<table><tr><th>Метрика</th><th style="text-align:right">Значение</th><th>Вердикт</th></tr>'
    + findings.map((f) => '<tr>'
      + '<td>' + esc(f.metric) + (f.recommendation ? '<div style="font-size:8.5pt;color:#6b7280">' + esc(f.recommendation) + '</div>' : '') + '</td>'
      + '<td class="num">' + (f.value === null || f.value === undefined ? '—' : esc(f.value) + ' ' + esc(f.unit || '')) + '</td>'
      + '<td>' + esc(labels[f.verdict] || f.verdict) + '</td>'
      + '</tr>').join('')
    + '</table>';
}

/** Настоящий водопад: невидимая база (время старта) + полоса длительности. */
async function waterfallChartPng(resources) {
  const wf = (resources && resources.waterfall) || [];
  if (!wf.length) return null;
  const labels = wf.map((r) => String(r.name).split('/').pop().slice(0, 28));
  const start = wf.map((r) => r.start);
  const duration = wf.map((r) => Math.max(1, r.end - r.start));
  const colors = wf.map((r) => TYPE_COLORS[r.type] || TYPE_COLORS.other);

  const buffer = await chartCanvas.renderToBuffer({
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'старт', data: start, backgroundColor: 'rgba(0,0,0,0)', stack: 'wf', borderWidth: 0 },
        { label: 'длительность', data: duration, backgroundColor: colors, stack: 'wf', borderWidth: 0 },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: false,
      animation: false,
      scales: {
        x: { stacked: true, title: { display: true, text: 'мс от начала навигации' } },
        y: { stacked: true, ticks: { font: { size: 9 } } },
      },
      plugins: { legend: { display: false }, title: { display: false } },
    },
  });
  return 'data:image/png;base64,' + buffer.toString('base64');
}

/**
 * Собрать HTML отчёта по анализу.
 * @param {object} report — результат analyze (src/engine.js)
 * @param {object} charts
 */
function buildAnalysisHtml(report, charts) {
  const template = fs.readFileSync(path.join(TEMPLATES_DIR, 'analysis.html'), 'utf8');
  const styles = fs.readFileSync(path.join(TEMPLATES_DIR, 'styles.css'), 'utf8');

  const m = report.metrics || {};
  const summary = (report.interpretation && report.interpretation.summary) || { score: 0, headline: '' };
  const url = (report.meta && report.meta.url) || '';
  const at = (report.meta && report.meta.analyzedAt) || new Date().toISOString();

  const metrics = {
    lcpMs: m.vitals ? m.vitals.lcpMs : null,
    cls: m.vitals ? m.vitals.cls : null,
    fcpMs: m.paint ? Math.round(m.paint.firstContentfulPaint) : null,
    ttfbMs: m.navigation ? Math.round(m.navigation.ttfb) : null,
    tbtMs: m.longTasks ? Math.round(m.longTasks.totalBlockingTime) : null,
    resources: m.resources ? m.resources.count : null,
  };

  const legend = summary.score >= 85
    ? 'Сайт в хорошем состоянии по метрикам загрузки.'
    : summary.score >= 60
      ? 'Есть заметные недочёты, которые стоит устранить.'
      : 'Обнаружены серьёзные проблемы с загрузкой.';

  return template
    .replace('__STYLES__', styles)
    .replace('__URL__', esc(url))
    .replace('__URL_SHORT__', esc(url.length > 60 ? url.slice(0, 57) + '...' : url))
    .replace('__DATE_LONG__', esc(fmtDate(at)))
    .replace('__DATE_SHORT__', esc(new Date(at).toLocaleDateString('ru-RU')))
    .replace('__SCORE_CLASS__', scoreClass(summary.score))
    .replace('__SCORE__', String(summary.score === undefined ? '—' : summary.score))
    .replace('__HEADLINE__', esc(summary.headline || 'Анализ производительности'))
    .replace('__SCORE_LEGEND__', esc(legend))
    .replace('__METRIC_CARDS__', metricCards(metrics))
    .replace('__VITALS_ROWS__', vitalsRows(metrics))
    .replace('__NAV_ROWS__', navRows(m.navigation))
    .replace('__RESOURCE_ROWS__', resourceRows(m.resources && m.resources.byType))
    .replace('__SLOW_ROWS__', slowRows(m.resources))
    .replace('__WATERFALL_CHART__', charts.waterfall || '')
    .replace('__LONG_TASK_ROWS__', longTaskRows(m.longTasks))
    .replace('__FINDINGS__', findingsRows(report.interpretation && report.interpretation.findings));
}

/**
 * Сгенерировать PDF по анализу.
 * @param {object} report — результат analyze
 * @param {string} outPath
 */
async function generateAnalysisPdf(report, outPath) {
  const started = Date.now();
  const charts = { waterfall: await waterfallChartPng(report.metrics && report.metrics.resources) };
  const html = buildAnalysisHtml(report, charts);
  const info = await renderPdf(html, outPath);
  return { ...info, durationMs: Date.now() - started };
}

module.exports = { generateAnalysisPdf, buildAnalysisHtml, waterfallChartPng };
