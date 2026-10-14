import { describe, expect, it } from 'vitest';
import { createTimer, elapsedMs, isDone, pauseTimer, progress, remainingMs, startTimer } from './timer';

const MIN = 60_000;

describe('session timer', () => {
  it('counts only while running', () => {
    let t = createTimer(25);
    expect(remainingMs(t, 1_000)).toBe(25 * MIN);
    t = startTimer(t, 0);
    expect(elapsedMs(t, 10 * MIN)).toBe(10 * MIN);
    t = pauseTimer(t, 10 * MIN);
    // Paused for an hour: nothing changes.
    expect(elapsedMs(t, 70 * MIN)).toBe(10 * MIN);
    t = startTimer(t, 70 * MIN);
    expect(remainingMs(t, 75 * MIN)).toBe(10 * MIN);
    expect(progress(t, 75 * MIN)).toBeCloseTo(15 / 25, 10);
  });

  it('is done exactly when the duration has elapsed', () => {
    const t = startTimer(createTimer(50), 1000);
    expect(isDone(t, 1000 + 50 * MIN - 1)).toBe(false);
    expect(isDone(t, 1000 + 50 * MIN)).toBe(true);
    expect(remainingMs(t, 1000 + 90 * MIN)).toBe(0);
    expect(progress(t, 1000 + 90 * MIN)).toBe(1);
  });

  it('start and pause are idempotent', () => {
    let t = startTimer(createTimer(25), 0);
    t = startTimer(t, 5 * MIN);
    expect(elapsedMs(t, 6 * MIN)).toBe(6 * MIN);
    t = pauseTimer(t, 6 * MIN);
    t = pauseTimer(t, 9 * MIN);
    expect(elapsedMs(t, 20 * MIN)).toBe(6 * MIN);
  });

  it('never goes backwards when the wall clock jumps back', () => {
    const t = startTimer(createTimer(25), 10 * MIN);
    expect(elapsedMs(t, 5 * MIN)).toBe(0);
    expect(remainingMs(t, 5 * MIN)).toBe(25 * MIN);
  });

  it('accepts fractional minutes (used for short tests)', () => {
    const t = startTimer(createTimer(0.05), 0);
    expect(isDone(t, 2_999)).toBe(false);
    expect(isDone(t, 3_000)).toBe(true);
  });
});
