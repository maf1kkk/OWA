/**
 * Валидация входных данных (zod) и формат ошибок API.
 *
 * Формат ошибки (ТЗ 7.2): HTTP-статус + JSON { error: CODE, message: string }.
 */
'use strict';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Разобрать значение zod-схемой, при неудаче — HttpError 400. */
function parseOrThrow(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0] || {};
    const where = issue.path && issue.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HttpError(400, 'VALIDATION', `${where}${issue.message}`);
  }
  return parsed.data;
}

const validateBody = (schema) => (req, _res, next) => {
  try {
    req.valid = { ...req.valid, ...parseOrThrow(schema, req.body ?? {}) };
    next();
  } catch (err) {
    next(err);
  }
};

const validateQuery = (schema) => (req, _res, next) => {
  try {
    req.valid = { ...req.valid, ...parseOrThrow(schema, req.query ?? {}) };
    next();
  } catch (err) {
    next(err);
  }
};

const validateParams = (schema) => (req, _res, next) => {
  try {
    req.valid = { ...req.valid, ...parseOrThrow(schema, req.params ?? {}) };
    next();
  } catch (err) {
    next(err);
  }
};

/** Express 5 сам передаёт rejected promise в error-handler. */
function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    if (err.wwwAuthenticate) res.set('WWW-Authenticate', err.wwwAuthenticate);
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  // express.json(): невалидный JSON тела
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON', message: 'Невалидный JSON' });
  }
  // слишком большое тело
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: 'Тело запроса слишком велико' });
  }
  if (err && err.status && err.status < 500) {
    return res.status(err.status).json({ error: 'BAD_REQUEST', message: err.message });
  }
  // Детали внутренних ошибок — только в лог, наружу нейтральный ответ,
  // иначе через message утекают пути, SQL и стектрейсы Playwright.
  console.error('[error]', err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'INTERNAL', message: 'Внутренняя ошибка сервера' });
}

function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Не найдено' });
}

module.exports = { HttpError, parseOrThrow, validateBody, validateQuery, validateParams, errorHandler, notFoundHandler };
