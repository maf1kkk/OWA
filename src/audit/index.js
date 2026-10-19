/**
 * Полный комплексный аудит по одному URL: общий AuditSession + все секции.
 *
 * Использование:
 *   const { runFullAudit } = require('../src/audit');
 *   const result = await runFullAudit('https://example.com', { timeout: 60000, waitAfterLoad: 2500 });
 *
 * Возвращает схему AuditOrchestrator + поле sections (ссылки на AuditSection).
 */
'use strict';

const { AuditOrchestrator } = require('../core/orchestrator');
const { AuditSession } = require('./session');
const { createAllSections, sectionByType } = require('./sections');

/**
 * Запустить полный аудит (Performance, SEO, Security, Accessibility, Content).
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<Object>} схема аудита + raw
 */
async function runFullAudit(url, options = {}) {
  const session = new AuditSession({
    url,
    timeout: Number.isFinite(options.timeout) ? options.timeout : 60000,
    waitAfterLoad: Number.isFinite(options.waitAfterLoad) ? options.waitAfterLoad : 2500,
  });
  await session.start();

  const types = Array.isArray(options.sections) && options.sections.length
    ? options.sections.map((t) => sectionByType(t)).filter(Boolean)
    : createAllSections();

  const orchestrator = new AuditOrchestrator({
    url,
    sections: types,
    context: { session },
    concurrency: Number.isFinite(options.concurrency) ? options.concurrency : 5,
    retries: 1,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000,
    logger: options.logger || (() => {}),
  });

  try {
    return await orchestrator.run();
  } finally {
    await session.close();
  }
}

module.exports = { runFullAudit };