import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { appendLog, clearLog, readLog } from './player/playbackLog';
import type { PlaybackEvent, Player, TrackMeta } from './player/types';
import { loadCatalogue, type CatalogueTrack } from './offline/catalogue';
import { downloadTrack, removeTrack, verifyStored, type CachesLike, type Progress } from './offline/store';
import { SessionScreen } from './ui/SessionScreen';
import { DownloadsScreen, type TrackOp } from './ui/DownloadsScreen';

const browserCaches = () => window.caches as unknown as CachesLike;

function useRoute(): ['session' | 'downloads', (r: 'session' | 'downloads') => void] {
  const read = (): 'session' | 'downloads' => (location.hash === '#/pobrane' ? 'downloads' : 'session');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => (location.hash = r === 'downloads' ? '#/pobrane' : '#/')];
}

function toTrackMeta(t: CatalogueTrack): TrackMeta {
  return {
    id: t.id,
    title: t.title,
    artist: 'Fala',
    album: 'Test nocny',
    src: t.url,
    artwork: [
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
  };
}

export function App({ player }: { player: Player }) {
  const state = useSyncExternalStore(
    (cb) => player.subscribe(cb),
    () => player.getState(),
  );
  const [route, go] = useRoute();
  const [tracks, setTracks] = useState<CatalogueTrack[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [ops, setOps] = useState<Record<string, TrackOp>>({});
  const [log, setLog] = useState<PlaybackEvent[]>(readLog);

  const refresh = useCallback(async () => {
    if (!('caches' in window)) return;
    const c = await loadCatalogue(browserCaches());
    setTracks(c.tracks);
    setOnline(c.online);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const current = tracks.find((t) => t.stored) ?? tracks[0] ?? null;

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

  useEffect(() => {
    if (current && swControls) player.load(toTrackMeta(current));
  }, [current, player, swControls]);

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

  const onDownload = async (t: CatalogueTrack) => {
    setOp(t.url, { kind: 'downloading', pct: 0, bytes: 0 });
    try {
      await downloadTrack(t, { caches: browserCaches(), onProgress: progressOp(t.url) });
      setOp(t.url, null);
      if (navigator.storage?.persist) await navigator.storage.persist();
    } catch (e) {
      setOp(t.url, { kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    await refresh();
  };

  const onVerify = async (t: CatalogueTrack) => {
    setOp(t.url, { kind: 'verifying', pct: 0, bytes: 0 });
    const r = await verifyStored(browserCaches(), t.url, progressOp(t.url));
    setOp(t.url, r.ok ? { kind: 'verified', at: new Date().toISOString() } : { kind: 'error', message: r.reason });
  };

  const onRemove = async (t: CatalogueTrack) => {
    if (state.track?.src === t.url) player.pause();
    await removeTrack(browserCaches(), t.url);
    setOp(t.url, null);
    await refresh();
  };

  return (
    <div className="app">
      <main className="screen">
        {route === 'session' ? (
          <SessionScreen player={player} state={state} track={current} onOpenDownloads={() => go('downloads')} />
        ) : (
          <DownloadsScreen
            tracks={tracks}
            online={online}
            ops={ops}
            log={log}
            onDownload={onDownload}
            onVerify={onVerify}
            onRemove={onRemove}
            onClearLog={() => {
              clearLog();
              setLog([]);
            }}
          />
        )}
      </main>
      <nav className="tabs" aria-label="Nawigacja">
        <a href="#/" className={route === 'session' ? 'active' : ''} aria-current={route === 'session' ? 'page' : undefined}>
          Sesja
        </a>
        <a
          href="#/pobrane"
          className={route === 'downloads' ? 'active' : ''}
          aria-current={route === 'downloads' ? 'page' : undefined}
        >
          Pobrane
        </a>
      </nav>
    </div>
  );
}
