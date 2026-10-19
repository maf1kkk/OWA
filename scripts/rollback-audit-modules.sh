#!/bin/sh
# ============================================================
#  OWA - откат модулей 0-5 (аудит, PDF, SSRF, crawl) без Git
#
#  Восстанавливает изменённые файлы из .rollback-backup/original
#  и удаляет добавленные модули. Работает без доступа к Git.
#
#  Запуск:  sh scripts/rollback-audit-modules.sh
# ============================================================
set -e
cd "$(dirname "$0")/.."

if [ ! -d ".rollback-backup/original" ]; then
  echo "[ОШИБКА] Не найден каталог .rollback-backup/original"
  exit 1
fi

echo "[1/2] Восстанавливаю изменённые файлы..."
for f in .env.example .github/workflows/test.yml .gitignore CHANGELOG.md README.md \
         bin/owa.js mcp/server.js package-lock.json package.json scripts/check-env.js \
         web/routes/api.js; do
  if [ -f ".rollback-backup/original/$f" ]; then
    cp ".rollback-backup/original/$f" "$f"
    echo "  + $f"
  fi
done

echo "[2/2] Удаляю добавленные модули..."
for d in src/audit src/crawl src/core src/report src/security templates; do
  if [ -d "$d" ]; then
    rm -rf "$d"
    echo "  - $d"
  fi
done

for f in test/audit.test.js test/crawl.test.js test/orchestrator.test.js \
         test/pdf.test.js test/ssrf.test.js; do
  if [ -f "$f" ]; then
    rm -f "$f"
    echo "  - $f"
  fi
done

echo ""
echo "Готово. Проверка: node --test \"test/*.test.js\""