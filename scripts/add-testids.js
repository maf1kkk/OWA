/**
 * Расставить data-testid в веб-интерфейсе: стабильные селекторы для E2E.
 * Разовая утилита, запускается вручную: node scripts/add-testids.js
 */
const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'web', 'index.html');
let s = fs.readFileSync(p, 'utf8');

const map = [
  ['<input type="url" id="url" placeholder="https://example.com"', '<input type="url" id="url" data-testid="analyze-url" placeholder="https://example.com"'],
  ['<button class="primary" id="btn" type="submit">', '<button class="primary" id="btn" data-testid="analyze-run" type="submit">'],
  ['<div id="result"></div>', '<div id="result" data-testid="analyze-result"></div>'],
  ['<input type="url" id="auditUrl" placeholder="https://example.com"', '<input type="url" id="auditUrl" data-testid="audit-url" placeholder="https://example.com"'],
  ['<button class="primary" id="auditBtn" type="submit">', '<button class="primary" id="auditBtn" data-testid="audit-run" type="submit">'],
  ['<div id="auditResult"></div>', '<div id="auditResult" data-testid="audit-result"></div>'],
  ['<input type="url" id="crawlUrl" placeholder="https://example.com"', '<input type="url" id="crawlUrl" data-testid="crawl-url" placeholder="https://example.com"'],
  ['<button class="primary" id="crawlBtn" type="submit">', '<button class="primary" id="crawlBtn" data-testid="crawl-run" type="submit">'],
  ['<div id="crawlResult"></div>', '<div id="crawlResult" data-testid="crawl-result"></div>'],
  ['<input type="url" id="compareTarget" placeholder="https://client-site.com"', '<input type="url" id="compareTarget" data-testid="compare-target" placeholder="https://client-site.com"'],
  ['<button class="primary" id="compareBtn" type="submit">', '<button class="primary" id="compareBtn" data-testid="compare-run" type="submit">'],
  ['<input type="text" id="compareWith" placeholder=', '<input type="text" id="compareWith" data-testid="compare-with" placeholder='],
  ['<div id="compareResult"></div>', '<div id="compareResult" data-testid="compare-result"></div>'],
  ['<select id="histUrl">', '<select id="histUrl" data-testid="history-url">'],
  ['<button class="ghost" id="btnRefreshHistory">', '<button class="ghost" id="btnRefreshHistory" data-testid="history-refresh">'],
  ['<table id="historyTable">', '<table id="historyTable" data-testid="history-table">'],
  ['<a class="ghost" id="btnPdf" href="#" download>', '<a class="ghost" id="btnPdf" data-testid="analyze-pdf" href="#" download>'],
  ['<a href="#" id="navAnalyze"', '<a href="#" id="navAnalyze" data-testid="nav-analyze"'],
  ['<a href="#" id="navAudit"', '<a href="#" id="navAudit" data-testid="nav-audit"'],
  ['<a href="#" id="navCrawl"', '<a href="#" id="navCrawl" data-testid="nav-crawl"'],
  ['<a href="#" id="navCompare"', '<a href="#" id="navCompare" data-testid="nav-compare"'],
  ['<a href="#" id="navHistory"', '<a href="#" id="navHistory" data-testid="nav-history"'],
  ['<a href="#" id="navSession"', '<a href="#" id="navSession" data-testid="nav-session"'],
];

let n = 0;
for (const [from, to] of map) {
  if (s.includes(from)) {
    s = s.replace(from, to);
    n += 1;
  } else {
    console.log('НЕ НАЙДЕНО: ' + from.slice(0, 60));
  }
}
fs.writeFileSync(p, s);
console.log('заменено: ' + n + ' из ' + map.length);
