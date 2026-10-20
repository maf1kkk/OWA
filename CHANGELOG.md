# Changelog

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).
Все изменения в этом проекте документируются в этом файле.

## [Unreleased]

## [1.3.0] — 2026-10-20

Комплексный аудит сайта: от инструмента для разработчика к клиентскому отчёту.

### Fixed
- **Оценка больше не рушится из-за secondary-находок**: вместо плоского
  `100 - bad*20 - warn*5` — взвешенная оценка (Core Web Vitals и JS-ошибки
  весят больше, чем количество ресурсов). Пример: github.com — было 15/100,
  стало 83/100 при тех же «плохих» long tasks/TBT/ресурсах.
- **Виджеты: убран шум на чужих сайтах и артефактные тайминги**. Хардкод
  `DEFAULT_WIDGET_SELECTORS` (`#match-widget`, `[class*="live"]` и т.п.)
  удалён. Авто-детект работает best-effort (опрос после `load` во время
  `waitAfterLoad`), результаты попадают в метрики, но не в finding'и и не
  в оценку. Finding'и («самый медленный виджет», «не найден») — только для
  селекторов, заданных явно (`--selector` / `selectors`). Раньше
  авто-детектные селекторы мерялись в момент проверки (~waitAfterLoad) и
  давали фейковые «6925 мс».
- `bin/owa.js`: `--json --baseline` выводит один JSON-объект с полем `diff`
  (раньше — два последовательных JSON в stdout, невалидный поток).
- `web/routes/api.js`: `/api/history/metrics` перенесён перед
  `/api/history/:id`, иначе Express ловил `metrics` как параметр `id`.

### Changed
- `customWidgets.explicitSelectors` — новые метки в отчёте: явные селекторы
  (точный замер) отделены от авто-детекта (best-effort). Совместимость:
  `results` и `autoDetectedSelectors` на месте.

### Новое (графики и история)
- `GET /api/history/metrics` — метрики во времени (оценка, LCP/FCP/TTFB,
  CLS, TBT, ресурсы, Long Tasks) по всем сайтам или по конкретному URL.
- Веб-UI: вкладка «История» со списком анализов и последними 30 точками по
  каждой метрике (графики через Chart.js).
- `src/collectors/performance.js`: водопад загрузки ресурсов
  (`metrics.resources.waterfall`) — начало/конец каждого ресурса,
  секция «Водопад ресурсов» на странице отчёта.

### Подготовка к публикации на GitHub
  - `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `package.json` (`license: MIT`,
    `private: true`, `repository`, `homepage`, `bugs`).
  - `.gitignore` дополнен (`*.db`, `*.db-wal`, `*.db-shm`, `*.db-journal`,
    `coverage/`, `test-results/`, `.idea/`, `.vscode/`, `sources/`, `*.tsbuildinfo`).
  - `.env.example` — только плейсхолдеры (без дефолтных логов/URL).
- Рефакторинг: абстракция AI-провайдера (`src/ai/providers/`), новая переменная
  `AI_PROVIDER` (дефолт `none`), `GLM_*` поддерживаются как алиасы.
- CLI: `--baseline <файл.json>` и `--threshold <N>` — сравнение с baseline
  (exit 0/1 по порогу регрессий).
- CI: GitHub Actions (`test.yml`, матрица Node 22.16/24), Dependabot,
  issue templates, бейджи в README.
- README: дисклеймер «пет-проект, не для продакшена», раздел «Почему OWA»,
  «Демо», «Как использовать для ИИ-агентов».
- База данных: улучшена документация, `scripts/migrate.js` работает standalone.

## [1.2.1] — 2026-10-16

Rate-limit, защита от DDoS, подготовка к публичному деплою.

### Added
- `web/rate-limit.js` — фиксированное окно (fixed window) в памяти, без внешних зависимостей. Счётчики по `IP + path`, протухшие записи чистятся по расписанию. Контракт: `check(ip, path) → remaining` (0 — отказ), `reset()`, `max`, `windowMs`.
- `web/app.js` — middleware rate-limit (лимиты только на `/api/*`, UI и health не трогаются). Заголовки RFC 6585: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` при 429.
- `OWA_RATE_LIMIT_MAX` (по умолч. 20) и `OWA_RATE_LIMIT_WINDOW_MS` (по умолч. 60 000) в `.env.example` — лимиты на IP для `/api/*`. `0` — отключить (локальный режим).
- Тесты: `test/web.test.js` (+4): заголовки и 429 при превышении, UI/health вне лимита, `OWA_RATE_LIMIT_MAX=0` отключает, разные IP не делят квоту (через limiter напрямую). Итого **107 тестов** (было 103).

### Changed
- `bin/owa.js`: `--wait 0` корректно означает 0, а не «по умолчанию» (`??` вместо `||`). `--selector` без значения больше не падает с `undefined` — понятная ошибка.
- `web/app.js`: `createApp` принимает `env` (для тестов rate-limit без изменения `process.env`).

### Fixed
- `better-sqlite3` не запускался на Node.js ≥ 24 (модуль скомпилирован под NODE_MODULE_VERSION 127, а нужен 137). `npm rebuild better-sqlite3` — фикс. Локальный запуск `start.bat`/`start.sh` теперь работает.
- `src/security.js` читал `OWA_DENY_PRIVATE_TARGETS` и `OWA_ALLOW_PRIVATE_TARGETS` при загрузке модуля — в CLI и MCP `dotenv` не подключался автоматически, и `OWA_DENY_PRIVATE_TARGETS=1` из `.env` не применялся. Теперь флаги читаются лениво на каждом вызове `checkTarget`, `.env` подключается в самом модуле.
- `css-rules.js`: `dups.find(([s]) => s === sel)` — O(n²) для каждого селектора в превью. Заменено на прямую деструктуризацию `[sel, v]` из `Map.entries()`.

## [1.2.0] — 2026-10-15

Безопасность, авторизация и ретеншн — выпуск для публичного использования.

### Added
- `web/auth.js` + `web/middleware/auth.js` — авторизация: **Basic Auth** (`AUTH_LOGIN` + `AUTH_PASSWORD_HASH`, bcrypt) и **Bearer** (`API_BEARER_TOKEN`, сравнение через `crypto.timingSafeEqual`). При включённом Bearer он применяется к `/api/*`, остальное уходит на Basic. `WWW-Authenticate` в 401. `/health`, `/api/health`, `/favicon.ico` открыты всегда.
- `web/server.js`: отказ запуска с `HOST=0.0.0.0` без пароля; корректное завершение по `SIGINT`/`SIGTERM` с `closeDb()`; обработка `uncaughtException`/`unhandledRejection`.
- `src/security.js` — защита от SSRF и утечки локальных файлов, два независимых уровня: целевой URL (http/https, приватные адреса разрешены как штатный локальный сценарий) и URL ресурсов со страницы (http/https, только тот же origin, `file://` запрещён всегда). Распознаются обфусцированные IP: `http://2130706433/`, `http://0x7f000001/`, восьмеричные. `OWA_DENY_PRIVATE_TARGETS=1` — жёсткий режим для публичного деплоя.
- `src/db/maintenance.js` — обслуживание БД: ретеншн (`OWA_RETENTION_DAYS`, по умолчанию 30 дней) для `analyses`/`ai_responses`/завершённых сессий, очистка `sources_gz` у завершённых сессий, `wal_checkpoint(TRUNCATE)`; по расписанию из `web/server.js` (`OWA_MAINTENANCE_EVERY_MS`).
- Security-заголовки: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- Лимиты и защита API: `429 TOO_MANY_REQUESTS` при `OWA_MAX_CONCURRENT` (по умолч. 2) параллельных анализах, `413 PAYLOAD_TOO_LARGE`, `.max(20)`/`.max(200)` на селекторы, `headed` через API только с `OWA_ALLOW_HEADED=1`.
- Тесты: `test/security.test.js` (8) — валидация URL, обфускация, двух уровневые правила; `test/engine.test.js` (6) — полный цикл анализа на локальном http-сервере, стабильность схемы, поведение при обрыве связи; `test/maintenance.test.js` (5) — ретеншн, `sources_gz`, WAL. Итого **103 теста** (было 76).
- Отдельные тесты авторизации в `test/web.test.js` (8): Basic/Bearer, 401 с `WWW-Authenticate`, битый хэш не пускает и не роняет сервер, `/health` открыт всегда.

### Fixed
- **Авторизация, задокументированная в README/`.env.example`, отсутствовала в коде** — все роуты были открытыми, `bcrypt` не использовался. Теперь работает; без пароля сервер вообще не слушает наружу.
- **SSRF и чтение произвольных локальных файлов через пользовательский `url`** — страница могла заставить сервер прочитать `file:///...` с диска (и отправить содержимое в LLM) либо сходить на внутренний адрес вроде `169.254.169.254`.
- Утечка процессов Chromium: `analyze()` не закрывал браузер при таймауте навигации или ошибке на странице — теперь `try/finally` для контекста и браузера.
- Мутация общей константы `DEFAULT_WIDGET_SELECTORS` между вызовами — массив рос на каждой итерации; теперь копия.
- Внутренние сообщения об ошибках Playwright уходили в ответ клиента — теперь наружу нейтральное сообщение, детали только в лог.
- `waitMs`/`timeoutMs` из MCP не ограничивались: агент мог передать `1e12` и повесить сервер; добавлен кламп и таймаут вызова `OWA_MCP_TOOL_TIMEOUT_MS` (по умолч. 5 минут).
- Неограниченный рост БД: `code_sessions.sources_gz` (gzip до 15 МБ) оставался после завершения сессии, WAL не чекпоинтился при остановке.
- `code_sessions` со статусом `error` не очищали `sources_gz` — только `done`.
- `src/engine.js`: число ожидания после load клампится (`clampWait`, 0…60000), защита от `NaN`/отрицательных.
- `mcp/server.js`: версия сервера берётся из `package.json` вместо захардкоденной `1.0.0`.
- `decodeIPv4` в валидаторе URL: десятичная запись `2130706433` (127.0.0.1) не распознавалась и проходила как публичный адрес.

### Changed
- `pino` убран из зависимостей (не использовался). `bcrypt` остаётся — теперь применяется в `web/auth.js`.
- `bin/owa.js`: `--wait 0` корректно означает 0, а не «по умолчанию» (`??` вместо `||`).
- `mcp/server.js`: `analyze_url` принимает `timeoutMs`; селекторы ограничены 20.
- README: раздел «Безопасность» (авторизация, SSRF), таблица переменных, `.env.example` с описанием всех режимов.

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

## [Unreleased] — комплексный аудит (модули 0–3)

### Added
- `src/core/orchestrator.js` — `AuditOrchestrator`: параллельный запуск секций через
  `p-queue` (ограничение параллелизма), повторы через `p-retry`, изоляция ошибок
  (секция -> `status: "failed"`, остальные продолжают), интегральная оценка
  (средневзвешенная: performance 0.3, seo 0.25, security 0.2, accessibility 0.15,
  content 0.1), логирование времени каждой секции.
- `src/audit/session.js` — общий Playwright-контекст: все секции работают на одном
  открытии страницы (браузер не перезапускается).
- `src/audit/sections.js` — четыре новые секции: `seo`, `security`, `accessibility`
  (axe-core 4.14), `content`. Каждая — независимая `AuditSection` с правилами
  severity (critical/warning/info) и человекочитаемой рекомендацией.
- `src/audit/index.js` — `runFullAudit(url)`: полный аудит в одной схеме
  (`url`, `timestamp`, `scores`, `issues`, `raw`, `integralScore`).
- `src/report/pdf.js` + `templates/report.html` + `templates/styles.css` — клиентский
  PDF: титульный лист с интегральной оценкой и радаром, Core Web Vitals с порогами
  Good/Needs Improvement/Poor, топ-10 проблем с блоками «Что не так» / «Как исправить»,
  кольцевая диаграмма распределения по категориям, футер. Графики рендерятся заранее
  в PNG (chartjs-node-canvas) и вставляются как data-URI — JS внутри `page.pdf()` не
  используется. Шрифты стандартные (Helvetica/Arial) — не разъезжаются в Adobe Reader.
- CLI: `owa audit --full <url>` (JSON/текст, `--out`) и `owa report --pdf <file> --url <url>`.
- `src/security/safe-fetch.js` — единая точка исходящих запросов: `ssrf-guard`
  (DNS резолвится один раз, адрес валидируется и пинится в сокет — TOCTOU/DNS-rebinding
  закрыты), редиректы обрабатываются вручную и перепроверяются на каждом ходу.
- Тесты: `test/orchestrator.test.js`, `test/audit.test.js`, `test/pdf.test.js`,
  `test/ssrf.test.js` — **141 тест** (было 118).

### Changed
- SSRF-защита включена по умолчанию: приватные диапазоны, `localhost`, `*.local`,
  `*.internal` блокируются в MCP, веб-API (`/api/analyze`) и аудите; заблокированные
  попытки логируются с URL и причиной. Локальная разработка — `OWA_ALLOW_PRIVATE_TARGETS=1`.
- `package.json` — добавлены `p-queue`, `p-retry`, `axe-core`, `chart.js`,
  `chartjs-node-canvas`, `undici`, `ssrf-guard` (ESM-only, требует Node >= 24).

### Прочее
- Откат модулей 0–3 без Git: `scripts/rollback-audit-modules.bat` / `.sh`
  (бэкап в `.rollback-backup/`, вне Git).

## [Unreleased] — модуль 4: обход сайта и sitemap

### Added
- `src/crawl/crawler.js` — краулер: очередь внутренних ссылок, ограничение доменом
  и глубины, лимит страниц, пауза между запросами (нагрузка на чужой сайт).
  Каждая страница проходит облегчённый аудит (Performance, SEO, Accessibility) на
  **одном** браузере на весь обход. Итог — агрегаты по сайту: средняя оценка,
  средние метрики, топ проблем по частоте, худшие страницы.
- `src/crawl/sitemap.js` — разбор `sitemap.xml` и вложенных `sitemapindex`
  (fast-xml-parser), загрузка через safeFetch (SSRF-защита + пининг IP).
- `src/crawl/robots.js` — соблюдение robots.txt (robots-parser).
- CLI: `owa crawl <URL>` и `owa sitemap <URL>/sitemap.xml`
  (`--max-pages`, `--max-depth`, `--delay`, `--ignore-robots`, `--no-audit`).
- Тесты: `test/crawl.test.js` — **148 тестов** (было 141).

### Changed
- `src/audit/session.js` — сессия может использовать уже открытый браузер
  (`options.browser`), чтобы краулер не перезапускал Chromium на каждой странице.
- `package.json` — добавлены `robots-parser`, `fast-xml-parser`.

## [Unreleased] — модуль 5: сравнение с конкурентами

### Added
- `src/compare/index.js` — сравнительный аудит: тот же оркестратор по списку URL.
  Обход **последовательный с паузой** (`--delay`, по умолч. 3000 мс) — чужие
  сайты не нагружаем; максимум 5 конкурентов. Результат: сводка по каждому
  сайту (оценки разделов, метрики, топ проблем), единая таблица «метрика на сайт»
  (разделы + метрики, отмечен лидер и отставание клиента) и текстовые выводы
  «где клиент проигрывает и на сколько».
- `src/report/compare-pdf.js` + `templates/compare.html` — comparative-PDF:
  титул с карточками сайтов, сгруппированный bar-график оценок по разделам,
  график LCP/TTFB, таблицы разделов и метрик, блок выводов. Графики — PNG
  через chartjs-node-canvas (JS в page.pdf() не выполняется).
- CLI: `owa compare --target <URL> --with <url1>,<url2> [--pdf файл] [--json]`.
- Тесты: `test/compare.test.js` — **156 тестов** (было 148).

## [Unreleased] — веб-UI для ручного аудита

### Added
- `web/routes/audit.js` — HTTP-роуты ручного сценария:
  `POST /api/audit`, `POST /api/crawl`, `POST /api/compare`,
  `GET /api/report/pdf?type=audit|compare&id=<id>` (PDF строится по готовому
  отчёту из короткоживущего кэша — Chromium не перезапускается).
- Веб-UI: вкладки «Аудит», «Обход», «Сравнение» — интегральная оценка,
  карточки разделов, проблемы по приоритету с рекомендациями, агрегаты по
  сайту, таблица «метрика на сайт» с отставанием, блок выводов, кнопки
  скачивания PDF и JSON.
- Аудиты сохраняются в историю (status `audit`), метрики доступны для PDF.

### Fixed
- **Навигация в UI не работала**: обработчик читал `href="#"` вместо
  `data-section`, из-за чего переключение вкладок ничего не делало.
- Ссылка «Скачать PDF» не получала стиль кнопки (`.ghost` был определён
  только для `button.ghost`).
- Поле «Конкуренты» вынесено из свёрнутого блока — это основной ввод
  для сравнения.
- Тесты: `test/web.test.js` (+6) на новые эндпоинты и разделы UI —
  **162 теста** (было 156).

## [Unreleased] — клиентский текст отчёта через LLM (RAG)

### Added
- `src/ai/knowledge/` — база знаний для RAG: пороги Core Web Vitals, SEO-ориентиры,
  заголовки безопасности, WCAG 2.1 и ГОСТ Р 52872-2019, рабочие приёмы по правке,
  структура клиентского отчёта (4 слоя, карточка находки, разделение
  наблюдение/вывод/гипотеза/рекомендация, приоритет vs серьёзность vs уверенность)
  и юридические ограничения (что нельзя писать, дисклеймер, «аудит — не пентест»).
- `src/ai/rag.js` — лексический поиск (BM25-подобный) по чанкам знаний: детерминированный,
  без внешних зависимостей и без сети.
- `src/ai/report-generator.js` — генерация клиентского текста: факт-лист из измерений →
  промпт с RAG-выдержками и профилем клиента → **проверка фактов** (все числа из
  фактов или базы знаний, все ruleId реальны) → при провале детерминированный fallback.
- `src/ai/client-profile.js` + `clients/example.json` — профиль клиента (тон, фокус,
  отрасль, конкуренты, контакты); влияет только на формулировки, не на измерения.
- CLI: `--ai` (клиентский текст) и `--client <slug>` для `report` и `compare`;
  в PDF появились блоки «Резюме для руководства», «Главное, на что обратить внимание»,
  «План работ», «Ограничения проверки».
- Тесты: `test/ai-report.test.js` (+16) — RAG, факт-лист, проверка ответа, fallback.

### Changed
- `src/ai/client.js` + провайдер: режим размышления GLM выключается через
  `AI_THINKING=0` (было ~116 с на отчёт, стало ~18 с); неизвестные поля тела
  запроса передаются напрямую, т.к. openai-node не поддерживает `extra_body`.

## [Unreleased] — PDF-отчёты: отдельный отчёт на каждую проверку

### Fixed
- **Водяной знак налезал на текст отчёта**: футер был `position: fixed` и
  повторялся на каждой странице PDF поверх содержимого. Теперь футер — обычный
  блок в конце документа.
- **Печать из веб-интерфейса печатала все вкладки разом** (анализ + аудит +
  обход + сравнение + историю) — получался каша-отчёт. Теперь печатается только
  активная вкладка.
- В шаблоне отчёта по обходу был незакрытый `<table>` — блок «худшие страницы»
  уезжал за футер. Добавлен тест на баланс тегов во всех шаблонах.
- Плейсхолдер `__PAGE_COUNT__` в отчёте по обходу подставлялся только в первом
  месте — в заголовке таблицы оставался литерал.

### Added
- `GET /api/report/pdf?type=analysis|audit|crawl|compare|session[&id=]` — PDF по
  любому типу проверки; для отчёта из истории — `GET /api/history/:id/pdf`.
- `src/report/analysis-pdf.js` + `templates/analysis.html` — отдельный отчёт по
  performance-анализу: метрики, фазы навигации, ресурсы, настоящий водопад
  (невидимая база + полоса длительности), Long Tasks, проблемы.
- `src/report/crawl-pdf.js` + `templates/crawl.html` — отчёт по обходу сайта.
- `src/report/session-pdf.js` + `templates/session.html` — сводный отчёт за
  сессию: операции, сайты, средняя оценка, проблемы по разделам, топ проблем.
- `src/report/render.js` — общий рендер HTML → PDF (единые поля и лимит размера).
- `src/web/session.js` — лог операций сессии и кэш результатов (час в памяти):
  PDF строится из готового отчёта, повторный анализ не нужен.
- Веб-UI: «Скачать PDF-отчёт» в анализе и обходе, кнопка «PDF» в истории,
  ссылка «Отчёт за сессию» в шапке.
- Тесты: `test/pdf-layout.test.js` (+7) — баланс тегов, футер не fixed,
  все плейсхолдеры подставлены; в `test/web.test.js` (+6) — эндпоинты PDF и лог
  сессии. **192 теста** (было 178).

## [Unreleased] — ускорение обхода сайта + локальный сканер уязвимостей

### Changed
- **Обход сайта в 4 раза быстрее** (8 страниц: 66 с -> 16 с на iana.org):
  - страницы обрабатываются **параллельно** (пул воркеров, по умолч. 3), очередь
    пополняется на ходу; опция `--concurrency` (CLI и веб-интерфейс);
  - навигация переведена на `waitUntil: 'commit'` + ограниченное ожидание DOM:
    страница с зависшим ресурсом больше не блокирует обход;
  - проверка битых ссылок при обходе отключена (внутренние ссылки и так
    обходятся, а внешние — это до 20 сетевых запросов на страницу);
  - ожидание после загрузки уменьшено 1500 -> 700 мс;
  - добавлен общий дедлайн обхода (5 минут) и таймаут на страницу.
- CLI: `--concurrency N` для обхода; веб-интерфейс: поле «Параллельных страниц».

### Fixed
- **Аудит всегда сообщал «robots.txt не найден»**: `safeFetch` возвращает обёртку
  `{ status, headers, url, body }`, а код читал `resp.text()` — было исключение,
  которое глоталось catch'ем. Теперь читается `resp.body.text()`.

### Локально (в репозиторий не попадает)
- `local/vulnscan.js` + `bin/owa-scan.js` — сканер уязвимостей и DoS-векторов
  (экспозиция `.git`/`.env`/дампов БД/phpinfo/actuator, CORS, TRACE, cookie-флаги,
  тяжёлые эндпоинты, TLS). Только чтение (GET/HEAD/OPTIONS), без эксплуатации.
  Каталог `local/` и `bin/owa-scan.js` — в `.gitignore`.

### Тесты
- `test/crawl.test.js` (+2): обход не зависает (дедлайн, лимит страниц) и не теряет
  страницы при параллельности. **194 теста** (было 192).
