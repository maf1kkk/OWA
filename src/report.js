/**
 * Форматирование отчёта в консоль (человекочитаемый вид) и в Markdown.
 */

function ms(v) {
  if (v === null || v === undefined) return '—';
  return `${v} мс`;
}

function kb(bytes) {
  if (!bytes) return '0 КБ';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1048576).toFixed(2)} МБ`;
}

function rate(name, value, good, poor, unit = 'мс', invert = false) {
  // invert=false: меньше — лучше. invert=true: больше — лучше.
  let verdict;
  if (value === null || value === undefined) verdict = 'нет данных';
  else if (invert ? value >= good : value <= good) verdict = '✅ хорошо';
  else if (invert ? value >= poor : value <= poor) verdict = '🟡 средне';
  else verdict = '🔴 плохо';
  return `${name}: ${value ?? '—'} ${unit} — ${verdict}`;
}

function printReport(data) {
  const m = data.metrics;
  const line = '─'.repeat(70);

  console.log(`\n${line}`);
  console.log(`  OWA — Отчёт о производительности`);
  console.log(`  URL: ${data.meta.url}`);
  console.log(`  Время анализа: ${data.meta.analyzedAt}`);
  console.log(line);

  console.log('\n■ Общая загрузка (Performance API)');
  console.log(`  ${rate('Полная загрузка (load)', m.legacyTiming?.loadTime, 2000, 5000)}`);
  console.log(`  ${rate('DOMContentLoaded', m.legacyTiming?.domContentLoaded, 1000, 3000)}`);
  if (m.paint.firstPaint !== null) console.log(`  ${rate('First Paint', Math.round(m.paint.firstPaint), 1000, 3000)}`);
  if (m.paint.firstContentfulPaint !== null) console.log(`  ${rate('FCP', Math.round(m.paint.firstContentfulPaint), 1800, 3000)}`);
  if (m.vitals.lcpMs !== null) console.log(`  ${rate('LCP (Core Web Vital)', m.vitals.lcpMs, 2500, 4000)}`);
  if (m.vitals.cls !== null) console.log(`  ${rate('CLS (Core Web Vital)', m.vitals.cls, 0.1, 0.25, '')}`);

  console.log('\n■ Фазы навигации');
  if (m.navigation) {
    const n = m.navigation;
    console.log(`  DNS:            ${ms(n.dns)}`);
    console.log(`  TCP:            ${ms(n.tcp)}`);
    console.log(`  SSL:            ${ms(n.ssl)}`);
    console.log(`  TTFB:           ${ms(n.ttfb)}`);
    console.log(`  DOM interactive:${ms(Math.round(n.domInteractive))}`);
    console.log(`  DOM complete:   ${ms(Math.round(n.domComplete))}`);
    console.log(`  Тип перехода:   ${n.type}, редиректов: ${n.redirectCount}`);
  } else {
    console.log('  Нет данных navigation entry');
  }

  console.log('\n■ Ресурсы');
  console.log(`  Всего ресурсов: ${m.resources.count}`);
  for (const [type, stat] of Object.entries(m.resources.byType)) {
    console.log(`   · ${type}: ${stat.count} шт, ${kb(stat.totalTransferSize)}, сред. ${Math.round(stat.totalDuration / stat.count)} мс`);
  }
  console.log('\n  Топ-5 самых тяжёлых:');
  for (const r of m.resources.top5Heaviest) {
    console.log(`   · [${r.type}] ${kb(r.size)} — ${shorten(r.name)}`);
  }
  console.log('\n  Топ-10 самых медленных:');
  for (const r of m.resources.top10Slowest) {
    console.log(`   · ${r.duration} мс — ${shorten(r.name)}`);
  }

  console.log('\n■ Долгие задачи (Long Tasks > 50 мс)');
  if (!m.longTasks.supported) {
    console.log('  PerformanceObserver longtask не поддерживается этим браузером');
  } else if (m.longTasks.count === 0) {
    console.log('  ✅ Долгих задач не обнаружено');
  } else {
    console.log(`  Количество:      ${m.longTasks.count}`);
    console.log(`  Макс. длительность: ${m.longTasks.maxDuration} мс`);
    console.log(`  Total Blocking Time (оценка): ${Math.round(m.longTasks.totalBlockingTime)} мс`);
    const sources = new Map();
    for (const t of m.longTasks.tasks) {
      for (const a of t.attribution) {
        const key = a.containerSrc || a.containerName || a.containerId || a.name || 'unknown';
        sources.set(key, (sources.get(key) || 0) + 1);
      }
    }
    if (sources.size) {
      console.log('  Источники (attribution):');
      for (const [src, cnt] of sources) console.log(`   · ${cnt}x — ${shorten(src)}`);
    }
  }

  console.log('\n■ Пользовательские метрики (время до появления виджетов)');
  console.log(`  ${m.customWidgets.note}`);
  for (const [sel, t] of Object.entries(m.customWidgets.results)) {
    const tag = m.customWidgets.autoDetectedSelectors.includes(sel) ? ' [авто]' : '';
    console.log(`  · ${sel}${tag}: ${t === null ? 'не найден' : ms(t)}`);
  }

  if (m.jsErrors && m.jsErrors.length) {
    console.log('\n■ JS-ошибки на странице');
    for (const e of m.jsErrors.slice(0, 10)) {
      console.log(`  · ${e.message} (${shorten(e.source || '')}:${e.line})`);
    }
  }

  if (m.memory) {
    console.log('\n■ Память (Chrome)');
    console.log(`  JS Heap: ${m.memory.usedJSHeapSizeMB} / ${m.memory.totalJSHeapSizeMB} МБ (лимит ${m.memory.jsHeapSizeLimitMB} МБ)`);
  }

  if (Array.isArray(data.codeFindings) && data.codeFindings.length) {
    const icons = { bad: '🔴', warn: '🟡', info: 'ℹ️' };
    console.log('\n■ Статический анализ кода');
    for (const f of data.codeFindings.slice(0, 30)) {
      const where = f.location ? ` — ${f.location}` : '';
      console.log(`  ${icons[f.verdict] || '·'} ${f.message}${where}`);
      if (f.recommendation) console.log(`     → ${f.recommendation}`);
    }
    if (data.codeFindings.length > 30) {
      console.log(`  ... и ещё ${data.codeFindings.length - 30} находок`);
    }
    if (data.codeSummary) {
      console.log(`  Итог статанализа: ${data.codeSummary.headline} (оценка ${data.codeSummary.score}/100)`);
    }
    if (Array.isArray(data.codeTruncated) && data.codeTruncated.length) {
      console.log(`  Не проанализировано (лимиты): ${data.codeTruncated.length} файл(ов)`);
    }
  }

  console.log(`\n${line}\n`);
}

function shorten(s, max = 80) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function toMarkdown(data) {
  const m = data.metrics;
  const rows = [];
  rows.push('| Метрика | Значение |');
  rows.push('|---|---|');
  rows.push(`| Полная загрузка | ${ms(m.legacyTiming?.loadTime)} |`);
  rows.push(`| DOMContentLoaded | ${ms(m.legacyTiming?.domContentLoaded)} |`);
  rows.push(`| First Paint | ${m.paint.firstPaint !== null ? ms(Math.round(m.paint.firstPaint)) : '—'} |`);
  rows.push(`| FCP | ${m.paint.firstContentfulPaint !== null ? ms(Math.round(m.paint.firstContentfulPaint)) : '—'} |`);
  rows.push(`| LCP | ${m.vitals.lcpMs !== null ? ms(m.vitals.lcpMs) : '—'} |`);
  rows.push(`| CLS | ${m.vitals.cls ?? '—'} |`);
  rows.push(`| Всего ресурсов | ${m.resources.count} |`);
  rows.push(`| Долгих задач | ${m.longTasks.count} |`);
  rows.push(`| Макс. длительность задачи | ${ms(m.longTasks.maxDuration)} |`);
  rows.push(`| Total Blocking Time (оценка) | ${ms(Math.round(m.longTasks.totalBlockingTime))} |`);

  let md = `# OWA отчёт — ${data.meta.url}\n\nДата: ${data.meta.analyzedAt}\n\n${rows.join('\n')}\n`;

  md += `\n## Фазы навигации\n\n| Фаза | Время |\n|---|---|\n`;
  if (m.navigation) {
    const n = m.navigation;
    md += `| DNS | ${ms(n.dns)} |\n| TCP | ${ms(n.tcp)} |\n| SSL | ${ms(n.ssl)} |\n| TTFB | ${ms(n.ttfb)} |\n| DOM interactive | ${ms(Math.round(n.domInteractive))} |\n| DOM complete | ${ms(Math.round(n.domComplete))} |\n`;
  }

  md += `\n## Виджеты (пользовательские метрики)\n\n| Селектор | Время появления |\n|---|---|\n`;
  for (const [sel, t] of Object.entries(m.customWidgets.results)) {
    md += `| \`${sel}\` | ${t === null ? 'не найден' : ms(t)} |\n`;
  }

  if (m.jsErrors && m.jsErrors.length) {
    md += `\n## JS-ошибки\n\n`;
    for (const e of m.jsErrors.slice(0, 20)) md += `- ${e.message} (${e.source}:${e.line})\n`;
  }

  if (Array.isArray(data.codeFindings) && data.codeFindings.length) {
    md += `\n## Статический анализ кода\n\n`;
    md += `| Уровень | Правило | Где | Что | Рекомендация |\n|---|---|---|---|---|\n`;
    for (const f of data.codeFindings) {
      md += `| ${escapePipe(f.severity || f.verdict)} | ${escapePipe(f.rule || f.id)} | ${escapePipe(f.location || '—')} | ${escapePipe(f.message)} | ${escapePipe(f.recommendation || f.suggestion || '—')} |\n`;
    }
    if (data.codeSummary) {
      md += `\nИтог: ${data.codeSummary.headline} (оценка ${data.codeSummary.score}/100)\n`;
    }
  }

  return md;
}

function escapePipe(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

module.exports = { printReport, toMarkdown };
