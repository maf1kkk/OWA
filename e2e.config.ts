import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { github } from '@e2e-dev/github';

/**
 * Конфигурация E2E-прогонов OWA.
 *
 * Приложение под тестом (веб-интерфейс OWA) и тестовый сайт поднимает
 * scripts/e2e-run.mjs ДО запуска раннера: конфиг читает APP_URL при загрузке,
 * поэтому адрес должен быть известен заранее.
 *
 * В CI добавляется репортер github(): результат прог��на приезжает комментарием
 * в pull request (и в job summary). Локально он не нужен — там только list.
 */
const reporters = process.env.GITHUB_ACTIONS ? ['list', github()] : ['list'];

export default {
  projectId: 'owa',
  tests: ['tests/**/*.e2e.ts'],
  timeout: 240_000,
  actionTimeout: 30_000,
  assertionTimeout: 15_000,
  retries: process.env.GITHUB_ACTIONS ? 1 : 0,
  workers: 1,
  reporters,
  targets: [
    {
      name: 'web',
      engine: web({ browser: 'chromium' }),
      app: { url: process.env.APP_URL ?? 'http://localhost:3210' },
    },
  ],
} satisfies E2EConfig;
