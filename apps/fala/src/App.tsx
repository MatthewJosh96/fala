import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { loadPrefs, savePrefs, type Prefs } from './app/prefs';
import { MODE_LABEL, MODE_ROUTE, hrefFor, parseRoute, type Route } from './app/routes';
import {
  allFiles,
  chooseTrack,
  loadCatalogue,
  pickFile,
  tracksForMode,
  type Catalogue,
  type CatalogueFile,
} from './offline/catalogue';
import type { Mode } from './offline/mediaIndex';
import { downloadTrack, removeTrack, verifyStored, type CachesLike, type Progress } from './offline/store';
import { appendLog, clearLog, readLog } from './player/playbackLog';
import type { PlaybackEvent, Player, TrackMeta } from './player/types';
import { createTimer, elapsedMs, isDone, pauseTimer, progress, remainingMs, startTimer, type TimerState } from './session/timer';
import { DownloadsScreen } from './ui/DownloadsScreen';
import { formatClock } from './ui/format';
import { HomeScreen, type ResumeChip } from './ui/HomeScreen';
import { InfoScreen } from './ui/InfoScreen';
import { FocusScreen, RelaxScreen, SleepScreen, type SessionView } from './ui/ModeScreens';
import type { TrackOp } from './ui/parts';
import { PlayerScreen } from './ui/PlayerScreen';

const BASE = import.meta.env.BASE_URL;
const browserCaches = () => window.caches as unknown as CachesLike;

interface Session {
  mode: Mode;
  timer: TimerState;
  finished: boolean;
  /** Relaks: session time at which the pacer (re)started; changing the tempo restarts it. */
  pacerOffsetMs: number;
  startRate: number;
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => (location.hash = hrefFor(r))];
}

const ARTWORK = [
  { src: `${BASE}icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
  { src: `${BASE}icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
];

const toTrackMeta = (f: CatalogueFile, album: string, loop: boolean): TrackMeta => ({
  id: f.id,
  title: f.title,
  artist: 'Fala',
  album,
  src: f.url,
  artwork: ARTWORK,
  loop,
});

const TITLES: Record<Route, string> = {
  home: 'Fala',
  focus: 'Skupienie · Fala',
  relax: 'Relaks · Fala',
  sleep: 'Sen · Fala',
  info: 'Informacje · Fala',
  downloads: 'Pobrane · Fala',
  player: 'Odtwarzacz testowy · Fala',
};

export function App({ player }: { player: Player }) {
  const state = useSyncExternalStore(
    (cb) => player.subscribe(cb),
    () => player.getState(),
  );
  const [route, go] = useRoute();
  const [catalogue, setCatalogue] = useState<Catalogue>({ tracks: [], online: navigator.onLine });
  const [catalogueLoaded, setCatalogueLoaded] = useState(false);
  const [ops, setOps] = useState<Record<string, TrackOp>>({});
  const [log, setLog] = useState<PlaybackEvent[]>(readLog);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [session, setSession] = useState<Session | null>(null);
  const [diagUrl, setDiagUrl] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const playing = state.status === 'playing';

  useEffect(() => savePrefs(prefs), [prefs]);

  const refresh = useCallback(async () => {
    if (!('caches' in window)) {
      setCatalogueLoaded(true);
      return;
    }
    setCatalogue(await loadCatalogue(browserCaches(), BASE));
    setCatalogueLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    document.title = TITLES[route];
    // Sleep screen is red-shifted and darker; the browser chrome follows.
    document.documentElement.dataset.theme = route === 'sleep' ? 'sleep' : '';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', route === 'sleep' ? '#0D0A09' : '#0B0E14');
  }, [route]);

  useEffect(() => {
    const record = (e: PlaybackEvent) => setLog(appendLog(e));
    const off = player.onEvent(record);
    const page = (type: string, detail?: () => string) => () =>
      record({ at: new Date().toISOString(), type, position: player.getState().currentTime, detail: detail?.() });
    const pairs: [EventTarget, string, () => void][] = [
      [document, 'visibilitychange', page('visibility', () => document.visibilityState)],
      [document, 'freeze', page('freeze')],
      [document, 'resume', page('resume')],
      [window, 'pagehide', page('pagehide')],
      [window, 'pageshow', page('pageshow')],
      [window, 'online', page('online')],
      [window, 'offline', page('offline')],
    ];
    for (const [t, type, fn] of pairs) t.addEventListener(type, fn);
    return () => {
      off();
      for (const [t, type, fn] of pairs) t.removeEventListener(type, fn);
    };
  }, [player]);

  // Media must never start outside the service worker: Chromium fails a media source
  // whose first bytes came straight from the network and later ranges from the SW
  // (on a first visit the page is not controlled yet). So the source is set only once
  // the SW controls the page and every byte takes the same path.
  const [swControls, setSwControls] = useState(
    () => !('serviceWorker' in navigator) || navigator.serviceWorker.controller !== null,
  );
  useEffect(() => {
    if (swControls) return;
    const on = () => setSwControls(navigator.serviceWorker.controller !== null);
    navigator.serviceWorker.addEventListener('controllerchange', on);
    return () => navigator.serviceWorker.removeEventListener('controllerchange', on);
  }, [swControls]);

  const modeTrack = (mode: Mode) => chooseTrack(catalogue.tracks, mode, mode === 'focus' ? prefs.focus.trackId : null);
  const modeFile = (mode: Mode) => {
    const t = modeTrack(mode);
    return t ? pickFile(t) : null;
  };
  const sessionFile = session ? modeFile(session.mode) : null;
  const diagFile = diagUrl ? (allFiles(catalogue.tracks).find((f) => f.url === diagUrl) ?? null) : null;

  // Late load: the catalogue or the SW became ready after the session was opened.
  useEffect(() => {
    if (!swControls) return;
    if (session && sessionFile) player.load(toTrackMeta(sessionFile, MODE_LABEL[session.mode], true));
    else if (!session && diagFile) player.load(toTrackMeta(diagFile, 'Odtwarzacz testowy', false));
  }, [session?.mode, sessionFile?.url, diagFile?.url, swControls, player]);

  // The countdown runs while audio plays, whatever started it (screen, lock screen, headphones).
  useEffect(() => {
    const t = Date.now();
    setSession((s) => {
      if (!s) return s;
      if (playing && s.finished) {
        // Played again after the timer ended: a fresh session of the same length.
        return { ...s, finished: false, pacerOffsetMs: 0, timer: startTimer(createTimer(s.timer.durationMs / 60_000), t) };
      }
      const timer = playing ? startTimer(s.timer, t) : pauseTimer(s.timer, t);
      return timer === s.timer ? s : { ...s, timer };
    });
  }, [playing]);

  const checkDone = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.finished || s.timer.runningSince === null) return;
    const t = Date.now();
    if (isDone(s.timer, t)) {
      player.pause();
      setSession({ ...s, finished: true, timer: pauseTimer(s.timer, t) });
    }
  }, [player]);

  // Timer checks ride on both a 1 s tick and the media element's timeupdate, so a
  // throttled background page still stops close to on time.
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      checkDone();
    }, 1000);
    return () => clearInterval(id);
  }, [checkDone]);
  useEffect(() => checkDone(), [state.currentTime, checkDone]);

  const startMode = (mode: Mode, autoplay: boolean) => {
    const file = modeFile(mode);
    const minutes = prefs[mode].minutes;
    const t = Date.now();
    // If the same file is already playing (Skupienie -> Relaks), the status will not change, so start now.
    const keepsPlaying = playing && file !== null && state.track?.src === file.url;
    setSession({
      mode,
      timer: keepsPlaying ? startTimer(createTimer(minutes), t) : createTimer(minutes),
      finished: false,
      pacerOffsetMs: 0,
      startRate: prefs.relax.startRate,
    });
    setDiagUrl(null);
    setPrefs((p) => ({ ...p, last: { mode, at: new Date(t).toISOString() } }));
    if (file && swControls) {
      player.load(toTrackMeta(file, MODE_LABEL[mode], true));
      if (autoplay) void player.play();
    }
    go(MODE_ROUTE[mode]);
  };

  const onToggle = (mode: Mode) => {
    if (session?.mode !== mode) return startMode(mode, true);
    const file = modeFile(mode);
    if (!file || !swControls) return;
    if (state.track?.src !== file.url) {
      player.load(toTrackMeta(file, MODE_LABEL[mode], true));
      void player.play();
      return;
    }
    void player.toggle();
  };

  const onMinutes = (mode: Mode, minutes: number) => {
    setPrefs((p) => ({ ...p, [mode]: { ...p[mode], minutes } }));
    if (session?.mode === mode) {
      const t = Date.now();
      setSession({ ...session, finished: false, timer: playing ? startTimer(createTimer(minutes), t) : createTimer(minutes) });
    }
  };

  const onFocusTrack = (trackId: string) => {
    setPrefs((p) => ({ ...p, focus: { ...p.focus, trackId } }));
    if (session?.mode !== 'focus' || !swControls) return;
    const track = tracksForMode(catalogue.tracks, 'focus').find((t) => t.id === trackId);
    const file = track ? pickFile(track) : null;
    if (!file) return;
    const wasPlaying = playing;
    player.load(toTrackMeta(file, MODE_LABEL.focus, true));
    if (wasPlaying) void player.play();
  };

  const onStartRate = (startRate: number) => {
    setPrefs((p) => ({ ...p, relax: { ...p.relax, startRate } }));
    if (session?.mode === 'relax') {
      setSession({ ...session, startRate, pacerOffsetMs: elapsedMs(session.timer, Date.now()) });
    }
  };

  const pacerSeconds = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.mode !== 'relax' || s.finished) return null;
    const e = elapsedMs(s.timer, Date.now());
    if (s.timer.runningSince === null && e === 0) return null;
    return Math.max(0, e - s.pacerOffsetMs) / 1000;
  }, []);

  const setOp = (url: string, op: TrackOp | null) =>
    setOps((o) => {
      const next = { ...o };
      if (op) next[url] = op;
      else delete next[url];
      return next;
    });

  const progressOp = (url: string) => {
    let last = -1;
    return (p: Progress) => {
      const pct = Math.floor((p.bytes / p.total) * 1000) / 10;
      if (pct === last) return;
      last = pct;
      setOp(url, { kind: p.phase === 'download' ? 'downloading' : 'verifying', pct, bytes: p.bytes });
    };
  };

  const onDownload = async (t: CatalogueFile) => {
    setOp(t.url, { kind: 'downloading', pct: 0, bytes: 0 });
    // A locked screen suspends the page and breaks a long transfer; keep it on while downloading.
    const wake = await navigator.wakeLock?.request('screen').catch(() => null);
    try {
      const { stored: _stored, ...info } = t;
      await downloadTrack(info, { caches: browserCaches(), onProgress: progressOp(t.url) });
      setOp(t.url, null);
      if (navigator.storage?.persist) await navigator.storage.persist();
    } catch (e) {
      setOp(t.url, { kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      await wake?.release().catch(() => undefined);
    }
    await refresh();
  };

  const onVerify = async (t: CatalogueFile) => {
    setOp(t.url, { kind: 'verifying', pct: 0, bytes: 0 });
    const r = await verifyStored(browserCaches(), t.url, progressOp(t.url));
    setOp(t.url, r.ok ? { kind: 'verified', at: new Date().toISOString() } : { kind: 'error', message: r.reason });
  };

  const onRemove = async (t: CatalogueFile) => {
    if (state.track?.src === t.url) player.pause();
    await removeTrack(browserCaches(), t.url);
    setOp(t.url, null);
    await refresh();
  };

  const onPlayFile = (f: CatalogueFile) => {
    setSession(null);
    setDiagUrl(f.url);
    if (swControls) player.load(toTrackMeta(f, 'Odtwarzacz testowy', false));
    go('player');
  };

  const statusFor = (mode: Mode): string => {
    if (session?.mode !== mode) return '';
    if (session.finished) return 'Sesja zakończona — Minutnik zatrzymał dźwięk';
    if (state.status === 'error') return `Błąd odtwarzania: ${state.error ?? ''}`;
    if (!sessionFile) return catalogueLoaded ? 'Brak utworu dla tego trybu' : 'Wczytuję katalog…';
    if (!swControls || state.track?.src !== sessionFile.url) return 'Przygotowuję odtwarzanie…';
    if (state.waiting && playing) return 'Buforowanie…';
    return state.error ?? '';
  };

  const view = (mode: Mode): SessionView => {
    const active = session?.mode === mode ? session : null;
    const file = modeFile(mode);
    const timer = active?.timer ?? createTimer(prefs[mode].minutes);
    return {
      playing: active !== null && playing,
      remainingMs: active?.finished ? 0 : remainingMs(timer, now),
      progress: active?.finished ? 1 : progress(timer, now),
      statusText: statusFor(mode),
      file,
      op: file ? ops[file.url] : undefined,
      online: catalogue.online,
      onDownload: (f) => void onDownload(f),
      onToggle: () => onToggle(mode),
      minutes: prefs[mode].minutes,
      onMinutes: (m) => onMinutes(mode, m),
    };
  };

  let resume: ResumeChip | null = null;
  if (session && !session.finished && (playing || elapsedMs(session.timer, now) > 0)) {
    const s = session;
    resume = {
      live: true,
      label: `${MODE_LABEL[s.mode]} · ${formatClock(remainingMs(s.timer, now) / 1000)} pozostało`,
      onClick: () => go(MODE_ROUTE[s.mode]),
    };
  } else if (prefs.last) {
    const m = prefs.last.mode;
    const parts = [MODE_LABEL[m], m === 'focus' ? modeTrack('focus')?.title : null, `${prefs[m].minutes} min`].filter(Boolean);
    resume = { live: false, label: `Wznów · ${parts.join(' · ')}`, onClick: () => startMode(m, true) };
  }

  return (
    <div className="app">
      <main className={`screen route-${route}`}>
        {route === 'home' && (
          <HomeScreen
            hour={new Date(now).getHours()}
            resume={resume}
            playing={playing}
            activeMode={session && !session.finished ? session.mode : null}
            onStart={(m) => startMode(m, true)}
          />
        )}
        {route === 'focus' && (
          <FocusScreen
            view={view('focus')}
            tracks={tracksForMode(catalogue.tracks, 'focus')}
            trackId={modeTrack('focus')?.id ?? null}
            onTrack={onFocusTrack}
          />
        )}
        {route === 'relax' && (
          <RelaxScreen
            view={view('relax')}
            startRate={prefs.relax.startRate}
            onStartRate={onStartRate}
            pacerSeconds={pacerSeconds}
            started={session?.mode === 'relax'}
          />
        )}
        {route === 'sleep' && <SleepScreen view={view('sleep')} now={now} />}
        {route === 'info' && <InfoScreen />}
        {route === 'downloads' && (
          <DownloadsScreen
            tracks={allFiles(catalogue.tracks)}
            online={catalogue.online}
            ops={ops}
            log={log}
            onDownload={(f) => void onDownload(f)}
            onVerify={(f) => void onVerify(f)}
            onRemove={(f) => void onRemove(f)}
            onPlay={onPlayFile}
            onClearLog={() => {
              clearLog();
              setLog([]);
            }}
          />
        )}
        {route === 'player' && <PlayerScreen player={player} state={state} track={diagFile} />}
      </main>
    </div>
  );
}
