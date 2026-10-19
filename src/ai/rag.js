/**
 * RAG для отчётов: поиск релевантных выдержек из базы знаний.
 *
 * Корпус — markdown-файлы в src/ai/knowledge. Документ режется на чанки
 * по заголовкам второго уровня (`## `), чтобы в контекст попадала ровно та
 * часть, которая относится к теме.
 *
 * Поиск лексический (BM25-подобный) — без внешних зависимостей, без сети,
 * детерминированный: одинаковый запрос всегда даёт одинаковую выдачу.
 * Русская морфология учитывается грубой нормализацией окончаний.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');

/** Стоп-слова русского/английского — не участвуют в скоринге. */
const STOP_WORDS = new Set([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'она',
  'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'только', 'ее',
  'мне', 'было', 'вот', 'от', 'меня', 'еще', 'нет', 'о', 'из', 'ему', 'теперь', 'когда',
  'даже', 'ну', 'вдруг', 'ли', 'если', 'уже', 'или', 'ни', 'быть', 'был', 'него', 'до',
  'вас', 'нибудь', 'опять', 'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей',
  'может', 'они', 'тут', 'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя', 'их', 'чем',
  'была', 'сам', 'чтоб', 'без', 'будто', 'чего', 'раз', 'тоже', 'себе', 'под', 'будет',
  'ж', 'тогда', 'кто', 'этот', 'того', 'потому', 'этого', 'какой', 'совсем', 'ним',
  'здесь', 'этом', 'один', 'почти', 'мой', 'тем', 'чтобы', 'нее', 'были', 'куда', 'зачем',
  'всех', 'никогда', 'можно', 'при', 'наконец', 'два', 'об', 'другой', 'хоть', 'после',
  'над', 'больше', 'тот', 'через', 'эти', 'нас', 'про', 'всего', 'них', 'какая', 'много',
  'разве', 'три', 'эту', 'моя', 'впрочем', 'свою', 'этой', 'перед', 'иногда', 'лучше',
  'чуть', 'том', 'нельзя', 'такой', 'им', 'более', 'всегда', 'конечно', 'всю', 'между',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'have', 'has',
]);

/** Грубая нормализация русского окончания (достаточно для поиска по чанкам). */
function stem(word) {
  let w = word;
  if (w.length > 6) {
    w = w.replace(/(ами|ями|ого|его|ому|ему|ыми|ими|ая|яя|ое|ее|ые|ие|ам|ям|ах|ях|ов|ев|ую|юю|ой|ей)$/u, '');
  } else if (w.length > 4) {
    w = w.replace(/(ам|ям|ах|ях|ов|ев|ую|юю|ой|ей|ая|яя|ое|ее|ые|ие|ам|ом|ем|ы|и|у|ю|а|я|о|е)$/u, '');
  }
  return w;
}

/** Разбить текст на токены (нормализованные). */
function tokenize(text) {
  const raw = String(text || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9#+.-]+/giu, ' ');
  const out = [];
  for (const t of raw.split(/\s+/)) {
    const clean = t.replace(/^[.+-]+|[.+-]+$/g, '');
    if (!clean || clean.length < 2) continue;
    if (STOP_WORDS.has(clean)) continue;
    out.push(stem(clean));
  }
  return out;
}

let cache = null;

/** Загрузить корпус (файлы *.md в knowledge/) и нарезать на чанки. */
function loadCorpus(dir = KNOWLEDGE_DIR) {
  if (cache && cache.dir === dir) return cache.chunks;

  const chunks = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    files = [];
  }

  for (const file of files) {
    const full = path.join(dir, file);
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split(/\r?\n/);
    let docTitle = file.replace(/\.md$/, '');
    let heading = null;
    let buffer = [];

    const flush = () => {
      const body = buffer.join('\n').trim();
      if (!body) return;
      const id = heading ? `${docTitle}#${slug(heading)}` : docTitle;
      chunks.push({
        id,
        file,
        doc: docTitle,
        heading: heading || '',
        text: body,
        tokens: tokenize(`${heading || ''}\n${body}`),
      });
      buffer = [];
    };

    for (const line of lines) {
      if (line.startsWith('# ')) {
        flush();
        docTitle = line.slice(2).trim();
        heading = null;
        continue;
      }
      if (line.startsWith('## ')) {
        flush();
        heading = line.slice(3).trim();
        continue;
      }
      buffer.push(line);
    }
    flush();
  }

  cache = { dir, chunks };
  return chunks;
}

/** Слаг для идентификатора чанка. */
function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Найти релевантные чанки.
 *
 * @param {string} query — поисковый запрос (обычно собран из id правил и текста проблем)
 * @param {object} [opts]
 * @param {number} [opts.topK=6] — сколько чанков вернуть
 * @param {string[]} [opts.boostTerms] — термины с дополнительным весом (id правил)
 * @param {number} [opts.maxChars=12000] — лимит на общий объём контекста
 * @returns {Array<{id, file, heading, text, score}>}
 */
function retrieve(query, opts = {}) {
  const topK = Number.isFinite(opts.topK) ? opts.topK : 6;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 12000;
  const chunks = loadCorpus();
  if (!chunks.length) return [];

  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const qSet = new Set(qTokens);

  // Частота терминов в корпусе — для BM25.
  const df = new Map();
  const totalLen = chunks.reduce((s, c) => s + c.tokens.length, 0);
  const avgLen = totalLen / Math.max(1, chunks.length);
  for (const c of chunks) {
    for (const t of new Set(c.tokens)) df.set(t, (df.get(t) || 0) + 1);
  }

  const boost = new Set((opts.boostTerms || []).map((t) => String(t).toLowerCase()));
  const k1 = 1.5;
  const b = 0.75;

  const scored = chunks.map((c) => {
    const tf = new Map();
    for (const t of c.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const term of qSet) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) || 0;
      const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (c.tokens.length / avgLen))));
    }
    // Прямое вхождение id правила (например «seo-no-title») — сильный сигнал.
    const lowerText = c.text.toLowerCase();
    for (const term of boost) {
      if (term && lowerText.includes(term)) score += 12;
    }
    return { ...c, score };
  });

  scored.sort((a, b2) => b2.score - a.score);

  const picked = [];
  let chars = 0;
  for (const c of scored) {
    if (c.score <= 0) break;
    if (picked.length >= topK) break;
    if (chars + c.text.length > maxChars && picked.length) continue;
    picked.push({ id: c.id, file: c.file, heading: c.heading, text: c.text, score: Math.round(c.score * 100) / 100 });
    chars += c.text.length;
  }
  return picked;
}

/** Сбросить кэш корпуса (для тестов). */
function resetCorpus() {
  cache = null;
}

module.exports = { retrieve, loadCorpus, tokenize, stem, slug, resetCorpus, KNOWLEDGE_DIR };
