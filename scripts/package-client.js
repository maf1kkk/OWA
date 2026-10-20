/**
 * Сборка пакета для отправки клиенту.
 *
 * Папка содержит:
 *   0_README_что_отправить.md   — что и в каком порядке отправлять
 *   1_сообщение_в_чат.txt       — готовый текст ответа
 *   2_анализ_выжимка.pdf        — PDF, который прикладываем к сообщению
 *   3_полный_отчёт.pdf          — полный отчёт (отправлять после оплаты/согласия)
 *   4_смета_и_условия.md        — варианты, цены, сроки, что входит
 *
 * Использование:
 *   node scripts/package-client.js --data out/neurobober-full.json --out out/neurobober
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { generateFullPdf } = require('../src/report/full-pdf');
const { generateSummaryPdf } = require('../src/report/summary-pdf');
const { buildTexts } = require('../src/report/client-package-texts');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const dataPath = arg('data');
const outDir = arg('out');
if (!dataPath || !outDir) {
  console.error('Нужны --data <файл с фактами и текстом> и --out <папка>');
  process.exit(2);
}

// Реквизиты клиента: из профиля clients/<slug>.json или из аргументов.
const clientSlug = arg('client', '');
let profile = null;
if (clientSlug) {
  const file = path.join(__dirname, '..', 'clients', clientSlug.endsWith('.json') ? clientSlug : clientSlug + '.json');
  if (!fs.existsSync(file)) {
    console.error('Профиль клиента не найден: ' + file);
    process.exit(2);
  }
  profile = JSON.parse(fs.readFileSync(file, 'utf8'));
}

const client = {
  name: arg('client-name', profile && profile.name ? profile.name : ''),
  siteUrl: arg('client-site', profile && profile.siteUrl ? profile.siteUrl : ''),
  contacts: arg('contacts', profile && profile.contacts ? profile.contacts : ''),
  executor: arg('executor', profile && profile.executor ? profile.executor : 'Максим Устименко'),
  priceBudget: arg('price', profile && profile.priceBudget ? profile.priceBudget : '20 000 ₽'),
};

const payload = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const facts = payload.facts;
const narrative = payload.narrative;
if (!facts || !narrative) {
  console.error('В файле нет facts/narrative');
  process.exit(2);
}

const branding = {
  title: 'Анализ сайта ' + facts.url.replace(/^https?:\/\//, ''),
  client: client.name || '',
  executor: client.executor || 'Максим Устименко',
  contacts: client.contacts || '',
  footerLeft: 'Анализ сайта ' + facts.url.replace(/^https?:\/\//, ''),
};

(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  const texts = buildTexts({ facts, narrative, client });
  fs.writeFileSync(path.join(outDir, '0_README_что_отправить.md'), texts.readme, 'utf8');
  fs.writeFileSync(path.join(outDir, '1_сообщение_в_чат.txt'), texts.message, 'utf8');
  fs.writeFileSync(path.join(outDir, '4_смета_и_условия.md'), texts.estimate, 'utf8');

  const summaryPath = path.join(outDir, '2_анализ_выжимка.pdf');
  const fullPath = path.join(outDir, '3_полный_отчёт.pdf');

  await generateSummaryPdf({
    facts,
    narrative,
    branding,
    nextStep: 'Полный отчёт по ' + (facts.crawl ? facts.crawl.pageCount : 1) + ' страницам (разбивка находок по частоте, худшие страницы, безопасность, сравнение с конкурентами, план работ на 3 месяца с критериями приёмки) — 10–14 страниц, 2–3 рабочих дня. Готовлю сразу после вашего подтверждения.',
  }, summaryPath);

  await generateFullPdf({ facts, narrative, branding, profile }, fullPath);

  console.log('Пакет собран: ' + outDir);
  for (const f of fs.readdirSync(outDir)) {
    const s = fs.statSync(path.join(outDir, f));
    console.log('  ' + (s.isDirectory() ? '[dir] ' : String(s.size).padStart(7) + ' Б  ') + f);
  }
})().catch((err) => {
  console.error('Ошибка сборки пакета: ' + (err && err.message || err));
  process.exit(1);
});
