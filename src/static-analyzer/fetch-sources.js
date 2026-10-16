/**
 * Сбор исходников страницы для статического анализа.
 * Через Playwright: открываем страницу, забираем HTML, инлайновые style/script
 * и внешние CSS/JS (скачивание через context.request).
 * Лимиты (ТЗ): не более 50 внешних файлов и 2 МБ на файл; всё сверху — в truncated.
 *
 * Безопасность: внешние ресурсы качаем только с того же origin, что и страница,
 * и только по http(s) — см. src/security.js, уровень 2. Страница не может
 * заставить сервить произвольные внутренние адреса или прочитать file://.
 */
'use strict';

const { checkTargetUrl, isPrivateHost } = require('../security');
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

/**
 * Скачать один внешний ресурс. Возвращает { content } | { error } | { skipped, reason }.
 * `baseOrigin` — origin анализируемой страницы; ссылки с него считаются своими.
 * `pageIsLocal` — сама страница на приватном адресе (анализ локальной сборки).
 */
async function download(context, resourceUrl, baseOrigin, pageIsLocal) {
  // Локальные файлы не читаем никогда: ссылки приходят из HTML страницы,
  // и "дружественная" страница так вытаскивает произвольные файлы с диска.
  if (resourceUrl.startsWith('file:')) {
    return { skipped: true, reason: 'file-scheme-blocked' };
  }

  // 1. Схема — только http(s)
  const verdict = checkTargetUrl(resourceUrl);
  if (!verdict.ok) {
    return { skipped: true, reason: `blocked:${verdict.reason}` };
  }

  // 2. Тот же origin, что и страница. Этого достаточно, чтобы страница не
  //    уводила сервер на произвольные адреса (в т.ч. в приватные сети).
  let origin = null;
  try {
    origin = new URL(resourceUrl).origin;
  } catch {
    return { error: 'bad resource url' };
  }
  if (baseOrigin && origin !== baseOrigin) {
    return { skipped: true, reason: 'cross-origin-blocked' };
  }

  // 3. Если origin страницы неизвестен, всё равно не даём уйти в приватные
  //    адреса и metadata. Для локальной страницы её собственный origin
  //    разрешён по определению (это анализ локальной сборки, шаг 1 в security.js).
  if (!baseOrigin && !pageIsLocal && isPrivateHost(new URL(resourceUrl).hostname)) {
    return { skipped: true, reason: 'blocked:private' };
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
    let baseOrigin = null;
    let pageHost = null;
    try {
      const parsed = new URL(finalUrl);
      baseOrigin = parsed.origin;
      pageHost = parsed.hostname;
    } catch {
      baseOrigin = null;
    }
    // Страница на приватном адресе (localhost/staging) — её собственные
    // ресурсы с того же адреса разрешены
    const pageIsLocal = pageHost ? isPrivateHost(pageHost) : true;
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

      const res = await download(context, item.url, baseOrigin, pageIsLocal);
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
