import { describe, expect, it } from 'vitest';
import { latestOnly } from './latest';

describe('latestOnly', () => {
  it('applies only the result of the newest call, even if an older one finishes last', async () => {
    const applied: string[] = [];
    let release!: (v: string) => void;
    const slow = new Promise<string>((r) => (release = r));
    const results = [slow, Promise.resolve('new')];
    const run = latestOnly(() => results.shift()!, (v: string) => applied.push(v));
    const first = run();
    const second = run();
    await second;
    release('old');
    await first;
    expect(applied).toEqual(['new']);
  });

  it('a cancelled runner applies nothing (component unmounted)', async () => {
    const applied: string[] = [];
    const run = latestOnly(async () => 'x', (v: string) => applied.push(v));
    const p = run();
    run.cancel();
    await p;
    expect(applied).toEqual([]);
  });
});
