#!/usr/bin/env node
/**
 * OWA — проверка окружения (идемпотентная).
 *
 * Использование:
 *   node scripts/check-env.js          # только проверить, коды выхода: 0 / 1 / 3
 *   node scripts/check-env.js --fix    # проверить и поставить недостающее
 *
 * Коды выхода:
 *   0 — всё готово к запуску
 *   1 — есть проблемы, которые не удалось устранить
 *   3 — .env создан из .env.example, нужно заполнить и запустить снова
 *
 * Проверки:
 *   1. версия Node.js >= 24.0.0
 *   2. node_modules (нет или package.json новее -> npm install)
 *   3. Chromium Playwright в пользовательском кэше
 *   4. наличие .env
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MIN_NODE = [24, 0, 0];
const ROOT = path.join(__dirname, '..');
const FIX = process.argv.includes('--fix');
const TTY = process.stdout.isTTY;

const c = {
  reset: TTY ? '\x1b[0m' : '',
  green: TTY ? '\x1b[32m' : '',
  red: TTY ? '\x1b[31m' : '',
  yellow: TTY ? '\x1b[33m' : '',
  blue: TTY ? '\x1b[36m' : '',
  bold: TTY ? '\x1b[1m' : '',
};

const ok = (msg) => console.log(`${c.green}[✓]${c.reset} ${msg}`);
const info = (msg) => console.log(`${c.blue}[→]${c.reset} ${msg}`);
const busy = (msg) => console.log(`${c.yellow}[↓]${c.reset} ${msg}`);
const warn = (msg) => console.log(`${c.yellow}[!]${c.reset} ${msg}`);
const fail = (msg) => console.log(`${c.red}[!]${c.reset} ${msg}`);

let exitCode = 0;

/** Запуск внешней команды. true = успех. */
function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    // shell нужен на Windows: без него .cmd (npm.cmd, npx.cmd) не запускается
    shell: process.platform === 'win32',
  });
  return r.status === 0;
}

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

// ---------------------------------------------------------------- 1. Node
function checkNode() {
  const raw = process.versions.node.split('.').map((n) => parseInt(n, 10));
  const cur = `${raw[0]}.${raw[1]}.${raw[2]}`;
  const okVersion =
    raw[0] > MIN_NODE[0] ||
    (raw[0] === MIN_NODE[0] && (raw[1] > MIN_NODE[1] || (raw[1] === MIN_NODE[1] && raw[2] >= MIN_NODE[2])));

  if (!okVersion) {
    fail(`Node.js v${cur} — нужен >= ${MIN_NODE.join('.')}`);
    info('Установите актуальный Node.js LTS: https://nodejs.org');
    exitCode = 1;
    return false;
  }
  ok(`Node.js v${cur}`);
  return true;
}

// ------------------------------------------------------- 2. node_modules
function checkDependencies() {
  const modulesDir = path.join(ROOT, 'node_modules');
  const lockStamp = path.join(modulesDir, '.package-lock.json');
  const pkgPath = path.join(ROOT, 'package.json');

  let stale = !fs.existsSync(modulesDir);
  if (!stale && fs.existsSync(lockStamp)) {
    // package.json новее установки -> зависимости надо обновить
    const pkgTime = fs.statSync(pkgPath).mtimeMs;
    const lockTime = fs.statSync(lockStamp).mtimeMs;
    if (pkgTime > lockTime) stale = true;
  }

  if (!stale) {
    ok('Зависимости установлены');
    return true;
  }

  if (!FIX) {
    fail('Зависимости не установлены (нет node_modules или package.json изменился)');
    info('Выполните: npm install');
    exitCode = 1;
    return false;
  }

  busy('Устанавливаю зависимости (npm install)...');
  if (!run(npmCmd(), ['install', '--no-audit', '--no-fund'])) {
    fail('npm install завершился с ошибкой — исправьте причину выше и запустите снова');
    exitCode = 1;
    return false;
  }
  ok('Зависимости установлены');
  return true;
}

// ------------------------------------------------ 3. Playwright Chromium
function playwrightCacheDir() {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Caches')
        : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'ms-playwright');
}

function chromiumInstalled() {
  // Точная проверка: спрашиваем у ЛОКАЛЬНОГО playwright, куда он ждёт браузер.
  // Важно: версии браузера у разных версий playwright разные (chromium-1243 и т.п.),
  // поэтому «любая папка chromium-* в кэше» — неверный признак.
  const r = spawnSync('npx', ['playwright', 'install', 'chromium', '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 60000,
  });
  if (r.status === 0) {
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const expected = [...out.matchAll(/Install location:\s+(.+)/g)].map((m) => m[1].trim());
    if (expected.length) return expected.every((p) => fs.existsSync(p));
  }
  // Fallback (нет локального playwright / нет --dry-run): смотрим кэш целиком
  const dir = playwrightCacheDir();
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((name) => name.startsWith('chromium'));
}

/** Системный Chromium-браузер (тот же движок): Chrome или Edge. */
function systemBrowser() {
  const candidates = process.platform === 'win32'
    ? [
        ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
        ['chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
        ['msedge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
        ['msedge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
      ]
    : [[process.platform === 'darwin' ? 'chrome' : 'chrome', '']];
  for (const [channel, exe] of candidates) {
    if (exe && fs.existsSync(exe)) return { channel, exe };
  }
  return null;
}

function checkChromium() {
  if (chromiumInstalled()) {
    ok(`Chromium установлен (кэш: ${playwrightCacheDir()})`);
    return true;
  }

  // Chromium Playwright недоступен (нет CDN/интернета), но анализ всё равно
  // возможен на системном Chrome/Edge — см. src/browser.js.
  const sys = systemBrowser();
  if (sys) {
    warn(`Chromium Playwright не найден в кэше — будет использован системный ${sys.channel} (${sys.exe})`);
    info('Чтобы вернуть отдельный Chromium: npx playwright install chromium');
    return true;
  }

  if (!FIX) {
    fail('Chromium Playwright не найден в кэше');
    info('Выполните: npx playwright install chromium');
    exitCode = 1;
    return false;
  }

  busy('Устанавливаю Playwright Chromium (~200 МБ, один раз)...');
  const r = run('npx', ['playwright', 'install', 'chromium']);
  if (!chromiumInstalled()) {
    fail(r ? 'Chromium так и не появился в кэше' : 'Установка Chromium завершилась с ошибкой');
    exitCode = 1;
    return false;
  }
  ok('Chromium установлен');
  return true;
}

// ------------------------------------------------------------- 4. .env
function checkEnv() {
  const envPath = path.join(ROOT, '.env');
  const examplePath = path.join(ROOT, '.env.example');

  if (!fs.existsSync(envPath)) {
    if (!FIX) {
      fail('.env не найден');
      info('Создайте его из .env.example (или запустите start.bat / check-env --fix)');
      exitCode = 1;
      return false;
    }
    if (!fs.existsSync(examplePath)) {
      fail('.env.example не найден — нечего копировать');
      exitCode = 1;
      return false;
    }
    fs.copyFileSync(examplePath, envPath);
    ok('.env создан из .env.example');
    fail('Заполните .env (порт, пароль, ключ GLM) и запустите снова');
    exitCode = 3;
    return false;
  }

  ok('.env найден');

  // Подсказки (не блокируют запуск)
  const content = fs.readFileSync(envPath, 'utf8');
  if (!/^AUTH_PASSWORD_HASH=.+/m.test(content)) {
    fail('В .env не задан AUTH_PASSWORD_HASH — без него Basic Auth не включится');
    info('Сгенерировать: node -e "require(\'bcrypt\').hash(\'ПАРОЛЬ\',10,(e,h)=>console.log(h))"');
  }
  if (!/^GLM_API_KEY=.+/m.test(content)) {
    info('GLM_API_KEY пуст — AI-объяснения будут возвращать { error: "AI_ERROR" }');
  }
  return true;
}

// --------------------------------------------------------------- main
if (!checkNode()) process.exit(exitCode);
const depsOk = checkDependencies();
// Без установленных зависимостей npx playwright недоступен — проверка браузера бессмысленна
if (depsOk) {
  checkChromium();
} else {
  info('Проверка Chromium пропущена — сначала поставьте зависимости');
}
checkEnv();
process.exit(exitCode);
