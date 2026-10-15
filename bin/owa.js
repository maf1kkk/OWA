#!/usr/bin/env node
/**
 * OWA — One-Click Web Analyzer
 * Автоматический сбор метрик производительности веб-приложений по URL.
 *
 * Использование:
 *   node bin/owa.js <URL> [опции]
 *
 * Опции:
 *   --json                 вывести только машиночитаемый JSON (для ИИ-агентов)
 *   --compact              сверхкомпактный JSON с готовой интерпретацией (минимум токенов)
 *   --out <файл>           сохранить полный JSON-отчёт в файл
 *   --md <файл>            сохранить Markdown-отчёт (для лабораторной)
 *   --selector <sel>       селектор виджета для пользовательской метрики (можно несколько раз)
 *   --wait <мс>            ожидание после load (по умолч. 5000)
 *   --timeout <мс>         таймаут навигации (по умолч. 60000)
 *   --headed               запуск с видимым окном браузера
 *   --console              перехватывать console-сообщения страницы
 *   --code                 статический анализ кода (CSS/HTML/JS) в отчёт
 */
const fs = require('fs');
const path = require('path');
const { analyze } = require('../src/engine');
const { analyzeCode } = require('../src/static-analyzer');
const { printReport, toMarkdown } = require('../src/report');
const { buildCompact } = require('../src/interpret');

function parseArgs(argv) {
  const args = { selectors: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': args.json = true; break;
      case '--compact': args.compact = true; args.json = true; break;
      case '--out': args.out = argv[++i]; break;
      case '--md': args.md = argv[++i]; break;
      case '--selector': args.selectors.push(argv[++i]); break;
      case '--wait': args.wait = parseInt(argv[++i], 10); break;
      case '--timeout': args.timeout = parseInt(argv[++i], 10); break;
      case '--headed': args.headed = true; break;
      case '--console': args.consoleLogs = true; break;
      case '--code': args.code = true; break;
      case '--help':
      case '-h':
        args.help = true; break;
      default:
        if (a.startsWith('--')) { console.error(`Неизвестная опция: ${a}`); process.exit(2); }
        args._.push(a);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args._.length === 0) {
  console.log(`OWA — One-Click Web Analyzer
Использование: node bin/owa.js <URL> [опции]
Опции:
  --json               только JSON-вывод (для ИИ-агентов)
  --compact            компактный JSON с готовой интерпретацией (минимум токенов)
  --out <файл>         сохранить полный JSON
  --md <файл>          сохранить Markdown-отчёт
  --selector <sel>     селектор виджета (повторяемо)
  --wait <мс>          ожидание после load (по умолч. 5000)
  --timeout <мс>       таймаут навигации (по умолч. 60000)
  --headed             видимый браузер
  --console            перехват console-логов страницы
  --code               статический анализ кода (CSS/HTML/JS) в отчёт`);
  process.exit(0);
}

const url = args._[0];
if (!/^https?:\/\//i.test(url)) {
  console.error('URL должен начинаться с http:// или https://');
  process.exit(2);
}

(async () => {
  try {
    const data = await analyze(url, {
      waitAfterLoad: args.wait || 5000,
      timeout: args.timeout || 60000,
      widgetSelectors: args.selectors.length ? args.selectors : null,
      headless: !args.headed,
      consoleLogs: !!args.consoleLogs,
    });

    // Статический анализ кода (по флагу --code): не ломает основной отчёт,
    // при сбое только предупреждает в stderr.
    let codeResult = null;
    if (args.code) {
      try {
        codeResult = await analyzeCode(url, { waitMs: 1000, timeout: args.timeout || 60000 });
        data.codeFindings = codeResult.findings;
        data.codeSummary = codeResult.summary;
        data.codeTruncated = codeResult.truncated;
      } catch (err) {
        console.error(`Статический анализ кода не выполнен: ${err.message || err}`);
      }
    }

    if (args.out) {
      fs.writeFileSync(path.resolve(args.out), JSON.stringify(data, null, 2), 'utf8');
      if (!args.json) console.error(`JSON-отчёт сохранён: ${args.out}`);
    }
    if (args.md) {
      fs.writeFileSync(path.resolve(args.md), toMarkdown(data), 'utf8');
      if (!args.json) console.error(`Markdown-отчёт сохранён: ${args.md}`);
    }

    if (args.json) {
      console.log(JSON.stringify(args.compact ? buildCompact(data) : data, null, 2));
    } else {
      printReport(data);
      const s = data.interpretation.summary;
      console.log(`Итог: ${s.headline} (оценка ${s.score}/100)`);
    }

    // Exit-код для ИИ-агентов: 0 = ок, 1 = есть серьёзные проблемы
    const m = data.metrics;
    const bad =
      (m.legacyTiming && m.legacyTiming.loadTime > 5000) ||
      (m.longTasks && m.longTasks.count > 5) ||
      (m.vitals.lcpMs !== null && m.vitals.lcpMs > 4000) ||
      (codeResult && codeResult.findings.some((f) => f.severity === 'error'));
    process.exit(bad ? 1 : 0);
  } catch (err) {
    if (args.json) {
      console.log(JSON.stringify({ error: String(err && err.message || err) }, null, 2));
    } else {
      console.error(`Ошибка: ${err.message}`);
    }
    process.exit(2);
  }
})();
