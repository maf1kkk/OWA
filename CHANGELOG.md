# Changelog

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

## [Unreleased]

### Added
- `src/browser.js` — единый запуск браузера: сначала Chromium из кэша Playwright, при его отсутствии — системный Chrome, затем Edge (тот же движок). Канал задаётся `OWA_BROWSER_CHANNEL=chrome|msedge`; при полном отсутствии браузера — понятная ошибка с командами, а не стектрейс Playwright.
- `OWA_BROWSER_CHANNEL` в `.env.example` (CLI и MCP-сервер грузят `.env` через `src/browser.js`, реальный env приоритетнее).
- `opencode.json` в корне — MCP-серверы для разработки: `context7` (актуальные доки библиотек), `playwright` и `chrome-devtools` (браузер для проверки веб-интерфейса), `memory`, `sequential-thinking`, `owa` (собственный MCP-сервер проекта).

### Fixed
- OWA падал с `Executable doesn't exist ... ms-playwright` на машинах без кэша Playwright (нет доступа к CDN) — теперь используется системный Chromium-браузер.
- `scripts/check-env.js` больше не считает это фатальной проблемой, если найден системный Chrome/Edge: сообщает `[!]` и подсказку, код выхода `0`.
- Документация подключения MCP (`mcp/server.js`, `README.md`) обновлена с устаревшего формата opencode v1 (`mcp.owa`) на v2 (`mcp.servers.owa`).

## [1.1.0] — 2026-10-10

### Added
- `start.bat` (Windows) и `start.sh` (Unix) — идемпотентный запуск с нуля: проверка Node.js (минимум 22.16), установка зависимостей, установка Chromium Playwright, создание `.env` из `.env.example`.
- `scripts/check-env.js` — проверка окружения (`npm run check-env`) с режимом `--fix`. Коды выхода: `0` готово, `1` проблема, `3` `.env` создан — заполни и перезапусти.
- `.env.example` — образец конфигурации: сервер (`PORT`, `HOST`), Basic Auth, Bearer-токен, GLM (OpenAI-совместимый endpoint).
- `.gitattributes` — LF для исходников, CRLF для `.bat`.
- `engines: { "node": ">=22.16.0" }` в `package.json`.
- **SQLite** (`better-sqlite3`, `data/owa.db`, WAL, `foreign_keys=ON`): `src/db/` — открытие БД, миграции по `PRAGMA user_version` (`src/db/migrations/001_init.sql`), репозитории `analyses` / `code_findings` / `ai_responses` / `settings`; `npm run migrate`.
- **HTTP API** (Express 5): `GET /health`, `GET /api/history`, `GET /api/history/:id`, `DELETE /api/history/:id` (каскадно), `DELETE /api/history` (очистка); `POST /api/analyze` теперь сохраняет запуск в историю (отключается флагом `save: false`) и возвращает `analysisId`.
- zod-валидация входных данных, формат ошибок `{ error: CODE, message: string }`.
- Тесты: `test/db.test.js`, `test/web.test.js`.

- **Статический анализ кода** (`src/static-analyzer/`): сбор исходников через Playwright (`fetch-sources.js`, лимиты ТЗ — 50 файлов/2 МБ, остальное в `truncated`), правила CSS (`css-rules.js`: синтаксис csstree-validator, `!important`, дубли/пустые/неиспользуемые селекторы, файл > 5000 строк), HTML (`html-rules.js` на html-validate: lang, alt, дубли id, deprecated, синтаксис), JS (`js-rules.js` на espree: `console.*`/`debugger`/`eval`, размер, синтаксис), приведение к формату findings + аддитивные `severity`/`rule`/`location`/`suggestion` (`to-findings.js`).
- **Сессии статанализа с продолжением** (по согласованию с заказчиком): таблица `code_sessions` (миграция 002), этапы `fetch → css → js → done`, прогресс (`step`/`cursor`) и сжатые исходники (`sources_gz`) в SQLite; `POST /api/code-analysis` — `{url}` создаёт сессию, `{sessionId}` продолжает следующим батчем (10 файлов), в конце `done: true` + `summary`.
- **CLI `--code`** — статический анализ в том же отчёте (секция «Статический анализ кода» в `printReport`/`toMarkdown` через `data.codeFindings`).
- Тесты: `test/code-analysis.test.js`, `test/code-session.test.js`.
- **AI-объяснения (GLM 4.5)** (`src/ai/`): клиент через официальный SDK `openai` (OpenAI-совместимый endpoint, `GLM_BASE_URL`/`GLM_MODEL`, модель `glm-4.5`), таймаут 30 с (`GLM_TIMEOUT_MS`), retry ровно 1 раз только на 5xx, ошибки нормализованы к `{ error: 'AI_TIMEOUT' | 'AI_ERROR' }` (504/502, нет ключа — 400 `AI_NOT_CONFIGURED`); кэш ответов в `ai_responses` по `sha256(model + prompt)`; `POST /api/ai/explain { analysisId, force? }` и флаг `explain` в `POST /api/code-analysis` заполняют `code_findings.ai_explanation` (поле `aiExplanation` в находках). Секреты (ключ, промпты, ответы LLM) не логируются.
- Тесты: `test/ai.test.js` — мок OpenAI-совместимого сервера: кэш (1 живой вызов на повтор), retry на 502, `AI_ERROR` на 500×2, `AI_TIMEOUT`, коды 400/404/502/504; интеграция `explain` в `test/code-session.test.js` (итого 76).

### Changed
- `src/report.js`: аддитивные секции `codeFindings`/`codeSummary`/`codeTruncated` в консольном и Markdown-рендере (без полей — рендер не меняется).
- Exit-код CLI: `1` и при ошибках статанализа (только с `--code`); контракт 0/1/2 сохранён.
- `web/server.js` переписан на Express: фабрика `web/app.js` + `web/routes/api.js` + `web/middleware/validate.js`. Существующие контракты сохранены (`/api/health`, форма ответа `/api/analyze`, UI).
- Зависимости: `express`, `zod`, `pino`, `dotenv`, `bcrypt`, `better-sqlite3`, `openai`, `css-tree`, `csstree-validator`, `html-validate@10`, `espree` (версии проверены через `npm view`, совместимы с Node 22.16+).
- `better-sqlite3` зафиксирован на **12.11.1**: у 13.x `"gypfile": false` не сохраняется в `package-lock.json`, из-за чего переустановка из lock пытается скомпилировать пакет через node-gyp и падает на машинах без Python/MSVC (воспроизведено и проверено).
- `.gitignore` — явный список вместо глобального `*.json`: `node_modules/`, `.env`, `data/`, `logs/`, `report*.json`, `*.log`.
- `README.md` — разделы «Требования», «Установка и запуск», «HTTP API», «Статический анализ кода», «AI-объяснения (GLM 4.5)», «База данных».

## [1.0.0]

### Added
- CLI `bin/owa.js` (`--json`, `--compact`, `--out`, `--md`, `--selector`, `--wait`, `--timeout`, `--headed`, `--console`), exit-коды 0/1/2.
- Движок `src/engine.js` и коллекторы: Performance API, Long Tasks, Core Web Vitals, пользовательские метрики, JS-ошибки, память.
- Детерминированная интерпретация `src/interpret.js` (без LLM).
- MCP-сервер `mcp/server.js` (stdio) с инструментом `analyze_url`.
- Веб-интерфейс `web/`.
- 27 тестов на `node --test`.
