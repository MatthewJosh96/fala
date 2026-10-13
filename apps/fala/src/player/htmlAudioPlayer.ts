import type { PlaybackEvent, Player, PlayerState, TrackMeta } from './types';

/*
 * One <audio> element, nothing else. Continuity of playback is left entirely to the
 * browser's media stack: there is no AudioContext, no 'ended' handler, no timers and
 * no crossfades. Every listener below only mirrors state into the UI, the lock-screen
 * controls or the diagnostic log.
 */

const SEEK_STEP_S = 15;

export class HtmlAudioPlayer implements Player {
  private readonly audio: HTMLAudioElement;
  private state: PlayerState = {
    status: 'idle',
    track: null,
    currentTime: 0,
    duration: 0,
    waiting: false,
    error: null,
  };
  private listeners = new Set<(s: PlayerState) => void>();
  private eventListeners = new Set<(e: PlaybackEvent) => void>();
  private cleanup: (() => void)[] = [];

  constructor(container: HTMLElement = document.body) {
    this.audio = document.createElement('audio');
    this.audio.preload = 'metadata';
    this.audio.dataset.testid = 'fala-audio';
    container.appendChild(this.audio);

    const sync = () => this.syncFromElement();
    for (const type of ['loadedmetadata', 'durationchange', 'timeupdate', 'playing', 'seeked', 'canplay']) {
      this.listen(type, sync);
    }
    this.listen('play', () => {
      this.log('play');
      sync();
      this.updatePositionState();
    });
    this.listen('pause', () => {
      // A media element fires 'pause' when it reaches the end, so the end of the file
      // is recorded here without an 'ended' handler.
      this.log('pause', this.audio.ended ? 'koniec pliku' : undefined);
      sync();
      this.updatePositionState();
    });
    this.listen('waiting', () => {
      this.log('waiting');
      this.set({ waiting: true });
    });
    this.listen('playing', () => this.set({ waiting: false }));
    this.listen('stalled', () => this.log('stalled'));
    this.listen('emptied', () => this.log('emptied'));
    this.listen('seeked', () => this.updatePositionState());
    this.listen('durationchange', () => this.updatePositionState());
    this.listen('ratechange', () => this.updatePositionState());
    this.listen('error', () => {
      const err = this.audio.error;
      const msg = err ? `MediaError ${err.code}${err.message ? `: ${err.message}` : ''}` : 'nieznany błąd';
      this.log('error', msg);
      this.set({ status: 'error', error: msg });
    });

    this.setupMediaSession();
  }

  private listen(type: string, fn: () => void) {
    this.audio.addEventListener(type, fn);
    this.cleanup.push(() => this.audio.removeEventListener(type, fn));
  }

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private syncFromElement() {
    const a = this.audio;
    let status: PlayerState['status'];
    if (a.error) status = 'error';
    else if (a.ended) status = 'ended';
    else if (!a.paused) status = 'playing';
    else if (this.state.track) status = a.readyState >= 1 ? 'paused' : 'loading';
    else status = 'idle';
    this.set({
      status,
      currentTime: a.currentTime,
      duration: Number.isFinite(a.duration) ? a.duration : 0,
    });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = status === 'playing' ? 'playing' : 'paused';
    }
  }

  private log(type: string, detail?: string) {
    const e: PlaybackEvent = { at: new Date().toISOString(), type, position: this.audio.currentTime, detail };
    for (const l of this.eventListeners) l(e);
  }

  private setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => void this.play()],
      ['pause', () => this.pause()],
      ['stop', () => this.pause()],
      ['seekto', (d) => d.seekTime !== undefined && this.seek(d.seekTime)],
      ['seekbackward', (d) => this.seek(this.audio.currentTime - (d.seekOffset ?? SEEK_STEP_S))],
      ['seekforward', (d) => this.seek(this.audio.currentTime + (d.seekOffset ?? SEEK_STEP_S))],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
        this.cleanup.push(() => ms.setActionHandler(action, null));
      } catch {
        // Older WebKit throws for actions it does not know.
      }
    }
  }

  private updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = this.audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        position: Math.min(Math.max(this.audio.currentTime, 0), d),
        playbackRate: this.audio.playbackRate || 1,
      });
    } catch {
      // Position state is cosmetic for the lock screen; never let it break playback.
    }
  }

  load(track: TrackMeta) {
    if (this.state.track?.src === track.src) return;
    this.set({ track, status: 'loading', currentTime: 0, duration: 0, error: null, waiting: false });
    this.audio.src = track.src;
    this.audio.load();
    if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album ?? 'Fala',
        artwork: track.artwork ?? [],
      });
    }
  }

  async play() {
    try {
      await this.audio.play();
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.log('play-rejected', msg);
      this.set({ error: msg });
      this.syncFromElement();
    }
  }

  pause() {
    this.audio.pause();
  }

  async toggle() {
    if (this.audio.paused) await this.play();
    else this.pause();
  }

  seek(seconds: number) {
    const d = Number.isFinite(this.audio.duration) ? this.audio.duration : Infinity;
    this.audio.currentTime = Math.min(Math.max(seconds, 0), d);
    this.syncFromElement();
  }

  getState() {
    return this.state;
  }

  subscribe(listener: (s: PlayerState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEvent(listener: (e: PlaybackEvent) => void) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  destroy() {
    for (const c of this.cleanup) c();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.audio.remove();
    this.listeners.clear();
    this.eventListeners.clear();
  }
}
