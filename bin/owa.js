#!/usr/bin/env node
/**
 * OWA — One-Click Web Analyzer / комплексный аудит сайтов
 *
 * Использование:
 *   node bin/owa.js audit --full <URL>     полный аудит (5 секций) -> JSON
 *   node bin/owa.js report --pdf out.pdf --url <URL>   клиентский PDF
 *   node bin/owa.js crawl <URL>            обход сайта (краулер) -> агрегаты
 *   node bin/owa.js sitemap <URL>/sitemap.xml   разбор sitemap (+обход)
 *   node bin/owa.js <URL> [опции]           performance-анализ (как раньше)
 *
 * Опции performance-режима:
 *   --json                 вывести только машиночитаемый JSON (для ИИ-агентов)
 *   --compact              сверхкомпактный JSON с готовой интерпретацией
 *   --out <файл>           сохранить полный JSON-отчёт в файл
 *   --md <файл>            сохранить Markdown-отчёт
 *   --selector <sel>       селектор виджета (можно несколько раз)
 *   --wait <мс>            ожидание после load (по умолч. 5000)
 *   --timeout <мс>         таймаут навигации (по умолч. 60000)
 *   --headed               запуск с видимым окном браузера
 *   --console              перехватывать console-сообщения страницы
 *   --code                 статический анализ кода (CSS/HTML/JS) в отчёт
 *   --baseline <файл.json> сравнить с сохранённым baseline (exit 1 при регрессиях)
 *   --threshold <N>        порог регрессии в % для --baseline (по умолч. 5)
 *
 * Опции crawl/sitemap:
 *   --max-pages <N>        сколько страниц обойти (по умолч. 10)
 *   --max-depth <N>        глубина обхода (по умолч. 2)
 *   --delay <мс>           пауза между страницами (по умолч. 300)
 *   --ignore-robots        не соблюдать robots.txt
 *   --no-audit             только собрать список URL, без аудита страниц
 */
const fs = require('fs');
const path = require('path');
const { analyze } = require('../src/engine');
const { analyzeCode } = require('../src/static-analyzer');
const { printReport, toMarkdown } = require('../src/report');
const { buildCompact } = require('../src/interpret');
const { diffWithBaseline, printDiff } = require('../src/diff');
const { runFullAudit } = require('../src/audit');
const { printAuditReport } = require('../src/audit/report-text');

function parseArgs(argv) {
  const args = { selectors: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': args.json = true; break;
      case '--compact': args.compact = true; args.json = true; break;
      case '--out': args.out = argv[++i]; break;
      case '--md': args.md = argv[++i]; break;
      case '--pdf': args.pdf = argv[++i]; break;
      case '--url': args.url = argv[++i]; break;
      case '--full': args.full = true; break;
      case '--max-pages': args.maxPages = parseInt(argv[++i], 10); break;
      case '--max-depth': args.maxDepth = parseInt(argv[++i], 10); break;
      case '--delay': args.delay = parseInt(argv[++i], 10); break;
      case '--concurrency': args.concurrency = parseInt(argv[++i], 10); break;
      case '--full': args.full = true; break;
      case '--pages': args.pages = parseInt(argv[++i], 10); break;
      case '--target': args.target = argv[++i]; break;
      case '--with': args.with = argv[++i]; break;
      case '--ai': args.ai = true; break;
      case '--client': args.client = argv[++i]; break;
      case '--ignore-robots': args.ignoreRobots = true; break;
      case '--no-audit': args.noAudit = true; break;
      case '--selector': {
        const sel = argv[++i];
        if (sel === undefined || sel.startsWith('--')) {
          console.error('Опция --selector требует значение (CSS-селектор)');
          process.exit(2);
        }
        args.selectors.push(sel);
        break;
      }
      case '--wait': args.wait = parseInt(argv[++i], 10); break;
      case '--timeout': args.timeout = parseInt(argv[++i], 10); break;
      case '--headed': args.headed = true; break;
      case '--console': args.consoleLogs = true; break;
      case '--code': args.code = true; break;
      case '--baseline': args.baseline = argv[++i]; break;
      case '--threshold': args.threshold = parseFloat(argv[++i]); break;
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

function usage() {
  console.log(`OWA — One-Click Web Analyzer / комплексный аудит сайтов
Использование:
  node bin/owa.js audit --full <URL> [--out audit.json] [--json]
  node bin/owa.js report --pdf <файл.pdf> --url <URL>
  node bin/owa.js compare --target <URL> --with <url1>,<url2> [--pdf файл]
  node bin/owa.js crawl <URL> [--max-pages N] [--max-depth N] [--delay мс]
  node bin/owa.js sitemap <URL>/sitemap.xml [--max-pages N]
  node bin/owa.js <URL> [опции]

Опции:
  --json               только JSON-вывод (для ИИ-агентов)
  --compact            компактный JSON с готовой интерпретацией
  --out <файл>         сохранить полный JSON
  --md <файл>          сохранить Markdown-отчёт
  --pdf <файл>         сохранить PDF-отчёт (report / compare)
  --url <URL>          целевой URL (команда report)
  --target <URL>       сайт клиента (команда compare)
  --with <url1>,<url2> конкуренты через запятую (команда compare)
  --ai                 клиентский текст отчёта через LLM (GLM), с проверкой фактов
  --client <slug>      профиль клиента из clients/<slug>.json (тон, фокус, конкуренты)
  --full               полный аудит (команда audit)
  --max-pages <N>      сколько страниц обойти (crawl/sitemap, по умолч. 10)
  --max-depth <N>      глубина обхода (по умолч. 2)
  --delay <мс>         пауза между страницами (по умолч. 300)
  --ignore-robots      не соблюдать robots.txt
  --no-audit           только собрать URL, без аудита страниц
  --selector <sel>     селектор виджета (повторяемо)
  --wait <мс>          ожидание после load (по умолч. 5000)
  --timeout <мс>       таймаут навигации (по умолч. 60000)
  --headed             видимый браузер
  --console            перехват console-логов страницы
  --code               статический анализ кода (CSS/HTML/JS) в отчёт
  --baseline <файл>    сравнить с сохранённым baseline (exit 1 при регрессиях)
  --threshold <N>      порог регрессии в % (по умолч. 5)`);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

/**
 * Клиентский текст отчёта: LLM (GLM) с проверкой фактов, при отказе —
 * детерминированный шаблон. Без --ai работает только шаблон.
 */
async function buildNarrative(result, args, comparison) {
  const { buildFacts, generateNarrative } = require('../src/ai/report-generator');
  const { loadProfile } = require('../src/ai/client-profile');

  const facts = buildFacts(result, comparison ? { comparison } : {});
  let profile = null;
  if (args.client) {
    try {
      profile = loadProfile(args.client);
      if (!profile) console.error(`Профиль клиента не найден: ${args.client}`);
    } catch (err) {
      console.error(`Профиль клиента: ${err.message}`);
    }
  }

  let ai = null;
  if (args.ai) {
    const { getAi } = require('../src/ai');
    ai = getAi();
    if (!ai.configured) {
      console.error('AI не настроен (AI_API_KEY в .env) — будет использован шаблонный текст');
      ai = null;
    }
  }

  const res = await generateNarrative({
    facts,
    ai,
    profile,
    comparison,
    logger: (m) => console.error('[ai] ' + m),
  });
  return res;
}

// ------------------------------------------------------------ compare
if (command === 'compare') {
  const target = args.target;
  const competitors = String(args.with || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!target || !/^https?:\/\//i.test(target)) {
    console.error('Команда compare требует --target <URL>');
    process.exit(2);
  }
  if (!competitors.length) {
    console.error('Команда compare требует --with <url1>,<url2> (конкуренты через запятую)');
    process.exit(2);
  }

  (async () => {
    try {
      const { compareSites } = require('../src/compare');
      const result = await compareSites(target, competitors, {
        // Пауза между аудитами: чужие сайты не нагружаем.
        delayMs: Number.isFinite(args.delay) ? args.delay : 3000,
        timeout: args.timeout ?? 60000,
        waitAfterLoad: args.wait ?? 2500,
        logger: args.json ? () => {} : (m) => console.error('[compare] ' + m),
      });

      if (args.out) {
        fs.writeFileSync(path.resolve(args.out), JSON.stringify(result, null, 2), 'utf8');
        if (!args.json) console.error(`JSON-отчёт сохранён: ${args.out}`);
      }
      if (args.pdf) {
        const { generateComparePdf } = require('../src/report/compare-pdf');
        const out = path.resolve(args.pdf);
        let narrative = null;
        if (args.ai) {
          const n = await buildNarrative(result, args, result);
          narrative = n.narrative;
          console.error(`Текст сравнения: ${n.source}${n.validation && !n.validation.ok ? ' (проверка фактов: ' + n.validation.errors.join('; ') + ')' : ''}`);
        }
        await generateComparePdf(result, out, { narrative });
        if (!args.json) console.error(`PDF-отчёт сохранён: ${out}`);
      }
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printCompareReport(result);
      }
      process.exit(0);
    } catch (err) {
      if (args.json) {
        console.log(JSON.stringify({ error: String(err && err.message || err) }, null, 2));
      } else {
        console.error(`Ошибка: ${err && err.message || err}`);
      }
      process.exit(2);
    }
  })();
  return;
}

/** Текстовый вывод сравнительного отчёта. */
function printCompareReport(result) {
  const line = '-'.repeat(70);
  console.log(`\n${line}`);
  console.log('  OWA — Сравнительный аудит');
  console.log(`  Ваш сайт: ${result.target.url}`);
  console.log(`  Конкуренты: ${result.competitors.map((c) => c.label).join(', ')}`);
  console.log(line);

  console.log('\n■ Оценки по разделам');
  for (const row of result.sectionRows) {
    const cells = result.sites
      .map((s) => (s.role === 'target' ? 'ВЫ' : s.label).padEnd(18) + String(row.values[s.url] ?? '—').padStart(4));
    const delta = row.deltaToBest === null || row.deltaToBest === undefined ? '—' : String(row.deltaToBest);
    console.log('  ' + row.label.padEnd(20) + cells.join('  ') + '   отставание: ' + delta);
  }

  console.log('\n■ Ключевые метрики');
  for (const row of result.metricRows) {
    const cells = result.sites.map((s) => String(row.values[s.url] ?? '—').padStart(8));
    console.log('  ' + row.label.padEnd(10) + cells.join('  ') + row.unit);
  }

  if (result.conclusions.length) {
    console.log('\n■ Выводы');
    for (const c of result.conclusions) {
      console.log('  [' + (c.severity || 'info') + '] ' + c.text);
    }
  }
  console.log(`\n${line}\n`);
}

// ------------------------------------------------------- crawl / sitemap
if (command === 'crawl' || command === 'sitemap') {
  const target = args._[1];
  if (!target || !/^https?:\/\//i.test(target)) {
    console.error(command === 'sitemap'
      ? 'Использование: owa sitemap <URL>/sitemap.xml'
      : 'Использование: owa crawl <URL>');
    process.exit(2);
  }

  (async () => {
    try {
      const { crawlSite } = require('../src/crawl/crawler');
      const { collectSitemapUrls } = require('../src/crawl/sitemap');

      let seedUrls = [];
      let startUrl = target;
      let sitemapInfo = null;

      if (command === 'sitemap') {
        sitemapInfo = await collectSitemapUrls(target, {
          maxSitemaps: 20,
          maxUrls: Number.isFinite(args.maxPages) ? args.maxPages * 5 : 200,
        });
        if (!sitemapInfo.urls.length) {
          console.error('В sitemap не найдено URL: ' + target);
          process.exit(2);
        }
        seedUrls = sitemapInfo.urls;
        // Стартовая страница — origin сайта, чтобы обход шёл по домену.
        startUrl = new URL(seedUrls[0]).origin + '/';
      }

      if (args.noAudit) {
        const result = {
          schemaVersion: 2,
          tool: 'owa',
          type: command,
          startUrl,
          urls: seedUrls,
          sitemap: sitemapInfo ? { sitemaps: sitemapInfo.sitemaps, truncated: sitemapInfo.truncated } : null,
        };
        if (args.out) {
          fs.writeFileSync(path.resolve(args.out), JSON.stringify(result, null, 2), 'utf8');
        }
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
      }

      const result = await crawlSite(startUrl, {
        maxPages: Number.isFinite(args.maxPages) ? args.maxPages : 10,
        maxDepth: Number.isFinite(args.maxDepth) ? args.maxDepth : 2,
        delayMs: Number.isFinite(args.delay) ? args.delay : 200,
        concurrency: Number.isFinite(args.concurrency) ? args.concurrency : 3,
        respectRobots: !args.ignoreRobots,
        timeout: args.timeout ?? 60000,
        waitAfterLoad: Math.min(args.wait ?? 700, 5000),
        logger: args.json ? () => {} : (m) => console.error('[crawl] ' + m),
      });
      if (sitemapInfo) {
        result.sitemap = { sitemaps: sitemapInfo.sitemaps, truncated: sitemapInfo.truncated, urlCount: sitemapInfo.urls.length };
      }

      if (args.out) {
        fs.writeFileSync(path.resolve(args.out), JSON.stringify(result, null, 2), 'utf8');
        if (!args.json) console.error(`JSON-отчёт сохранён: ${args.out}`);
      }
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printCrawlReport(result);
      }
      process.exit(0);
    } catch (err) {
      if (args.json) {
        console.log(JSON.stringify({ error: String(err && err.message || err) }, null, 2));
      } else {
        console.error(`Ошибка: ${err && err.message || err}`);
      }
      process.exit(2);
    }
  })();
  return;
}

/** Текстовый вывод отчёта по обходу сайта. */
function printCrawlReport(result) {
  const a = result.aggregate || {};
  const line = '-'.repeat(70);
  console.log(`\n${line}`);
  console.log('  OWA — Обход сайта');
  console.log(`  Старт: ${result.startUrl}`);
  console.log(`  Страниц обработано: ${a.pageCount || 0} (ошибок: ${a.failedCount || 0})`);
  console.log(line);

  if (a.avgScore !== null && a.avgScore !== undefined) {
    console.log(`\n■ Средняя оценка по сайту: ${a.avgScore}/100`);
  }
  if (a.avgMetrics) {
    const m = a.avgMetrics;
    const line2 = (label, value, unit) => {
      if (value === null || value === undefined) return;
      console.log('  ' + label.padEnd(16) + value + unit);
    };
    console.log('\n■ Средние метрики');
    line2('LCP', m.lcpMs, ' мс');
    line2('CLS', m.cls, '');
    line2('FCP', m.fcpMs, ' мс');
    line2('TTFB', m.ttfbMs, ' мс');
    line2('TBT', m.tbtMs, ' мс');
    line2('Ресурсов', m.resources, ' шт');
  }

  if (a.topIssues && a.topIssues.length) {
    console.log('\n■ Топ проблем по частоте (сколько страниц затронуто)');
    for (const issue of a.topIssues) {
      console.log(`  [${issue.severity}] ${issue.rule}: ${issue.count} стр. — ${issue.pages.slice(0, 3).join(', ')}`);
    }
  }

  if (a.worstPages && a.worstPages.length) {
    console.log('\n■ Страницы с худшими показателями');
    for (const p of a.worstPages) {
      console.log(`  ${String(p.score).padStart(3)}/100  ${p.url}`);
    }
  }
  console.log(`\n${line}\n`);
}

// ------------------------------------------------------------ audit / report
if (command === 'audit' || command === 'report') {
  const url = command === 'report' ? args.url : args._[1];
  if (!url || !/^https?:\/\//i.test(url)) {
    console.error(command === 'report'
      ? 'Команда report требует --url <URL>'
      : 'Использование: owa audit --full <URL>');
    process.exit(2);
  }
  if (command === 'audit' && !args.full) {
    console.error('Команда audit требует флаг --full');
    process.exit(2);
  }

  (async () => {
    try {
      if (command === 'audit') {
        const result = await runFullAudit(url, {
          timeout: args.timeout ?? 60000,
          waitAfterLoad: args.wait ?? 2500,
          logger: args.json ? () => {} : (m) => console.error(`[audit] ${m}`),
        });
        if (args.out) {
          fs.writeFileSync(path.resolve(args.out), JSON.stringify(result, null, 2), 'utf8');
          if (!args.json) console.error(`JSON-отчёт сохранён: ${args.out}`);
        }
        if (args.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printAuditReport(result);
        }
        process.exit(0);
      }

      // report --pdf
      const { generatePdfReport } = require('../src/report/pdf');

      if (args.full) {
        // Полный отчёт: аудит + обход + безопасность + сравнение + план.
        const { runFullAudit } = require('../src/audit');
        const { crawlSite } = require('../src/crawl/crawler');
        const { compareSites } = require('../src/compare');
        const { buildFullFacts, generateFullNarrative } = require('../src/ai/full-narrative');
        const { generateFullPdf } = require('../src/report/full-pdf');

        const audit = await runFullAudit(url, {
          timeout: args.timeout ?? 60000,
          waitAfterLoad: args.wait ?? 2500,
        });

        const crawl = args.pages === 0 ? null : await crawlSite(url, {
          maxPages: args.pages ?? 40,
          maxDepth: args.maxDepth ?? 3,
          delayMs: args.delay ?? 250,
          concurrency: args.concurrency ?? 3,
          respectRobots: !args.ignoreRobots,
        });

        let scan = null;
        try {
          const { scanDos } = require('../local/dos-scan');
          scan = await scanDos(url, { delayMs: 150, concurrency: 4 });
        } catch (e) {
          console.error('Сканер безопасности недоступен (локальный модуль не установлен) — раздел «Безопасность» будет сокращённым');
        }

        let compare = null;
        if (args.with) {
          const competitors = String(args.with).split(',').map((s) => s.trim()).filter(Boolean);
          if (competitors.length) {
            compare = await compareSites(url, competitors, {
              delayMs: Math.max(3000, args.delay ?? 0),
              timeout: args.timeout ?? 60000,
            });
          }
        }

        const facts = buildFullFacts({ audit, crawl, scan, compare });
        const ai = args.ai ? require('../src/ai').getAi() : null;
        const narrativeRes = await generateFullNarrative({
          facts,
          ai: ai && ai.configured ? ai : null,
          profile: args.client ? require('../src/ai/client-profile').loadProfile(args.client) : null,
          logger: (m) => console.error('[ai] ' + m),
        });

        const out = path.resolve(args.pdf || 'owa-full-report.pdf');
        await generateFullPdf({ facts, narrative: narrativeRes.narrative }, out);
        console.error(`Полный отчёт сохранён: ${out}`);
        console.error(`Текст: ${narrativeRes.source}`);
        if (args.out) {
          fs.writeFileSync(path.resolve(args.out), JSON.stringify({ facts, narrative: narrativeRes.narrative }, null, 2), 'utf8');
          console.error(`JSON сохранён: ${args.out}`);
        }
        process.exit(0);
      }

      const result = await runFullAudit(url, {
        timeout: args.timeout ?? 60000,
        waitAfterLoad: args.wait ?? 2500,
      });
      const narrative = await buildNarrative(result, args, null);
      const out = path.resolve(args.pdf || 'owa-report.pdf');
      await generatePdfReport(result, out, { narrative: narrative.narrative });
      console.error(`PDF-отчёт сохранён: ${out}`);
      if (narrative.source) {
        console.error(`Текст отчёта: ${narrative.source}${narrative.validation && !narrative.validation.ok ? ' (проверка фактов: ' + narrative.validation.errors.join('; ') + ')' : ''}`);
      }
      process.exit(0);
    } catch (err) {
      if (args.json) {
        console.log(JSON.stringify({ error: String(err && err.message || err) }, null, 2));
      } else {
        console.error(`Ошибка: ${err && err.message || err}`);
      }
      process.exit(2);
    }
  })();
  return;
}

// ------------------------------------------------- performance-режим (как раньше)
if (args.help || args._.length === 0) {
  usage();
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
      waitAfterLoad: args.wait ?? 5000,
      timeout: args.timeout ?? 60000,
      widgetSelectors: args.selectors.length ? args.selectors : null,
      headless: !args.headed,
      consoleLogs: !!args.consoleLogs,
    });

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

    let hasRegression = false;
    let diff = null;
    let thresholdPct = Number.isFinite(args.threshold) ? args.threshold : 5;
    if (args.baseline) {
      let baseline;
      try {
        baseline = JSON.parse(fs.readFileSync(path.resolve(args.baseline), 'utf8'));
      } catch (err) {
        console.error(`Не удалось прочитать baseline: ${err.message}`);
        process.exit(2);
      }
      diff = diffWithBaseline(data, baseline, thresholdPct);
      hasRegression = diff.regressions > 0;
    }

    if (args.json) {
      const report = args.compact ? buildCompact(data) : data;
      if (diff) report.diff = diff;
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(data);
      const s = data.interpretation.summary;
      console.log(`Итог: ${s.headline} (оценка ${s.score}/100)`);
      if (diff) printDiff(diff, { thresholdPct });
    }

    const m = data.metrics;
    const bad =
      (m.legacyTiming && m.legacyTiming.loadTime > 5000) ||
      (m.longTasks && m.longTasks.count > 5) ||
      (m.vitals.lcpMs !== null && m.vitals.lcpMs > 4000) ||
      (codeResult && codeResult.findings.some((f) => f.severity === 'error'));
    process.exit(hasRegression || bad ? 1 : 0);
  } catch (err) {
    if (args.json) {
      console.log(JSON.stringify({ error: String(err && err.message || err) }, null, 2));
    } else {
      console.error(`Ошибка: ${err.message}`);
    }
    process.exit(2);
  }
})();