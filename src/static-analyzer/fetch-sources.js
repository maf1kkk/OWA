/**
 * Сбор исходников страницы для статического анализа.
 * Через Playwright: открываем страницу, забираем HTML, инлайновые style/script
 * и внешние CSS/JS (скачивание через context.request; file:// — с диска).
 * Лимиты (ТЗ): не более 50 внешних файлов и 2 МБ на файл; всё сверху — в truncated.
 */
'use strict';

const fs = require('fs');
const { fileURLToPath } = require('url');

const LIMITS = {
  maxFiles: 50, // внешних css+js файлов
  maxFileBytes: 2 * 1024 * 1024, // 2 МБ на файл
  maxTotalBytes: 15 * 1024 * 1024, // общий бюджет исходников
  requestTimeoutMs: 15000,
};

const BINARY_CT = /^(image|font|audio|video)\//i;

function byteLength(s) {
  return Buffer.byteLength(s, 'utf8');
}

/** Скачать один внешний ресурс. Возвращает { content } | { error } | { skipped, reason }. */
async function download(context, resourceUrl) {
  if (resourceUrl.startsWith('file://')) {
    try {
      const p = fileURLToPath(resourceUrl);
      const st = fs.statSync(p);
      if (st.size > LIMITS.maxFileBytes) {
        return { skipped: true, reason: 'file-too-big', size: st.size };
      }
      return { content: fs.readFileSync(p, 'utf8') };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }

  try {
    const resp = await context.request.get(resourceUrl, { timeout: LIMITS.requestTimeoutMs });
    if (!resp.ok()) return { error: `HTTP ${resp.status()}` };
    const ct = resp.headers()['content-type'] || '';
    if (BINARY_CT.test(ct)) return { skipped: true, reason: 'binary-content-type' };
    const buf = await resp.body();
    if (buf.length > LIMITS.maxFileBytes) {
      return { skipped: true, reason: 'file-too-big', size: buf.length };
    }
    return { content: buf.toString('utf8') };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

/**
 * Открыть страницу и собрать исходники.
 * @returns {Promise<{finalUrl:string, html:string, css:Array, js:Array, truncated:Array, counts:object}>}
 *   css/js: { url, content, inline? }
 */
async function fetchSources(url, opts = {}) {
  const timeout = opts.timeout || 60000;
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 1000;
  const { launchBrowser } = require('../browser');

  const browser = await launchBrowser(true);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout });
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const finalUrl = page.url();
    const html = await page.content();
    const found = await page.evaluate(() => {
      const cssLinks = [...document.querySelectorAll('link[rel~="stylesheet"]')].map((e) => e.href).filter(Boolean);
      const jsScripts = [...document.querySelectorAll('script[src]')].map((e) => e.src).filter(Boolean);
      const inlineStyles = [...document.querySelectorAll('style')]
        .map((e, i) => ({ url: `${document.location.href} <style #${i + 1}>`, content: e.textContent || '' }))
        .filter((s) => s.content.trim());
      const inlineScripts = [...document.querySelectorAll('script:not([src])')]
        .filter((e) => !e.type || /^(text\/)?(java|ecma)script$|^module$/i.test(e.type))
        .map((e) => e.textContent || '')
        .filter((c) => c.trim())
        .map((content, i) => ({ url: document.location.href, content, inline: true, n: i + 1 }));
      return { cssLinks, jsScripts, inlineStyles, inlineScripts };
    });

    const truncated = [];
    const css = [...found.inlineStyles];
    const js = found.inlineScripts.map((s) => ({ url: s.url, content: s.content, inline: true }));
    let totalBytes = byteLength(html);

    // Внешние файлы: дедупликация, лимиты
    const external = [
      ...found.cssLinks.map((u) => ({ url: u, kind: 'css' })),
      ...found.jsScripts.map((u) => ({ url: u, kind: 'js' })),
    ];
    const seen = new Set();
    let fileCount = 0;

    for (const item of external) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);

      if (fileCount >= LIMITS.maxFiles) {
        truncated.push({ url: item.url, reason: 'file-limit' });
        continue;
      }

      const res = await download(context, item.url);
      if (res.skipped) {
        truncated.push({ url: item.url, reason: res.reason, size: res.size ?? null });
        continue;
      }
      if (res.error) {
        truncated.push({ url: item.url, reason: `download-failed: ${res.error}` });
        continue;
      }

      if (totalBytes + byteLength(res.content) > LIMITS.maxTotalBytes) {
        truncated.push({ url: item.url, reason: 'total-limit' });
        continue;
      }

      fileCount += 1;
      totalBytes += byteLength(res.content);
      const entry = { url: item.url, content: res.content };
      if (item.kind === 'css') css.push(entry);
      else js.push(entry);
    }

    return {
      finalUrl,
      html,
      css,
      js,
      truncated,
      counts: {
        css: css.length,
        js: js.length,
        externalFiles: fileCount,
        truncated: truncated.length,
      },
    };
  } finally {
    await browser.close();
  }
}

module.exports = { fetchSources, LIMITS };
