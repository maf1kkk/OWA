/**
 * Тесты краулера и sitemap (модуль 4).
 * Локальный HTTP-сервер: детерминированно и офлайн.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { parseSitemapXml } = require('../src/crawl/sitemap');
const { crawlSite, aggregate, normalizeUrl, sameHost } = require('../src/crawl/crawler');

process.env.OWA_ALLOW_PRIVATE_TARGETS = '1';

/** Сайт из нескольких страниц со ссылками (в т.ч. наружу). */
function startSite() {
  const pages = {
    '/': `<!doctype html><html lang="en"><head><title>Home</title><meta name="description" content="home"></head>
      <body><h1>Home</h1><a href="/about">about</a><a href="/blog">blog</a>
      <a href="/secret">secret</a>
      <a href="http://external.example/page">external</a><a href="/about">dup</a></body></html>`,
    '/about': `<!doctype html><html lang="en"><head><title>About</title></head>
      <body><h1>About</h1><a href="/">home</a><a href="/contact">contact</a></body></html>`,
    '/blog': `<!doctype html><html lang="en"><head><title>Blog</title></head><body><h1>Blog</h1></body></html>`,
    '/contact': `<!doctype html><html lang="en"><head><title>Contact</title></head><body><h1>Contact</h1></body></html>`,
  };
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /secret\n');
      return;
    }
    if (path === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
        <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>${base}/sitemap-pages.xml</loc></sitemap>
        </sitemapindex>`);
      return;
    }
    if (path === '/sitemap-pages.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${base}/</loc></url>
          <url><loc>${base}/about</loc></url>
        </urlset>`);
      return;
    }
    if (pages[path]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pages[path]);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<!doctype html><html lang="en"><head><title>404</title></head><body><h1>404</h1></body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, base, url: base + '/' });
    });
  });
}
let base = '';

test('sitemap: разбор urlset и sitemapindex', () => {
  const urlset = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://a.test/</loc></url><url><loc>https://a.test/x</loc></url></urlset>`;
  const parsedSet = parseSitemapXml(urlset);
  assert.strictEqual(parsedSet.type, 'urlset');
  assert.deepStrictEqual(parsedSet.urls, ['https://a.test/', 'https://a.test/x']);

  const index = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://a.test/s1.xml</loc></sitemap>
    <sitemap><loc>https://a.test/s2.xml</loc></sitemap></sitemapindex>`;
  const parsedIndex = parseSitemapXml(index);
  assert.strictEqual(parsedIndex.type, 'sitemapindex');
  assert.deepStrictEqual(parsedIndex.sitemaps, ['https://a.test/s1.xml', 'https://a.test/s2.xml']);

  assert.strictEqual(parseSitemapXml('<html>not xml</html>').type, 'unknown');
});

test('sitemap: индекс разворачивается в список URL', { timeout: 60000 }, async () => {
  const { collectSitemapUrls } = require('../src/crawl/sitemap');
  const { server, base: b } = await startSite();
  try {
    const res = await collectSitemapUrls(b + '/sitemap.xml', { maxSitemaps: 5, maxUrls: 50 });
    assert.ok(res.urls.length >= 2, 'URL из вложенного sitemap получены');
    assert.ok(res.urls.some((u) => u.endsWith('/about')));
    assert.ok(res.sitemaps.length >= 2, 'развёрнут и индекс, и вложенный sitemap');
  } finally {
    server.close();
  }
});

test('crawl: обходит страницы и не выходит за домен', { timeout: 180000 }, async () => {
  const { server, url } = await startSite();
  try {
    const result = await crawlSite(url, { maxPages: 10, maxDepth: 2, delayMs: 0, waitAfterLoad: 200, respectRobots: false });
    const visited = result.pages.map((p) => p.url);
    assert.ok(visited.length >= 3, 'обработано несколько страниц: ' + visited.length);
    assert.ok(visited.length <= 10, 'не больше max-pages');
    for (const u of visited) {
      assert.ok(sameHost(u, new URL(url).hostname), 'только свой домен: ' + u);
    }
    assert.ok(!visited.some((u) => u.includes('external.example')), 'внешняя ссылка не пройдена');
  } finally {
    server.close();
  }
});

test('crawl: соблюдает robots.txt', { timeout: 120000 }, async () => {
  const { server, url } = await startSite();
  try {
    const result = await crawlSite(url, { maxPages: 10, maxDepth: 2, delayMs: 0, waitAfterLoad: 200, respectRobots: true });
    assert.ok(result.skipped.some((s) => s.reason === 'robots.txt disallow'), 'запрещённая страница пропущена');
  } finally {
    server.close();
  }
});

test('crawl: агрегаты по сайту считаются', { timeout: 120000 }, async () => {
  const { server, url } = await startSite();
  try {
    const result = await crawlSite(url, { maxPages: 4, maxDepth: 1, delayMs: 0, waitAfterLoad: 200, respectRobots: false });
    const a = result.aggregate;
    assert.ok(a.pageCount >= 2);
    assert.ok(typeof a.avgScore === 'number');
    assert.ok(a.avgMetrics && 'lcpMs' in a.avgMetrics);
    assert.ok(Array.isArray(a.topIssues));
    assert.ok(Array.isArray(a.worstPages));
  } finally {
    server.close();
  }
});

test('crawl: normalizeUrl и sameHost работают как задумано', () => {
  assert.strictEqual(normalizeUrl('https://A.test/x#frag'), 'https://a.test/x');
  assert.strictEqual(normalizeUrl('https://a.test/x/'), 'https://a.test/x');
  assert.strictEqual(normalizeUrl('mailto:a@b.test'), null);
  assert.strictEqual(normalizeUrl('javascript:void(0)'), null);
  assert.strictEqual(sameHost('https://a.test/x', 'A.TEST'), true);
  assert.strictEqual(sameHost('https://b.test/x', 'a.test'), false);
});

test('aggregate: топ проблем по частоте и худшие страницы', () => {
  const pages = [
    { url: 'https://a.test/1', status: 'ok', score: 40, issues: [{ rule: 'csp', severity: 'critical' }, { rule: 'title', severity: 'warning' }], metrics: { lcpMs: 3000 } },
    { url: 'https://a.test/2', status: 'ok', score: 70, issues: [{ rule: 'csp', severity: 'critical' }], metrics: { lcpMs: 2000 } },
    { url: 'https://a.test/3', status: 'failed', score: null, issues: [], metrics: {} },
  ];
  const a = aggregate(pages);
  assert.strictEqual(a.pageCount, 3);
  assert.strictEqual(a.okCount, 2);
  assert.strictEqual(a.failedCount, 1);
  assert.strictEqual(a.topIssues[0].rule, 'csp');
  assert.strictEqual(a.topIssues[0].count, 2);
  assert.strictEqual(a.worstPages[0].url, 'https://a.test/1');
  assert.strictEqual(a.avgScore, 55);
});
