/**
 * Краткая выжимка аудита (2 страницы) — то, что прикладывается к сообщению.
 *
 * Полный отчёт продаём отдельно; выжимка показывает компетентность и конкретику,
 * но не отдаёт всю работу: план, полный список находок и все страницы — в полном
 * отчёте.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { renderPdf } = require('./render');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

const SECTION_LABELS = {
  performance: 'Производительность',
  seo: 'SEO',
  security: 'Безопасность',
  accessibility: 'Доступность',
  content: 'Контент',
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

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric' });
}

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

function sectionCards(facts) {
  return Object.entries(facts.sections).map(([name, s]) =>
    '<div class="site-card"><div class="name">' + esc(SECTION_LABELS[name] || name) + '</div>'
    + '<div class="val ' + scoreClass(s.score) + '">' + (s.score === null ? 'н/д' : s.score) + '</div>'
    + '<div class="role">' + s.issues + ' проблем</div></div>').join('\n      ');
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

function planRows(narrative) {
  const plan = (narrative.plan || []).slice(0, 6);
  if (!plan.length) return '<tr><td colspan="4">План формируется после полного аудита</td></tr>';
  return plan.map((p) => '<tr>'
    + '<td class="num">' + esc(p.month) + '</td>'
    + '<td>' + esc(p.title) + '</td>'
    + '<td>' + esc(p.why) + '</td>'
    + '<td class="num">' + esc(p.effort || '') + '</td>'
    + '</tr>').join('\n');
}

/**
 * Собрать HTML выжимки.
 * @param {object} args
 * @param {object} args.facts
 * @param {object} args.narrative
 * @param {object} [args.branding]
 * @param {string} [args.nextStep] — блок «Что дальше»
 */
function buildSummaryHtml(args) {
  const { facts, narrative } = args;
  const b = Object.assign({
    title: 'Анализ сайта',
    client: '',
    executor: 'OWA · One-Click Web Analyzer',
    contacts: '',
    footerLeft: 'Анализ сайта',
  }, args.branding || {});

  const template = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary.html'), 'utf8');
  const styles = fs.readFileSync(path.join(TEMPLATES_DIR, 'styles.css'), 'utf8');

  const score = facts.integralScore;
  const legend = score >= 85
    ? 'Сайт в хорошем состоянии по автоматическим критериям.'
    : score >= 60
      ? 'Есть заметные недочёты, часть повторяется на всех страницах.'
      : 'Обнаружены серьёзные проблемы, часть затрагивает весь сайт.';

  const focus = (narrative.focus || []).map((f) => '<li>' + esc(f) + '</li>').join('\n    ');

  return template
    .replace('__STYLES__', styles)
    .replaceAll('__REPORT_TITLE__', esc(b.title))
    .replace('__CLIENT_LINE__', b.client ? '<div class="date">Заказчик: ' + esc(b.client) + '</div>' : '')
    .replace('__EXECUTOR_LINE__', b.executor
      ? '<div class="date" style="margin-top:6px">Подготовил: ' + esc(b.executor) + (b.contacts ? ' · ' + esc(b.contacts) : '') + '</div>'
      : '')
    .replace('__URL__', esc(facts.url))
    .replace('__DATE_LONG__', esc(fmtDate(facts.date)))
    .replace('__PAGE_COUNT__', String(facts.crawl ? facts.crawl.pageCount : 1))
    .replace('__INTEGRAL_SCORE__', String(score))
    .replace('__SCORE_CLASS__', scoreClass(score))
    .replace('__SCORE_LEGEND__', esc(legend))
    .replace('__SECTION_CARDS__', sectionCards(facts))
    .replace('__FOCUS__', focus)
    .replace('__VITALS_ROWS__', vitalsRows(facts.metrics))
    .replace('__COMPARE_TABLE__', compareTable(facts))
    .replace('__PLAN_ROWS__', planRows(narrative))
    .replace('__NEXT_STEP__', esc(args.nextStep || 'Полный отчёт по всем страницам — с разбивкой находок по частоте, планом работ и критериями приёмки — готовлю по вашему подтверждению.'))
    .replace('__FOOTER_LEFT__', esc(b.footerLeft))
    .replace('__FOOTER_RIGHT__', esc(b.contacts || facts.url));
}

/**
 * Сгенерировать PDF-выжимку.
 * @param {object} args — { facts, narrative, branding, nextStep }
 * @param {string} outPath
 */
async function generateSummaryPdf(args, outPath) {
  const html = buildSummaryHtml(args);
  return renderPdf(html, outPath);
}

module.exports = { generateSummaryPdf, buildSummaryHtml };
