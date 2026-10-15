const { launchBrowser } = require('./browser');
const perf = require('./collectors/performance');
const longtasks = require('./collectors/longtasks');
const widget = require('./collectors/widget');
const vitals = require('./collectors/vitals');
const { buildFindings, buildSummary } = require('./interpret');

const DEFAULT_WIDGET_SELECTORS = [
  '#match-widget',
  '#scoreboard',
  '.live-stats',
  '.chat',
  '#chat',
  '[class*="scoreboard"]',
  '[class*="live"]',
];

async function analyze(url, options = {}) {
  const {
    waitAfterLoad = 5000,       // мс ожидания после load (для динамики/виджетов)
    widgetSelectors = null,     // null => дефолтные + авто-детект
    headless = true,
    timeout = 60000,
    consoleLogs = false,
  } = options;

  // Копия, а не ссылка: ниже массив мутируется авто-детектом, менять
  // модульную константу нельзя — иначе он растёт на каждом вызове.
  const selectors = [...(widgetSelectors && widgetSelectors.length
    ? widgetSelectors
    : DEFAULT_WIDGET_SELECTORS)];

  const browser = await launchBrowser(headless);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  try {
    // Скрипты ДО навигации
    await context.addInitScript(longtasks.initScript);
    await context.addInitScript(vitals.initScript);
    await context.addInitScript(widget.initScript(selectors));

    const page = await context.newPage();
    const consoleMessages = [];
    if (consoleLogs) {
      page.on('console', (m) => consoleMessages.push({ type: m.type(), text: m.text() }));
    }

    const startedAt = new Date().toISOString();
    await page.goto(url, { waitUntil: 'load', timeout });
    await page.waitForTimeout(clampWait(waitAfterLoad));

    // Авто-детект динамических виджетов, если пользователь не задал селекторы
    let autoDetected = null;
    if (!widgetSelectors || !widgetSelectors.length) {
      autoDetected = await page.evaluate(() => {
        const found = [];
        const candidates = document.querySelectorAll('[id], [class]');
        const dynamicHints = /widget|score|chat|live|stream|match|table|feed|banner|player/i;
        for (const el of candidates) {
          if (found.length >= 8) break;
          const sig = (el.id ? '#' + el.id : '') || (el.classList.length ? '.' + el.classList[0] : '');
          if (sig && dynamicHints.test(sig)) found.push(sig);
        }
        return [...new Set(found)];
      });
      for (const sel of autoDetected) {
        if (!selectors.includes(sel)) selectors.push(sel);
      }
    }

    // Замер виджетов: приоритет у данных init-скрипта (реальный момент появления),
    // финальный замер — только для селекторов, которые init-скрипт не отследил
    const widgetResults = await page.evaluate(`
      (function () {
        const sels = ${JSON.stringify(selectors)};
        const init = window.__owaWidgetResults || {};
        const res = {};
        for (const s of sels) {
          if (init[s] !== undefined && init[s] !== null) { res[s] = init[s]; continue; }
          try { res[s] = document.querySelector(s) ? Math.round(performance.now()) : null; }
          catch (e) { res[s] = null; }
        }
        return res;
      })()
    `);

    const perfData = await page.evaluate(perf.collectScript);
    const longTaskData = await page.evaluate(longtasks.collectScript);
    const vitalsData = await page.evaluate(vitals.collectScript);

    const metrics = {
      legacyTiming: perfData.legacy,
        navigation: perfData.navigation,
        paint: perfData.paint,
        vitals: {
          lcpMs: vitalsData.vitals ? vitalsData.vitals.lcp : null,
          cls: vitalsData.vitals ? Math.round(vitalsData.vitals.cls * 1000) / 1000 : null,
        },
        resources: perfData.resources,
        longTasks: longTaskData,
        customWidgets: {
          note: 'Время (мс от начала навигации) до появления элемента. null = не найден за время наблюдения.',
          autoDetectedSelectors: autoDetected || [],
          results: widgetResults,
        },
        jsErrors: vitalsData.jsErrors,
        memory: vitalsData.memory,
        ...(consoleLogs ? { console: consoleMessages.slice(0, 100) } : {}),
      };

    const findings = buildFindings(metrics);
    const summary = buildSummary(findings);

    return {
      schemaVersion: 1,
      tool: 'owa',
      meta: {
        url,
        analyzedAt: startedAt,
        finishedAt: new Date().toISOString(),
        waitAfterLoadMs: waitAfterLoad,
        userAgent: 'Chrome/120 (Playwright Chromium)',
      },
      metrics,
      interpretation: { summary, findings },
      consoleMessages: consoleLogs ? consoleMessages.slice(0, 100) : undefined,
    };
  } finally {
    // Закрываем и без ошибок, и при любой поломке — иначе Chromium остаётся висеть
    // зомби-процессом (для MCP-сервера это накапливается навсегда)
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/** Жёсткий предел ожидания после load: защита от waitMs=1e9 и NaN. */
function clampWait(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 60000);
}

module.exports = { analyze, clampWait };
