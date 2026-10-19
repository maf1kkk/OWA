/**
 * Генерация клиентского PDF-отчёта по результату комплексного аудита.
 *
 * Графики рендерятся ЗАРАНЕЕ в PNG (chartjs-node-canvas) и вставляются в HTML
 * как <img> с data-URI. В page.pdf() не полагаемся на выполнение JS внутри
 * страницы: так отчёт не зависит от того, отработал ли скрипт в headless.
 *
 * Шрифты — стандартные (Helvetica/Arial): кастомные требуют встраивания
 * и разъезжаются в Adobe Reader.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { Chart, registerables } = require('chart.js');
const { launchBrowser } = require('../browser');

Chart.register(...registerables);

// Один инстанс на модуль: внутри держит canvas-фабрику и кэш шрифтов.
const chartCanvas = new ChartJSNodeCanvas({
  width: 720,
  height: 360,
  backgroundColour: 'white',
});

/** Отрисовать конфигурацию Chart.js в PNG-buffer. */
async function renderChartPng(config) {
  const buffer = await chartCanvas.renderToBuffer(config);
  return 'data:image/png;base64,' + buffer.toString('base64');
}

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const MAX_PDF_BYTES = 10 * 1024 * 1024;

const SECTION_LABELS = {
  performance: 'Производительность',
  seo: 'SEO',
  security: 'Безопасность',
  accessibility: 'Доступность',
  content: 'Контент',
};

const SEVERITY_LABELS = { critical: 'критично', warning: 'предупреждение', info: 'инфо' };

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

function shortUrl(url, max = 60) {
  const s = String(url || '');
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Core Web Vitals: значение + пороги Google + индикатор. */
function vitalsRows(result) {
  const perf = result.scores && result.scores.performance;
  const raw = (perf && perf.raw && perf.raw.metrics) || {};
  const rows = [
    { label: 'LCP (Largest Contentful Paint)', value: raw.lcpMs, unit: ' мс', good: 2500, poor: 4000 },
    { label: 'CLS (Cumulative Layout Shift)', value: raw.cls, unit: '', good: 0.1, poor: 0.25 },
    { label: 'FCP (First Contentful Paint)', value: raw.fcpMs, unit: ' мс', good: 1800, poor: 3000 },
    { label: 'TTFB (Time to First Byte)', value: raw.ttfbMs, unit: ' мс', good: 800, poor: 1800 },
    { label: 'TBT (Total Blocking Time)', value: raw.tbtMs, unit: ' мс', good: 200, poor: 600 },
  ];
  return rows.map((r) => {
    let cls = 'none';
    let verdict = 'нет данных';
    if (typeof r.value === 'number') {
      if (r.value <= r.good) { cls = 'good'; verdict = 'Good'; }
      else if (r.value <= r.poor) { cls = 'warn'; verdict = 'Needs Improvement'; }
      else { cls = 'bad'; verdict = 'Poor'; }
    }
    const fmt = (v) => (typeof v === 'number' ? v + r.unit : '-');
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

function sectionScoreCards(result) {
  return Object.entries(result.scores || {}).map(([name, sec]) => {
    const label = SECTION_LABELS[name] || name;
    const value = sec.score === null ? 'n/a' : sec.score;
    return '<div class="section-score">'
      + '<div class="name">' + esc(label) + '</div>'
      + '<div class="val ' + scoreClass(sec.score) + '">' + esc(value) + '</div>'
      + '</div>';
  }).join('\n      ');
}

function sectionRows(result) {
  return Object.entries(result.scores || {}).map(([name, sec]) => {
    const label = SECTION_LABELS[name] || name;
    const issues = Array.isArray(sec.issues) ? sec.issues.length : 0;
    const time = sec.durationMs === null || sec.durationMs === undefined ? '-' : sec.durationMs;
    return '<tr>'
      + '<td>' + esc(label) + '</td>'
      + '<td class="num">' + (sec.score === null ? 'n/a' : esc(sec.score)) + '</td>'
      + '<td>' + esc(sec.status) + '</td>'
      + '<td class="num">' + esc(issues) + '</td>'
      + '<td class="num">' + esc(time) + '</td>'
      + '</tr>';
  }).join('\n');
}

function issueCard(issue, index) {
  const sev = issue.severity || 'info';
  const loc = issue.location ? '<div class="loc">' + esc(Array.isArray(issue.location) ? issue.location.join(' ') : issue.location) + '</div>' : '';
  let out = '<div class="issue ' + esc(sev) + '">';
  out += '<div class="head"><span class="sev">' + esc(SEVERITY_LABELS[sev] || sev) + '</span>' + index + '. ' + esc(issue.message) + '</div>';
  out += '<div class="row"><b>Что не так:</b> ' + esc(issue.message) + '</div>';
  if (issue.recommendation) out += '<div class="row"><b>Как исправить:</b> ' + esc(issue.recommendation) + '</div>';
  if (issue.rule) out += '<div class="row"><b>Правило:</b> ' + esc(issue.rule) + '</div>';
  out += loc;
  out += '</div>';
  return out;
}

function sortIssues(issues) {
  const order = { critical: 0, warning: 1, info: 2 };
  return [...issues].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
}

/** Кольцевая диаграмма распределения проблем по секциям -> PNG data-URI. */
async function issuesChartPng(result) {
  const labels = [];
  const values = [];
  const colors = ['#c0392b', '#3b82f6', '#b7791f', '#1a7f37', '#6b7280'];
  for (const [name, sec] of Object.entries(result.scores || {})) {
    labels.push(SECTION_LABELS[name] || name);
    values.push(Array.isArray(sec.issues) ? sec.issues.length : 0);
  }

  return renderChartPng({
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: labels.map((_, idx) => colors[idx % colors.length]),
        borderColor: '#ffffff',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: { position: 'right', labels: { font: { size: 14 }, color: '#1b1f24' } },
        title: { display: true, text: 'Проблемы по секциям', font: { size: 16 }, color: '#1b1f24' },
      },
    },
  });
}

/** Радар по оценкам секций -> PNG data-URI. */
async function radarChartPng(result) {
  const labels = [];
  const values = [];
  for (const [name, sec] of Object.entries(result.scores || {})) {
    labels.push(SECTION_LABELS[name] || name);
    values.push(sec.score === null ? 0 : sec.score);
  }

  return renderChartPng({
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: 'Оценка секции',
        data: values,
        backgroundColor: 'rgba(59, 130, 246, 0.22)',
        borderColor: '#3b82f6',
        pointBackgroundColor: '#3b82f6',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: { stepSize: 20, font: { size: 11 } },
          pointLabels: { font: { size: 13 } },
        },
      },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 12 } } },
      },
    },
  });
}

/** Собрать HTML отчёта из шаблона. */
function buildHtml(result, charts) {
  const template = fs.readFileSync(path.join(TEMPLATES_DIR, 'report.html'), 'utf8');
  const styles = fs.readFileSync(path.join(TEMPLATES_DIR, 'styles.css'), 'utf8');

  const issues = sortIssues(result.issues || []);
  const top = issues.slice(0, 10);

  const score = result.integralScore;
  const legend = score >= 85
    ? 'Результат: сайт в хорошем состоянии, критичных проблем не обнаружено.'
    : score >= 60
      ? 'Результат: есть заметные недочёты, которые стоит устранить.'
      : 'Результат: обнаружены серьёзные проблемы, требующие внимания.';

  // replaceAll: __URL__ встречается в отчёте дважды (шапка и подвал).
  return template
    .replace('__STYLES__', styles)
    .replace('__URL_SHORT__', esc(shortUrl(result.url, 42)))
    .replace('__DATE_SHORT__', esc(new Date(result.timestamp).toLocaleDateString('ru-RU')))
    .replaceAll('__URL__', esc(result.url))
    .replace('__DATE_LONG__', esc(fmtDate(result.timestamp)))
    .replace('__SCORE_CLASS__', scoreClass(score))
    .replace('__INTEGRAL_SCORE__', String(score))
    .replace('__SCORE_LEGEND__', esc(legend))
    .replace('__SECTION_SCORES__', sectionScoreCards(result))
    .replace('__VITALS_ROWS__', vitalsRows(result))
    .replace('__SECTION_ROWS__', sectionRows(result))
    .replace('__ISSUES_CHART__', charts.issues)
    .replace('__RADAR_CHART__', charts.radar)
    .replace('__TOP_ISSUES__', top.length
      ? top.map((i, n) => issueCard(i, n + 1)).join('\n')
      : '<p>Критичных проблем не обнаружено.</p>')
    .replace('__ALL_ISSUES__', issues.length
      ? issues.map((i, n) => issueCard(i, n + 1)).join('\n')
      : '<p>Проблем не обнаружено.</p>');
}

/**
 * Сгенерировать PDF-отчёт.
 * @param {object} result — результат runFullAudit
 * @param {string} outPath — куда сохранить .pdf
 * @returns {Promise<{path: string, bytes: number, durationMs: number}>}
 */
async function generatePdfReport(result, outPath) {
  const started = Date.now();
  const charts = {
    issues: await issuesChartPng(result),
    radar: await radarChartPng(result),
  };
  const html = buildHtml(result, charts);

  const browser = await launchBrowser(true);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
      displayHeaderFooter: false,
    });
    await context.close();

    if (buffer.length > MAX_PDF_BYTES) {
      throw new Error('PDF слишком большой: ' + buffer.length + ' байт (лимит ' + MAX_PDF_BYTES + ')');
    }
    fs.writeFileSync(outPath, buffer);
    return { path: outPath, bytes: buffer.length, durationMs: Date.now() - started };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { generatePdfReport, buildHtml, issuesChartPng, radarChartPng };