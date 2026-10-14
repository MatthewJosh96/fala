import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { REPO_ROOT } from './fixture';
import { expectPlaying, modeCard, openApp } from './helpers';

/*
 * Opt-in: iPhone-sized screenshots for docs/design/screens/ (compared with the mockups
 * in docs/design/gen/). FALA_SCREENS=1 npx playwright test e2e/screens.spec.ts
 */
test.skip(!process.env.FALA_SCREENS, 'opt-in: FALA_SCREENS=1 writes docs/design/screens/*.png');

const OUT = path.join(REPO_ROOT, 'docs/design/screens');

test.use({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  timezoneId: 'Europe/Warsaw',
  locale: 'pl-PL',
});

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled', caret: 'hide' });

test('screens', async ({ page }) => {
  test.setTimeout(180_000);
  await page.clock.install({ time: new Date('2026-10-14T20:15:00+02:00') });
  // A previous session, so the home screen shows the "Wznów" chip as in the mockup.
  await page.addInitScript(() => {
    if (!localStorage.getItem('fala.prefs.v1')) {
      localStorage.setItem(
        'fala.prefs.v1',
        JSON.stringify({ focus: { trackId: null, minutes: 25 }, last: { mode: 'focus', at: '2026-10-14T16:00:00+02:00' } }),
      );
    }
  });

  await openApp(page);
  await expect(page.getByTestId('resume')).toContainText('Poranne światło');
  await shot(page, 'home');

  await modeCard(page, 'Skupienie').click();
  await expectPlaying(page);
  await page.clock.fastForward('09:30');
  await expect(page.getByTestId('remaining')).toHaveText(/^15:\d\d$/);
  await shot(page, 'skupienie');

  await page.getByRole('link', { name: 'Wróć' }).click();
  await modeCard(page, 'Relaks').click();
  await expect(page.getByTestId('breath-phase')).toHaveText(/Wdech|Wydech/);
  await page.clock.fastForward('00:40');
  await expect(page.getByTestId('breath-phase')).toHaveText(/Wdech|Wydech/);
  await shot(page, 'relaks');

  await page.getByRole('link', { name: 'Wróć' }).click();
  await modeCard(page, 'Sen').click();
  await expectPlaying(page);
  await page.clock.fastForward('03:00');
  await shot(page, 'sen');
});
