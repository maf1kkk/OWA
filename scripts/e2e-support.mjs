/**
 * Поддержка E2E-прогонов: фикстур-сайт и веб-интерфейс OWA.
 *
 * Модуль поднимает оба сервера на свободных портах и отдаёт их адреса.
 * Адреса передаются в прогон через переменные окружения:
 *   APP_URL  — веб-интерфейс OWA (то, что проверяем);
 *   SITE_URL — тестовый сайт (цель аудита).
 *
 * Конфиг e2e.config.ts читает APP_URL при загрузке, поэтому серверы
 * поднимаются ДО запуска раннера — см. scripts/e2e-run.mjs.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDb, migrate } = require('../src/db/index.js');
const { createApp, createAuth } = require('../web/app.js');

// Фикстур на 127.0.0.1 — нужен разрешённый приватный адрес.
process.env.OWA_ALLOW_PRIVATE_TARGETS = '1';

/** Тестовый сайт: страницы со ссылками и типовыми проблемами (нет title, img без alt). */
const PAGES = {
  '/': `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Фикстур — главная страница сайта</title>
<meta name="description" content="Тестовая страница для E2E-проверок веб-интерфейса OWA и его разделов.">
<link rel="canonical" href="/">
<meta property="og:title" content="Фикстур">
<meta property="og:description" content="Тестовая страница">
<meta property="og:image" content="/img.png">
</head>
<body>
  <h1>Фикстур</h1>
  <p>Главная страница тестового сайта.</p>
  <a href="/about">О компании</a>
  <a href="/contacts">Контакты</a>
  <img src="/pic.png" alt="Логотип">
</body>
</html>`,
  '/about': `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>О компании — страница раздела</title>
<meta name="description" content="Раздел о компании: описание, история, команда и подход к работе."></head>
<body><h1>О компании</h1><p>Описание компании.</p><a href="/">На главную</a></body>
</html>`,
  '/contacts': `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title></title></head>
<body><h1>Контакты</h1><img src="/pic.png"><a href="#">Подробнее</a></body>
</html>`,
};

function startSite() {
  const server = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (PAGES[p]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES[p]);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="ru"><head><title>404</title></head><body><h1>404</h1></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

function startOwa() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-e2e-'));
  const db = openDb(path.join(dir, 'e2e.db'));
  migrate(db);
  const app = createApp({ db, auth: createAuth({}) });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Поднять серверы для прогона.
 * @returns {Promise<{appUrl: string, siteUrl: string, stop: () => Promise<void>}>}
 */
export async function startTestServers() {
  const site = await startSite();
  const owa = await startOwa();
  return {
    appUrl: owa.url,
    siteUrl: site.url,
    async stop() {
      await Promise.all([
        new Promise((r) => site.server.close(r)),
        new Promise((r) => owa.server.close(r)),
      ]);
    },
  };
}
