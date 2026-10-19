/**
 * Ядро оркестрации комплексного аудита.
 *
 * Каждый AuditSection - независимая проверка с единым интерфейсом:
 *   run(url, context) -> Promise<SectionResult>
 * Оркестратор запускает все секции параллельно (с ограничением p-queue),
 * собирает результаты в единую схему, вычисляет интегральную оценку.
 * Падение одной секции не роняет весь аудит.
 */
'use strict';

const PQueue = require('p-queue').default;
const pRetry = require('p-retry').default;

/** Интегральная оценка: средневзвешенная по включённым успешным секциям. */
const SECTION_WEIGHTS = {
  performance: 0.3,
  seo: 0.25,
  security: 0.2,
  accessibility: 0.15,
  content: 0.1,
};

/** Замерить время выполнения асинхронной секции. */
async function timedTask(task) {
  const start = Date.now();
  const result = await task();
  return { result, durationMs: Date.now() - start };
}

/**
 * Нормализовать результат секции: если секция вернула null/undefined или выбросила
 * исключение - превратить в failed-объект, а не проглатывать.
 */
function normalizeSectionResult(section, value) {
  if (value && typeof value.score === 'number') {
    return {
      status: 'ok',
      score: value.score,
      issues: Array.isArray(value.issues) ? value.issues : [],
      raw: value.raw || value,
      error: null,
      durationMs: value.durationMs || null,
    };
  }
  if (value && typeof value === 'object' && 'status' in value) {
    return value;
  }
  return {
    status: 'failed',
    score: null,
    issues: [],
    raw: value,
    error: String(value && value.message ? value.message : value || 'секция не вернула данные'),
    durationMs: null,
  };
}

/**
 * Класс оркестратора аудита.
 */
class AuditOrchestrator {
  constructor(options = {}) {
    this.url = options.url;
    this.sections = options.sections || [];
    this.concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 5;
    this.retries = Number.isFinite(options.retries) ? options.retries : 2;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
    this.context = options.context || {};
    this.logger = options.logger || (() => {});
  }

  /**
   * Запустить все секции, собрать результат.
   * @returns {Promise<Object>} единая схема аудита.
   */
  async run() {
    if (!this.url) {
      throw new Error('URL не задан для аудита');
    }

    const queue = new PQueue({ concurrency: this.concurrency });
    const startedAt = new Date().toISOString();

    const results = await Promise.all(
      this.sections.map((section) =>
        queue.add(async () => {
          const sectionName = section && section.name ? section.name : section.constructor && section.constructor.name ? section.constructor.name : 'unknown';
          if (!section || typeof section.run !== 'function') {
            return {
              [sectionName]: {
                status: 'failed',
                score: null,
                issues: [],
                raw: null,
                error: 'неверная секция: отсутствует метод run()',
                durationMs: null,
              },
            };
          }

          let outcome;
          try {
            outcome = await pRetry(
              async () => {
                const { result, durationMs } = await timedTask(() =>
                  Promise.race([
                    section.run(this.url, this.context),
                    new Promise((_, reject) =>
                      setTimeout(
                        () => reject(new Error('таймаут секции ' + sectionName + ' > ' + this.timeoutMs + ' мс')),
                        this.timeoutMs
                      )
                    ),
                  ])
                );
                return Object.assign({}, result, { durationMs });
              },
              {
                retries: this.retries,
                shouldRetry: (error) => {
                  const msg = String((error && error.message) || '');
                  return !/неверная секция/.test(msg) && !/не найдено/.test(msg);
                },
                onFailedAttempt: (attempt) => {
                  this.logger('повтор ' + sectionName + ' после неудачи: ' + attempt.attemptNumber);
                },
              }
            );
          } catch (err) {
            outcome = null;
            this.logger('секция ' + sectionName + ' завершилась ошибкой: ' + String((err && err.message) || err));
          }

          let normalized;
          if (outcome) {
            normalized = normalizeSectionResult(section, outcome);
          } else {
            normalized = {
              status: 'failed',
              score: null,
              issues: [],
              raw: null,
              error: 'секция завершилась ошибкой',
              durationMs: null,
            };
          }
          if (outcome && outcome.durationMs !== undefined) {
            normalized.durationMs = outcome.durationMs;
          }

          this.logger('секция ' + sectionName + ': status=' + normalized.status + ', duration=' + normalized.durationMs + ' мс');
          return { [sectionName]: normalized };
        })
      )
    );

    const sectionResults = results.reduce((acc, r) => Object.assign(acc, r), {});

    const successful = Object.entries(sectionResults)
      .filter(([, r]) => r.status === 'ok')
      .map(([name, r]) => ({ name, score: r.score, weight: SECTION_WEIGHTS[name] || 0.1 }));

    let integralScore = 0;
    const weightSum = successful.reduce((s, x) => s + x.weight, 0);
    if (weightSum > 0) {
      const weighted = successful.reduce((s, x) => s + x.score * x.weight, 0);
      integralScore = Math.round(weighted / weightSum);
    }

    const issues = Object.values(sectionResults)
      .filter((r) => r.status === 'ok')
      .flatMap((r) => r.issues || [])
      .map((i) => ({ ...i }));

    const failedSections = Object.entries(sectionResults)
      .filter(([, r]) => r.status !== 'ok')
      .map(([n]) => n);

    const finishedAt = new Date().toISOString();

    return {
      schemaVersion: 2,
      tool: 'owa',
      url: this.url,
      timestamp: startedAt,
      finishedAt,
      scores: sectionResults,
      integralScore,
      issues,
      failedSections,
      raw: sectionResults,
      summary: {
        status: failedSections.length === 0 ? 'ok' : 'partial',
        failedSections,
        issueCount: issues.length,
      },
    };
  }
}

module.exports = { AuditOrchestrator, SECTION_WEIGHTS, normalizeSectionResult };