/**
 * Сводный PDF-отчёт за сессию: все операции, сайты, проблемы по разделам.
 *
 * Собирает из лога операций (src/web/session.js) единый документ —
 * чтобы не печатать веб-интерфейс целиком (там смешиваются все вкладки).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { Chart, registerables } = require('chart.js');
const { renderPdf } = require('./render');

Chart.register(...registerables);

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const chartCanvas = new ChartJSNodeCanvas({ width: 760, height: 320, backgroundColour: 'white' });

const SECTION_LABELS = {
  performance: 'Производительность',
  seo: 'SEO',
  security: 'Безопасность',
  accessibility: 'Доступность',
  content: 'Контент',
};

const TYPE_LABELS = {
  analyze: 'Анализ',
  audit: 'Аудит',
  crawl: 'Обход',
  compare: 'Сравнение',
};

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function scoreClass(score) {
  if (score === null || score === undefined) return 'bad';
  if (score >= 85) return 'good';
  if (score >= 60) return 'warn';
  return 'bad';
}

/** Сводные карточки: операций, сайтов, средняя оценка, всего проблем. */
function summaryCards(stats) {
  const cards = [
    ['Операций', stats.opCount, 'в этой сессии'],
    ['Сайтов', stats.siteCount, 'уникальных'],
    ['Средняя оценка', stats.avgScore === null ? '—' : stats.avgScore, 'по операциям'],
    ['Проблем найдено', stats.issueCount, 'всего'],
  ];
  return cards.map(([name, value, sub]) => '<div class="site-card">'
    + '<div class="name">' + esc(name) + '</div>'
    + '<div class="val">' + esc(value) + '</div>'
    + '<div class="role">' + esc(sub) + '</div>'
    + '</div>').join('\n      ');
}

function opsRows(ops) {
  if (!ops.length) return '<tr><td colspan="5">Операций пока не было</td></tr>';
  return ops.map((op) => '<tr>'
    + '<td class="num">' + esc(fmtTime(op.at)) + '</td>'
    + '<td>' + esc(TYPE_LABELS[op.type] || op.type) + '</td>'
    + '<td style="font-size:8.5pt;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(op.url) + '</td>'
    + '<td class="num">' + (op.score === null || op.score === undefined ? '—' : esc(op.score)) + '</td>'
    + '<td class="num">' + esc(op.issueCount || 0) + '</td>'
    + '</tr>').join('\n');
}

function sitesRows(sites) {
  if (!sites.length) return '<tr><td colspan="4">Нет данных</td></tr>';
  return sites.map((s) => '<tr>'
    + '<td style="font-size:8.5pt;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.url) + '</td>'
    + '<td class="num">' + esc(s.count) + '</td>'
    + '<td class="num">' + (s.avgScore === null ? '—' : esc(s.avgScore)) + '</td>'
    + '<td>' + esc(s.lastType) + '</td>'
    + '</tr>').join('\n');
}

function topIssuesRows(issues) {
  if (!issues.length) return '<tr><td colspan="4">Проблем не найдено</td></tr>';
  const labels = { critical: 'критично', warning: 'предупреждение', info: 'инфо' };
  return issues.slice(0, 25).map((i) => '<tr>'
    + '<td>' + esc(i.rule) + '</td>'
    + '<td>' + esc(i.section) + '</td>'
    + '<td>' + esc(labels[i.severity] || i.severity) + '</td>'
    + '<td class="num">' + esc(i.count) + '</td>'
    + '</tr>').join('\n');
}

/** Кольцевая диаграмма проблем по разделам. */
async function issuesChartPng(bySection) {
  const labels = Object.keys(bySection);
  if (!labels.length) return null;
  const values = labels.map((k) => bySection[k]);
  const colors = ['#c0392b', '#3b82f6', '#b7791f', '#1a7f37', '#6b7280'];
  const buffer = await chartCanvas.renderToBuffer({
    type: 'doughnut',
    data: {
      labels: labels.map((k) => SECTION_LABELS[k] || k),
      datasets: [{ data: values, backgroundColor: labels.map((_, i) => colors[i % colors.length]), borderColor: '#fff', borderWidth: 2 }],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: { position: 'right', labels: { font: { size: 12 } } },
        title: { display: true, text: 'Проблемы по разделам', font: { size: 14 } },
      },
    },
  });
  return 'data:image/png;base64,' + buffer.toString('base64');
}

/**
 * Посчитать сводку по операциям сессии.
 * @param {Array} ops — лог операций
 */
function summarize(ops) {
  const scored = ops.filter((o) => typeof o.score === 'number');
  const avgScore = scored.length
    ? Math.round(scored.reduce((s, o) => s + o.score, 0) / scored.length)
    : null;

  const bySite = new Map();
  for (const op of ops) {
    const key = op.url || '(не указан)';
    const entry = bySite.get(key) || { url: key, count: 0, scores: [], lastType: '' };
    entry.count += 1;
    if (typeof op.score === 'number') entry.scores.push(op.score);
    entry.lastType = TYPE_LABELS[op.type] || op.type;
    bySite.set(key, entry);
  }
  const sites = [...bySite.values()].map((s) => ({
    url: s.url,
    count: s.count,
    avgScore: s.scores.length ? Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length) : null,
    lastType: s.lastType,
  }));

  const bySection = {};
  const byRule = new Map();
  for (const op of ops) {
    for (const issue of op.issues || []) {
      const section = issue.section || '—';
      bySection[section] = (bySection[section] || 0) + 1;
      const rule = issue.rule || issue.id || '—';
      const key = rule + '|' + section;
      const entry = byRule.get(key) || {
        rule, section, severity: issue.severity || 'info', count: 0,
      };
      entry.count += 1;
      if (entry.severity !== 'critical' && issue.severity === 'critical') entry.severity = 'critical';
      byRule.set(key, entry);
    }
  }

  const severityOrder = { critical: 0, warning: 1, info: 2 };
  const topIssues = [...byRule.values()]
    .sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3) || b.count - a.count);

  return {
    opCount: ops.length,
    siteCount: sites.length,
    avgScore,
    issueCount: ops.reduce((s, o) => s + (o.issues || []).length, 0),
    bySection,
    sites,
    topIssues,
  };
}

/**
 * Собрать HTML сводного отчёта.
 * @param {Array} ops — лог операций
 */
function buildSessionHtml(ops, charts) {
  const template = fs.readFileSync(path.join(TEMPLATES_DIR, 'session.html'), 'utf8');
  const styles = fs.readFileSync(path.join(TEMPLATES_DIR, 'styles.css'), 'utf8');
  const stats = summarize(ops);
  const at = ops.length ? ops[ops.length - 1].at : new Date().toISOString();

  return template
    .replace('__STYLES__', styles)
    .replace('__DATE_LONG__', esc(fmtDate(at)))
    .replace('__DATE_SHORT__', esc(new Date(at).toLocaleDateString('ru-RU')))
    .replace('__OP_COUNT__', String(stats.opCount))
    .replace('__SUMMARY_CARDS__', summaryCards(stats))
    .replace('__OPS_ROWS__', opsRows(ops))
    .replace('__SITES_ROWS__', sitesRows(stats.sites))
    .replace('__ISSUES_CHART__', charts.issues || '')
    .replace('__TOP_ISSUES__', topIssuesRows(stats.topIssues));
}

/**
 * Сгенерировать сводный PDF за сессию.
 * @param {Array} ops — лог операций
 * @param {string} outPath
 */
async function generateSessionPdf(ops, outPath) {
  const started = Date.now();
  const stats = summarize(ops);
  const charts = { issues: await issuesChartPng(stats.bySection) };
  const html = buildSessionHtml(ops, charts);
  const info = await renderPdf(html, outPath);
  return { ...info, durationMs: Date.now() - started };
}

module.exports = { generateSessionPdf, buildSessionHtml, summarize, issuesChartPng };
