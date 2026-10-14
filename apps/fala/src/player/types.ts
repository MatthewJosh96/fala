/*
 * Platform-neutral playback contract. The PWA implements it with one
 * HTMLAudioElement; a Capacitor build can swap in a native AVPlayer adapter
 * without touching the UI.
 */

export interface TrackMeta {
  id: string;
  title: string;
  artist: string;
  album?: string;
  /** URL the platform player opens; for the PWA a same-origin path served by the SW. */
  src: string;
  artwork?: { src: string; sizes: string; type: string }[];
  /** Native element looping; sessions loop a short render until their timer ends. */
  loop?: boolean;
}

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerState {
  status: PlayerStatus;
  track: TrackMeta | null;
  currentTime: number;
  duration: number;
  /** True while the element waits for data (buffer underrun). */
  waiting: boolean;
  error: string | null;
}

export interface PlaybackEvent {
  at: string;
  type: string;
  position: number;
  detail?: string;
}

export interface Player {
  load(track: TrackMeta): void;
  play(): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  seek(seconds: number): void;
  getState(): PlayerState;
  subscribe(listener: (state: PlayerState) => void): () => void;
  /** Passive log of what the platform reported (pauses, stalls, errors) for the overnight test. */
  onEvent(listener: (event: PlaybackEvent) => void): () => void;
  destroy(): void;
}
