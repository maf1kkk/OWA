/**
 * Общий рендер HTML -> PDF через headless Chromium.
 *
 * Используется всеми типами отчётов (анализ, аудит, обход, сравнение, сессия),
 * чтобы вёрстка, поля страницы и лимит размера были одинаковыми.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { launchBrowser } = require('../browser');

const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * Отрисовать HTML в PDF-файл.
 * @param {string} html
 * @param {string} outPath
 * @returns {Promise<{path: string, bytes: number}>}
 */
async function renderPdf(html, outPath) {
  const browser = await launchBrowser(true);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
      displayHeaderFooter: false,
    });
    await context.close();

    if (buffer.length > MAX_PDF_BYTES) {
      throw new Error('PDF слишком большой: ' + buffer.length + ' байт (лимит ' + MAX_PDF_BYTES + ')');
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buffer);
    return { path: outPath, bytes: buffer.length };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { renderPdf, MAX_PDF_BYTES };
