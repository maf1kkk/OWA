/**
 * Sitemap: разбор sitemap.xml и вложенных sitemap-индексов.
 *
 * Поддерживаются оба формата:
 *   <urlset>      — плоский список URL;
 *   <sitemapindex> — список файлов sitemap, каждый из которых разворачивается.
 *
 * Загрузка идёт через safeFetch: SSRF-защита и пининг IP работают и здесь.
 */
'use strict';

const { XMLParser } = require('fast-xml-parser');
const { safeFetchText } = require('../security/safe-fetch');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});

/**
 * Достать <loc>: это текстовый элемент, а не атрибут.
 * @param {*} node
 * @returns {string|null}
 */
function readLoc(node) {
  if (typeof node === 'string') return node.trim() || null;
  if (!node || typeof node !== 'object') return null;
  const value = node.loc !== undefined ? node.loc : node['@_loc'];
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object' && typeof value['#text'] === 'string') return value['#text'].trim() || null;
  return null;
}

/**
 * Разобрать XML карты сайта.
 * @param {string} xml
 * @returns {{type: 'urlset'|'sitemapindex'|'unknown', urls: string[], sitemaps: string[]}}
 */
function parseSitemapXml(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    return { type: 'unknown', urls: [], sitemaps: [], error: String(err && err.message || err).slice(0, 120) };
  }
  const root = doc && doc.urlset ? doc.urlset : doc && doc.sitemapindex ? doc.sitemapindex : null;
  if (!root) return { type: 'unknown', urls: [], sitemaps: [] };

  if (doc.sitemapindex) {
    const items = Array.isArray(doc.sitemapindex.sitemap) ? doc.sitemapindex.sitemap : [doc.sitemapindex.sitemap];
    const sitemaps = items.map(readLoc).filter(Boolean);
    return { type: 'sitemapindex', urls: [], sitemaps };
  }

  const items = Array.isArray(root.url) ? root.url : [root.url];
  const urls = items.map(readLoc).filter(Boolean);
  return { type: 'urlset', urls, sitemaps: [] };
}

/**
 * Развернуть sitemap (с индексами) и вернуть список URL.
 * @param {string} sitemapUrl
 * @param {object} [opts]
 * @param {number} [opts.maxSitemaps=20] — сколько sitemap-файлов разворачивать
 * @param {number} [opts.maxUrls=500] — предел URL
 * @param {number} [opts.depth=2] — глубина вложенности индекса
 * @returns {Promise<{urls: string[], sitemaps: string[], truncated: boolean}>}
 */
async function collectSitemapUrls(sitemapUrl, opts = {}) {
  const maxSitemaps = Number.isFinite(opts.maxSitemaps) ? opts.maxSitemaps : 20;
  const maxUrls = Number.isFinite(opts.maxUrls) ? opts.maxUrls : 500;
  const maxDepth = Number.isFinite(opts.depth) ? opts.depth : 2;

  const urls = [];
  const visited = new Set();
  const queue = [{ url: String(sitemapUrl), depth: 0 }];
  let truncated = false;

  while (queue.length && visited.size < maxSitemaps) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let xml;
    try {
      const res = await safeFetchText(url, { timeoutMs: 15000, maxRedirects: 3 });
      if (res.status >= 400) continue;
      xml = res.body;
    } catch (err) {
      // Заблокированный или недоступный sitemap — пропускаем.
      continue;
    }

    const parsed = parseSitemapXml(xml);
    if (parsed.type === 'sitemapindex') {
      if (depth >= maxDepth) {
        truncated = true;
        continue;
      }
      for (const sub of parsed.sitemaps) {
        if (visited.size + queue.length >= maxSitemaps) {
          truncated = true;
          break;
        }
        queue.push({ url: sub, depth: depth + 1 });
      }
      continue;
    }

    for (const loc of parsed.urls) {
      if (urls.length >= maxUrls) {
        truncated = true;
        break;
      }
      urls.push(loc);
    }
  }

  if (queue.length) truncated = true;
  return { urls, sitemaps: [...visited], truncated };
}

module.exports = { parseSitemapXml, collectSitemapUrls };