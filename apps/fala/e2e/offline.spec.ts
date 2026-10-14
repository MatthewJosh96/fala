import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { BASE, E2E_MEDIA_DIR, SLOW_RANGES_FLAG, TONE, TRACKS } from './fixture';
import { audioState, expectPlaying, expectSteadyPlayback, goHash, modeCard, openApp, rangeFetch } from './helpers';

const CHUNK = 2 * 1024 * 1024;
const mediaPath = (file: string) => `${BASE}media/${file}`;

test('a track downloaded in Skupienie plays offline under /fala/ after a reload, looping at the end', async ({ page, context }) => {
  const bytes = readFileSync(path.join(E2E_MEDIA_DIR, TRACKS.morning.file));
  const url = mediaPath(TRACKS.morning.file);
  expect(bytes.length).toBeGreaterThan(3 * CHUNK);

  await openApp(page, '#/skupienie');
  await expect(page.locator('.track-title')).toHaveText(TRACKS.morning.title);
  await page.getByTestId('download').click();
  await expect(page.getByTestId('availability')).toHaveText(/Dostępne offline/, { timeout: 60_000 });

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.topbar-title')).toHaveText('Skupienie');

  // The page really has no network: the catalogue is not served by the service worker.
  const indexReachable = await page.evaluate((u) => fetch(u).then(() => true, () => false), `${BASE}media/index.json`);
  expect(indexReachable).toBe(false);

  for (const [a, b] of [
    [0, 1],
    [CHUNK - 50, CHUNK + 49],
    [bytes.length - 100, bytes.length - 1],
  ]) {
    const r = await rangeFetch(page, url, a, b);
    expect(r.status).toBe(206);
    expect(r.range).toBe(`bytes ${a}-${b}/${bytes.length}`);
    expect(r.length).toBe(String(b - a + 1));
    expect(Buffer.from(r.bytes)).toEqual(bytes.subarray(a, b + 1));
  }

  // If-Range (F1): the stored copy's strong ETag keeps the range, any other validator gets the whole file.
  const etag = await page.evaluate(async (u) => (await fetch(u, { headers: { Range: 'bytes=0-1' } })).headers.get('etag'), url);
  expect(etag).toMatch(/^"sha256-[0-9a-f]{64}"$/);
  const conditional = (ifRange: string) =>
    page.evaluate(
      async ([u, v]) => {
        const res = await fetch(u, { headers: { Range: 'bytes=0-1', 'If-Range': v } });
        await res.arrayBuffer();
        return { status: res.status, length: res.headers.get('content-length') };
      },
      [url, ifRange] as const,
    );
  expect(await conditional(etag!)).toEqual({ status: 206, length: '2' });
  expect(await conditional('"sha256-stale"')).toEqual({ status: 200, length: String(bytes.length) });

  // Offline only the stored track is known, so there is no track choice.
  await expect(page.locator('.track-title')).toHaveText(TRACKS.morning.title);
  await expect(page.getByRole('group', { name: 'Utwór' })).toHaveCount(0);
  await expect(page.getByTestId('availability')).toHaveText(/Dostępne offline/);

  await page.getByTestId('toggle').click();
  await expectPlaying(page);
  const s = await audioState(page);
  expect(s.src).toContain(url);
  expect(s.loop).toBe(true);

  // Over the end of the file: the element loops instead of ending.
  await page.evaluate((d) => (document.querySelector('audio')!.currentTime = d - 1.5), s.duration);
  await expect.poll(async () => (await audioState(page)).t, { timeout: 15_000 }).toBeLessThan(10);
  const looped = await audioState(page);
  expect(looped).toMatchObject({ paused: false, ended: false, error: null });
  await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Pauza');

  // After removal nothing can serve the file offline any more.
  await page.getByTestId('toggle').click();
  await goHash(page, '#/pobrane');
  const card = page.getByTestId('track-card').filter({ hasText: TRACKS.morning.title });
  await card.getByRole('button', { name: 'Usuń' }).click();
  await expect(page.getByTestId('track-card')).toHaveCount(0);
  const afterRemoval = await page.evaluate(
    (u) => fetch(u, { headers: { Range: 'bytes=0-1' } }).then((r) => r.status, () => 'network-error'),
    url,
  );
  expect(afterRemoval).toBe('network-error');
});

test('a track playing from the network keeps playing while and after it is downloaded (no reload)', async ({ page }) => {
  await openApp(page);
  await modeCard(page, 'Skupienie').click();
  await expectPlaying(page);

  await page.getByTestId('download').click();
  await expect(page.getByTestId('availability')).toHaveText(/Dostępne offline/, { timeout: 60_000 });
  await expectPlaying(page);

  // New ranges now come from the stored copy; the same element must keep reading.
  await page.evaluate(() => (document.querySelector('audio')!.currentTime = 300));
  await expect.poll(async () => (await audioState(page)).t, { timeout: 15_000 }).toBeGreaterThan(301);
  expect((await audioState(page)).error).toBeNull();

  await page.getByTestId('toggle').click();
  await goHash(page, '#/pobrane');
  const card = page.getByTestId('track-card').filter({ hasText: TRACKS.morning.title });
  await card.getByRole('button', { name: 'Usuń' }).click();
  await expect(card.getByTestId('offline-badge')).toHaveText(/Niepobrane/);
});

// Blind tester on the live site: downloading the playing track stopped playback, and every
// later "Odtwórz" played only 1–2 s. The preview server sends validators like GitHub Pages.
test('downloading the track that plays from the network: playback goes on and stays steady', async ({ page }) => {
  // A real link: the element is still mid-stream when the download commits (on localhost it
  // has the whole file in ~0.2 s and never asks the service worker again).
  writeFileSync(SLOW_RANGES_FLAG, '');
  try {
    await openApp(page);
    await modeCard(page, 'Skupienie').click();
    await expectPlaying(page, 2);
    const buffered = () => page.evaluate(() => document.querySelector('audio')!.buffered.end(0));
    expect(await buffered()).toBeLessThan(200); // not the whole file
    await page.getByTestId('download').click();
    await expect(page.getByTestId('availability')).toHaveText(/Dostępne offline/, { timeout: 60_000 });
    await expectSteadyPlayback(page, 6_000);
    // A jump past the buffer: new ranges, now answered from the stored copy.
    await page.evaluate(() => (document.querySelector('audio')!.currentTime = 300));
    await expectSteadyPlayback(page, 12_000);
    await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Pauza');
  } finally {
    rmSync(SLOW_RANGES_FLAG, { force: true });
  }
});

test('Pobrane → Odtwórz: a file without a mode downloads, verifies and plays to its end offline', async ({ page, context }) => {
  await openApp(page);
  await page.getByRole('link', { name: 'Pobrane' }).click();
  const card = page.getByTestId('track-card').filter({ hasText: TONE.title });
  // Mode tracks are played from their screens, not from here.
  await expect(
    page.getByTestId('track-card').filter({ hasText: TRACKS.morning.title }).getByRole('button', { name: 'Odtwórz' }),
  ).toHaveCount(0);

  await card.getByRole('button', { name: 'Pobierz' }).click();
  await expect(card.getByTestId('offline-badge')).toHaveText(/Dostępne offline/, { timeout: 30_000 });
  await card.getByRole('button', { name: 'Sprawdź plik' }).click();
  await expect(card.getByTestId('verify-ok')).toBeVisible({ timeout: 30_000 });

  await context.setOffline(true);
  await page.reload();
  await expect(card.getByTestId('offline-badge')).toHaveText(/Dostępne offline/);
  await card.getByRole('button', { name: 'Odtwórz' }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}#/odtwarzacz$`));
  await expect(page.locator('.topbar-title')).toHaveText('Odtwarzacz testowy');
  await expect(page.getByTestId('availability')).toHaveText(/Dostępne offline/);

  await page.getByTestId('toggle').click();
  await expectPlaying(page);
  const { duration, loop } = await audioState(page);
  expect(duration).toBeCloseTo(TONE.durationS, 0);
  expect(loop).toBe(false);

  await page.getByLabel('Pozycja odtwarzania').fill(String(Math.floor(duration - 3)));
  await expect(page.getByTestId('status')).toHaveText('Plik odtworzony do końca', { timeout: 15_000 });
  expect(await audioState(page)).toMatchObject({ ended: true, error: null });
  await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Odtwórz');

  await page.getByRole('link', { name: 'Wróć' }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}#/pobrane$`));
  await card.getByRole('button', { name: 'Usuń' }).click();
  await expect(page.getByTestId('track-card')).toHaveCount(0);
});

test('the app shell is installable under /fala/: manifest, icons, iOS meta tags, service worker scope', async ({ page, request }) => {
  await openApp(page);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', `${BASE}icons/apple-touch-icon-180.png`);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope);
  expect(new URL(scope!).pathname).toBe(BASE);

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toBe(`${BASE}manifest.webmanifest`);
  const manifest = await (await request.get(manifestHref!)).json();
  expect(manifest).toMatchObject({ display: 'standalone', start_url: BASE, scope: BASE, id: BASE, lang: 'pl' });
  const manifestUrl = new URL(manifestHref!, 'http://x');
  for (const src of [...manifest.icons.map((i: { src: string }) => new URL(i.src, manifestUrl).pathname), `${BASE}icons/apple-touch-icon-180.png`]) {
    expect(src.startsWith(BASE), src).toBe(true);
    const res = await request.get(src);
    expect(res.status(), src).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
  }
  // Nothing in the shell may point outside the base path (it would 404 on GitHub Pages).
  const outside = await page.evaluate((base) => {
    const refs = [...document.querySelectorAll('link[href], script[src]')].map(
      (e) => new URL((e as HTMLLinkElement).href || (e as HTMLScriptElement).src).pathname,
    );
    return refs.filter((p) => !p.startsWith(base));
  }, BASE);
  expect(outside).toEqual([]);
});

test('coming back online refreshes the catalogue without a reload (F9)', async ({ page, context }) => {
  await openApp(page, '#/skupienie');
  await expect(page.locator('.track-title')).toHaveText(TRACKS.morning.title);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.track-title')).toHaveText('Brak utworu');

  await context.setOffline(false);
  await expect(page.locator('.track-title')).toHaveText(TRACKS.morning.title);
  await expect(page.getByTestId('download')).toBeVisible();
});

test('coming back online keeps the session on the track it plays (R4)', async ({ page, context }) => {
  // Only the second Focus track is stored; preferences are the defaults.
  await openApp(page, '#/pobrane');
  const pulse = page.getByTestId('track-card').filter({ hasText: TRACKS.pulse.title });
  await pulse.getByRole('button', { name: 'Pobierz' }).click();
  await expect(pulse.getByTestId('offline-badge')).toHaveText(/Dostępne offline/, { timeout: 60_000 });

  await context.setOffline(true);
  await page.reload();
  await goHash(page, '#/');
  await modeCard(page, 'Skupienie').click();
  await expectPlaying(page);
  expect((await audioState(page)).src).toContain(TRACKS.pulse.file);

  await context.setOffline(false);
  // The full catalogue is back: both tracks are offered again…
  await expect(page.getByRole('group', { name: 'Utwór' }).getByRole('radio')).toHaveCount(2);
  await page.waitForTimeout(1_000);
  // …but the running session keeps its file; only an explicit choice changes it.
  const s = await audioState(page);
  expect(s.src).toContain(TRACKS.pulse.file);
  expect(s.paused).toBe(false);
  await expect(page.locator('.track-title')).toHaveText(TRACKS.pulse.title);
  await expect(page.getByRole('radio', { name: TRACKS.pulse.title })).toBeChecked();
});

test('if the playing file leaves the catalogue, the toggle still stops it and the status says why (L4)', async ({ page }) => {
  const sidecar = path.join(E2E_MEDIA_DIR, TRACKS.morning.file.replace(/\.m4a$/, '.json'));
  await openApp(page);
  await modeCard(page, 'Skupienie').click();
  await expectPlaying(page);
  renameSync(sidecar, `${sidecar}.hidden`); // the server's catalogue no longer lists it
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('online'))); // catalogue refresh
    await expect(page.getByRole('group', { name: 'Utwór' })).toHaveCount(0);
    await page.getByTestId('toggle').click();
    await expect.poll(async () => (await audioState(page)).paused).toBe(true);
    await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Odtwórz');
    await expect(page.getByTestId('status')).toHaveText(/nie ma już w katalogu/);
    await expect(page.locator('.track-title')).toHaveText(TRACKS.morning.title);
  } finally {
    renameSync(`${sidecar}.hidden`, sidecar);
  }
});

test('removing a file in another window keeps its playback going; the space is freed once it stops (R2)', async ({ context }) => {
  const a = await context.newPage();
  await openApp(a, '#/skupienie');
  await a.getByTestId('download').click();
  await expect(a.getByTestId('availability')).toHaveText(/Dostępne offline/, { timeout: 60_000 });
  await a.getByTestId('toggle').click();
  await expectPlaying(a);

  const b = await context.newPage();
  await openApp(b, '#/pobrane');
  const card = b.getByTestId('track-card').filter({ hasText: TRACKS.morning.title });
  await card.getByRole('button', { name: 'Usuń' }).click();
  await expect(card.getByTestId('offline-badge')).toHaveText(/Niepobrane/);

  const t = (await audioState(a)).t;
  await expect.poll(async () => (await audioState(a)).t, { timeout: 10_000 }).toBeGreaterThan(t + 2);
  expect((await audioState(a)).error).toBeNull();

  await a.close(); // its stream ends; the service worker frees the retired copy
  await expect
    .poll(
      async () => {
        await b.reload();
        return b.getByTestId('media-usage').textContent();
      },
      { timeout: 20_000 },
    )
    .toMatch(/^Pobrane pliki: 0 MB$/);
});

test('an unknown path under /fala/ (GitHub Pages 404 page) returns to the app and keeps the screen', async ({ page }) => {
  await page.goto(`${BASE}404.html#/sen`);
  await expect(page).toHaveURL(new RegExp(`${BASE}#/sen$`));
  await expect(page.locator('.topbar-title')).toHaveText('Sen');
});
