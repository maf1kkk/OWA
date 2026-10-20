/**
 * Полный отчёт по сайту в PDF: аудит + обход + безопасность + сравнение + план.
 *
 * Всё, что попадает в отчёт, — результат измерений. Текст (резюме и план)
 * генерируется LLM, но проверяется на соответствие фактам.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { Chart, registerables } = require('chart.js');
const { renderPdf } = require('./render');

Chart.register(...registerables);

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const chartCanvas = new ChartJSNodeCanvas({ width: 900, height: 380, backgroundColour: 'white' });

const SECTION_LABELS = {
  performance: 'Производительность',
  seo: 'SEO',
  security: 'Безопасность',
  accessibility: 'Доступность',
  content: 'Контент',
};

const SEV_LABELS = { critical: 'критично', warning: 'предупреждение', info: 'инфо' };

const SITE_COLORS = ['#3b82f6', '#c0392b', '#b7791f', '#1a7f37', '#a371f7', '#6b7280'];

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

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Оценка метрики по порогам Core Web Vitals. */
function vitalsVerdict(value, good, poor) {
  if (typeof value !== 'number') return { cls: 'none', text: 'нет данных' };
  if (value <= good) return { cls: 'good', text: 'Good' };
  if (value <= poor) return { cls: 'warn', text: 'Needs Improvement' };
  return { cls: 'bad', text: 'Poor' };
}

function vitalsRows(metrics) {
  const rows = [
    { label: 'LCP (Largest Contentful Paint)', value: metrics.lcpMs, unit: ' мс', good: 2500, poor: 4000 },
    { label: 'CLS (Cumulative Layout Shift)', value: metrics.cls, unit: '', good: 0.1, poor: 0.25 },
    { label: 'FCP (First Contentful Paint)', value: metrics.fcpMs, unit: ' мс', good: 1800, poor: 3000 },
    { label: 'TTFB (Time to First Byte)', value: metrics.ttfbMs, unit: ' мс', good: 800, poor: 1800 },
    { label: 'TBT (Total Blocking Time)', value: metrics.tbtMs, unit: ' мс', good: 200, poor: 600 },
  ];
  return rows.map((r) => {
    const v = vitalsVerdict(r.value, r.good, r.poor);
    const fmt = (x) => (typeof x === 'number' ? x + r.unit : '—');
    return '<tr>'
      + '<td class="indicator"><span class="dot ' + v.cls + '"></span></td>'
      + '<td>' + esc(r.label) + '</td>'
      + '<td class="num">' + esc(fmt(r.value)) + '</td>'
      + '<td class="num">' + esc(fmt(r.good)) + '</td>'
      + '<td class="num">' + esc(fmt(r.poor)) + '</td>'
      + '<td>' + esc(v.text) + '</td>'
      + '</tr>';
  }).join('\n');
}

function avgRows(avgMetrics) {
  if (!avgMetrics) return '<tr><td colspan="3">Нет данных</td></tr>';
  const items = [
    ['LCP, среднее по сайту', avgMetrics.lcpMs, ' мс', 2500, 4000],
    ['CLS, среднее по сайту', avgMetrics.cls, '', 0.1, 0.25],
    ['FCP, среднее по сайту', avgMetrics.fcpMs, ' мс', 1800, 3000],
    ['TTFB, среднее по сайту', avgMetrics.ttfbMs, ' мс', 800, 1800],
    ['TBT, среднее по сайту', avgMetrics.tbtMs, ' мс', 200, 600],
    ['Ресурсов на страницу, среднее', avgMetrics.resources, ' шт', 50, 150],
  ];
  return items.map(([label, value, unit, good, poor]) => {
    const v = vitalsVerdict(value, good, poor);
    const shown = typeof value === 'number' ? value + unit : '—';
    return '<tr><td>' + esc(label) + '</td><td class="num">' + esc(shown) + '</td>'
      + '<td><span class="dot ' + v.cls + '"></span> ' + esc(v.text) + '</td></tr>';
  }).join('\n');
}

function sectionRows(facts) {
  const counts = {};
  for (const f of facts.findings) counts[f.section] = (counts[f.section] || 0) + 1;
  const topBySection = {};
  for (const f of facts.findings) {
    topBySection[f.section] = topBySection[f.section] || [];
    if (topBySection[f.section].length < 3) topBySection[f.section].push(f.message);
  }
  return Object.entries(facts.sections).map(([name, s]) => '<tr>'
    + '<td>' + esc(SECTION_LABELS[name] || name) + '</td>'
    + '<td class="num"><span class="v ' + scoreClass(s.score) + '">' + (s.score === null ? 'н/д' : s.score) + '</span></td>'
    + '<td class="num">' + (counts[name] || 0) + '</td>'
    + '<td>' + esc((topBySection[name] || []).join('; ')) + '</td>'
    + '</tr>').join('\n');
}

function topIssuesRows(facts) {
  const list = facts.crawl ? facts.crawl.topIssues : [];
  if (!list.length) return '<tr><td colspan="3">Нет данных</td></tr>';
  return list.map((i) => '<tr>'
    + '<td class="sel">' + esc(i.ruleId) + '</td>'
    + '<td>' + esc(SEV_LABELS[i.severity] || i.severity) + '</td>'
    + '<td class="num">' + esc(i.pages) + '</td>'
    + '</tr>').join('\n');
}

function worstPagesRows(facts) {
  const list = facts.crawl ? facts.crawl.worstPages : [];
  if (!list.length) return '<tr><td colspan="2">Нет данных</td></tr>';
  return list.map((p) => '<tr><td class="sel" style="font-size:8.5pt">' + esc(p.url) + '</td>'
    + '<td class="num">' + esc(p.score) + '</td></tr>').join('\n');
}

function securityBlock(facts) {
  if (!facts.security) {
    return '<p>Детальная проверка безопасности в этом отчёте не выполнялась.</p>';
  }
  const edge = facts.security.edge || {};
  const cdn = (edge.cdn || []).map((c) => c.name).join(', ') || 'не обнаружен';
  const waf = (edge.waf || []).map((c) => c.name).join(', ') || 'не обнаружен';
  const rl = facts.security.rateLimit || {};
  let rlText = 'не проверялось';
  if (rl.probed) {
    rlText = rl.limitSeen
      ? 'ограничение работает: сервер отвечает 429'
      : 'ограничение частоты запросов не обнаружено';
  }
  const findings = facts.security.findings || [];
  const rows = findings.length
    ? findings.map((f) => '<tr><td>' + esc(SEV_LABELS[f.severity] || f.severity) + '</td><td>' + esc(f.message) + '</td></tr>').join('\n')
    : '<tr><td colspan="2">Критичных проблем не обнаружено</td></tr>';

  return '<table><tr><th style="width:32%">Параметр</th><th>Значение</th></tr>'
    + '<tr><td>CDN</td><td>' + esc(cdn) + '</td></tr>'
    + '<tr><td>WAF</td><td>' + esc(waf) + '</td></tr>'
    + '<tr><td>Ограничение частоты запросов</td><td>' + esc(rlText) + '</td></tr>'
    + '</table>'
    + '<table><tr><th style="width:140px">Уровень</th><th>Находка</th></tr>' + rows + '</table>';
}

function compareTable(facts) {
  if (!facts.comparison) return '<p>Сравнение с конкурентами не выполнялось.</p>';
  const sites = facts.comparison.sites;
  const head = sites.map((s, i) => '<th class="site">' + (s.role === 'target' ? 'Ваш сайт' : 'Конкурент ' + i)
    + '<span>' + esc(s.label) + '</span></th>').join('');
  const rows = facts.comparison.sectionRows.map((r) => {
    const cells = sites.map((s) => {
      const v = r.values[s.url];
      const cls = s.role === 'target' ? ' class="num target"' : ' class="num"';
      return '<td' + cls + '>' + (v === null || v === undefined ? '—' : esc(v)) + '</td>';
    }).join('');
    const d = r.deltaToBest;
    const dCls = d === null || d === undefined ? '' : d > 0 ? ' class="num delta-bad"' : ' class="num delta-good"';
    const dText = d === null || d === undefined ? '—' : (d > 0 ? '+' : '') + d;
    return '<tr><td>' + esc(r.label) + '</td>' + cells + '<td' + dCls + '>' + dText + '</td></tr>';
  }).join('\n');
  return '<table class="cmp-table"><tr><th>Раздел</th>' + head + '<th>Отставание</th></tr>' + rows + '</table>';
}

/** Сгруппированный bar-график: раздел × сайт. */
async function compareChartPng(facts) {
  if (!facts.comparison) return null;
  const sites = facts.comparison.sites;
  const labels = facts.comparison.sectionRows.map((r) => r.label);
  const datasets = sites.map((s, i) => ({
    label: s.role === 'target' ? 'Ваш сайт' : 'Конкурент ' + i,
    data: facts.comparison.sectionRows.map((r) => {
      const v = r.values[s.url];
      return typeof v === 'number' ? v : 0;
    }),
    backgroundColor: SITE_COLORS[i % SITE_COLORS.length],
    borderWidth: 0,
  }));
  const buffer = await chartCanvas.renderToBuffer({
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: false,
      animation: false,
      scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: 'Оценка, 0-100' } } },
      plugins: { legend: { position: 'bottom', labels: { font: { size: 12 } } } },
    },
  });
  return 'data:image/png;base64,' + buffer.toString('base64');
}

function findingsBlock(facts) {
  const list = facts.findings.slice(0, 40);
  if (!list.length) return '<p>Проблем не обнаружено.</p>';
  const rows = list.map((f) => '<tr>'
    + '<td>' + esc(SEV_LABELS[f.severity] || f.severity) + '</td>'
    + '<td class="sel">' + esc(f.ruleId) + '</td>'
    + '<td>' + esc(SECTION_LABELS[f.section] || f.section) + '</td>'
    + '<td>' + esc(f.message) + '</td>'
    + '</tr>').join('\n');
  return '<table><tr><th style="width:110px">Уровень</th><th style="width:200px">Правило</th><th style="width:130px">Раздел</th><th>Что не так</th></tr>' + rows + '</table>';
}

/**
 * Собрать HTML полного отчёта.
 * @param {object} args
 * @param {object} args.facts — факт-лист (buildFullFacts)
 * @param {object} args.narrative — текст (резюме + план)
 */
function buildFullHtml(args) {
  const { facts, narrative } = args;
  const template = fs.readFileSync(path.join(TEMPLATES_DIR, 'full.html'), 'utf8');
  const styles = fs.readFileSync(path.join(TEMPLATES_DIR, 'styles.css'), 'utf8');

  const score = facts.integralScore;
  const legend = score >= 85
    ? 'Сайт в хорошем состоянии по автоматическим критериям.'
    : score >= 60
      ? 'Есть заметные недочёты; часть из них повторяется на всех страницах сайта.'
      : 'Обнаружены серьёзные проблемы, часть из них затрагивает весь сайт.';

  const sectionCards = Object.entries(facts.sections).map(([name, s]) =>
    '<div class="site-card"><div class="name">' + esc(SECTION_LABELS[name] || name) + '</div>'
    + '<div class="val ' + scoreClass(s.score) + '">' + (s.score === null ? 'н/д' : s.score) + '</div>'
    + '<div class="role">' + s.issues + ' проблем</div></div>').join('\n      ');

  const focus = (narrative.focus || []).map((f) => '<li>' + esc(f) + '</li>').join('\n    ');

  const planRows = (narrative.plan || []).map((p) => '<tr>'
    + '<td class="num">' + esc(p.month) + '</td>'
    + '<td>' + esc(p.title) + '</td>'
    + '<td>' + esc(p.why) + '</td>'
    + '<td>' + esc(p.impact || '') + '</td>'
    + '<td class="num">' + esc(p.effort || '') + '</td>'
    + '</tr>').join('\n');

  const limitations = (narrative.limitations || []).map((l) => '<li>' + esc(l) + '</li>').join('\n    ');

  return template
    .replace('__STYLES__', styles)
    .replace('__URL__', esc(facts.url))
    .replace('__URL_SHORT__', esc(String(facts.url).replace(/^https?:\/\//, '').slice(0, 50)))
    .replace('__DATE_LONG__', esc(fmtDate(facts.date)))
    .replace('__DATE_SHORT__', esc(new Date(facts.date).toLocaleDateString('ru-RU')))
    .replace('__PAGE_COUNT__', String(facts.crawl ? facts.crawl.pageCount : 1))
    .replace('__INTEGRAL_SCORE__', String(score))
    .replace('__SCORE_CLASS__', scoreClass(score))
    .replace('__SCORE_LEGEND__', esc(legend))
    .replace('__SECTION_CARDS__', sectionCards)
    .replace('__SUMMARY__', esc(narrative.summary || ''))
    .replace('__FOCUS__', focus)
    .replace('__PLAN_ROWS__', planRows)
    .replace('__VITALS_ROWS__', vitalsRows(facts.metrics))
    .replace('__AVG_ROWS__', avgRows(facts.crawl ? facts.crawl.avgMetrics : null))
    .replace('__SECTION_ROWS__', sectionRows(facts))
    .replace('__TOP_ISSUES__', topIssuesRows(facts))
    .replace('__WORST_PAGES__', worstPagesRows(facts))
    .replace('__SECURITY__', securityBlock(facts))
    .replace('__COMPARE_TABLE__', compareTable(facts))
    .replace('__COMPARE_CHART__', args.charts && args.charts.compare ? args.charts.compare : '')
    .replace('__FINDINGS__', findingsBlock(facts))
    .replace('__LIMITATIONS__', limitations);
}

/**
 * Сгенерировать полный PDF-отчёт.
 * @param {object} args
 * @param {object} args.facts
 * @param {object} args.narrative
 * @param {string} outPath
 */
async function generateFullPdf(args, outPath) {
  const charts = { compare: await compareChartPng(args.facts) };
  const html = buildFullHtml({ facts: args.facts, narrative: args.narrative, charts });
  return renderPdf(html, outPath);
}

module.exports = { generateFullPdf, buildFullHtml, compareChartPng, SECTION_LABELS };
