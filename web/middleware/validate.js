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
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  // express.json(): невалидный JSON тела
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'INVALID_JSON', message: 'Невалидный JSON' });
  }
  if (err && err.status && err.status < 500) {
    return res.status(err.status).json({ error: 'BAD_REQUEST', message: err.message });
  }
  // В проде здесь будет pino (итерация 6); stderr — не содержит секретов
  console.error('[error]', err);
  return res
    .status(500)
    .json({ error: 'INTERNAL', message: String((err && err.message) || err) });
}

function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Не найдено' });
}

module.exports = { HttpError, parseOrThrow, validateBody, validateQuery, validateParams, errorHandler, notFoundHandler };
