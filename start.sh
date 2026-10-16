#!/usr/bin/env sh
# OWA — идемпотентный запуск на Unix (Linux / macOS).
set -eu
cd "$(dirname "$0")"

# --- 1. Node.js в PATH --------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js не найден в PATH."
  echo "    Установите Node.js 22.16 или новее: https://nodejs.org"
  echo "    и запустите start.sh снова."
  exit 1
fi

# --- 2. Остальная проверка + установка недостающего ---------------------
set +e
node scripts/check-env.js --fix
ENV_RESULT=$?
set -e

if [ "$ENV_RESULT" = "1" ]; then
  echo ""
  echo "[!] Окружение не готово - см. сообщения выше."
  exit 1
fi

if [ "$ENV_RESULT" = "3" ]; then
  echo ""
  echo "[*] Заполните .env (пароль, ключ GLM) и запустите start.sh снова."
  exit 0
fi

# --- 3. Запуск сервера (логи в консоли, остановка - Ctrl+C) -------------
echo ""
echo "[>] Сервер: http://localhost:3210"
exec node web/server.js
