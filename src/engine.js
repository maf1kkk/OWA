const { launchBrowser } = require('./browser');
const perf = require('./collectors/performance');
const longtasks = require('./collectors/longtasks');
const widget = require('./collectors/widget');
const vitals = require('./collectors/vitals');
const { buildFindings, buildSummary } = require('./interpret');

async function analyze(url, options = {}) {
  const {
    waitAfterLoad = 5000,       // мс ожидания после load (для динамики/виджетов)
    widgetSelectors = null,     // null => только авто-детект (best-effort)
    headless = true,
    timeout = 60000,
    consoleLogs = false,
  } = options;

  // Явные селекторы пользователя: точный замер с начала навигации.
  const explicitSelectors = widgetSelectors && widgetSelectors.length
    ? [...widgetSelectors]
    : [];

  const browser = await launchBrowser(headless);
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  try {
    // Скрипты ДО навигации
    await context.addInitScript(longtasks.initScript);
    await context.addInitScript(vitals.initScript);
    if (explicitSelectors.length) {
      await context.addInitScript(widget.initScript(explicitSelectors));
    }

    const page = await context.newPage();
    const consoleMessages = [];
    if (consoleLogs) {
      page.on('console', (m) => consoleMessages.push({ type: m.type(), text: m.text() }));
    }

    const startedAt = new Date().toISOString();
    await page.goto(url, { waitUntil: 'load', timeout });

    // Авто-детект динамических виджетов (только если пользователь не задал
    // селекторы): опрос запускается сразу после load и работает во время
    // waitAfterLoad. Время появления = момент обнаружения (best-effort).
    let autoDetected = [];
    if (!explicitSelectors.length) {
      autoDetected = await page.evaluate(() => {
        const found = [];
        const candidates = document.querySelectorAll('[id], [class]');
        const dynamicHints = /widget|score|chat|live|stream|match|table|feed|player/i;
        for (const el of candidates) {
          if (found.length >= 5) break;
          let sig = null;
          if (el.id && dynamicHints.test(el.id)) {
            sig = '#' + el.id;
          } else if (el.classList.length) {
            for (const cls of el.classList) {
              if (dynamicHints.test(cls)) { sig = '.' + cls; break; }
            }
          }
          if (sig && !found.includes(sig)) found.push(sig);
        }
        return found;
      });
      if (autoDetected.length) {
        await page.evaluate(widget.autoPollScript(autoDetected));
      }
    }

    await page.waitForTimeout(clampWait(waitAfterLoad));

    // Замер виджетов: явные селекторы — точные тайминги init-скрипта,
    // авто-детект — best-effort. При совпадении побеждает точный замер.
    // Не найденный за окно наблюдения селектор = null (не отсутствующий ключ).
    const tracked = explicitSelectors.length
      ? await page.evaluate(widget.collectScript)
      : {};
    const explicitResults = {};
    for (const sel of explicitSelectors) {
      explicitResults[sel] = tracked[sel] ?? null;
    }
    const autoRaw = autoDetected.length
      ? await page.evaluate(widget.collectAutoScript)
      : {};
    const autoResults = {};
    for (const sel of autoDetected) {
      autoResults[sel] = autoRaw[sel] ?? null;
    }
    const widgetResults = { ...autoResults, ...explicitResults };

    const perfData = await page.evaluate(perf.collectScript);
    // Перед сбором метрик форсируем кадр: наблюдатели (longtask, LCP, CLS)
    // отдают записи на шаге рендеринга, и без этого часть метрик молча
    // пропадала на страницах, которые после load больше не рисуют.
    await page.evaluate(longtasks.flushScript).catch(() => {});
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
          note: explicitSelectors.length
            ? 'Явные селекторы — точное время появления (мс от начала навигации). Авто-детект — приблизительное время обнаружения после load.'
            : 'Авто-детект — приблизительное время обнаружения после load. Для точного замера задайте селекторы явно (--selector / selectors).',
          explicitSelectors,
          autoDetectedSelectors: autoDetected,
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
