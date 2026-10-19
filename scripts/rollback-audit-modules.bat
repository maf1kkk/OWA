@echo off
REM ============================================================
REM  OWA - откат модулей 0-5 + веб-UI (аудит, PDF, SSRF, crawl, compare) без Git
REM
REM  Восстанавливает изменённые файлы из .rollback-backup\original
REM  и удаляет добавленные модули. Работает без доступа к Git.
REM
REM  Запуск:  scripts\rollback-audit-modules.bat
REM ============================================================
setlocal
cd /d "%~dp0\.."

if not exist ".rollback-backup\original" (
  echo [ОШИБКА] Не найден каталог .rollback-backup\original
  echo Запускайте скрипт из корня проекта.
  exit /b 1
)

echo [1/2] Восстанавливаю изменённые файлы...
for %%F in (
  .env.example
  .github\workflows\test.yml
  .gitignore
  CHANGELOG.md
  README.md
  bin\owa.js
  mcp\server.js
  package-lock.json
  package.json
  scripts\check-env.js
  web\app.js
  web\routes\api.js
) do (
  if exist ".rollback-backup\original\%%F" (
    copy /Y ".rollback-backup\original\%%F" "%%F" >nul && echo   + %%F
  )
)

echo [2/2] Удаляю добавленные модули...
for %%D in (
  src\audit
  src\crawl
  src\compare
  src\core
  src\report
  src\security
  templates
) do (
  if exist "%%D" (
    rmdir /S /Q "%%D" && echo   - %%D
  )
)

if exist "web\routes\audit.js" (
  del /Q "web\routes\audit.js" && echo   - web\routes\audit.js
)

for %%F in (
  test\audit.test.js
  test\crawl.test.js
  test\compare.test.js
  test\orchestrator.test.js
  test\pdf.test.js
  test\ssrf.test.js
) do (
  if exist "%%F" (
    del /Q "%%F" && echo   - %%F
  )
)

echo.
echo Готово. Проверка: node --test "test/*.test.js"
echo Зависимости: node "%ProgramFiles%\nodejs\node_modules\npm\bin\npm-cli.js" install
endlocal
