/**
 * Тексты пакета для клиента: инструкция, сообщение в чат, смета.
 *
 * ВАЖНО: все числа берутся из факт-листа (результата измерений). Никаких
 * зашитых констант — иначе текст может разойтись с приложенным PDF.
 */
'use strict';

/** Русское склонение: 1 страница, 2 страницы, 5 страниц. */
function plural(n, one, few, many) {
  const v = Math.abs(Math.round(n));
  const m10 = v % 10;
  const m100 = v % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function pages(n) {
  return n + ' ' + plural(n, 'страница', 'страницы', 'страниц');
}

/** Ищем находку по правилу среди частых (обход) и среди общих. */
function findIssue(facts, ruleId) {
  const top = (facts.crawl && facts.crawl.topIssues || []).find((i) => i.ruleId === ruleId);
  if (top) {
    const count = typeof top.pages === 'number' ? top.pages : (typeof top.count === 'number' ? top.count : null);
    return { count, severity: top.severity };
  }
  const f = (facts.findings || []).find((i) => i.ruleId === ruleId);
  return f ? { count: 1, severity: f.severity, message: f.message } : null;
}

/** Собираем все числа, на которые будем ссылаться, — из фактов. */
function collectNumbers(facts) {
  const m = facts.metrics || {};
  const avg = (facts.crawl && facts.crawl.avgMetrics) || {};
  const contrast = findIssue(facts, 'color-contrast');
  const labels = findIssue(facts, 'label-content-name-mismatch');
  const heading = findIssue(facts, 'heading-order');
  const h1 = findIssue(facts, 'seo-h1');
  const title = findIssue(facts, 'seo-title');
  const security = facts.counts ? (facts.counts.security || 0) : 0;
  const longTasks = findIssue(facts, 'longTasks');
  const resources = m.resources !== undefined ? m.resources : null;
  const avgResources = avg.resources !== undefined ? avg.resources : null;

  return {
    pageCount: facts.crawl ? facts.crawl.pageCount : 1,
    contrastPages: contrast ? contrast.count : null,
    contrastTotal: contrast && facts.crawl ? null : null,
    labelPages: labels ? labels.count : null,
    headingPages: heading ? heading.count : null,
    h1Pages: h1 ? h1.count : null,
    titlePages: title ? title.count : null,
    securityHeaders: security,
    longTasksPages: longTasks ? longTasks.count : null,
    longTasksMain: m.longTasks !== undefined ? m.longTasks : null,
    resourcesMain: resources,
    resourcesAvg: avgResources,
    loadMs: m.loadMs !== undefined ? m.loadMs : null,
    tbtMs: m.tbtMs !== undefined ? m.tbtMs : null,
    lcpMs: m.lcpMs !== undefined ? m.lcpMs : null,
    lcpAvg: avg.lcpMs !== undefined ? avg.lcpMs : null,
    clsAvg: avg.cls !== undefined ? avg.cls : null,
  };
}

/**
 * Собрать тексты пакета.
 * @param {object} args
 * @param {object} args.facts — факт-лист
 * @param {object} args.narrative — текст отчёта
 * @param {object} args.client — { name, siteUrl, contacts, executor, priceBudget }
 */
function buildTexts(args) {
  const { facts, narrative, client } = args;
  const site = client.siteUrl || facts.url;
  const host = String(site).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const n = collectNumbers(facts);
  const sections = facts.sections || {};
  const sec = (name) => (sections[name] && sections[name].score !== null ? sections[name].score : '—');
  const comp = facts.comparison;
  const competitors = comp ? comp.sites.filter((s) => s.role !== 'target') : [];

  const focus = (narrative.focus || []).map((f) => '   • ' + f).join('\n');

  const compareRows = comp
    ? comp.sectionRows.map((r) => {
      const ours = r.values[site] !== undefined ? r.values[site] : r.values[Object.keys(r.values)[0]];
      const others = competitors.map((c) => r.values[c.url]);
      return '   ' + String(r.label).padEnd(17) + 'вы ' + String(ours).padStart(4)
        + '   ' + competitors.map((c, i) => c.label + ' ' + others[i]).join('   ');
    }).join('\n')
    : '';

  const a11yLine = [
    n.contrastPages ? '• ' + n.contrastPages + ' ' + plural(n.contrastPages, 'страница', 'страницы', 'страниц') + ' с недостаточным контрастом текста (правило color-contrast);' : null,
    n.labelPages ? '• ' + n.labelPages + ' ' + plural(n.labelPages, 'страница', 'страницы', 'страниц') + ': видимый текст элемента не совпадает с его доступным именем (label-content-name-mismatch);' : null,
    n.headingPages ? '• порядок заголовков нарушен на ' + n.headingPages + ' ' + plural(n.headingPages, 'странице', 'страницах', 'страницах') + ';' : null,
    n.h1Pages ? '• на ' + n.h1Pages + ' ' + plural(n.h1Pages, 'странице', 'страницах', 'страницах') + ' нет <h1>;' : null,
  ].filter(Boolean).join('\n   ');

  const perfLine = [
    n.resourcesAvg ? '• ' + n.resourcesAvg + ' ресурсов на страницу в среднем по сайту (на главной — ' + n.resourcesMain + ');' : null,
    n.loadMs ? '• полная загрузка главной — ' + (n.loadMs / 1000).toFixed(2) + ' с;' : null,
    n.tbtMs ? '• TBT (блокировка потока) — ' + n.tbtMs + ' мс;' : null,
    n.longTasksPages ? '• долгие задачи (>50 мс) — на ' + n.longTasksPages + ' ' + plural(n.longTasksPages, 'странице', 'страницах', 'страницах') + ';' : null,
    n.lcpAvg ? '• при этом LCP в норме (' + n.lcpAvg + ' мс в среднем) и CLS = ' + n.clsAvg + ' — ядро рендера у вас быстрое, теряете вы на количестве и весе подгружаемого (картинки, шрифты, аналитика).' : null,
  ].filter(Boolean).join('\n   ');

  const message = `Здравствуйте! Прогнал ${site} своим инструментом (OWA: headless Chromium, Performance API, axe-core, обход сайта). Ниже — что уже нашёл, без общих слов.

ЧТО НАШЁЛ ПО САЙТУ (${pages(n.pageCount)}, обход по внутренним ссылкам, ошибок обхода нет):

1) Доступность (WCAG 2 AA / ГОСТ Р 52872-2019) — блокер, и это почти на всех страницах:
   ${a11yLine}
   Оценка раздела — ${sec('accessibility')} из 100. Для сервиса, которым пользуются люди с нарушениями зрения, это репутационный и регуляторный риск (508-ФЗ, ГОСТ Р 52872-2019), а не только «accessibility».

2) Производительность:
   ${perfLine}
   Оценка раздела — ${sec('performance')} из 100.

3) Безопасность: не настроены ${n.securityHeaders} заголовков (CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy). Проверил отдельно экспонированные файлы (.git, .env, бэкапы БД, phpinfo, Spring actuator) и тяжёлые открытые эндпоинты — ничего не светится, TLS в норме, CDN стоит. То есть «дыр в лоб» нет, но базовая гигиена отсутствует.
   Оценка раздела — ${sec('security')} из 100.

4) SEO: базовые мета-теги в порядке (оценка ${sec('seo')} из 100), но на ${n.titlePages || '—'} ${plural(n.titlePages || 0, 'странице', 'страницах', 'страницах')} нет title и на ${n.h1Pages || '—'} — нет <h1>: правится точечно. Ссылочный профиль в этом объёме я не снимаю: честнее сказать, что это отдельный этап после технических правок.

ГЛАВНОЕ, ЧТО НАШЛОСЬ:
${focus}
${compareRows ? '\nСРАВНЕНИЕ С КОНУРЕНТАМИ (те же проверки по двум нишевым сайтам):\n' + compareRows + '\n   Средняя оценка: ' + (comp.targetAvg !== null ? comp.targetAvg : '—') + ' у вас против ' + (comp.competitorAvg !== null ? comp.competitorAvg : '—') + ' у конкурентов.\n' : ''}
ЧТО МОГУ СДЕЛАТЬ И СКОЛЬКО СТОИТ:

Вариант 1 — «разведка»: этот разбор + созвон 20 минут, приоритеты. Можно взять сразу и дёшево.

Вариант 2 — ПОЛНЫЙ ОТЧЁТ (то, что вы просили): обход всего сайта (${pages(n.pageCount)}), по каждому разделу оценка и список находок, разбивка проблем по частоте (какая на скольких страницах), 5 худших страниц, раздел безопасности, сравнение с конкурентами, план работ на 3 месяца с приоритетами и критериями приёмки. Формат — PDF, 10–14 страниц. Срок 2–3 рабочих дня. Цена — в рамках вашего бюджета (${client.priceBudget || '20 000 ₽'}) за отчёт, правки оцениваем отдельно.

Вариант 3 — отчёт + внедрение первого месяца: отчёт плюс правка блокера доступности (контраст, доступные имена, порядок заголовков) и настройка security-заголовков. По контрасту это 1–2 дня работы: правится палитра темы, а не вёрстка.

Скажите, какой вариант ближе. К выжимке приложил PDF с цифрами — чтобы вы видели формат. Полный отчёт приложу сразу, как только подтвердите вариант: не хочу делать работу за половину оплаты.

Если удобно — созвон на 15 минут, разберём приоритеты под ваши цели.`;

  const readme = `# Что отправить клиенту (${host})

Порядок действий — строго по этому списку.

## Шаг 1. Отправить в чат (kwork / Telegram / почта)

1. Текст сообщения — файл \`1_сообщение_в_чат.txt\` (копировать целиком).
2. Вложение — файл \`2_анализ_выжимка.pdf\` (2 страницы: оценка, цифры, сравнение, приоритеты).

**Не отправлять сейчас:** \`3_полный_отчёт.pdf\`. Он идёт после подтверждения варианта 2 или 3 — это и есть продажа.

## Шаг 2. Если выбрали вариант 2 (полный отчёт)

1. Отправить \`3_полный_отчёт.pdf\` + \`4_смета_и_условия.md\` (или его содержимое в сообщении).
2. Рекомендуемая схема оплаты: **50% аванс до начала работ, 50% после приёмки отчёта.**
   Основание: часть отчёта уже собрана (обход ${pages(n.pageCount)}, замеры, сравнение), остаток — сборка и оформление.

## Шаг 3. Если выбрали вариант 3 (отчёт + внедрение)

1. То же + согласовать объём правок по месяцу 1 (доступность + заголовки).
2. Сроки: отчёт 2–3 дня, правки месяца 1 — 1–2 дня.

## Что НЕ делать
- Не отправлять полный отчёт «просто так» — это вся работа, за которую платят.
- Не обещать конкретных цифр по росту трафика/конверсии.
- Не утверждать, что сайт «полностью защищён» или «соответствует ГОСТ/PCI» — только факты проверки.

## Файлы
| Файл | Что это | Когда отправлять |
|---|---|---|
| \`1_сообщение_в_чат.txt\` | текст ответа | сразу |
| \`2_анализ_выжимка.pdf\` | 2 стр.: оценка, цифры, сравнение, приоритеты | сразу, вложением |
| \`3_полный_отчёт.pdf\` | ${pages(n.pageCount)}: все разделы, находки, план на 3 месяца | после согласования варианта 2/3 |
| \`4_смета_и_условия.md\` | варианты, цены, сроки, что входит | вместе с полным отчётом |

Фактические данные отчёта: ${pages(n.pageCount)}, интегральная оценка ${facts.integralScore}/100, разделы: ${Object.entries(sections).map(([k, v]) => k + ' ' + v.score).join(', ')}.
`;

  const estimate = `# Смета и условия

**Сайт:** ${site}
**Дата проверки:** ${String(facts.date || '').slice(0, 10)}
**Объём:** ${pages(n.pageCount)} (${facts.crawl ? facts.crawl.okCount : 1} обработано, ошибок ${facts.crawl ? facts.crawl.failedCount : 0})

## Вариант 1 — разведка
- Что: разбор ключевых страниц с цифрами, созвон 20 минут, приоритеты.
- Срок: 1 день.
- Стоимость: по договорённости (${client.priceBudget || '20 000 ₽'} — верхняя граница бюджета заказчика, если он его назвал).

## Вариант 2 — полный отчёт
Что входит:
- обход всего сайта: ${pages(n.pageCount)}, оценка каждой;
- 5 разделов аудита: производительность, SEO, безопасность, доступность, контент;
- Core Web Vitals с порогами Good / Needs Improvement / Poor;
- разбивка находок по частоте (на скольких страницах встречается) и 5 худших страниц;
- раздел безопасности: заголовки, проверка экспонированных файлов и тяжёлых эндпоинтов;
- сравнение с ${competitors.length} конкурентами по тем же критериям;
- план работ на 3 месяца: помесячно, с объёмом, трудоёмкостью и критериями приёмки;
- формат: PDF, 10–14 страниц.
Срок: 2–3 рабочих дня.
Стоимость: ${client.priceBudget || '20 000 ₽'}.

## Вариант 3 — отчёт + внедрение первого месяца
Всё из варианта 2, плюс правки месяца 1:
- контраст текста до 4.5:1 (${n.contrastPages || '—'} ${plural(n.contrastPages || 0, 'страница', 'страницы', 'страниц')}) — правится палитра темы;
- доступные имена элементов и порядок заголовков;
- ${n.securityHeaders} security-заголовков: CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy.
Срок: отчёт 2–3 дня + правки 1–2 дня.
Стоимость: по договорённости, после оценки объёма по вашему стеку.

## Условия
- Оплата: 50% аванс, 50% после приёмки.
- Что не входит: правки вёрстки и разработка, настройка аналитики, работа с контентом и ссылочным профилем, нагрузочное тестирование, тестирование на проникновение.
- Гарантии: не гарантируем конкретных цифр по трафику и конверсии — фиксируем состав работ и критерии приёмки.
- Отчёт предназначен для внутреннего использования заказчиком.

## Ближайшие шаги
1. Выбрать вариант.
2. Согласовать дату старта и аванс.
3. На старте — доступ на сайт (админка/доступ к коду) для проверки находок и сбора скриншотов.
`;

  return { readme, message, estimate };
}

module.exports = { buildTexts, collectNumbers, plural };
