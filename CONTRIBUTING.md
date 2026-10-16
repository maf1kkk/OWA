# CONTRIBUTING.md

Спасибо за интерес! OWA — пет-проект в портфолио, но к的贡献ам
относимся серьёзно. Ниже — короткий регламент.

## Запуск локально

```bash
# Windows
start.bat

# Linux / macOS
sh start.sh
```

Одна команда проверяет окружение (Node.js ≥ 22.16, зависимости, Chromium,
`.env`) и запускает сервер на `http://localhost:3210`.

Ручной запуск без проверки:

```bash
npm install
npx playwright install chromium
node web/server.js
```

## Тесты

```bash
npm test              # все тесты (node --test)
node --test test/<имя>.test.js   # один файл
```

Без установленного Chromium (`npx playwright install chromium`)
зависят сетевые тесты CLI/MCP — остальные проходят.

## Стиль коммитов

Conventional Commits (на русском или английском):

```
feat: описание
fix: описание
docs: описание
chore: описание
refactor: описание
```

Один коммит — одна логическая перемена. Не смешивайте фичу и фикс.

## PR-процесс

1. Один PR — одна тема. Не сваливайте разные задачи в один PR.
2. В описании PR: что изменилось, как проверить, какие тесты тронули.
3. Перед пушем: `npm test` зелёный.
4. Не коммитьте `.env`, `data/`, `*.db`, `report*.json` — это в `.gitignore`.

## Направления, где помощь нужна

- Новые правила статанализа (`src/static-analyzer/*`).
- Новые метрики в коллекторах (`src/collectors/*`).
- Улучшение интерпретации (`src/interpret.js` — осторожно, это ядро).
- CI, Dependabot, бейджи.
