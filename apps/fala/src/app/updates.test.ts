import { describe, expect, it } from 'vitest';
import { canUpdateNow, createUpdateStore, updateStep } from './updates';

const idle = { playing: false, storing: false, liveSession: false };

describe('service worker updates wait for a quiet moment', () => {
  it('a waiting update is applied only when nothing plays, stores or is mid-session', () => {
    expect(updateStep('none', idle)).toBe('none');
    expect(updateStep('waiting', idle)).toBe('apply');
    expect(updateStep('waiting', { ...idle, playing: true })).toBe('defer');
    expect(updateStep('waiting', { ...idle, storing: true })).toBe('defer');
    expect(updateStep('waiting', { ...idle, liveSession: true })).toBe('defer');
    expect(updateStep('applying', idle)).toBe('none');
  });

  it('a new worker that already controls the page (another tab) reloads only when quiet', () => {
    expect(updateStep('controlling', idle)).toBe('reload');
    expect(updateStep('controlling', { ...idle, playing: true })).toBe('defer');
    expect(updateStep('controlling', { ...idle, storing: true })).toBe('defer');
    expect(updateStep('controlling', { ...idle, liveSession: true })).toBe('defer');
  });

  it('after this page applied the update, it reloads unless sound plays or a file is stored', () => {
    expect(updateStep('activated', { ...idle, liveSession: true })).toBe('reload');
    expect(updateStep('activated', { ...idle, playing: true })).toBe('defer');
    expect(updateStep('activated', { ...idle, storing: true })).toBe('defer');
  });

  it('the user may update a paused session by hand, never while sound plays or a file is stored', () => {
    expect(canUpdateNow({ ...idle, liveSession: true })).toBe(true);
    expect(canUpdateNow({ ...idle, playing: true })).toBe(false);
    expect(canUpdateNow({ ...idle, storing: true })).toBe(false);
  });

  it('the store moves none → waiting → applying → activated and notifies subscribers', () => {
    const s = createUpdateStore();
    const seen: string[] = [];
    s.subscribe(() => seen.push(s.get()));
    s.markWaiting();
    s.markWaiting();
    s.markApplying();
    s.markControlling();
    s.markWaiting(); // a late "waiting" never downgrades a worker that already controls
    expect(seen).toEqual(['waiting', 'applying', 'activated']);
    expect(s.get()).toBe('activated');
  });

  it('a worker activated elsewhere is "controlling", not "activated"', () => {
    const s = createUpdateStore();
    s.markWaiting();
    s.markControlling();
    expect(s.get()).toBe('controlling');
  });

  it('a takeover that stalls reloads only when nothing plays or stores, re-checked when the fallback fires (R3)', () => {
    expect(updateStep('applying', idle, false)).toBe('none');
    expect(updateStep('applying', idle, true)).toBe('reload');
    expect(updateStep('applying', { ...idle, liveSession: true }, true)).toBe('reload');
    expect(updateStep('applying', { ...idle, playing: true }, true)).toBe('defer');
    expect(updateStep('applying', { ...idle, storing: true }, true)).toBe('defer');
  });
});
