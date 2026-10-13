import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_MEDIA_DIR, FIXTURE } from './fixture';

const CHUNK = 2 * 1024 * 1024;

const audioState = (page: Page) =>
  page.evaluate(() => {
    const a = document.querySelector('audio')!;
    return {
      t: a.currentTime,
      duration: a.duration,
      paused: a.paused,
      ended: a.ended,
      error: a.error?.code ?? null,
      src: a.currentSrc,
    };
  });

test('downloaded file plays offline after a reload, including a seek to the end', async ({ page, context }) => {
  const sidecar = JSON.parse(readFileSync(path.join(E2E_MEDIA_DIR, 'e2e-tone.json'), 'utf8'));
  const fileBytes = readFileSync(path.join(E2E_MEDIA_DIR, FIXTURE.file));
  const url = `/media/${FIXTURE.file}`;
  expect(fileBytes.length).toBeGreaterThan(3 * CHUNK);

  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });

  await page.getByRole('link', { name: 'Pobrane' }).click();
  const card = page.getByTestId('track-card').filter({ hasText: FIXTURE.title });
  await card.getByRole('button', { name: 'Pobierz' }).click();
  await expect(card.getByTestId('offline-badge')).toHaveText(/Dostępne offline/, { timeout: 60_000 });

  await card.getByRole('button', { name: 'Sprawdź plik' }).click();
  await expect(card.getByTestId('verify-ok')).toBeVisible({ timeout: 30_000 });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('link', { name: 'Sesja' })).toBeVisible();

  // Proves the page really has no network: the catalogue is not handled by the SW.
  const catalogueReachable = await page.evaluate(() => fetch('/media/index.json').then(() => true, () => false));
  expect(catalogueReachable).toBe(false);

  for (const [a, b] of [
    [0, 1],
    [CHUNK - 50, CHUNK + 49],
    [fileBytes.length - 100, fileBytes.length - 1],
  ]) {
    const r = await page.evaluate(
      async ([u, from, to]) => {
        const res = await fetch(u as string, { headers: { Range: `bytes=${from}-${to}` } });
        return {
          status: res.status,
          range: res.headers.get('content-range'),
          length: res.headers.get('content-length'),
          bytes: Array.from(new Uint8Array(await res.arrayBuffer())),
        };
      },
      [url, a, b] as const,
    );
    expect(r.status).toBe(206);
    expect(r.range).toBe(`bytes ${a}-${b}/${fileBytes.length}`);
    expect(r.length).toBe(String(b - a + 1));
    expect(Buffer.from(r.bytes)).toEqual(fileBytes.subarray(a, b + 1));
  }

  await page.getByRole('link', { name: 'Sesja' }).click();
  await expect(page.getByTestId('availability')).toHaveText(/Dostępne offline/);
  await page.getByTestId('toggle').click();
  await expect.poll(async () => (await audioState(page)).t, { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Pauza');

  const { duration } = await audioState(page);
  expect(duration).toBeCloseTo(sidecar.duration_s, 0);

  await page.getByLabel('Pozycja odtwarzania').fill(String(Math.floor(duration - 3)));
  await expect.poll(async () => (await audioState(page)).t, { timeout: 5_000 }).toBeGreaterThan(duration - 4);
  await expect(page.getByTestId('status')).toHaveText('Plik odtworzony do końca', { timeout: 15_000 });
  const end = await audioState(page);
  expect(end.ended).toBe(true);
  expect(end.error).toBeNull();
  expect(end.src).toContain(url);
  await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Odtwórz');

  // After removal nothing can serve the file offline any more.
  await page.getByRole('link', { name: 'Pobrane' }).click();
  await card.getByRole('button', { name: 'Usuń' }).click();
  await expect(page.getByTestId('track-card')).toHaveCount(0);
  const afterRemoval = await page.evaluate(
    (u) => fetch(u, { headers: { Range: 'bytes=0-1' } }).then((r) => r.status, () => 'network-error'),
    url,
  );
  expect(afterRemoval).toBe('network-error');
});

test('a file opened from the network keeps playing after it is downloaded (no reload)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  // The element has already read metadata through the SW's network path.
  await expect.poll(async () => (await audioState(page)).duration, { timeout: 15_000 }).toBeGreaterThan(0);

  await page.getByRole('link', { name: 'Pobrane' }).click();
  const card = page.getByTestId('track-card').filter({ hasText: FIXTURE.title });
  await card.getByRole('button', { name: 'Pobierz' }).click();
  await expect(card.getByTestId('offline-badge')).toHaveText(/Dostępne offline/, { timeout: 60_000 });

  await page.getByRole('link', { name: 'Sesja' }).click();
  await page.getByTestId('toggle').click();
  await expect.poll(async () => (await audioState(page)).t, { timeout: 15_000 }).toBeGreaterThan(1);
  expect((await audioState(page)).error).toBeNull();
  await page.getByLabel('Pozycja odtwarzania').fill('300');
  await expect.poll(async () => (await audioState(page)).t, { timeout: 15_000 }).toBeGreaterThan(301);
  expect((await audioState(page)).error).toBeNull();

  await page.getByRole('link', { name: 'Pobrane' }).click();
  await card.getByRole('button', { name: 'Usuń' }).click();
  await expect(card.getByTestId('offline-badge')).toHaveText(/Niepobrane/);
});

test('the app shell is installable: manifest, icons and iOS meta tags', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon-180.png');
  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await request.get(manifestHref!)).json();
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/', lang: 'pl' });
  for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon-180.png' }]) {
    const res = await request.get(icon.src);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
  }
});
