/*
 * Session countdown (Minutnik). Counts wall-clock time only while audio plays, so a
 * page suspended by the OS catches up on its next tick instead of losing time.
 */

export interface TimerState {
  durationMs: number;
  accumulatedMs: number;
  runningSince: number | null;
}

export function createTimer(minutes: number): TimerState {
  return { durationMs: Math.round(minutes * 60_000), accumulatedMs: 0, runningSince: null };
}

export function elapsedMs(t: TimerState, now: number): number {
  const running = t.runningSince === null ? 0 : Math.max(0, now - t.runningSince);
  return t.accumulatedMs + running;
}

export function startTimer(t: TimerState, now: number): TimerState {
  return t.runningSince === null ? { ...t, runningSince: now } : t;
}

export function pauseTimer(t: TimerState, now: number): TimerState {
  return t.runningSince === null ? t : { ...t, accumulatedMs: elapsedMs(t, now), runningSince: null };
}

export function remainingMs(t: TimerState, now: number): number {
  return Math.max(0, t.durationMs - elapsedMs(t, now));
}

export function isDone(t: TimerState, now: number): boolean {
  return elapsedMs(t, now) >= t.durationMs;
}

export function progress(t: TimerState, now: number): number {
  return t.durationMs <= 0 ? 1 : Math.min(1, elapsedMs(t, now) / t.durationMs);
}
