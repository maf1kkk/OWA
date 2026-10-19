/**
 * Comparative-PDF: клиент против конкурентов (модуль 5).
 *
 * Как и обычный отчёт, графики рендерятся заранее в PNG (chartjs-node-canvas)
 * и вставляются как data-URI — JS внутри page.pdf() не выполняется.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const { Chart, registerables } = require('chart.js');
const { launchBrowser } = require('../browser');

/** Только слово: 1 балл / 2 балла / 5 баллов (число печатается отдельно). */
function pluralBalls(count) {
  const n = Math.abs(Math.round(count));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'балл';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'балла';
  return 'баллов';
}

Chart.register(...registerables);

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');
const MAX_PDF_BYTES = 10 * 1024 * 1024;

const SITE_COLORS = ['#3b82f6', '#c0392b', '#b7791f', '#1a7f37', '#6b7280', '#a371f7'];

const chartCanvas = new ChartJSNodeCanvas({ width: 900, height: 420, backgroundColour: 'white' });

async function renderChartPng(config) {
  const buffer = await chartCanvas.renderToBuffer(config);
  return 'data:image/png;base64,' + buffer.toString('base64');
}

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

/** Карточки сайтов: цели и конкурентов. */
function siteCards(result) {
  return result.sites.map((site, i) => {
    const isTarget = site.role === 'target';
    const value = site.avgSectionScore === null ? 'n/a' : site.avgSectionScore;
    return '<div class="site-card' + (isTarget ? ' target' : '') + '">'
      + '<div class="role">' + (isTarget ? 'Ваш сайт' : 'Конкурент ' + i) + '</div>'
      + '<div class="name">' + esc(site.label) + '</div>'
      + '<div class="val ' + scoreClass(site.avgSectionScore) + '">' + esc(value) + '</div>'
      + '</div>';
  }).join('\n      ');
}

function siteHeaders(result) {
  return result.sites.map((site, i) =>
    '<th style="text-align:right">' + (site.role === 'target' ? 'Ваш сайт' : 'Конкурент ' + i) + '<br><span style="font-weight:400;text-transform:none">' + esc(site.label) + '</span></th>'
  ).join('');
}

function sectionRows(result) {
  return result.sectionRows.map((row) => {
    const cells = result.sites.map((site) => {
      const value = row.values[site.url];
      const isTarget = site.role === 'target';
      return '<td class="num' + (isTarget ? ' target-cell' : '') + '">' + (value === null || value === undefined ? '—' : esc(value)) + '</td>';
    }).join('');
    const delta = row.deltaToBest;
    const lead = row.best ? result.sites.find((s) => s.url === row.best) : null;
    const leadName = lead ? (lead.role === 'target' ? 'вы' : lead.label) : '—';
    const deltaText = delta === null || delta === undefined
      ? '—'
      : (delta > 0 ? '+' : '') + esc(delta) + ' ' + pluralBalls(delta) + '.';
    return '<tr>'
      + '<td>' + esc(row.label) + '</td>'
      + cells
      + '<td>' + esc(leadName) + '</td>'
      + '<td class="num">' + deltaText + '</td>'
      + '</tr>';
  }).join('\n');
}

function metricRows(result) {
  return result.metricRows.map((row) => {
    const cells = result.sites.map((site) => {
      const value = row.values[site.url];
      const isTarget = site.role === 'target';
      return '<td class="num' + (isTarget ? ' target-cell' : '') + '">'
        + (value === null || value === undefined ? '—' : esc(value) + esc(row.unit))
        + '</td>';
    }).join('');
    const lead = row.best ? result.sites.find((s) => s.url === row.best) : null;
    const leadName = lead ? (lead.role === 'target' ? 'вы' : lead.label) : '—';
    return '<tr>'
      + '<td>' + esc(row.label) + '</td>'
      + cells
      + '<td>' + esc(leadName) + (row.bestValue === null || row.bestValue === undefined ? '' : ' (' + esc(row.bestValue) + esc(row.unit) + ')') + '</td>'
      + '</tr>';
  }).join('\n');
}

function conclusions(result) {
  if (!result.conclusions.length) return '<p>Выводов нет — все показатели сопоставимы.</p>';
  return result.conclusions
    .map((c) => '<div class="conclusion ' + esc(c.severity || 'info') + '">' + esc(c.text) + '</div>')
    .join('\n');
}

/** Сгруппированный bar-график: секции по X, сайты по датасетам. */
async function barsChartPng(result) {
  const labels = result.sectionRows.map((r) => r.label);
  const datasets = result.sites.map((site, i) => ({
    label: site.role === 'target' ? 'Ваш сайт' : 'Конкурент ' + i,
    data: result.sectionRows.map((r) => {
      const v = r.values[site.url];
      return typeof v === 'number' ? v : 0;
    }),
    backgroundColor: SITE_COLORS[i % SITE_COLORS.length],
    borderWidth: 0,
  }));

  return renderChartPng({
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: false,
      animation: false,
      scales: {
        y: { beginAtZero: true, max: 100, title: { display: true, text: 'Оценка, 0-100' } },
        x: { ticks: { font: { size: 12 } } },
      },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 12 } } },
        title: { display: true, text: 'Оценки по разделам аудита', font: { size: 15 } },
      },
    },
  });
}

/** Bar-график ключевых метрик (LCP/TTFB) по сайтам. */
async function metricsChartPng(result) {
  const rows = result.metricRows.filter((r) => r.key === 'lcpMs' || r.key === 'ttfbMs');
  const labels = rows.map((r) => r.label);
  const datasets = result.sites.map((site, i) => ({
    label: site.role === 'target' ? 'Ваш сайт' : 'Конкурент ' + i,
    data: rows.map((r) => {
      const v = r.values[site.url];
      return typeof v === 'number' ? v : 0;
    }),
    backgroundColor: SITE_COLORS[i % SITE_COLORS.length],
    borderWidth: 0,
  }));

  return renderChartPng({
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: false,
      animation: false,
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'мс (меньше — лучше)' } },
        x: { ticks: { font: { size: 12 } } },
      },
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 12 } } },
        title: { display: true, text: 'LCP и TTFB по сайтам', font: { size: 15 } },
      },
    },
  });
}

/** Собрать HTML сравнительного отчёта. */
function buildCompareHtml(result, charts, opts = {}) {
  const template = fs.readFileSync(path.join(TEMPLATES_DIR, 'compare.html'), 'utf8');
  const styles = fs.readFileSync(path.join(TEMPLATES_DIR, 'styles.css'), 'utf8');
  const competitors = result.competitors.map((c) => c.url).join(',');

  const narrative = opts.narrative;
  let nSummary = '';
  let nPlan = '';
  if (narrative) {
    if (narrative.summary) nSummary = '<p>' + esc(narrative.summary) + '</p>';
    if (Array.isArray(narrative.focus) && narrative.focus.length) {
      nSummary += '<ul style="margin:0 0 8px 18px">';
      for (const f of narrative.focus) nSummary += '<li>' + esc(f) + '</li>';
      nSummary += '</ul>';
    }
    if (Array.isArray(narrative.plan) && narrative.plan.length) {
      nPlan = '<h3 style="font-size:11pt;margin-top:12px">План работ</h3><table>'
        + '<tr><th style="width:40%">Что сделать</th><th>Зачем</th><th style="width:60px">Трудоёмкость</th></tr>';
      for (const p of narrative.plan) {
        nPlan += '<tr><td>' + esc(p.title) + '</td><td>' + esc(p.why) + '</td><td class="num">' + esc(p.effort || '') + '</td></tr>';
      }
      nPlan += '</table>';
    }
  }

  return template
    .replace('__STYLES__', styles)
    .replace('__DATE_SHORT__', esc(new Date(result.createdAt).toLocaleDateString('ru-RU')))
    .replaceAll('__TARGET_URL__', esc(result.target.url))
    .replace('__DATE_LONG__', esc(fmtDate(result.createdAt)))
    .replace('__COMPETITOR_COUNT__', String(result.competitors.length))
    .replaceAll('__COMPETITORS__', esc(competitors))
    .replace('__SITE_CARDS__', siteCards(result))
    .replaceAll('__SITE_HEADERS__', siteHeaders(result))
    .replace('__SECTION_ROWS__', sectionRows(result))
    .replace('__METRIC_ROWS__', metricRows(result))
    .replace('__BARS_CHART__', charts.bars)
    .replace('__METRICS_CHART__', charts.metrics)
    .replace('__NARRATIVE_SUMMARY__', nSummary)
    .replace('__NARRATIVE_PLAN__', nPlan)
    .replace('__CONCLUSIONS__', conclusions(result));
}

/**
 * Сгенерировать comparative-PDF.
 * @param {object} result — результат compareSites
 * @param {string} outPath
 * @param {object} [opts]
 * @param {object} [opts.narrative] — клиентский текст (AI или детерминированный)
 * @returns {Promise<{path: string, bytes: number, durationMs: number}>}
 */
async function generateComparePdf(result, outPath, opts = {}) {
  const started = Date.now();
  const charts = {
    bars: await barsChartPng(result),
    metrics: await metricsChartPng(result),
  };
  const html = buildCompareHtml(result, charts, opts);

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

module.exports = { generateComparePdf, buildCompareHtml, barsChartPng, metricsChartPng };