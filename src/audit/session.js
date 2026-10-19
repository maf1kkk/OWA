/**
 * Общий браузерный контекст для всех секций аудита.
 *
 * Секции не открывают браузер заново: каждая получает готовый context/page
 * через AuditOrchestrator-контекст и использует их для сбора своих метрик.
 *
 * Завершается через close() — нужно вызывать точно один раз в конце.
 */
'use strict';

const fs = require('fs');
const { launchBrowser } = require('../browser');
const longtasks = require('../collectors/longtasks');
const vitals = require('../collectors/vitals');
const perf = require('../collectors/performance');

class AuditSession {
  constructor(options = {}) {
    this.url = options.url;
    this.context = null;
    this.page = null;
    this.browser = null;
    // Браузер может быть передан снаружи (краулер открывает его один раз
    // на весь обход). ownBrowser=false — close() не закрывает чужой браузер.
    this.ownBrowser = !options.browser;
    this.browser = options.browser || null;
    this.timeout = Number.isFinite(options.timeout) ? options.timeout : 60000;
    this.waitAfterLoad = Number.isFinite(options.waitAfterLoad) ? options.waitAfterLoad : 2500;
    this.collected = {};
  }

  async start() {
    // SSRF-защита целевого URL: приватные адреса запрещены по умолчанию.
    await this.assertTargetSafe();

    if (!this.browser) {
      this.browser = await launchBrowser(true);
      this.ownBrowser = true;
    }
    this.context = await this.browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    await this.context.addInitScript(longtasks.initScript);
    await this.context.addInitScript(vitals.initScript);
    const axeSource = fs.readFileSync(require.resolve('axe-core'), 'utf8');
    await this.context.addInitScript(axeSource);

    // Блокируем запросы страницы к приватным адресам: страница не должна
    // утянуть OWA в локальную сеть или в cloud metadata.
    await this.context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (await this.isBlockedRequest(requestUrl)) {
        const { reportBlocked } = require('../security/safe-fetch');
        reportBlocked(requestUrl, 'запрос страницы к приватному адресу заблокирован');
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });

    this.page = await this.context.newPage();
    this.mainResponse = await this.page.goto(this.url, { waitUntil: 'load', timeout: this.timeout });
    await this.page.waitForTimeout(this.waitAfterLoad);
    return this;
  }

  /** Проверить целевой URL на приватный диапазон (SSRF). */
  async assertTargetSafe() {
    const { assertSafeUrl } = require('../security/safe-fetch');
    await assertSafeUrl(this.url);
  }

  /** Приватный ли адрес у запроса страницы (http/https). */
  async isBlockedRequest(requestUrl) {
    let parsed;
    try {
      parsed = new URL(requestUrl);
    } catch {
      return true;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      // data:/blob:/about: — не сетевые запросы, пропускаем
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    const { isPrivateHost } = require('../security');
    if (isPrivateHost(hostname)) {
      const { allowPrivate, allowedPrivateHosts } = require('../security/safe-fetch');
      const allowList = allowedPrivateHosts();
      return !(allowPrivate() && (allowList.length === 0 || allowList.includes(hostname)));
    }
    return false;
  }

  /** Собрать все «сырые» данные одним вынужденным блоком. */
  async collectRaw() {
    if (this.collected._done) return this.collected;
    const perfData = await this.page.evaluate(perf.collectScript);
    const longTaskData = await this.page.evaluate(longtasks.collectScript);
    const vitalsData = await this.page.evaluate(vitals.collectScript);
    const pageState = await this.page.evaluate(() => {
      const title = document.title || '';
      const description =
        (document.querySelector('meta[name="description"]') || {}).content || '';
      const ogTags = {};
      document.querySelectorAll('meta[property^="og:"]').forEach((m) => {
        ogTags[m.getAttribute('property')] = m.getAttribute('content') || '';
      });
      const headings = {};
      for (let i = 1; i <= 6; i++) headings['h' + i] = document.querySelectorAll('h' + i).length;
      const imgsTotal = document.querySelectorAll('img').length;
      const imgsNoAlt = document.querySelectorAll('img:not([alt])').length;
      const linksAll = document.querySelectorAll('a[href]').length;
      const linksEmpty = document.querySelectorAll('a[href=""], a[href="#"]').length;
      const docLang = document.documentElement.getAttribute('lang') || '';
      return {
        title,
        description,
        ogTags,
        headings,
        imgsTotal,
        imgsNoAlt,
        linksAll,
        linksEmpty,
        docLang,
      };
    });

    this.collected = {
      _done: true,
      legacyTiming: perfData.legacy,
      navigation: perfData.navigation,
      paint: perfData.paint,
      resources: perfData.resources,
      longTasks: longTaskData,
      vitals: {
        lcpMs: vitalsData.vitals ? vitalsData.vitals.lcp : null,
        cls: vitalsData.vitals ? Math.round(vitalsData.vitals.cls * 1000) / 1000 : null,
      },
      jsErrors: vitalsData.jsErrors || [],
      memory: vitalsData.memory,
      pageState,
    };
    return this.collected;
  }

  /** Запустить axe-core в странице. */
  async runAxe() {
    return this.page.evaluate(() => axe.run(document, { resultTypes: ['violations'] }));
  }

  /** Ответ на robots.txt через safeFetch (SSRF-защита + пининг IP). */
  async fetchRobotsText() {
    let base;
    try {
      base = new URL(this.url);
      base.pathname = '/robots.txt';
      base.search = '';
      base.hash = '';
    } catch {
      return { exists: false, raw: '' };
    }
    try {
      const { safeFetch } = require('../security/safe-fetch');
      const resp = await safeFetch(base.toString(), { timeout: 5000, maxRedirects: 2 });
      if (resp.status === 404 || resp.status >= 400) {
        return { exists: false, raw: '', status: resp.status };
      }
      const text = await resp.text();
      return { exists: true, raw: text, status: resp.status };
    } catch {
      return { exists: false, raw: '', error: 'unreachable' };
    }
  }

  /** Безопасный HEAD/GET-запрос через safeFetch (для проверки битых ссылок). */
  async safeRequest(url, options = {}) {
    const { safeFetch } = require('../security/safe-fetch');
    const resp = await safeFetch(url, { timeout: 8000, maxRedirects: 3, ...options });
    return { status: resp.status, headers: resp.headers || {} };
  }

  /** Заголовки и статус реального ответа навигации (без повторного GET). */
  async getResponseHeaders() {
    const resp = this.mainResponse;
    if (!resp) return { status: null, headers: {} };
    const headers = {};
    try {
      for (const [k, v] of Object.entries(resp.headers())) headers[k.toLowerCase()] = v;
    } catch {
      return { status: null, headers: {} };
    }
    return { status: resp.status(), headers };
  }

  async close() {
    if (this.context) {
      try { await this.context.close(); } catch {}
    }
    // Чужой браузер (краулер) не закрываем — им пользуются следующие страницы.
    if (this.browser && this.ownBrowser) {
      try { await this.browser.close(); } catch {}
    }
  }
}

module.exports = { AuditSession };