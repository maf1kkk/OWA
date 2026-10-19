/**
 * Профиль клиента: что отчёт должен учитывать помимо измерений.
 *
 * Профиль хранится как JSON в clients/<slug>.json. Он влияет ТОЛЬКО на
 * формулировки и порядок подачи — измеренные значения, пороги и вердикты
 * профиль изменить не может.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CLIENTS_DIR = path.join(__dirname, '..', '..', 'clients');

const TONES = ['business', 'technical', 'friendly', 'neutral'];
const FOCUS_SECTIONS = ['performance', 'seo', 'security', 'accessibility', 'content'];

/**
 * Загрузить и нормализовать профиль.
 * @param {string} slug — имя файла без расширения (или путь к .json)
 * @returns {object|null} профиль или null, если не найден
 */
function loadProfile(slug) {
  if (!slug) return null;
  const candidates = [];
  if (slug.endsWith('.json')) {
    candidates.push(path.isAbsolute(slug) ? slug : path.join(CLIENTS_DIR, slug));
  } else {
    candidates.push(path.join(CLIENTS_DIR, `${slug}.json`));
    candidates.push(path.isAbsolute(slug) ? slug : path.resolve(slug));
  }

  let file = null;
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      file = c;
      break;
    }
  }
  if (!file) return null;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Профиль клиента повреждён: ${file}: ${err.message}`);
  }
  return normalizeProfile(raw, path.basename(file, '.json'));
}

/** Нормализовать и проверить профиль. */
function normalizeProfile(raw, slug = '') {
  const profile = {
    slug: raw.slug || slug,
    name: str(raw.name),
    industry: str(raw.industry),
    siteUrl: str(raw.siteUrl),
    language: raw.language === 'en' ? 'en' : 'ru',
    tone: TONES.includes(raw.tone) ? raw.tone : 'business',
    focus: Array.isArray(raw.focus)
      ? raw.focus.filter((f) => FOCUS_SECTIONS.includes(f))
      : [],
    competitors: Array.isArray(raw.competitors)
      ? raw.competitors.map((c) => str(c)).filter((c) => /^https?:\/\//i.test(c))
      : [],
    contact: {
      name: str(raw.contact && raw.contact.name),
      email: str(raw.contact && raw.contact.email),
      site: str(raw.contact && raw.contact.site),
      telegram: str(raw.contact && raw.contact.telegram),
    },
    branding: {
      color: str(raw.branding && raw.branding.color),
      note: str(raw.branding && raw.branding.note),
    },
    notes: str(raw.notes),
  };
  return profile;
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** Текстовое описание профиля для промпта (пустая строка, если профиля нет). */
function profileToPromptText(profile) {
  if (!profile) return '';
  const lines = [];
  if (profile.name) lines.push(`Клиент: ${profile.name}`);
  if (profile.industry) lines.push(`Отрасль: ${profile.industry}`);
  if (profile.siteUrl) lines.push(`Сайт клиента: ${profile.siteUrl}`);
  lines.push(`Язык отчёта: ${profile.language === 'en' ? 'English' : 'русский'}`);
  lines.push(`Тон изложения: ${toneLabel(profile.tone)}`);
  if (profile.focus.length) lines.push(`Приоритетные разделы: ${profile.focus.join(', ')}`);
  if (profile.competitors.length) lines.push(`Конкуренты для сравнения: ${profile.competitors.join(', ')}`);
  if (profile.notes) lines.push(`Примечания об клиенте: ${profile.notes}`);
  return lines.join('\n');
}

function toneLabel(tone) {
  return {
    business: 'деловой, для владельца бизнеса',
    technical: 'технический, для ИТ-специалиста',
    friendly: 'разговорный, без канцелярита',
    neutral: 'нейтральный',
  }[tone] || 'деловой';
}

module.exports = { loadProfile, normalizeProfile, profileToPromptText, CLIENTS_DIR, TONES, FOCUS_SECTIONS };
