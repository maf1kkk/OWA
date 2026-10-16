@echo off
chcp 65001 >nul 2>nul
setlocal
title OWA - One-Click Web Analyzer
cd /d "%~dp0"

rem --- 1. Node.js в PATH ------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js не найден в PATH.
  echo     Установите Node.js 22.16 или новее с https://nodejs.org
  echo     и запустите start.bat снова.
  exit /b 1
)

rem --- 2. Остальная проверка + установка недостающего -------------------
node scripts\check-env.js --fix
set ENV_RESULT=%errorlevel%

if "%ENV_RESULT%"=="1" (
  echo.
  echo [!] Окружение не готово - см. сообщения выше.
  exit /b 1
)

if "%ENV_RESULT%"=="3" (
  echo.
  echo [*] Заполните .env - пароль и ключ GLM - и запустите start.bat снова.
  exit /b 0
)

rem --- 3. Запуск сервера (логи в консоли, остановка - Ctrl+C) -----------
echo.
echo [^>] Сервер: http://localhost:3210
node web\server.js
exit /b %errorlevel%
