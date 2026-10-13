import type { CatalogueTrack } from '../offline/catalogue';
import type { Player, PlayerState } from '../player/types';
import { formatClock } from './format';

const R = 118;
const C = 2 * Math.PI * R;

export function SessionScreen({
  player,
  state,
  track,
  onOpenDownloads,
}: {
  player: Player;
  state: PlayerState;
  track: CatalogueTrack | null;
  onOpenDownloads: () => void;
}) {
  const duration = state.duration || track?.durationS || 0;
  const progress = duration > 0 ? Math.min(state.currentTime / duration, 1) : 0;
  const remaining = Math.max(duration - state.currentTime, 0);
  const playing = state.status === 'playing';

  if (!track) {
    return (
      <section className="session empty">
        <p className="eyebrow">fala</p>
        <h1>Brak pliku</h1>
        <p className="muted">Serwer nie udostępnia żadnej ścieżki, a nic nie jest pobrane.</p>
        <button className="btn" onClick={onOpenDownloads}>
          Przejdź do „Pobrane”
        </button>
      </section>
    );
  }

  return (
    <section className={`session ${playing ? 'is-playing' : ''}`}>
      <header className="session-head">
        <span className="wordmark">fala</span>
        <span className="mode">Sen · test nocny</span>
      </header>

      <div className="ring" role="img" aria-label={`Pozostało ${formatClock(remaining)}`}>
        <svg viewBox="0 0 260 260" aria-hidden="true">
          <circle className="ring-track" cx="130" cy="130" r={R} />
          <circle
            className="ring-progress"
            cx="130"
            cy="130"
            r={R}
            strokeDasharray={C}
            strokeDashoffset={C * (1 - progress)}
          />
        </svg>
        <div className="ring-label">
          <span className="clock" data-testid="remaining">
            {formatClock(remaining)}
          </span>
          <span className="muted">pozostało</span>
        </div>
      </div>

      <div className="track">
        <h1 className="track-title">{track.title}</h1>
        <p className={`availability ${track.stored ? 'ok' : ''}`} data-testid="availability">
          <span className="dot" aria-hidden="true" />
          {track.stored ? 'Dostępne offline' : 'Tylko z sieci — pobierz w „Pobrane”'}
        </p>
      </div>

      <svg className="wave" viewBox="0 0 800 80" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 40 C 100 0, 100 0, 200 40 S 300 80, 400 40 S 500 0, 600 40 S 700 80, 800 40" />
      </svg>

      <div className="scrub">
        <input
          type="range"
          min={0}
          max={Math.max(Math.floor(duration), 1)}
          step={1}
          value={Math.floor(state.currentTime)}
          onChange={(e) => player.seek(Number(e.currentTarget.value))}
          aria-label="Pozycja odtwarzania"
          disabled={duration <= 0}
        />
        <div className="scrub-times muted">
          <span>{formatClock(state.currentTime)}</span>
          <span>{formatClock(duration)}</span>
        </div>
      </div>

      <div className="controls">
        <button
          className={`toggle ${playing ? 'on' : ''}`}
          onClick={() => void player.toggle()}
          aria-label={playing ? 'Pauza' : 'Odtwórz'}
          data-testid="toggle"
        >
          {playing ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6.5" y="5" width="3.5" height="14" rx="1.2" />
              <rect x="14" y="5" width="3.5" height="14" rx="1.2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5.2v13.6c0 .8.9 1.3 1.6.8l10-6.8a1 1 0 0 0 0-1.6l-10-6.8C8.9 3.9 8 4.4 8 5.2z" />
            </svg>
          )}
        </button>
        <span className="toggle-label">{playing ? 'Pauza' : state.status === 'ended' ? 'Koniec — odtwórz' : 'Odtwórz'}</span>
      </div>

      <p className="status muted" data-testid="status" aria-live="polite">
        {state.waiting && playing ? 'Buforowanie…' : statusText(state)}
      </p>
    </section>
  );
}

function statusText(s: PlayerState) {
  if (s.status === 'error') return `Błąd odtwarzania: ${s.error ?? ''}`;
  if (s.status === 'ended') return 'Plik odtworzony do końca';
  if (s.error) return s.error;
  return ' ';
}
