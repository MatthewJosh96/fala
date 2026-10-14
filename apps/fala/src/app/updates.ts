/*
 * Service worker updates without interrupting anything. The worker does not take over by
 * itself (no skipWaiting in sw.ts); this module tracks the update and decides when the page
 * may apply it and reload:
 *   none        no update
 *   waiting     a new worker is installed and waiting
 *   applying    this page asked it to take over (SKIP_WAITING)
 *   activated   it took over at this page's request: reload as soon as nothing plays or stores
 *   controlling it took over because another page asked: reload only when fully idle
 */

export type UpdateState = 'none' | 'waiting' | 'applying' | 'activated' | 'controlling';

export interface Activity {
  /** Sound is playing (or the user pressed play and it is buffering). */
  playing: boolean;
  /** A download or a verification is running. */
  storing: boolean;
  /** A started, unfinished session whose timer a reload would lose. */
  liveSession: boolean;
}

export type UpdateStep = 'none' | 'defer' | 'apply' | 'reload';

/** What the user may trigger by hand: anything but cutting sound or storage work. */
export const canUpdateNow = (a: Activity) => !a.playing && !a.storing;

const idle = (a: Activity) => canUpdateNow(a) && !a.liveSession;

/**
 * The one policy for every reload. `stalled`: the takeover we asked for has not happened in
 * time (another page may hold the old worker); reloading this page frees our side of it, but
 * only if, at that moment, nothing plays and nothing is being stored.
 */
export function updateStep(state: UpdateState, a: Activity, stalled = false): UpdateStep {
  switch (state) {
    case 'waiting':
      return idle(a) ? 'apply' : 'defer';
    case 'applying':
      if (!stalled) return 'none';
      return canUpdateNow(a) ? 'reload' : 'defer';
    case 'activated':
      return canUpdateNow(a) ? 'reload' : 'defer';
    case 'controlling':
      return idle(a) ? 'reload' : 'defer';
    default:
      return 'none';
  }
}

export function createUpdateStore() {
  let state: UpdateState = 'none';
  const listeners = new Set<() => void>();
  const set = (next: UpdateState) => {
    if (next === state) return;
    state = next;
    for (const l of listeners) l();
  };
  let apply: () => void = () => undefined;
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    markWaiting() {
      if (state === 'none') set('waiting');
    },
    markApplying() {
      if (state === 'waiting') set('applying');
    },
    /** A new worker controls the page now. */
    markControlling() {
      if (state === 'activated' || state === 'controlling') return;
      set(state === 'applying' ? 'activated' : 'controlling');
    },
    /** Wired by main.tsx to the plugin's updateServiceWorker(). */
    setApply(fn: () => void) {
      apply = fn;
    },
    apply() {
      if (state !== 'waiting') return;
      set('applying');
      apply();
    },
  };
}

export const updates = createUpdateStore();
