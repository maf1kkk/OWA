# OWA — One-Click Web Analyzer

> **Статус:** пет-проект в портфолио. Не для продакшена.
> **Зачем:** демонстрация работы с Performance API, Playwright, MCP и AI-интеграцией.

[![test](https://github.com/maf1kkk/OWA/actions/workflows/test.yml/badge.svg)](https://github.com/maf1kkk/OWA/actions/workflows/test.yml)
![Node](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

Автоматизированный сборщик метрик производительности веб-приложений. Вставляешь ссылку — получаешь полный отчёт в консоль, JSON или Markdown.

## Почему OWA

OWA — это **одна команда**: запуск headless Chromium, сбор реальных метрик (Performance API, Long Tasks, Core Web Vitals, ресурсы, JS-ошибки, пользовательские метрики), и **детерминированная** интерпретация — все выводы вычисляются по фиксированным правилам в `src/interpret.js`, не «выдумываются».

Чем отличается от Lighthouse CI / Unlighthouse / ohmyperf:

- **Детерминированная интерпретация** — LLM не выдумывает метрики; вердикты
  и рекомендации считаются в самом приложении. Для CI-мониторинга глубже и
  стабильнее — Lighthouse CI.
- **MCP-сервер «из коробки»** — ИИ-агент получает `analyze_url` как встроенный
  инструмент. Вызвать tool дешевле и надёжнее, чем просить агента оценить
  производительность «из памяти». MCP работает **standalone** (без SQLite,
  без Express, без `.env`) — `npm run mcp` или `node mcp/server.js`.
  UI и история анализов — опциональные части, для MCP-сценария не нужны.
- **Один бинарник** — без облака и аккаунтов. `node bin/owa.js` работает
  локально; `--json` / `--compact` / `--baseline` — для ИИ-агентов и CI.
- **Статический анализ кода** (CSS/HTML/JS) — флаг `--code`: правила через
  csstree-validator, html-validate, espree, секция в том же отчёте.
- **Diff-режим** (`--baseline`) — сравнение с сохранённым baseline,
  регрессии подсвечиваются (exit 1), порог настраивается `--threshold`.
- **Взвешенная оценка 0–100** — Core Web Vitals и JS-ошибки весят больше,
  чем количество ресурсов; оценка не рушится из-за secondary-находок при
  здоровых LCP/CLS/TTFB.

Честно: OWA — не замена Lighthouse CI для продакшн-мониторинга. Это пет-проект
для демонстрации: как собрать реальные метрики через Playwright и
интерпретировать их детерминированно, без галлюцинаций.

## Демо

<!-- TODO: вставить asciinema-запись или гифку с реальным запуском.
     Пример команды для записи:
       node bin/owa.js https://lolesports.com --selector "#match-widget" --selector "#scoreboard"
     Записать:  asciinema rec demo.cast
     Вставить сюда: ![](docs/demo.gif) -->

_Плейсхолдер: здесь будет демонстрация (asciinema/gif)._

## Требования

- **Node.js 24.0.0 или новее** — https://nodejs.org (старше не ставим сами, только проверяем). Node 24 обязателен: ssrf-guard и chartjs-node-canvas требуют его
- Доступ в интернет при первой установке (npm + Chromium Playwright)
- Windows / Linux / macOS

## Установка и запуск

Одна команда — она сама проверит окружение и доставит недостающее:

```bash
# Windows
start.bat

# Linux / macOS
sh start.sh
```

Что делает скрипт (идемпотентно, каждый запуск):

1. `[✓]` проверяет Node.js в PATH и его версию (нет/старый → инструкция, выход)
2. `[↓]` ставит зависимости (`npm install`), если `node_modules` нет или `package.json` изменился
3. `[↓]` ставит Chromium Playwright в пользовательский кэш, если его нет
   (Windows: `%LOCALAPPDATA%\ms-playwright`, Linux: `~/.cache/ms-playwright`, macOS: `~/Library/Caches/ms-playwright`)
4. `[✓]` если `.env` нет — копирует из `.env.example` и просит заполнить (выход, ничего не сломано)
5. `[→]` запускает сервер: `http://localhost:3210` (остановка — `Ctrl+C`)

Ручная проверка окружения без установки:

```bash
npm run check-env            # только проверить
node scripts/check-env.js --fix   # проверить и поставить недостающее
```

Если CDN Playwright недоступен (нет сети до `cdn.playwright.dev` или режет корпоративный прокси), Chromium не скачается — OWA всё равно запустится на системном Chrome или Edge (тот же движок). Канал можно зафиксировать: `OWA_BROWSER_CHANNEL=chrome` или `msedge` в `.env`.

### Конфигурация (.env)

При первом запуске создаётся `.env` из `.env.example`. Заполните:

| Переменная | Назначение |
|---|---|
| `PORT` / `HOST` | порт и интерфейс. Без пароля наружу не пустит — см. «Безопасность» |
| `AUTH_LOGIN` / `AUTH_PASSWORD_HASH` | Basic Auth (bcrypt-хэш пароля) для UI и API |
| `API_BEARER_TOKEN` | Bearer-токен для `/api/*` (скрипты, ИИ-агенты) |
| `OWA_BROWSER_CHANNEL` | пусто (по умолчанию) — Chromium из кэша Playwright, при его отсутствии системный Chrome, затем Edge; либо явно `chrome` / `msedge` |
| `OWA_DENY_PRIVATE_TARGETS` | `1` — запретить приватные адреса как цели анализа (public-деплой) |
| `OWA_MAX_CONCURRENT` | максимум одновременных анализов (по умолч. 2) |
| `OWA_RATE_LIMIT_MAX` / `OWA_RATE_LIMIT_WINDOW_MS` | rate limit на `/api/*` по IP (по умолч. 20 за 60 с, `0` — отключить) |
| `OWA_RETENTION_DAYS` | срок хранения анализов и кэша AI (по умолч. 30, `0` — без ограничений) |
| `AI_PROVIDER` | LLM-провайдер: `openai` / `anthropic` / `ollama` / `glm` / `none` (по умолч. `none`) |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` | доступ к LLM (любой OpenAI-совместимый endpoint) |
| `AI_TIMEOUT_MS`, `AI_MAX_TOKENS`, `AI_TEMPERATURE` | таймаут AI-вызова (по умолч. 30000) и параметры генерации |
| `GLM_API_KEY`, `GLM_BASE_URL`, `GLM_MODEL`, ... | устаревшие алиасы `AI_*` — работают для обратной совместимости |

Сгенерировать bcrypt-хэш пароля:

```bash
node -e "require('bcrypt').hash('ВАШ_ПАРОЛЬ', 10, (e,h)=>console.log(h))"
```

`.env` не попадает в git.

## Использование (CLI)

```bash
# Базовый анализ — отчёт в консоль
node bin/owa.js https://lolesports.com

# Сохранить отчёты
node bin/owa.js https://example.com --out report.json --md report.md

# Пользовательская метрика: время до появления виджета (можно несколько селекторов)
node bin/owa.js https://lolesports.com --selector "#match-widget" --selector "#scoreboard"

# Машинночитаемый вывод для ИИ-агентов (opencode и т.п.)
node bin/owa.js https://example.com --json

# Минимум токенов: компактный JSON с готовой интерпретацией (для ИИ)
node bin/owa.js https://example.com --compact

# Видимый браузер + перехват console-логов страницы
node bin/owa.js https://example.com --headed --console

# Diff-режим: сравнить с сохранённым baseline (exit 1 при регрессиях)
node bin/owa.js https://example.com --baseline baseline.json --threshold 5
```

### Все опции CLI

| Опция | Описание |
|---|---|
| `--json` | Только JSON-вывод (для ИИ-агентов) |
| `--compact` | Компактный JSON с готовой интерпретацией (минимум токенов для ИИ) |
| `--out <файл>` | Сохранить полный JSON-отчёт |
| `--md <файл>` | Сохранить Markdown-отчёт (готовая таблица для лабораторной) |
| `--selector <sel>` | Селектор виджета для пользовательской метрики (повторяемо) |
| `--wait <мс>` | Ожидание после `load` (по умолч. 5000) — для динамического контента |
| `--timeout <мс>` | Таймаут навигации (по умолч. 60000) |
| `--headed` | Показать окно браузера |
| `--console` | Перехватить console-сообщения страницы |
| `--code` | Добавить в отчёт статический анализ кода (CSS/HTML/JS) |
| `--baseline <файл>` | Сравнить с сохранённым baseline (JSON от `--out` или `/api/analyze`) |
| `--threshold <N>` | Порог регрессии в % для `--baseline` (по умолч. 5) |

### Exit-коды (для автоматизации)

- `0` — метрики в норме
- `1` — есть проблемы (load > 5 с, > 5 долгих задач, LCP > 4 с, либо ошибки статанализа с `--code`, либо регрессии при `--baseline`)
- `2` — ошибка анализа

## Что собирается

### Performance API (шаг 2 лабораторной)
- Полное время загрузки (`performance.timing.loadEventEnd - navigationStart`)
- Время до `DOMContentLoaded`
- `performance.getEntriesByType('navigation')` — DNS, TCP, SSL, TTFB, DOM interactive/complete
- `performance.getEntriesByType('resource')` — все ресурсы: количество, группировка по типу, топ-5 тяжёлых, топ-10 медленных

### Пользовательские метрики (шаг 3)
- Время (мс от начала навигации) до появления заданного селектора — чат, таблица результатов, виджет матча. Точный замер — только для селекторов, заданных явно (`--selector`, `selectors` в API/MCP)
- Авто-детект вероятных динамических виджетов (`#match-widget`, `#scoreboard`, `.chat` и т.п.), если селекторы не заданы: best-effort (время обнаружения после `load`, не появления), попадает в метрики, но не в вердикты/оценку

### Long Tasks (шаг 4)
- Количество задач > 50 мс, максимальная длительность, attribution (какой скрипт виноват)
- Оценка Total Blocking Time

### Дополнительно
- Core Web Vitals: LCP, CLS
- First Paint / First Contentful Paint
- JS-ошибки на странице
- Память JS Heap (Chrome)
- Опционально: console-логи страницы

## Интерпретация без галлюцинаций (для ИИ-агентов)

Все вердикты и рекомендации вычисляются **в самом приложении** детерминированными правилами (`src/interpret.js`) — ИИ не нужно ничего «додумывать». ИИ остаётся только пересказать готовые выводы.

Три способа подключения ИИ, от простого к правильному:

**1. `--json`** — полный машиночитаемый отчёт, включая блок `interpretation`:
```bash
node bin/owa.js https://site.com --json
```

**2. `--compact`** — сверхкомпактный вывод со стабильной схемой (`schemaVersion: 1`), готовой интерпретацией и минимумом токенов (нет сырых массивов ресурсов и задач):
```bash
node bin/owa.js https://site.com --compact
```

**3. MCP-сервер (рекомендуется)** — ИИ получает OWA как встроенный инструмент `analyze_url`. Вызвать tool дешевле и надёжнее, чем галлюцинировать метрики «из памяти». Подключение в `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "owa": {
        "type": "local",
        "command": ["node", "mcp/server.js"],
        "cwd": "."
      }
    }
  }
}
```

После этого агент сам вызовет `analyze_url` с аргументами `{ url, selectors?, waitMs? }` и получит проверенные измерения с вердиктами — экономия токенов и ноль выдуманных данных.

## Структура

```
start.bat / start.sh       Идемпотентный запуск: проверка окружения + установка
scripts/check-env.js       Проверка Node/зависимостей/Chromium/.env (+ --fix)
scripts/migrate.js         Применение миграций SQLite вручную
bin/owa.js                 CLI
src/engine.js              Движок: запуск браузера, оркестрация сборщиков
src/report.js              Консольный и Markdown-рендер (+ секция статанализа)
src/interpret.js           Детерминированная интерпретация (verdict/recommendation)
src/static-analyzer/
  index.js                 Оркестрация: analyzeCode (за раз) и сессии (продолжение)
  fetch-sources.js         Сбор HTML/CSS/JS через Playwright (лимиты ТЗ)
  css-rules.js             Правила CSS (!important, дубли, неиспользуемые, ...)
  html-rules.js            Правила HTML (lang, alt, дубли id, deprecated)
  js-rules.js              Правила JS (console, debugger, eval, размер)
  validators.js            Обёртки: csstree-validator, html-validate, espree
  to-findings.js           Raw -> формат findings (+ severity, rule, location, suggestion)
src/ai/
  client.js                Клиент OpenAI-совместимого API (таймаут 30 с, retry 1× на 5xx)
  explain.js               Промпт находки, sha256-кэш в ai_responses, explainMissing
  index.js                 Ленивая конфигурация провайдера из .env (getAi/resetAi)
  providers/               Абстракция LLM-провайдера (openai-compatible, null)
    index.js               Реестр: выбор по AI_PROVIDER (дефолт none)
    openai-compatible.js   OpenAI/GLM/Ollama/любой OpenAI-совместимый endpoint
    null.js                Заглушка, когда AI не настроен
src/db/
  index.js                 Открытие SQLite, PRAGMA (WAL), миграции по user_version
  migrations/001_init.sql  Схема: analyses, code_findings, ai_responses, settings
  migrations/002_code_sessions.sql  Сессии статанализа (продолжение анализа)
  repositories/            Тонкие обёртки над prepared statements
  mcp/server.js              MCP-сервер (stdio): инструмент analyze_url для ИИ-агентов
  web/
    server.js                Точка входа: .env, БД, listen
    app.js                   Фабрика Express-приложения (+ rate-limit middleware)
    rate-limit.js            Rate limit в памяти (фиксированное окно по IP+path)
  routes/api.js            HTTP API (см. раздел «HTTP API»)
  routes/code-analysis.js  POST /api/code-analysis (сессии статанализа)
  routes/ai.js             POST /api/ai/explain (AI-объяснения находок)
  middleware/validate.js   zod-валидация и формат ошибок { error, message }
  index.html               UI
test/                      Тесты (node --test)
src/collectors/
  performance.js           Navigation/Resource/Paint timing
  longtasks.js             PerformanceObserver longtask
  widget.js                Пользовательские метрики виджетов
  vitals.js                LCP/CLS/ошибки/память
```

## HTTP API

Сервер: `npm start` (или `start.bat`). Настройки — из `.env` (`PORT`, `HOST`).

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/` | UI |
| `GET` | `/health` | `{ status, version, uptime }` |
| `GET` | `/api/health` | `{ ok, tool }` (для UI) |
| `POST` | `/api/analyze` | Синхронный анализ: `{ url, selectors?, waitMs?, timeoutMs?, headed?, consoleLogs?, compact?, save? }` → `{ ok, report, compact?, analysisId }`. `save: false` — не сохранять в историю |
| `POST` | `/api/code-analysis` | Статический анализ кода с продолжением: `{ url }` → первая сессия, `{ sessionId, explain? }` → следующий батч, см. раздел «Статический анализ кода» |
| `POST` | `/api/ai/explain` | AI-объяснения находок: `{ analysisId, force? }` → `{ ok, findings, explained, cached }`, см. раздел «AI-объяснения» |
| `GET` | `/api/history?limit&offset&url` | Список анализов: `{ ok, items, total }` |
| `GET` | `/api/history/metrics?limit&url` | Метрики во времени для графиков: `{ ok, series }` |
| `GET` | `/api/history/diff?id1&id2[&threshold]` | Сравнение двух запусков: метрики, вердикты, регрессии |
| `GET` | `/api/history/:id` | Детали анализа (+ `codeFindings`) |
| `DELETE` | `/api/history/:id` | Удалить запись (каскадно) |
| `DELETE` | `/api/history` | Очистить историю целиком |

Ошибки — всегда JSON вида `{ error: CODE, message: string }` + корректный HTTP-статус.

Пример для ИИ-агента:

```bash
curl -X POST http://localhost:3210/api/analyze \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

## Статический анализ кода

Два способа запуска:

**CLI** — одной командой с метриками:

```bash
node bin/owa.js https://example.com --code          # + секция «Статический анализ кода» в отчёте
node bin/owa.js https://example.com --code --json   # поле codeFindings в JSON
```

**HTTP** — сессии с продолжением (каждый вызов делает очередной шаг и сохраняет
прогресс в SQLite, можно продолжить позже — как «продолжение диалога»):

```bash
# 1) создать сессию: сбор исходников (fetch) + анализ HTML
curl -X POST http://localhost:3210/api/code-analysis \
  -H "Content-Type: application/json" -d '{"url":"https://example.com"}'
# -> { sessionId, step: "css", done: false, findings: [...] }

# 2) продолжать, пока done не станет true (следующий батч CSS/JS, batch по умолч. 10 файлов)
curl -X POST http://localhost:3210/api/code-analysis \
  -H "Content-Type: application/json" -d '{"sessionId": 1}'
# -> ... { step: "js", done: false } / { done: true, summary: {...} }
```

Что проверяется:

| Тип | Правила |
|---|---|
| CSS | синтаксис (csstree-validator), счётчик `!important`, дубли селекторов, неиспользуемые селекторы (сверка с HTML), пустые правила, файл > 5000 строк |
| HTML | нет `lang`, `<img>` без `alt`, дубли `id`, deprecated-теги, синтаксис/структура (html-validate) |
| JS | `console.*`/`debugger` (счётчик), `eval`/`new Function`, файл > 500 КБ, синтаксис (espree) |

Лимиты (ТЗ): до 50 внешних файлов и 2 МБ на файл — что не влезло, попадает в
`truncated` с причиной. Находки выдаются в формате `findings` из `interpret.js`
(+ аддитивные поля `severity`, `rule`, `location`, `suggestion`), привязываются к
записи в истории и удаляются каскадно вместе с ней.

## AI-объяснения (LLM)

Модуль `src/ai/` объясняет находки статанализа через любой **OpenAI-совместимый
endpoint** (GLM 4.5 — дефолт, но модуль абстрагирован, см. `src/ai/providers/`):

- **таймаут 30 с** (`AI_TIMEOUT_MS`), **retry ровно 1 раз только на 5xx**;
- ошибки нормализуются: `{ error: 'AI_TIMEOUT' }` (HTTP 504) или
  `{ error: 'AI_ERROR' }` (HTTP 502); нет ключа — `400 AI_NOT_CONFIGURED`;
- **кэш в SQLite**: ключ `sha256(model + prompt)` в таблице `ai_responses` —
  повторный запрос тех же данных отдаётся из кэша без обращения к LLM;
- промпты и ответы LLM не логируются, ключ — только в `.env` (в git не попадает).

Провайдер выбирается переменной `AI_PROVIDER`:

| Значение | Что делает |
|---|---|
| `none` (дефолт) | AI выключен — проект работает без LLM, `ai: { configured: false }` |
| `openai` | OpenAI endpoint (`AI_API_KEY` + `AI_BASE_URL` + `AI_MODEL`) |
| `anthropic` | alias → OpenAI-совместимый (через прокси) |
| `ollama` | локальный Ollama (`http://localhost:11434/v1`) |
| `glm` | GLM (Zhipu) — OpenAI-совместимый, дефолты `AI_BASE_URL`/`AI_MODEL` |

Старые переменные `GLM_API_KEY`/`GLM_BASE_URL`/`GLM_MODEL` поддерживаются как
алиасы (с warning в лог), чтобы не ломать существующие деплои.

Два способа получить объяснения:

```bash
# 1) сразу при анализе: флаг explain в /api/code-analysis (объясняет все находки
#    без ai_explanation, в ответе — блок ai { configured, explained, cached })
curl -X POST http://localhost:3210/api/code-analysis \
  -H "Content-Type: application/json" -d '{"url":"https://example.com","explain":true}'

# 2) отдельно по готовому анализу из истории (force: true — переобъяснить всё,
#    но повторные тексты всё равно берутся из кэша)
curl -X POST http://localhost:3210/api/ai/explain \
  -H "Content-Type: application/json" -d '{"analysisId": 1}'
```

Объяснение сохраняется в `code_findings.ai_explanation` и возвращается в поле
`aiExplanation` у находки. Ошибка AI не прерывает анализ: в ответе появляется
`ai.error`, повторный вызов дозаполняет остаток (успешное уже сохранено).

## База данных

SQLite (`better-sqlite3`) в `data/owa.db` (каталог создаётся сам, в git не попадает):

- режим **WAL**, `foreign_keys = ON` — включаются при открытии;
- миграции — SQL-файлы `src/db/migrations/NNN_*.sql`, применяются по `PRAGMA user_version` при старте сервера;
- вручную: `npm run migrate`;
- таблицы: `analyses` (история), `code_findings` (находки статанализа, каскад), `code_sessions` (прогресс сессий статанализа), `ai_responses` (кэш LLM), `settings`.

**Обслуживание** (раз в 6 часов, по расписанию сервера): удаление анализов,
кэша AI и завершённых сессий старше `OWA_RETENTION_DAYS` (по умолчанию 30),
очистка `sources_gz` у завершённых сессий и чекпоинт WAL. Отключается
`OWA_MAINTENANCE_EVERY_MS=0`, срок хранения — `OWA_RETENTION_DAYS=0`.

## Безопасность

### Авторизация

Без настройки сервер приватный: слушает только `127.0.0.1`. Попытка запустить
с `HOST=0.0.0.0` **без пароля завершается ошибкой** — открытого доступа без
авторизации не бывает.

| Переменная | Что даёт |
|---|---|
| `AUTH_LOGIN` + `AUTH_PASSWORD_HASH` | Basic Auth (bcrypt) для UI и API. Запросит логин в браузере |
| `API_BEARER_TOKEN` | Bearer-токен для `/api/*` — для скриптов и ИИ-агентов. Применяется вместе с Basic: Bearer на API, всё остальное — Basic |

Сравнение Bearer-токена тайминг-защищённое, пароль — через `bcrypt.compare`.
Битый хэш пароля = отказ в доступе с сообщением в лог (не пускает).
`/health` и `/api/health` открыты всегда.

```bash
# хэш пароля для .env
node -e "require('bcrypt').hash('ВАШ_ПАРОЛЬ', 10, (e,h)=>console.log(h))"

# запрос с токеном
curl -H "Authorization: Bearer $API_BEARER_TOKEN" http://localhost:3210/api/history
```

### Защита от SSRF и утечки локальных файлов

OWA открывает **чужие** страницы в браузере, поэтому URL проверяются в
`src/security.js` по двум независимым правилам:

| Что | Правила |
|---|---|
| Целевой URL (тело запроса, `analyze_url`, `--url`) | только `http`/`https`; приватные адреса разрешены (штатный локальный сценарий — «проверь сборку на localhost»); при публичном деплое включается запрет — `OWA_DENY_PRIVATE_TARGETS=1` |
| URL ресурсов **со страницы** (CSS/JS из её HTML) | только `http`/`https` и только с того же origin; `file://` запрещён категорически, приватные адреса не допускаются никогда |

Без этого страница вида `<link rel=stylesheet href="file:///C:/secrets.txt">`
заставила бы сервер прочитать локальный файл и отправить его в промпт LLM, а
`<script src="http://169.254.169.254/">` — сходить в облачный
metadata-сервиз. Распознаются и обфусцированные формы `http://2130706433/`,
`http://0x7f000001/`, восьмеричные записи.

Дополнительно: один URL не анализируется дважды параллельно, не больше
`OWA_MAX_CONCURRENT` одновременных запусков (дальше — `429`), видимый браузер
через API только с `OWA_ALLOW_HEADED=1`, тело запроса ≤ 1 МБ, наружу не
утекают внутренние сообщения об ошибках.

**Rate limit** (защита от DDoS для публичного деплоя):
по умолчанию `20` запросов `/api/*` на IP за `60` секунд
(`OWA_RATE_LIMIT_MAX` / `OWA_RATE_LIMIT_WINDOW_MS`), дальше `429` с заголовком
`Retry-After`. Заголовки `X-RateLimit-Limit` / `X-RateLimit-Remaining`
отдаются на каждый ответ, чтобы клиенты (включая ИИ-агентов) планировали
повторы. `OWA_RATE_LIMIT_MAX=0` — отключить (локальный режим).
Лимит не касается UI и `/health` (мониторинг должен работать всегда).

## Тесты

```bash
npm test                              # все тесты
node --test test/interpret.test.js    # правила интерпретации
node --test test/cli.test.js          # CLI (есть сетевые тесты)
node --test test/mcp.test.js          # MCP-сервер (есть сетевые тесты)
```

76+ тестов: граничные случаи, стабильность схемы JSON, обработка недоступных сайтов / невалидных URL / несуществующих селекторов, живучесть MCP-сервера, миграции и репозитории SQLite, HTTP-роуты (история, валидация, формат ошибок), правила статанализа CSS/HTML/JS, полный цикл сессий `POST /api/code-analysis`, AI-слой (кэш, retry на 5xx, таймаут, коды ошибок) на мок-сервере, и diff-режим `--baseline`.

> Сетевые тесты CLI/MCP требуют установленного Chromium (`npx playwright install chromium`) — `start.bat` делает это сам.

---

## Комплексный аудит (модули 0–3)

Расширение OWA: полный аудит сайта в пяти секциях + клиентский PDF-отчёт.

### Команды

```bash
# Полный аудит (Performance, SEO, Security, Accessibility, Content) -> JSON
node bin/owa.js audit --full https://example.com
node bin/owa.js audit --full https://example.com --out audit.json --json

# Клиентский PDF-отчёт (титул, Core Web Vitals, топ-10 проблем, графики)
node bin/owa.js report --pdf report.pdf --url https://example.com
```

### Архитектура

```
Заказ/API -> валидация URL + SSRF -> AuditOrchestrator (p-queue, p-retry)
           -> 5 секций на общем Playwright-контексте
           -> нормализация -> integralScore -> PDF/JSON
```

| Файл | Назначение |
|---|---|
| `src/core/orchestrator.js` | Ядро: параллельный запуск секций, изоляция ошибок, интегральная оценка |
| `src/audit/session.js` | Общий Playwright-контекст аудита (одно открытие страницы на все секции) |
| `src/audit/sections.js` | Секции: performance, seo, security, accessibility, content |
| `src/audit/index.js` | `runFullAudit(url)` — запуск всех секций |
| `src/report/pdf.js` | Генерация PDF (Playwright `page.pdf()` + PNG-графики через chartjs-node-canvas) |
| `templates/report.html`, `templates/styles.css` | Шаблон клиентского отчёта |
| `src/security/safe-fetch.js` | Единый `safeFetch`: SSRF-защита, пининг IP, перепроверка редиректов |

### Секции аудита

- **Performance** — LCP, CLS, FCP, TTFB, TBT, Long Tasks, ресурсы, JS-ошибки.
- **SEO** — title, description, canonical, Open Graph, H-структура, alt-тексты, битые внутренние ссылки, robots.txt.
- **Security** — CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, mixed content, HTTPS.
- **Accessibility** — axe-core: violations с селекторами и severity (critical/warning/info).
- **Content** — пустые ссылки, дубли заголовков, длина title, структурированные данные, объём текста.

Падение одной секции не роняет аудит: секция получает `status: "failed"`, остальные отрабатывают.

### SSRF-защита (включена по умолчанию)

Все исходящие запросы идут через `src/security/safe-fetch.js`: DNS резолвится один раз,
адрес проверяется и **пинится в сокет** (закрывает DNS-rebinding), каждый редирект
перепроверяется. Приватные диапазоны (включая `169.254.169.254`), `localhost`, `*.local`
и `*.internal` блокируются; заблокированные попытки логируются с URL и причиной.

Локальная разработка (аудит сборки на `http://localhost:3000`):

```bash
OWA_ALLOW_PRIVATE_TARGETS=1 node bin/owa.js audit --full http://localhost:3000
```

### Откат модулей 0–3 без Git

Изменения лежат в рабочем дереве (коммита нет). Чтобы откатить их локально:

```bash
scripts\rollback-audit-modules.bat    # Windows
sh scripts/rollback-audit-modules.sh  # Linux/macOS
```

Скрипт восстанавливает изменённые файлы из `.rollback-backup/original` и удаляет
добавленные модули (`src/audit`, `src/core`, `src/report`, `src/security`, `templates`,
новые тесты). Бэкап лежит вне Git (в `.gitignore`).

### Обход сайта и sitemap (модуль 4)

```bash
# Обход сайта: до 10 страниц, глубина 2, с учётом robots.txt
node bin/owa.js crawl https://example.com --max-pages 10 --max-depth 2

# Разбор sitemap.xml (включая вложенные sitemap-индексы) + обход страниц
node bin/owa.js sitemap https://example.com/sitemap.xml --max-pages 10

# Только собрать список URL, без аудита
node bin/owa.js crawl https://example.com --no-audit --json
```

Опции: `--max-pages`, `--max-depth`, `--delay <мс>` (пауза между страницами),
`--ignore-robots`, `--no-audit`, `--out`, `--json`.

Каждая страница проходит облегчённый аудит (Performance, SEO, Accessibility) —
Security и Content пропущены ради экономии ресурсов. Итоговый JSON содержит
**агрегаты по сайту**: средняя оценка, средние метрики (LCP/CLS/FCP/TTFB/TBT),
топ проблем по частоте (сколько страниц затронуто) и страницы с худшими
показателями. Обход не выходит за пределы домена и уважает `robots.txt`.

### Сравнение с конкурентами (модуль 5)

```bash
# Сравнительный аудит: ваш сайт против двух конкурентов
node bin/owa.js compare --target https://client-site.com --with https://rival-a.com,https://rival-b.com

# С comparative-PDF для отправки клиенту
node bin/owa.js compare --target https://client-site.com --with https://rival-a.com,https://rival-b.com --pdf compare.pdf

# Только JSON
node bin/owa.js compare --target https://client-site.com --with https://rival-a.com --json --out compare.json
```

Опции: `--delay <мс>` (пауза между аудитами конкурентов, по умолч. 3000 — чужие
сайты не нагружаем), `--pdf <файл>`, `--out <файл>`, `--json`.

Отчёт содержит:
- **Таблицу «метрика на сайт»** — оценки по пяти разделам и ключевые метрики
  (LCP, CLS, FCP, TTFB, TBT, ресурсы) для каждого сайта; колонка клиента
  выделена, отмечен лидер и отставание клиента в баллах.
- **Текстовые выводы** — «где клиент проигрывает и на сколько»: по средней
  оценке, по каждому разделу и по метрикам, где клиент хуже лучшего конкурента.
- **Comparative-PDF** (`--pdf`) — титул с карточками сайтов, сгруппированный
  bar-график оценок по разделам, график LCP/TTFB, таблицы и выводы.

### Ручной сценарий в веб-интерфейсе

В UI пять вкладок — всё, что умеет CLI, доступно руками:

| Вкладка | Что делает |
|---|---|
| **Анализ** | Прежний performance-анализ: метрики загрузки, ресурсы, водопад, Long Tasks |
| **Аудит** | Полный аудит пяти секций: интегральная оценка, карточки разделов, проблемы по приоритету с рекомендациями, кнопка «Скачать PDF-отчёт» |
| **Обход** | Обход сайта: агрегаты (средняя оценка, средние метрики), таблица страниц, топ проблем по частоте |
| **Сравнение** | Клиент против конкурентов: таблица «метрика на сайт», отставание по разделам, выводы, «Скачать PDF со сравнением» |
| **История** | Все прошлые анализы с графиками метрик во времени |

Новые эндпоинты:

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/api/audit` | `{ url, waitMs?, timeoutMs? }` → полный аудит (5 секций) |
| `POST` | `/api/crawl` | `{ url, maxPages?, maxDepth?, delayMs?, respectRobots? }` → обход сайта |
| `POST` | `/api/compare` | `{ target, competitors[], delayMs? }` → сравнение с конкурентами |
| `GET` | `/api/report/pdf?type=audit\|compare&id=<id>` | PDF по готовому отчёту (без повторного аудита) |
