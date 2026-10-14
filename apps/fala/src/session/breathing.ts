/*
 * Visual breathing pacer for Relaks. Research (research-params.json, relax):
 * ~6 breaths/min raises vagal HRV (M); with a fixed 6/min pacer people averaged
 * ~12/min, so the pacer starts at the user's own rate and slows down (design inference).
 * Inhale:exhale 4:6 is a design choice (longer exhale), recorded in DECISIONS.md.
 */

export const TARGET_RATE = 6;
export const MIN_START_RATE = 6;
export const MAX_START_RATE = 14;
export const DEFAULT_START_RATE = 10;
export const RAMP_S = 180;
export const INHALE_FRACTION = 4 / 10;

export interface BreathPlan {
  /** Breaths per minute the user reports at the start. */
  startRate: number;
}

export type BreathPhaseName = 'inhale' | 'exhale';

export interface BreathPhase {
  phase: BreathPhaseName;
  /** 0..1 within the current phase. */
  progress: number;
  /** Index of the current breath, from 0. */
  cycle: number;
  /** Current rate, breaths per minute. */
  rate: number;
}

export function clampStartRate(rate: number): number {
  if (!Number.isFinite(rate)) return DEFAULT_START_RATE;
  return Math.min(MAX_START_RATE, Math.max(MIN_START_RATE, Math.round(rate)));
}

export function rateAt(plan: BreathPlan, tS: number): number {
  const r0 = plan.startRate;
  if (tS <= 0) return r0;
  if (tS >= RAMP_S) return TARGET_RATE;
  return r0 + (TARGET_RATE - r0) * (tS / RAMP_S);
}

/** Number of breaths completed by time t: the integral of the rate. */
export function cyclesAt(plan: BreathPlan, tS: number): number {
  const r0 = plan.startRate;
  if (tS <= 0) return 0;
  if (tS <= RAMP_S) return (r0 * tS + ((TARGET_RATE - r0) * tS * tS) / (2 * RAMP_S)) / 60;
  return ((r0 + TARGET_RATE) * RAMP_S) / 120 + (TARGET_RATE * (tS - RAMP_S)) / 60;
}

export function phaseAt(plan: BreathPlan, tS: number): BreathPhase {
  const c = cyclesAt(plan, tS);
  const cycle = Math.floor(c);
  const f = c - cycle;
  const rate = rateAt(plan, tS);
  if (f < INHALE_FRACTION) return { phase: 'inhale', progress: f / INHALE_FRACTION, cycle, rate };
  return { phase: 'exhale', progress: (f - INHALE_FRACTION) / (1 - INHALE_FRACTION), cycle, rate };
}

/** 0 = smallest circle (lungs empty), 1 = largest; sine easing so turns feel soft. */
export function breathScale(p: Pick<BreathPhase, 'phase' | 'progress'>): number {
  const eased = (1 - Math.cos(Math.PI * Math.min(Math.max(p.progress, 0), 1))) / 2;
  return p.phase === 'inhale' ? eased : 1 - eased;
}
