import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE } from './fixture';
import { audioState, openApp } from './helpers';

/*
 * Opt-in: the real 8 h diagnostic file through the whole offline path (~466 MB into
 * Cache Storage, SHA-256 twice, playback and a seek to the last seconds offline), along
 * the route docs/ACCEPTANCE.md uses: Pobrane -> Pobierz -> Odtwórz -> Odtwarzacz testowy.
 * The file is not kept on disk; regenerate it first (see docs/ACCEPTANCE.md), then:
 *   FALA_E2E_MEDIA_DIR=$PWD/../../renders/diagnostic FALA_E2E_LARGE_FILE=fala-diag-8h.m4a \
 *     npx playwright test e2e/large-file.spec.ts
 */
const dir = process.env.FALA_E2E_MEDIA_DIR;
const file = process.env.FALA_E2E_LARGE_FILE;
const present = !!dir && !!file && existsSync(path.join(dir, file));

test.skip(!present, 'opt-in: set FALA_E2E_MEDIA_DIR and FALA_E2E_LARGE_FILE to an existing file');

test('large diagnostic file downloads, verifies and plays to the end offline', async ({ page, context }) => {
  test.setTimeout(15 * 60_000);
  const sidecar = JSON.parse(readFileSync(path.join(dir!, file!.replace(/\.m4a$/, '.json')), 'utf8'));

  await openApp(page, '#/pobrane');
  const card = page.getByTestId('track-card').filter({ hasText: sidecar.title });
  const t0 = Date.now();
  await card.getByRole('button', { name: 'Pobierz' }).click();
  await expect(card.getByTestId('offline-badge')).toHaveText(/Dostępne offline/, { timeout: 12 * 60_000 });
  console.log(`download + verification of ${sidecar.size} B: ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  await context.setOffline(true);
  await page.reload();
  await card.getByRole('button', { name: 'Odtwórz' }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}#/odtwarzacz$`));
  await expect(page.getByTestId('availability')).toHaveText(/Dostępne offline/);
  await page.getByTestId('toggle').click();
  await expect.poll(async () => (await audioState(page)).t, { timeout: 15_000 }).toBeGreaterThan(1);
  const { duration } = await audioState(page);
  expect(duration).toBeCloseTo(sidecar.duration_s, 0);

  await page.getByLabel('Pozycja odtwarzania').fill(String(Math.floor(duration / 2)));
  await expect.poll(async () => (await audioState(page)).t, { timeout: 15_000 }).toBeGreaterThan(duration / 2 + 1);
  await page.getByLabel('Pozycja odtwarzania').fill(String(Math.floor(duration - 3)));
  await expect(page.getByTestId('status')).toHaveText('Plik odtworzony do końca', { timeout: 30_000 });
  expect(await audioState(page)).toMatchObject({ ended: true, error: null });

  await page.getByRole('link', { name: 'Wróć' }).click();
  await card.getByRole('button', { name: 'Usuń' }).click();
  await expect(page.getByTestId('track-card').filter({ hasText: sidecar.title })).toHaveCount(0);
});
