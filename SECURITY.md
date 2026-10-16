# SECURITY.md

OWA — пет-проект в портфолио, **не предназначен для продакшена**. В этом
документе описано, что реализовано в плане безопасности и что намеренно не
делается.

## Как сообщить об уязвимости

Не публикуйте уязвимости публично (issues) — это пет-проект, и «вред» от
раскрытия минимален, но давайте так:

1. **Предпочтительно:** [GitHub Security Advisories](https://github.com/maf1kkk/OWA/security/advisories/new)
   на репозитории.
2. Либо email: создайте issue с меткой `security` (для личного репозитория
   достаточно приватного письма).

Срок реакции: разумный, по возможности до первого публичного ответа.

## Что реализовано

| Механизм | Где | Комментарий |
|---|---|---|
| SSRF-защита целевых URL | `src/security.js` | Только `http(s)`, распознавание обфусцированных приватных адресов (hex/octal/decimal, `::ffff:*`). |
| Защита от `file://` и приватных URL ресурсов | `src/security.js` (уровень 2) | Ссылки на CSS/JS со страницы качаются только с того же origin и только по `http(s)`; `file://` всегда запрещён. |
| Строгий режим публичного деплоя | `OWA_DENY_PRIVATE_TARGETS=1` | Запрещает приватные адреса как *цели* анализа (не для локальной сборки). |
| Basic Auth | `web/auth.js`, `web/middleware/auth.js` | bcrypt-хэш пароля, `WWW-Authenticate: Basic`. |
| Bearer-токен для API | `web/auth.js`, `web/middleware/auth.js` | Сравнение через `crypto.timingSafeEqual` (защита от тайминг-атак). |
| Лимит одновременных анализов | `web/routes/api.js` | `OWA_MAX_CONCURRENT` (по умолч. 2) → дальше `429`. |
| Rate limit на `/api/*` | `web/rate-limit.js` | Фиксированное окно по IP+path, `OWA_RATE_LIMIT_MAX`/`OWA_RATE_LIMIT_WINDOW_MS`, заголовки `X-RateLimit-*` + `Retry-After`. |
| Защита от OOM | `web/routes/api.js` | Дедупликация запущенного URL (`ALREADY_RUNNING`), лимит параллельных запусков. |
| Ретеншн БД | `src/db/maintenance.js` | Удаление просроченных записей, чистка `sources_gz`, `wal_checkpoint(TRUNCATE)`. |
| Ограничение тела запроса | `web/app.js` | `express.json({ limit: '1mb' })` → `413` при превышении. |
| Безопасные заголовки | `web/app.js` | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. |
| Таймауты и клампы | `src/engine.js`, `mcp/server.js` | `clampWait` (0…60000), `OWA_MCP_TOOL_TIMEOUT_MS` (по умолч. 300000), `timeoutMs` клампится 5000…120000. |
| Без утечки внутренних ошибок | `web/middleware/validate.js` | В наружу — нейтральное `{ error, message }`, детали только в лог. |

## Что **не** реализовано и не планируется

- **WAF** (Web Application Firewall) — это вне скоупа пет-проекта. Для
  продакшена придется поднимать Cloudflare / AWS WAF перед этим сервисом.
- **Аудит-лог** (кто и когда вызывал API, какие URL анализировались) — не
  ведётся. Для продакшена добавьте логирование на уровне прокси или
  middleware.
- **Распределённый rate limit** — текущий лимит в памяти одного процесса
  (фиксированное окно по IP+path). За прокси/несколькими инстансами
  нужно будет заменить на Redis (`web/rate-limit.js` спроектирован под эту замену,
  контракт вызова не меняется).
- **Хранение secrets** — `GLM_API_KEY` и токены живут только в `.env`
  (в git не попадают). В продакшене нужно использовать secret manager (HashiCorp
  Vault, AWS Secrets Manager, Cloudflare KV).
- **Защита от DoS на уровне TCP** — за этим отвечает хостинг/прокси,
  не сам сервис.

## Замечания для рецензента

- `mcp/server.js` не использует SQLite — MCP работает standalone, БД нужна
  только веб-интерфейсу и HTTP API.
- `AI_PROVIDER=none` (дефолт) — LLM-объяснения выключены, проект не
  звонит наружу (кроме самой анализируемой страницы).
