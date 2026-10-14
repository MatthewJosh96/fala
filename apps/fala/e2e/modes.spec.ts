import { expect, test, type Page } from '@playwright/test';
import { BASE, TRACKS } from './fixture';
import { audioState, expectPlaying, modeCard, openApp } from './helpers';

const title = (page: Page) => page.locator('.topbar-title');
const back = (page: Page) => page.getByRole('link', { name: 'Wróć' });

test('home lists the three modes; each card opens its screen and starts the looped track', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.greeting h1')).toHaveText(/Dzień dobry|Dobry wieczór|Dobrej nocy/);
  await expect(page.locator('.mode-card .mode-title')).toHaveText(['Skupienie', 'Relaks', 'Sen']);
  await expect(page.getByTestId('resume')).toHaveCount(0);

  await modeCard(page, 'Skupienie').click();
  await expect(page).toHaveURL(new RegExp(`${BASE}#/skupienie$`));
  await expect(title(page)).toHaveText('Skupienie');
  await expect(page).toHaveTitle('Skupienie · Fala');
  await expectPlaying(page, 2);
  const focus = await audioState(page);
  expect(focus.src).toContain(`${BASE}media/${TRACKS.morning.file}`);
  expect(focus.loop).toBe(true);
  await expect(page.getByTestId('remaining')).toHaveText(/^2[45]:\d\d$/);

  // Back home: the chip leads back to the running session.
  await back(page).click();
  await expect(page.getByTestId('resume')).toHaveText(/Skupienie · \d\d:\d\d pozostało/);
  await expect(modeCard(page, 'Skupienie')).toHaveClass(/active/);

  // Same file in Relaks: no restart, no gap.
  await modeCard(page, 'Relaks').click();
  await expect(page).toHaveURL(new RegExp(`${BASE}#/relaks$`));
  await expect(title(page)).toHaveText('Relaks');
  const relax = await audioState(page);
  expect(relax.t).toBeGreaterThanOrEqual(focus.t);
  expect(relax.paused).toBe(false);
  await expect(page.getByTestId('remaining')).toHaveText(/^(10:00|09:\d\d)$/);
  await expect(page.getByTestId('breath-phase')).toHaveText(/Wdech|Wydech/);

  await back(page).click();
  await modeCard(page, 'Sen').click();
  await expect(page).toHaveURL(new RegExp(`${BASE}#/sen$`));
  await expect(title(page)).toHaveText('Sen');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'sleep');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0D0A09');
  await expect(page.locator('.sleep-clock')).toHaveText(/^\d\d:\d\d$/);
  await expect(page.getByTestId('remaining')).toHaveText('45 min');
  await page.getByRole('group', { name: 'Minutnik' }).getByRole('radio', { name: '30 min' }).click();
  await expect(page.getByTestId('remaining')).toHaveText('30 min');
  await expectPlaying(page);

  await back(page).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'sleep');
  await page.getByRole('link', { name: 'Informacje' }).first().click();
  await expect(title(page)).toHaveText('Informacje');
});

test('Skupienie: track choice, and the Minutnik counts only playing time and stops the sound', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await modeCard(page, 'Skupienie').click();
  await expectPlaying(page);

  await page.getByRole('group', { name: 'Utwór' }).getByRole('radio', { name: TRACKS.pulse.title }).click();
  await expect(page.locator('.track-title')).toHaveText(TRACKS.pulse.title);
  await expect.poll(async () => (await audioState(page)).src).toContain(`${BASE}media/${TRACKS.pulse.file}`);
  await expectPlaying(page);

  // Paused: wall-clock time passes, the session does not.
  await page.getByTestId('toggle').click();
  await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Odtwórz');
  const pausedAt = await page.getByTestId('remaining').textContent();
  await page.clock.fastForward('10:00');
  await expect(page.getByTestId('remaining')).toHaveText(pausedAt!);

  // 30 min of wall-clock time since the start, but only ~20 min of playing: still running.
  await page.getByTestId('toggle').click();
  await expectPlaying(page);
  await page.clock.fastForward('20:00');
  await expect(page.getByTestId('remaining')).toHaveText(/^0[45]:\d\d$/);
  await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Pauza');
  expect((await audioState(page)).paused).toBe(false);

  await page.clock.fastForward('05:00');
  await expect(page.getByTestId('status')).toHaveText('Sesja zakończona — Minutnik zatrzymał dźwięk');
  await expect(page.getByTestId('remaining')).toHaveText('00:00');
  await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Odtwórz');
  expect((await audioState(page)).paused).toBe(true);

  // The choice is remembered: after a reload the chip offers the same mode and track.
  await page.reload();
  await page.getByRole('link', { name: 'Wróć' }).click();
  await expect(page.getByTestId('resume')).toHaveText(`Wznów · Skupienie · ${TRACKS.pulse.title} · 25 min`);
});

// Regression: the guide's frame loop stopped for good when its first frame came before
// the session timer started (Relaks opened directly, then Odtwórz). From the home card it
// only worked by luck of event order.
for (const [how, start] of [
  ['opened directly, then Odtwórz', async (page: Page) => {
    await openApp(page, '#/relaks');
    await page.getByTestId('toggle').click();
  }],
  ['started from the home card', async (page: Page) => {
    await openApp(page);
    await modeCard(page, 'Relaks').click();
  }],
] as const) {
  test(`Relaks ${how} with nothing playing: the breathing guide runs`, async ({ page }) => {
    await start(page);
    await expectPlaying(page);
    await expect(page.getByTestId('breath-phase')).toHaveText(/Wdech|Wydech/, { timeout: 5_000 });
    await expect(page.locator('.breath-rate')).toHaveText(/oddech(ów|u)\/min$/);
  });
}

/** Phase sequence of the breathing guide, sampled every `stepMs` of page time. */
async function samplePhases(page: Page, totalMs: number, stepMs = 100) {
  const out: { at: number; phase: string }[] = [];
  for (let at = 0; at <= totalMs; at += stepMs) {
    // React commits on a real-time task after the fake frame, so give it a moment.
    await page.waitForTimeout(30);
    out.push({ at, phase: (await page.getByTestId('breath').getAttribute('data-phase'))! });
    await page.clock.runFor(stepMs);
  }
  return out;
}

/** Lengths (ms) of the complete phase runs, dropping the partial first and last ones. */
function runs(samples: { at: number; phase: string }[]) {
  const out: { phase: string; ms: number }[] = [];
  let start = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].phase !== samples[i - 1].phase) {
      out.push({ phase: samples[i - 1].phase, ms: samples[i].at - samples[start].at });
      start = i;
    }
  }
  return out.slice(1);
}

test('Relaks: inhale and exhale alternate 4:6 from the chosen tempo and slow down to 6 breaths/min', async ({ page }) => {
  await page.clock.install();
  await openApp(page, '#/relaks');
  await expect(page.getByTestId('breath-phase')).toHaveText('Oddech');
  await expect(page.getByTestId('start-rate')).toHaveText('10 / min');
  await page.getByRole('button', { name: 'Wolniej' }).click();
  await page.getByRole('button', { name: 'Szybciej' }).click();
  await expect(page.getByTestId('start-rate')).toHaveText('10 / min');

  await page.getByTestId('toggle').click();
  await expectPlaying(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));

  // 10 breaths/min: 6 s per breath, 2.4 s in, 3.6 s out (the tempo only starts to drop).
  const early = runs(await samplePhases(page, 14_000));
  expect(early.length).toBeGreaterThanOrEqual(3);
  for (const r of early) {
    expect(r.phase).toMatch(/^(inhale|exhale)$/);
    expect(r.ms).toBeGreaterThan(r.phase === 'inhale' ? 2_100 : 3_300);
    expect(r.ms).toBeLessThan(r.phase === 'inhale' ? 2_800 : 4_100);
  }
  await expect(page.locator('.breath-rate')).toHaveText(/^(10|9,\d) oddech(ów|u)\/min$/);

  // After the 3-minute ramp: 6 breaths/min, 4 s in, 6 s out.
  await page.clock.fastForward('03:10');
  const late = runs(await samplePhases(page, 22_000, 200));
  expect(late.length).toBeGreaterThanOrEqual(3);
  for (const r of late) {
    expect(r.ms).toBeGreaterThan(r.phase === 'inhale' ? 3_600 : 5_600);
    expect(r.ms).toBeLessThan(r.phase === 'inhale' ? 4_400 : 6_400);
  }
  await expect(page.locator('.breath-rate')).toHaveText('6 oddechów/min');

  // Reduced motion: the circle stops scaling, the words keep guiding.
  const scaled = await page.locator('.breath-circle').evaluate((e) => (e as HTMLElement).style.transform);
  expect(scaled).toMatch(/^scale\(/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.runFor(500);
  await expect.poll(() => page.locator('.breath-circle').evaluate((e) => (e as HTMLElement).style.transform)).toBe('');
  await expect(page.getByTestId('breath-phase')).toHaveText(/Wdech|Wydech/);
});

test('Minutnik and breathing wait while the sound is buffering (F4)', async ({ page, context }) => {
  await page.clock.install();
  await openApp(page);
  // Audio requests (also those the service worker makes) never get an answer: playback cannot start.
  await context.route('**/*.m4a', () => undefined);
  await modeCard(page, 'Skupienie').click();
  await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Pauza');
  await expect(page.getByTestId('status')).toHaveText('Buforowanie…');

  await page.clock.fastForward('02:00');
  const s = await audioState(page);
  expect(s.t).toBe(0);
  expect(s.paused).toBe(false);
  await expect(page.getByTestId('remaining')).toHaveText('25:00');
});

test('Relaks: changing the session length after the tempo keeps the breathing guide moving (F7)', async ({ page }) => {
  await page.clock.install();
  await openApp(page, '#/relaks');
  await page.getByTestId('toggle').click();
  await expectPlaying(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
  await page.clock.fastForward('01:00');
  await page.getByRole('button', { name: 'Szybciej' }).click();
  await page.getByRole('group', { name: 'Czas sesji' }).getByRole('radio', { name: '20 min' }).click();
  await expect(page.getByTestId('remaining')).toHaveText('20:00');

  // 11 breaths/min: both phases within 8 s.
  const phases = new Set((await samplePhases(page, 8_000, 200)).map((p) => p.phase));
  expect([...phases].sort()).toEqual(['exhale', 'inhale']);
});

// Diagnostics (blind-tester report: pauses without an error): every pause the app itself asks
// for is logged with its source, so a bare 'pause' event means the browser paused on its own.
test('every pause the app asks for is logged with its source', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await modeCard(page, 'Skupienie').click();
  await expectPlaying(page);
  await page.getByTestId('toggle').click();
  await expect(page.getByTestId('toggle')).toHaveAttribute('aria-label', 'Odtwórz');
  await page.getByTestId('toggle').click();
  await expectPlaying(page);
  await page.clock.fastForward('25:30');
  await expect(page.getByTestId('status')).toHaveText(/Sesja zakończona/);

  const log = (await page.evaluate(() => JSON.parse(localStorage.getItem('fala.playbackLog.v1') ?? '[]'))) as {
    type: string;
    detail?: string;
  }[];
  expect(log.filter((e) => e.type === 'pause-request').map((e) => e.detail)).toEqual(['przycisk', 'minutnik']);
  // Each pause event comes right after the request that caused it.
  log.forEach((e, i) => {
    if (e.type === 'pause') expect(log[i - 1]?.type, `pause at #${i} without a request`).toBe('pause-request');
  });
});
