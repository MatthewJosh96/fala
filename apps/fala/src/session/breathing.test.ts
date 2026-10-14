import { describe, expect, it } from 'vitest';
import {
  DEFAULT_START_RATE,
  INHALE_FRACTION,
  RAMP_S,
  TARGET_RATE,
  breathScale,
  clampStartRate,
  cyclesAt,
  phaseAt,
  rateAt,
} from './breathing';

/** Times at which a new phase starts, found by sampling every 10 ms. */
function phaseStarts(startRate: number, fromS: number, toS: number) {
  const out: { t: number; phase: string }[] = [];
  let prev = phaseAt({ startRate }, fromS).phase;
  for (let i = Math.round(fromS * 100) + 1; i <= toS * 100; i++) {
    const t = i / 100;
    const p = phaseAt({ startRate }, t).phase;
    if (p !== prev) out.push({ t, phase: p });
    prev = p;
  }
  return out;
}

describe('breathing schedule', () => {
  it('uses the research defaults: 10/min start, 6/min target, 3 min ramp, inhale:exhale 4:6', () => {
    expect(DEFAULT_START_RATE).toBe(10);
    expect(TARGET_RATE).toBe(6);
    expect(RAMP_S).toBe(180);
    expect(INHALE_FRACTION).toBeCloseTo(0.4, 10);
  });

  it('clamps the starting rate to whole breaths between 6 and 14 per minute', () => {
    expect(clampStartRate(3)).toBe(6);
    expect(clampStartRate(20)).toBe(14);
    expect(clampStartRate(9.6)).toBe(10);
    expect(clampStartRate(Number.NaN)).toBe(DEFAULT_START_RATE);
  });

  it('slows the rate linearly to 6/min over 3 minutes and then holds it', () => {
    const plan = { startRate: 10 };
    expect(rateAt(plan, 0)).toBe(10);
    expect(rateAt(plan, 90)).toBeCloseTo(8, 10);
    expect(rateAt(plan, 180)).toBe(6);
    expect(rateAt(plan, 1800)).toBe(6);
    expect(rateAt(plan, -5)).toBe(10);
  });

  it('keeps a constant rate when the user already breathes at 6/min', () => {
    const plan = { startRate: 6 };
    expect(rateAt(plan, 0)).toBe(6);
    expect(rateAt(plan, 100)).toBe(6);
    expect(cyclesAt(plan, 60)).toBeCloseTo(6, 10);
  });

  it('integrates the rate into breath cycles, continuous at the end of the ramp', () => {
    const plan = { startRate: 14 };
    // Ramp 14 -> 6 over 180 s: average 10/min for 3 min = 30 cycles.
    expect(cyclesAt(plan, 180)).toBeCloseTo(30, 10);
    expect(cyclesAt(plan, 180 - 1e-6)).toBeCloseTo(cyclesAt(plan, 180 + 1e-6), 5);
    expect(cyclesAt(plan, 240)).toBeCloseTo(36, 10);
  });

  it('at 6/min a breath lasts 10 s: 4 s inhale, 6 s exhale', () => {
    const plan = { startRate: 6 };
    expect(phaseAt(plan, 0)).toMatchObject({ phase: 'inhale', progress: 0 });
    expect(phaseAt(plan, 2)).toMatchObject({ phase: 'inhale' });
    expect(phaseAt(plan, 2).progress).toBeCloseTo(0.5, 10);
    expect(phaseAt(plan, 3.99).phase).toBe('inhale');
    expect(phaseAt(plan, 4.01).phase).toBe('exhale');
    expect(phaseAt(plan, 7).progress).toBeCloseTo(0.5, 10);
    expect(phaseAt(plan, 10.01)).toMatchObject({ phase: 'inhale', cycle: 1 });
  });

  it('breaths get longer during the ramp and settle at 4 s + 6 s after it', () => {
    const starts = phaseStarts(10, 0, 240).filter((s) => s.phase === 'inhale').map((s) => s.t);
    const lengths = starts.slice(1).map((t, i) => t - starts[i]);
    // First full breath near 10/min (6 s), slightly longer because the rate is falling.
    expect(lengths[0]).toBeGreaterThan(6);
    expect(lengths[0]).toBeLessThan(6.6);
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1] - 0.011);
    const after = phaseStarts(10, 200, 240);
    const inhaleStart = after.find((s) => s.phase === 'inhale')!.t;
    const exhaleStart = after.find((s) => s.phase === 'exhale' && s.t > inhaleStart)!.t;
    const nextInhale = after.find((s) => s.phase === 'inhale' && s.t > exhaleStart)!.t;
    expect(exhaleStart - inhaleStart).toBeCloseTo(4, 1);
    expect(nextInhale - exhaleStart).toBeCloseTo(6, 1);
  });

  it('maps phases to a circle size that grows on inhale and shrinks on exhale', () => {
    expect(breathScale({ phase: 'inhale', progress: 0 })).toBeCloseTo(0, 10);
    expect(breathScale({ phase: 'inhale', progress: 1 })).toBeCloseTo(1, 10);
    expect(breathScale({ phase: 'exhale', progress: 0 })).toBeCloseTo(1, 10);
    expect(breathScale({ phase: 'exhale', progress: 1 })).toBeCloseTo(0, 10);
    expect(breathScale({ phase: 'inhale', progress: 0.5 })).toBeCloseTo(0.5, 10);
  });
});
