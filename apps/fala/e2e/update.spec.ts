import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { REPO_ROOT, TONE } from './fixture';
import { audioState, expectPlaying, modeCard, openApp } from './helpers';

/*
 * F5: a new service worker must not reload the page during playback or storage work.
 * A "new version" is published by changing the built sw.js on disk (restored afterwards);
 * the page then asks its registration to look for an update.
 * Chromium does not activate a new worker while the old one still streams a response, so
 * the first test plays a short file that is fully buffered (no request left open): that is
 * when the old code reloaded the page mid-playback.
 */
const SW_FILE = path.join(REPO_ROOT, 'apps/fala/dist/sw.js');

async function publishNewWorker(page: Page) {
  writeFileSync(SW_FILE, Buffer.concat([readFileSync(SW_FILE), Buffer.from(`\n/* e2e update ${Date.now()} */\n`)]));
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
}

const hasWaitingWorker = (page: Page) =>
  page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting != null).catch(() => false);

function countLoads(page: Page) {
  let loads = 0;
  page.on('load', () => loads++);
  return () => loads;
}

let original: Buffer;
test.beforeEach(() => {
  original = readFileSync(SW_FILE);
});
test.afterEach(() => writeFileSync(SW_FILE, original));

test('an app update never reloads the page while sound plays; it applies once playback stops', async ({ page }) => {
  await openApp(page, '#/pobrane');
  await page.getByTestId('track-card').filter({ hasText: TONE.title }).getByRole('button', { name: 'Odtwórz' }).click();
  await page.getByTestId('toggle').click();
  await expectPlaying(page);
  await page.waitForFunction(() => {
    const a = document.querySelector('audio')!;
    return a.buffered.length > 0 && a.buffered.end(a.buffered.length - 1) >= a.duration - 0.05;
  });
  const loads = countLoads(page);

  await publishNewWorker(page);
  await expect.poll(async () => loads() > 0 || (await hasWaitingWorker(page)), { timeout: 20_000 }).toBe(true);
  await page.waitForTimeout(2_000); // the old code reloaded within ~1 s here
  expect(loads(), 'the page reloaded during playback').toBe(0);
  const t = (await audioState(page)).t;
  await expect.poll(async () => (await audioState(page)).t).toBeGreaterThan(t + 0.5);

  // Nothing plays and no session is open: the update applies by itself.
  await page.getByTestId('toggle').click();
  await expect.poll(loads, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  expect(await hasWaitingWorker(page)).toBe(false);
});

test('a paused session keeps its state; the home screen offers the update instead', async ({ page }) => {
  await openApp(page);
  await modeCard(page, 'Skupienie').click();
  await expectPlaying(page);
  const loads = countLoads(page);

  await publishNewWorker(page);
  await expect.poll(() => hasWaitingWorker(page), { timeout: 20_000 }).toBe(true);
  await page.getByTestId('toggle').click();
  await page.getByRole('link', { name: 'Wróć' }).click();
  await expect(page.getByTestId('update')).toContainText('Dostępna aktualizacja');
  await expect(page.getByTestId('resume')).toContainText('pozostało');
  await page.waitForTimeout(2_000);
  expect(loads(), 'a paused session was reloaded away').toBe(0);

  await page.getByRole('button', { name: 'Zaktualizuj' }).click();
  await expect.poll(loads, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
  expect(await hasWaitingWorker(page)).toBe(false);
  await expect(page.getByTestId('update')).toHaveCount(0);
});

test('if the takeover stalls, the 10 s fallback never reloads a page that started playing meanwhile (R3)', async ({ context }) => {
  // Page B keeps a stream open on the old worker, so Chromium holds the new one back.
  const b = await context.newPage();
  await openApp(b);
  await modeCard(b, 'Skupienie').click();
  await expectPlaying(b);

  const a = await context.newPage();
  await openApp(a);
  const loadsA = countLoads(a);
  await publishNewWorker(a);
  await expect(a.getByTestId('update')).toContainText('Aktualizuję', { timeout: 20_000 }); // A was idle: it applied

  await modeCard(a, 'Skupienie').click();
  await expectPlaying(a);
  await a.waitForTimeout(11_000);
  expect(loadsA(), 'the fallback reloaded a playing page').toBe(0);
  expect((await audioState(a)).paused).toBe(false);
});

test('a stalled takeover reloads an idle page at most once for the same waiting worker (M1)', async ({ context }) => {
  const b = await context.newPage();
  await openApp(b);
  await modeCard(b, 'Skupienie').click();
  await expectPlaying(b);

  const a = await context.newPage();
  await openApp(a);
  const loadsA = countLoads(a);
  await publishNewWorker(a);
  await expect(a.getByTestId('update')).toContainText('Aktualizuję', { timeout: 20_000 });
  await expect.poll(loadsA, { timeout: 20_000 }).toBe(1); // the one fallback reload
  await a.waitForTimeout(14_000); // the old code reloaded again ~10 s later, and so on
  expect(loadsA(), 'the idle page kept reloading').toBe(1);
  await expect(a.getByTestId('update')).toContainText('Aktualizuję'); // still waiting for window B
  expect((await audioState(b)).paused).toBe(false);
});
