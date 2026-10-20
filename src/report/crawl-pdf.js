/**
 * PDF-отчёт по обходу сайта (crawl): агрегаты по сайту, топ проблем
 * по частоте, таблица страниц, худшие страницы.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { renderPdf } = require('./render');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

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

function aggCards(a) {
  const cards = [
    ['Страниц', a.pageCount, 'ошибок: ' + (a.failedCount || 0)],
    ['Средняя оценка', a.avgScore === null || a.avgScore === undefined ? '—' : a.avgScore, 'по разделам'],
    ['LCP (среднее)', a.avgMetrics ? a.avgMetrics.lcpMs : '—', 'мс'],
    ['TTFB (среднее)', a.avgMetrics ? a.avgMetrics.ttfbMs : '—', 'мс'],
  ];
  return cards.map(([name, value, sub]) => '<div class="site-card">'
    + '<div class="name">' + esc(name) + '</div>'
    + '<div class="val">' + esc(value) + '</div>'
    + '<div class="role">' + esc(sub) + '</div>'
    + '</div>').join('\n      ');
}

function avgRows(a) {
  const m = a.avgMetrics || {};
  const rows = [
    { label: 'LCP (Largest Contentful Paint)', value: m.lcpMs, unit: ' мс', good: 2500, poor: 4000 },
    { label: 'CLS (Cumulative Layout Shift)', value: m.cls, unit: '', good: 0.1, poor: 0.25 },
    { label: 'FCP (First Contentful Paint)', value: m.fcpMs, unit: ' мс', good: 1800, poor: 3000 },
    { label: 'TTFB (Time to First Byte)', value: m.ttfbMs, unit: ' мс', good: 800, poor: 1800 },
    { label: 'TBT (Total Blocking Time)', value: m.tbtMs, unit: ' мс', good: 200, poor: 600 },
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

function topIssuesRows(issues) {
  if (!issues || !issues.length) return '<tr><td colspan="4">Проблем не найдено</td></tr>';
  const labels = { critical: 'критично', warning: 'предупреждение', info: 'инфо' };
  return issues.map((i) => '<tr>'
    + '<td>' + esc(i.rule) + '</td>'
    + '<td>' + esc(labels[i.severity] || i.severity) + '</td>'
    + '<td class="num">' + esc(i.count) + '</td>'
    + '<td style="font-size:8.5pt">' + esc((i.pages || []).slice(0, 4).join(', ')) + '</td>'
    + '</tr>').join('\n');
}

function pageRows(pages) {
  if (!pages || !pages.length) return '<tr><td colspan="6">Страницы не обработаны</td></tr>';
  return pages.map((p) => '<tr>'
    + '<td style="font-size:8.5pt;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.url) + '</td>'
    + '<td class="num"><span class="v ' + scoreClass(p.score) + '">' + (p.score === null ? 'ошибка' : p.score) + '</span></td>'
    + '<td class="num">' + esc(p.scores ? p.scores.performance ?? '—' : '—') + '</td>'
    + '<td class="num">' + esc(p.scores ? p.scores.seo ?? '—' : '—') + '</td>'
    + '<td class="num">' + esc(p.scores ? p.scores.accessibility ?? '—' : '—') + '</td>'
    + '<td class="num">' + esc((p.issues || []).length) + '</td>'
    + '</tr>').join('\n');
}

function worstRows(worst) {
  if (!worst || !worst.length) return '<tr><td colspan="2">Нет данных</td></tr>';
  return worst.map((p) => '<tr>'
    + '<td style="font-size:8.5pt;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.url) + '</td>'
    + '<td class="num">' + esc(p.score) + '</td>'
    + '</tr>').join('\n');
}

/**
 * Собрать HTML отчёта по обходу.
 * @param {object} result — результат crawlSite
 */
function buildCrawlHtml(result) {
  const template = fs.readFileSync(path.join(TEMPLATES_DIR, 'crawl.html'), 'utf8');
  const styles = fs.readFileSync(path.join(TEMPLATES_DIR, 'styles.css'), 'utf8');
  const a = result.aggregate || {};
  const at = result.crawledAt || new Date().toISOString();

  return template
    .replace('__STYLES__', styles)
    .replace('__START_URL__', esc(result.startUrl || ''))
    .replace('__DATE_LONG__', esc(fmtDate(at)))
    .replace('__DATE_SHORT__', esc(new Date(at).toLocaleDateString('ru-RU')))
    // __PAGE_COUNT__ встречается дважды (титул и заголовок таблицы).
    .replaceAll('__PAGE_COUNT__', String(a.pageCount || (result.pages || []).length))
    .replace('__AGG_CARDS__', aggCards(a))
    .replace('__AVG_ROWS__', avgRows(a))
    .replace('__TOP_ISSUES__', topIssuesRows(a.topIssues))
    .replace('__PAGE_ROWS__', pageRows(result.pages))
    .replace('__WORST_ROWS__', worstRows(a.worstPages));
}

/**
 * Сгенерировать PDF по обходу сайта.
 * @param {object} result — результат crawlSite
 * @param {string} outPath
 */
async function generateCrawlPdf(result, outPath) {
  const started = Date.now();
  const html = buildCrawlHtml(result);
  const info = await renderPdf(html, outPath);
  return { ...info, durationMs: Date.now() - started };
}

module.exports = { generateCrawlPdf, buildCrawlHtml };
