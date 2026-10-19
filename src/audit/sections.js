/**
 * Секции комплексного аудита. Каждая — AuditSection с методом run(url, context).
 *
 * context = { session: AuditSession } — общее Playwright-окружение,
 * уже открытое и прошедшее nav до этой страницы. Все пять секций работают
 * на одном контексте (не открывая браузер заново).
 *
 * Возврат: { score, issues, raw }.
 *  - score: 0-100 (интегральная по секции);
 *  - issues: массив { id, rule, severity, message, recommendation?, location? };
 *  - raw: сырые данные секции.
 */
'use strict';

const { buildFindings, buildSummary } = require('../interpret');

// ------------------------------------------------------------------ helpers
function severityToScore(issues, weights) {
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  let penalty = 0;
  for (const i of issues) {
    penalty += i.severity === 'critical' ? 30 : i.severity === 'warning' ? 10 : 3;
  }
  return Math.max(0, 100 - Math.round((penalty / Math.max(1, totalWeight)) * 100));
}

function toIssue(id, rule, severity, message, recommendation, location) {
  const issue = { id, rule, severity, message };
  if (recommendation) issue.recommendation = recommendation;
  if (location) issue.location = location;
  return issue;
}

// ------------------------------------------------- SECTION: performance
class PerformanceSection {
  static name = 'performance';
  static weight = { lcp: 25, cls: 20, fcp: 15, tbt: 12, jsErrors: 12, ttfb: 10, longTasks: 8, load: 7, resources: 5, domContentLoaded: 5 };
  async run(url, context) {
    const { session } = context;
    const raw = await session.collectRaw();

    // Точка: legacy metrics -> существующие findings
    const findings = buildFindings({
      legacyTiming: raw.legacyTiming,
      navigation: raw.navigation,
      paint: raw.paint,
      vitals: { lcpMs: raw.vitals.lcpMs, cls: raw.vitals.cls },
      longTasks: raw.longTasks,
      resources: raw.resources,
      jsErrors: raw.jsErrors,
    });

    // Точки в issues (severity по вердиктам)
    const issues = findings
      .filter((f) => f.verdict === 'bad' || f.verdict === 'warn')
      .map((f) => ({
        id: f.id,
        rule: f.id,
        severity: f.verdict === 'bad' ? 'critical' : 'warning',
        message: f.message,
        recommendation: f.recommendation || null,
      }));

    const summary = buildSummary(findings);

    return {
      score: summary.score,
      issues,
      raw: {
        summary,
        findings,
        metrics: {
          lcpMs: raw.vitals.lcpMs,
          cls: raw.vitals.cls,
          fcpMs: raw.paint && raw.paint.firstContentfulPaint !== null ? Math.round(raw.paint.firstContentfulPaint) : null,
          ttfbMs: raw.navigation ? Math.round(raw.navigation.ttfb) : null,
          loadMs: raw.legacyTiming ? raw.legacyTiming.loadTime : null,
          tbtMs: raw.longTasks ? Math.round(raw.longTasks.totalBlockingTime) : null,
          longTasks: raw.longTasks ? raw.longTasks.count : null,
          resources: raw.resources ? raw.resources.count : null,
          jsErrors: raw.jsErrors ? raw.jsErrors.length : 0,
        },
      },
    };
  }
}

// ------------------------------------------------- SECTION: seo
class SeoSection {
  static name = 'seo';
  async run(url, context) {
    const { session } = context;
    const raw = await session.collectRaw();
    const state = raw.pageState;
    const issues = [];

    // title
    if (!state.title) {
      issues.push(toIssue('seo-no-title', 'seo-title', 'critical', 'Отсутствует <title>', 'Задайте <title> (50-60 символов) для страницы'));
    } else if (state.title.length < 20) {
      issues.push(toIssue('seo-short-title', 'seo-title', 'warning', `Короткий title (${state.title.length} симв.)`, 'Title < 20 симв. не индексируется нормально. Расширьте до 50-60 символов.'));
    } else if (state.title.length > 65) {
      issues.push(toIssue('seo-long-title', 'seo-title', 'warning', `Длинный title (${state.title.length} симв.)`, 'Title > 65 симв. обрезается в выдаче. Сократите.'));
    }

    // description
    if (!state.description) {
      issues.push(toIssue('seo-no-description', 'seo-description', 'warning', 'Отсутствует meta description', 'Добавьте <meta name="description"> (120-155 симв.)'));
    }

    // canonical
    const hasCanonical = await session.page.evaluate(() => !!document.querySelector('link[rel="canonical"]'));
    if (!hasCanonical) {
      issues.push(toIssue('seo-no-canonical', 'seo-canonical', 'warning', 'Нет canonical', 'Добавьте <link rel="canonical" href="...">'));
    }

    // open graph
    if (!Object.keys(state.ogTags).length) {
      issues.push(toIssue('seo-no-og', 'seo-open-graph', 'warning', 'Нет Open Graph мета-тегов', 'Добавьте og:title, og:description, og:image'));
    }

    // H-структура
    if (!state.headings['h1'] || state.headings['h1'] === 0) {
      issues.push(toIssue('seo-no-h1', 'seo-h1', 'critical', 'Нет <h1> на странице', 'Каждая страница должна иметь один <h1>'));
    } else if (state.headings['h1'] > 1) {
      issues.push(toIssue('seo-multiple-h1', 'seo-h1', 'warning', `Несколько <h1> (${state.headings['h1']})`, 'Оставьте один <h1> на страницу'));
    }

    // alt-тексты
    if (state.imgsNoAlt > 0) {
      issues.push(toIssue('seo-img-alt', 'seo-img-alt', 'warning', `${state.imgsNoAlt} изображений без alt`, 'Добавьте осмысленные alt-атрибуты к <img>'));
    }

    // битые внутренние ссылки: проверяем a[href] на 404 через safeFetch
    const linkHrefs = await session.page.evaluate(() => {
      return [...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href'))
        .filter((h) => h && !h.startsWith('javascript:') && !h.startsWith('#'))
        .slice(0, 20)
        .map((h) => new URL(h, window.location.href).href);
    });
    const brokenLinks = [];
    const blockedLinks = [];
    for (const href of linkHrefs) {
      try {
        const resp = await session.safeRequest(href, { method: 'HEAD' });
        if (resp.status >= 400) brokenLinks.push({ href, status: resp.status });
      } catch (err) {
        // Заблокированный SSRF/сетевой сбой — это не «битая ссылка»:
        // отделяем, чтобы не путать политику безопасности с ошибками сайта.
        const blocked = err && err.code === 'SSRF_BLOCKED';
        const entry = { href, status: 0, error: String(err && err.message || err).slice(0, 120) };
        if (blocked) blockedLinks.push(entry);
        else brokenLinks.push(entry);
      }
    }
    if (brokenLinks.length) {
      issues.push(toIssue('seo-broken-links', 'seo-broken-links', 'critical', `Битые ссылки: ${brokenLinks.length} (первые: ${brokenLinks.slice(0, 3).map((l) => l.href).join(', ')})`, 'Уберите битые ссылки или замените их'));
    }
    if (blockedLinks.length) {
      issues.push(toIssue('seo-links-unverified', 'seo-links-unverified', 'info', `Не удалось проверить ${blockedLinks.length} ссылок (заблокировано политикой безопасности)`, 'Проверьте ссылки вручную: внешние адреса могут быть недоступны серверу аудита'));
    }

    // robots.txt
    const robots = await session.fetchRobotsText();
    const robotsIssue = !robots.exists;
    if (robotsIssue) {
      issues.push(toIssue('seo-robots-missing', 'seo-robots', 'info', 'robots.txt не найден (404)', 'Это не ошибка, но добавьте robots.txt, если хотите управлять индексацией'));
    }

    const score = 100 - issues.reduce((s, i) => s + (i.severity === 'critical' ? 20 : i.severity === 'warning' ? 10 : 2), 0);
    return { score: Math.max(0, score), issues, raw: { state, brokenLinks, blockedLinks, robots } };
  }
}

// ------------------------------------------------- SECTION: security
class SecuritySection {
  static name = 'security';
  async run(url, context) {
    const { session } = context;
    const { status, headers } = await session.getResponseHeaders();
    const pageUrl = session.page.url();
    const isHttps = pageUrl.startsWith('https');

    const issues = [];
    let score = 100;
    const penalty = (w) => { score = Math.max(0, score - w); };

    // CSP
    if (!headers['content-security-policy']) {
      issues.push(toIssue('sec-no-csp', 'csp', 'warning', 'Нет Content-Security-Policy', 'Добавьте заголовок CSP для ограничения источников'));
      penalty(15);
    }
    // HSTS
    if (isHttps && !headers['strict-transport-security']) {
      issues.push(toIssue('sec-no-hsts', 'hsts', 'warning', 'Нет Strict-Transport-Security', 'Включите HSTS (max-age, includeSubdomains)'));
      penalty(10);
    }
    // X-Frame-Options / CSP frame-ancestors
    if (!headers['x-frame-options'] && !headers['content-security-policy']) {
      issues.push(toIssue('sec-no-frame', 'x-frame-options', 'warning', 'Нет X-Frame-Options (кликджекинг)', 'Установите X-Frame-Options: DENY или SAMEORIGIN'));
      penalty(5);
    }
    // X-Content-Type-Options
    if (!headers['x-content-type-options']) {
      issues.push(toIssue('sec-no-cto', 'x-content-type-options', 'warning', 'Нет X-Content-Type-Options: nosniff', 'Добавьте заголовок X-Content-Type-Options: nosniff'));
      penalty(5);
    }
    // Referrer-Policy
    if (!headers['referrer-policy']) {
      issues.push(toIssue('sec-no-rp', 'referrer-policy', 'info', 'Нет Referrer-Policy', 'Задайте Referrer-Policy (no-referrer, strict-origin-when-cross-origin)'));
      penalty(2);
    }
    // HTTP → HTTPS redirect
    if (!isHttps) {
      issues.push(toIssue('sec-not-https', 'https', 'critical', 'Страница не на HTTPS', 'Перейдите на HTTPS (Let\'s Encrypt или аналоги)'));
      penalty(30);
    }

    // Mixed content: HTTP-подресурсы. На HTTPS это критично (браузер их
    // блокирует), на HTTP — предупреждение: при переходе на HTTPS страница
    // станет mixed content.
    const mixedContent = await session.page.evaluate(() => {
      const res = [];
      for (const el of document.querySelectorAll('img[src], script[src], link[href], iframe[src], source[src]')) {
        const src = el.src || el.href || el.getAttribute('href');
        if (src && src.startsWith('http://')) res.push(src);
      }
      return [...new Set(res)].slice(0, 20);
    });
    if (mixedContent.length) {
      if (isHttps) {
        issues.push(toIssue('sec-mixed', 'mixed-content', 'critical', `Mixed content: ${mixedContent.length} ресурсов на HTTP (${mixedContent.slice(0, 3).join(', ')})`, 'Переведите все ресурсы на HTTPS'));
        penalty(20);
      } else {
        issues.push(toIssue('sec-mixed', 'mixed-content', 'warning', `${mixedContent.length} ресурсов подключены по HTTP (станут mixed content при переходе на HTTPS)`, 'Переведите ресурсы на HTTPS до включения TLS'));
        penalty(5);
      }
    }

    // Permissions-Policy (info)
    if (!headers['permissions-policy']) {
      issues.push(toIssue('sec-no-permissions', 'permissions-policy', 'info', 'Нет Permissions-Policy', 'Задайте Permissions-Policy (geolocation=(), camera=(), etc.)'));
      penalty(1);
    }

    return { score, issues, raw: { status, headers, mixedContent } };
  }
}

// ------------------------------------------------- SECTION: accessibility
class AccessibilitySection {
  static name = 'accessibility';
  async run(url, context) {
    const { session } = context;
    const axeResult = await session.runAxe();
    const violations = axeResult.violations || [];

    // axe-impact: minor, moderate, serious, critical
    const SEV_MAP = { critical: 'critical', serious: 'critical', moderate: 'warning', minor: 'info' };
    const issues = violations.map((v) => ({
      id: 'a11y-' + v.id,
      rule: v.id,
      severity: SEV_MAP[v.impact] || 'info',
      message: `${v.id}: ${v.description} (воздействий: ${v.nodes.length})`,
      recommendation: v.help,
      location: v.nodes && v.nodes[0] ? v.nodes[0].target : null,
      _nodes: v.nodes,
    }));

    // Оценка: -30 за каждое critical, -10 за warning, -3 за info
    let score = 100;
    for (const i of issues) {
      score -= i.severity === 'critical' ? 30 : i.severity === 'warning' ? 10 : 3;
    }
    score = Math.max(0, score);

    return { score, issues, raw: { violations: violations.map((v) => ({ id: v.id, impact: v.impact, description: v.description, nodes: v.nodes.map((n) => n.target) })) } };
  }
}

// ------------------------------------------------- SECTION: content
class ContentSection {
  static name = 'content';
  async run(url, context) {
    const { session } = context;
    const raw = await session.collectRaw();
    const state = raw.pageState;
    const issues = [];

    // Пустые ссылки
    if (state.linksEmpty > 0) {
      issues.push(toIssue('content-empty-links', 'empty-links', 'warning', `Пустых ссылок: ${state.linksEmpty}`, 'Уберите ссылки без href или с href="#"'));
    }

    // Дублирующиеся заголовки
    const dupHeadings = await session.page.evaluate(() => {
      const seen = new Map();
      for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
        const key = (h.tagName + '|' + h.textContent.trim()).toLowerCase();
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      return [...seen.entries()].filter(([, c]) => c > 1).map(([k, c]) => ({ key: k, count: c }));
    });
    if (dupHeadings.length) {
      issues.push(toIssue('content-dup-headings', 'dup-headings', 'info', `Дублирующиеся заголовки: ${dupHeadings.length}`, 'Не используйте идентичные <h*> для разных секций'));
    }

    // Title длиннее/короче
    const title = state.title;
    if (title && title.length > 70) {
      issues.push(toIssue('content-title-long', 'title-length', 'info', `Title длиннее 70 симв. (${title.length})`, 'Сократите title'));
    }

    // Отсутствие структурированных данных
    const hasJsonLd = await session.page.evaluate(() => !!document.querySelector('script[type="application/ld+json"]'));
    if (!hasJsonLd) {
      issues.push(toIssue('content-no-sd', 'structured-data', 'info', 'Нет structured data (JSON-LD / microdata)', 'Добавьте микроразметку для rich snippets (schema.org)'));
    }

    // Текстовый объём
    const textLen = await session.page.evaluate(() => (document.body && document.body.innerText || '').trim().length);
    if (textLen < 100) {
      issues.push(toIssue('content-thin', 'thin-content', 'warning', `Мало текста: ${textLen} симв.`, 'Добавьте контент (мин. 300-500 симв.)'));
    }

    const score = 100 - issues.reduce((s, i) => s + (i.severity === 'critical' ? 20 : i.severity === 'warning' ? 8 : 3), 0);
    return { score: Math.max(0, score), issues, raw: { textLen, dupHeadings, hasJsonLd } };
  }
}

// ------------------------------------------------- Фабрика
function createAllSections() {
  return [
    new PerformanceSection(),
    new SeoSection(),
    new SecuritySection(),
    new AccessibilitySection(),
    new ContentSection(),
  ];
}

function sectionByType(type) {
  const map = { performance: PerformanceSection, seo: SeoSection, security: SecuritySection, accessibility: AccessibilitySection, content: ContentSection };
  const C = map[type];
  return C ? new C() : null;
}

module.exports = {
  createAllSections,
  sectionByType,
  PerformanceSection,
  SeoSection,
  SecuritySection,
  AccessibilitySection,
  ContentSection,
};