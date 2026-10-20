/**
 * Запуск E2E-прогонов: поднимает серверы, затем запускает раннер e2e.
 *
 * Серверы поднимаются ДО раннера: конфиг e2e.config.ts читает APP_URL
 * при загрузке, поэтому адрес должен быть известен заранее.
 *
 *   node scripts/e2e-run.mjs            весь набор
 *   node scripts/e2e-run.mjs tests/audit.e2e.ts   один файл
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServers } from './e2e-support.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const servers = await startTestServers();
console.error(`[e2e] приложение OWA: ${servers.appUrl}`);
console.error(`[e2e] тестовый сайт: ${servers.siteUrl}`);

const args = process.argv.slice(2);
const cli = path.join(root, 'node_modules', 'e2e', 'dist', 'cli', 'bin.js');

const child = spawn(process.execPath, [cli, 'run', ...args], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_URL: servers.appUrl,
    SITE_URL: servers.siteUrl,
    E2E_TELEMETRY_DISABLED: '1',
  },
});

const code = await new Promise((resolve) => {
  child.on('exit', (c) => resolve(c ?? 1));
  child.on('error', () => resolve(2));
});

await servers.stop();
process.exit(code);
