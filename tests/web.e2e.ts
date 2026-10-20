/**
 * E2E-тесты веб-интерфейса OWA.
 *
 * Работают на фреймворке e2e (tester-army/e2e) поверх Playwright.
 * Приложение поднимает scripts/e2e-run.mjs, адреса приходят в APP_URL / SITE_URL.
 *
 * Селекторы — по data-testid: они не зависят от текста кнопок и подписей.
 */
import { test, describe } from '@e2e-dev/web';
import { expect } from 'e2e';

const SITE_URL = process.env.SITE_URL ?? 'http://127.0.0.1:3000/';

describe('веб-интерфейс OWA', () => {
  test('открывается и показывает вкладки', async ({ app, screen }) => {
    await app.open('/');
    await expect(screen.getByTestId('nav-analyze')).toBeVisible();
    for (const id of ['nav-analyze', 'nav-audit', 'nav-crawl', 'nav-compare', 'nav-history', 'nav-session']) {
      await expect(screen.getByTestId(id)).toBeVisible();
    }
    await expect(screen.getByText('ready')).toBeVisible();
  });

  test('вкладки переключаются', async ({ app, screen }) => {
    await app.open('/');

    await screen.getByTestId('nav-audit').tap();
    await expect(screen.getByTestId('audit-run')).toBeVisible();

    await screen.getByTestId('nav-crawl').tap();
    await expect(screen.getByTestId('crawl-run')).toBeVisible();

    await screen.getByTestId('nav-compare').tap();
    await expect(screen.getByTestId('compare-run')).toBeVisible();

    await screen.getByTestId('nav-history').tap();
    await expect(screen.getByTestId('history-refresh')).toBeVisible();
  });

  test('анализ: метрики и оценка', async ({ app, screen }) => {
    await app.open('/');
    await screen.getByTestId('analyze-url').fill(SITE_URL);
    await screen.getByTestId('analyze-run').tap();

    await expect(screen.getByText('Ключевые метрики')).toBeVisible({ timeout: 120_000 });
    await expect(screen.getByText('Полная загрузка')).toBeVisible();
    await expect(screen.getByText('LCP')).toBeVisible();
    await expect(screen.getByTestId('analyze-pdf')).toBeVisible();
  });

  test('аудит: пять секций и найденные проблемы', async ({ app, screen }) => {
    await app.open('/');
    await screen.getByTestId('nav-audit').tap();
    await screen.getByTestId('audit-url').fill(SITE_URL);
    await screen.getByTestId('audit-run').tap();

    await expect(screen.getByText('Интегральная оценка')).toBeVisible({ timeout: 180_000 });
    for (const name of ['performance', 'seo', 'security', 'accessibility', 'content']) {
      await expect(screen.getByTestId('audit-card-' + name)).toBeVisible();
    }
    await expect(screen.getByText('Проблемы по приоритету')).toBeVisible();
    // У фикстура нет security-заголовков — аудит обязан это найти.
    await expect(screen.getByText('Нет Content-Security-Policy')).toBeVisible();
    await expect(screen.getByTestId('issue-fix').first()).toBeVisible();
  });

  test('обход: агрегаты и страницы', async ({ app, screen }) => {
    await app.open('/');
    await screen.getByTestId('nav-crawl').tap();
    await screen.getByTestId('crawl-url').fill(SITE_URL);
    await screen.getByTestId('crawl-run').tap();

    await expect(screen.getByTestId('crawl-card-pages')).toBeVisible({ timeout: 180_000 });
    await expect(screen.getByTestId('crawl-card-score')).toBeVisible();
  });

  test('сравнение: таблица и выводы', async ({ app, screen }) => {
    await app.open('/');
    await screen.getByTestId('nav-compare').tap();
    await screen.getByTestId('compare-target').fill(SITE_URL);
    await screen.getByTestId('compare-with').fill(`${SITE_URL}about`);
    await screen.getByTestId('compare-run').tap();

    await expect(screen.getByText('Оценки по разделам')).toBeVisible({ timeout: 300_000 });
    await expect(screen.getByTestId('compare-card-target')).toBeVisible();
    await expect(screen.getByTestId('compare-card-competitor1')).toBeVisible();
  });

  test('история: записи и кнопка PDF', async ({ app, screen }) => {
    await app.open('/');
    await screen.getByTestId('nav-history').tap();
    await expect(screen.getByTestId('history-table')).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByRole('link', 'PDF').first()).toBeVisible();
  });
});
