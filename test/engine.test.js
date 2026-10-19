/**
 * Тесты движка анализа (src/engine.js).
 *
 * Локальный HTTP-сервер вместо внешней сети: детерминированно и работает офлайн.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { analyze, clampWait } = require('../src/engine');

/** Мини-сервер со страницей-нагрузкой: head, стили, скрипты, долгая задача. */
function startServer() {
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>OWA test page</title>
  <style>
    #heavy { display: block; height: 10px; background: red; }
  </style>
</head>
<body>
  <h1 id="title">Привет</h1>
  <div id="scoreboard">макет виджета</div>
  <script>
    // Долгая задача (~300 мс) для PerformanceObserver long tasks.
    // Держим заметно выше порога 50 мс, чтобы задача гарантированно
    // регистрировалась наблюдателем (иначе тест формы отчёта флейкает).
    const t0 = Date.now();
    while (Date.now() - t0 < 300) {}
    window.__owa = true;
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

test('engine: анализ локальной страницы возвращает полный отчёт', async (t) => {
  const { server, url } = await startServer();
  try {
    const data = await analyze(url, { waitAfterLoad: 300 });

    assert.equal(data.schemaVersion, 1);
    assert.equal(data.tool, 'owa');
    assert.equal(data.meta.url, url);
    assert.ok(data.meta.analyzedAt, 'analyzedAt заполнен');

    const m = data.metrics;
    assert.ok(m.legacyTiming && Number.isFinite(m.legacyTiming.loadTime), 'legacyTiming.loadTime — число');
    assert.ok(m.navigation, 'navigation-фазы собраны');
    assert.ok(Number.isFinite(m.navigation.ttfb), 'ttfb — число');
    assert.ok(m.paint, 'paint собран');
    assert.ok(Array.isArray(m.resources.top10Slowest), 'top10Slowest — массив');
    assert.ok(m.longTasks, 'longTasks собран');
    assert.ok(Number.isFinite(m.longTasks.maxDuration), 'maxDuration — число');
    assert.ok(m.customWidgets && typeof m.customWidgets.results === 'object', 'виджеты измерены');
    assert.ok(Array.isArray(m.jsErrors), 'jsErrors — массив');
    assert.ok(data.interpretation && Array.isArray(data.interpretation.findings), 'интерпретация есть');
    assert.ok(data.interpretation.summary && Number.isFinite(data.interpretation.summary.score), 'оценка — число');
  } finally {
    server.close();
  }
});

test('engine: пользовательский селектор попадает в результаты', async (t) => {
  const { server, url } = await startServer();
  try {
    const data = await analyze(url, { waitAfterLoad: 200, widgetSelectors: ['#title', '#missing-element'] });
    const results = data.metrics.customWidgets.results;
    assert.ok('#title' in results, 'явный селектор измерен');
    assert.equal(results['#missing-element'], null, 'несуществующий селектор = null');
  } finally {
    server.close();
  }
});

test('engine: авто-детект не мутируется между вызовами, дефолтных селекторов нет', async (t) => {
  const { server, url } = await startServer();
  try {
    const first = await analyze(url, { waitAfterLoad: 200 });
    const cw = first.metrics.customWidgets;
    assert.deepEqual(cw.explicitSelectors, [], 'без --selector явных селекторов нет');
    // Страница-фикстура содержит #scoreboard — авто-детект должен его найти
    assert.ok(cw.autoDetectedSelectors.includes('#scoreboard'), 'авто-детект видит #scoreboard');
    // В results — только авто-селекторы (best-effort), без дефолтного мусора
    assert.deepEqual(Object.keys(cw.results).sort(), [...cw.autoDetectedSelectors].sort(), 'results = только авто-детект');
    assert.ok(!('#title' in cw.results), 'неавто-элементы не попадают в results');
    const lenAfterFirst = cw.autoDetectedSelectors.length;

    for (let i = 0; i < 3; i++) {
      await analyze(url, { waitAfterLoad: 200 });
    }
    const last = await analyze(url, { waitAfterLoad: 200 });
    assert.equal(
      last.metrics.customWidgets.autoDetectedSelectors.length,
      lenAfterFirst,
      'авто-детект не раздувает внутренний список',
    );
  } finally {
    server.close();
  }
});

test('engine: недоступный порт — понятная ошибка, не крэш', async () => {
  // порт 1 закрыт: ECONNREFUSED должен прийти как ошибка анализа
  await assert.rejects(
    () => analyze('http://127.0.0.1:1/', { waitAfterLoad: 100, timeout: 5000 }),
    /ERR|refused|net::|playwright|browserType|Timeout|Navigation/i,
  );
});

test('engine: clampWait защищает от мусора и огромных значений', () => {
  assert.equal(clampWait(1000), 1000);
  assert.equal(clampWait(-5), 0);
  assert.equal(clampWait(NaN), 0);
  assert.equal(clampWait('abc'), 0);
  assert.equal(clampWait(1e12), 60000);
  assert.equal(clampWait(undefined), 0);
});

test('engine: схема отчёта стабильна между запусками (ключи и типы)', async (t) => {
  const { server, url } = await startServer();
  try {
    const shapes = [];
    for (let i = 0; i < 2; i++) {
      // waitAfterLoad с запасом: long task фикстуры должен успеть попасть
      // в отчёт (иначе форма JSON плавает между прогонами).
      const data = await analyze(url, { waitAfterLoad: 400, widgetSelectors: ['#title'] });
      // Количество long tasks зависит от тайминга браузера, а не от схемы
      // отчёта: сравниваем форму, а не содержимое этого массива.
      const normalized = JSON.parse(JSON.stringify(data));
      if (normalized.metrics && normalized.metrics.longTasks) {
        normalized.metrics.longTasks.tasks = '[volatile]';
      }
      shapes.push(describe(normalized));
    }
    assert.deepEqual(shapes[0], shapes[1], 'форма отчёта детерминирована');
  } finally {
    server.close();
  }
});

/** Скелет значения: ключи и типы, без значений и таймингов. */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [describe(value[0])] : [];
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, describe(value[k])]),
    );
  }
  return typeof value;
}
