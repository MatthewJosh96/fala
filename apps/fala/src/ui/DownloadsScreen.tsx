import { useEffect, useState } from 'react';
import type { CatalogueTrack } from '../offline/catalogue';
import type { PlaybackEvent } from '../player/types';
import { formatClock, formatMB } from './format';

export type TrackOp =
  | { kind: 'downloading' | 'verifying'; pct: number; bytes: number }
  | { kind: 'verified'; at: string }
  | { kind: 'error'; message: string };

type Persist = 'unknown' | 'granted' | 'denied' | 'unsupported';

function useStorageInfo(trigger: unknown) {
  const [persist, setPersist] = useState<Persist>('unknown');
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const refresh = async () => {
    if (!navigator.storage?.persisted) setPersist('unsupported');
    else setPersist((await navigator.storage.persisted()) ? 'granted' : 'denied');
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      setEstimate({ usage: e.usage ?? 0, quota: e.quota ?? 0 });
    }
  };
  useEffect(() => {
    void refresh();
  }, [trigger]);
  const request = async () => {
    if (!navigator.storage?.persist) return setPersist('unsupported');
    setPersist((await navigator.storage.persist()) ? 'granted' : 'denied');
    await refresh();
  };
  return { persist, estimate, request };
}

const PERSIST_TEXT: Record<Persist, string> = {
  unknown: 'sprawdzam…',
  granted: 'przyznana — system nie usunie pobranych plików przy braku miejsca',
  denied: 'nieprzyznana — system może usunąć pliki przy braku miejsca',
  unsupported: 'przeglądarka nie obsługuje',
};

export function DownloadsScreen(props: {
  tracks: CatalogueTrack[];
  online: boolean;
  ops: Record<string, TrackOp>;
  log: PlaybackEvent[];
  onDownload: (t: CatalogueTrack) => void;
  onVerify: (t: CatalogueTrack) => void;
  onRemove: (t: CatalogueTrack) => void;
  onClearLog: () => void;
}) {
  const { tracks, online, ops, log } = props;
  const storage = useStorageInfo(tracks);
  const [standalone] = useState(
    () =>
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
  );

  return (
    <section className="downloads">
      <h1>Pobrane</h1>
      {!online && <p className="note">Brak połączenia — widać tylko pliki zapisane na urządzeniu.</p>}
      {!standalone && (
        <p className="note">
          Aplikacja działa w karcie przeglądarki. Na iPhonie pobieraj plik dopiero w aplikacji uruchomionej z ekranu
          początkowego — Safari i aplikacja z ekranu początkowego mają osobne magazyny danych.
        </p>
      )}

      <ul className="track-list">
        {tracks.length === 0 && <li className="card muted">Brak ścieżek do pobrania.</li>}
        {tracks.map((t) => {
          const op = ops[t.url];
          const busy = op?.kind === 'downloading' || op?.kind === 'verifying';
          return (
            <li key={t.url} className="card track-card" data-testid="track-card">
              <div className="track-card-head">
                <div>
                  <h2>{t.title}</h2>
                  <p className="muted">
                    {t.durationS ? formatClock(t.durationS) : '—'} · {formatMB(t.size)}
                  </p>
                </div>
                <span className={`badge ${t.stored ? 'ok' : ''}`} data-testid="offline-badge">
                  <span className="dot" aria-hidden="true" />
                  {t.stored ? 'Dostępne offline' : 'Niepobrane'}
                </span>
              </div>

              {busy && (
                <div className="progress" role="progressbar" aria-valuenow={op.pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="progress-bar" style={{ width: `${op.pct}%` }} />
                  <span className="muted">
                    {op.kind === 'downloading' ? 'Pobieranie' : 'Weryfikacja SHA-256'} {op.pct.toFixed(1)}% ·{' '}
                    {formatMB(op.bytes)}
                  </span>
                </div>
              )}
              {op?.kind === 'error' && <p className="error">Nie udało się: {op.message}</p>}
              {op?.kind === 'verified' && (
                <p className="ok-text" data-testid="verify-ok">
                  Plik zgodny (rozmiar i SHA-256), sprawdzono {new Date(op.at).toLocaleTimeString('pl-PL')}
                </p>
              )}

              <div className="row">
                {!t.stored && (
                  <button className="btn primary" disabled={busy || !online} onClick={() => props.onDownload(t)}>
                    Pobierz
                  </button>
                )}
                {t.stored && (
                  <>
                    <button className="btn" disabled={busy} onClick={() => props.onVerify(t)}>
                      Sprawdź plik
                    </button>
                    <button className="btn danger" disabled={busy} onClick={() => props.onRemove(t)}>
                      Usuń
                    </button>
                  </>
                )}
              </div>
              <p className="hash muted">SHA-256 {t.sha256.slice(0, 16)}…</p>
            </li>
          );
        })}
      </ul>

      <div className="card storage">
        <h2>Pamięć urządzenia</h2>
        <p>
          Pamięć trwała: <strong data-testid="persist">{PERSIST_TEXT[storage.persist]}</strong>
        </p>
        {storage.estimate && (
          <p className="muted">
            Zajęte {formatMB(storage.estimate.usage)} z dostępnych {formatMB(storage.estimate.quota)}
          </p>
        )}
        {storage.persist !== 'granted' && storage.persist !== 'unsupported' && (
          <button className="btn" onClick={() => void storage.request()}>
            Poproś o pamięć trwałą
          </button>
        )}
      </div>

      <details className="card log">
        <summary>Dziennik odtwarzania ({log.length})</summary>
        <ol>
          {[...log].reverse().map((e, i) => (
            <li key={i}>
              <time>{new Date(e.at).toLocaleString('pl-PL')}</time> {e.type} @ {formatClock(e.position)}
              {e.detail ? ` — ${e.detail}` : ''}
            </li>
          ))}
        </ol>
        {log.length > 0 && (
          <button className="btn" onClick={props.onClearLog}>
            Wyczyść dziennik
          </button>
        )}
      </details>
    </section>
  );
}
