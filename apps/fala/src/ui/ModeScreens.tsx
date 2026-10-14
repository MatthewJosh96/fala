import { useEffect, useRef, useState } from 'react';
import { FOCUS_MINUTES, RELAX_MINUTES, SLEEP_MINUTES } from '../app/prefs';
import type { CatalogueFile, CatalogueTrack } from '../offline/catalogue';
import { MAX_START_RATE, MIN_START_RATE, breathScale, phaseAt } from '../session/breathing';
import { formatClock } from './format';
import { Availability, Choice, PlayToggle, Ring, TopBar, Wave, type TrackOp } from './parts';

/** What every mode screen needs about its session. */
export interface SessionView {
  playing: boolean;
  remainingMs: number;
  /** Elapsed fraction of the timer, 0..1. */
  progress: number;
  statusText: string;
  file: CatalogueFile | null;
  op?: TrackOp;
  online: boolean;
  onDownload: (f: CatalogueFile) => void;
  onToggle: () => void;
  minutes: number;
  onMinutes: (m: number) => void;
}

const minutesLabel = (m: number) => `${m} min`;

// Polish: whole numbers from 5 up take "oddechów", fractions take "oddechu".
const breathsPerMin = (r: number) =>
  `${r.toLocaleString('pl-PL', { maximumFractionDigits: 1 })} ${Number.isInteger(r) ? 'oddechów' : 'oddechu'}/min`;

function Status({ text }: { text: string }) {
  return (
    <p className="status muted" data-testid="status" aria-live="polite">
      {text || ' '}
    </p>
  );
}

export function FocusScreen({
  view,
  tracks,
  trackId,
  onTrack,
  pinnedTitle = null,
}: {
  view: SessionView;
  tracks: CatalogueTrack[];
  trackId: string | null;
  onTrack: (id: string) => void;
  /** The session's track when the catalogue no longer lists it. */
  pinnedTitle?: string | null;
}) {
  const current = pinnedTitle ? null : (tracks.find((t) => t.id === trackId) ?? null);
  return (
    <section className={`mode-screen focus ${view.playing ? 'is-playing' : ''}`}>
      <TopBar title="Skupienie" />
      <Ring progress={view.progress} label={`Pozostało ${formatClock(view.remainingMs / 1000)}`}>
        <span className="clock" data-testid="remaining">
          {formatClock(view.remainingMs / 1000)}
        </span>
        <span className="muted">pozostało</span>
      </Ring>

      <div className="track">
        <h2 className="track-title">{pinnedTitle ?? current?.title ?? 'Brak utworu'}</h2>
        <p className="muted track-sub">
          {pinnedTitle ? 'Niedostępny' : current ? 'Muzyka do skupienia' : 'Katalog utworów jest niedostępny.'}
        </p>
        <Availability file={view.file} op={view.op} online={view.online} onDownload={view.onDownload} />
      </div>

      {tracks.length > 1 && (
        <Choice
          legend="Utwór"
          name="focus-track"
          options={tracks.map((t) => t.id)}
          value={pinnedTitle ? '' : (trackId ?? '')}
          onChange={onTrack}
          format={(id) => tracks.find((t) => t.id === id)?.title ?? id}
        />
      )}

      <Wave playing={view.playing} />

      <PlayToggle playing={view.playing} onClick={view.onToggle} />
      <Choice legend="Minutnik" name="focus-minutes" options={FOCUS_MINUTES} value={view.minutes} onChange={view.onMinutes} format={minutesLabel} />
      <Status text={view.statusText} />
    </section>
  );
}

function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduce, setReduce] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setReduce(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

/**
 * Breathing circle. Driven by requestAnimationFrame reading the session clock; the audio
 * never depends on it (a hidden or locked page simply stops drawing).
 */
function BreathCircle({ pacerSeconds, startRate, running }: { pacerSeconds: () => number | null; startRate: number; running: boolean }) {
  const reduce = usePrefersReducedMotion();
  const circle = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'inhale' | 'exhale' | null>(null);
  const [rate, setRate] = useState(startRate);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const t = pacerSeconds();
      if (t === null) {
        setPhase(null);
        if (circle.current) circle.current.style.transform = '';
      } else {
        const p = phaseAt({ startRate }, t);
        setPhase(p.phase);
        setRate(Math.round(p.rate * 10) / 10);
        if (circle.current) {
          // Reduced motion: no growing and shrinking, only the words change.
          circle.current.style.transform = reduce ? '' : `scale(${0.62 + 0.38 * breathScale(p)})`;
        }
      }
      // Keep polling while running even before the timer starts: this effect runs before
      // the parent's effect that starts the session clock, and nothing re-triggers it after.
      if (running) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [pacerSeconds, startRate, running, reduce]);

  return (
    <div className="breath" data-phase={phase ?? 'idle'} data-testid="breath">
      <div className="breath-circle" ref={circle} aria-hidden="true" />
      <div className="breath-label">
        <span className="breath-word" aria-live="polite" data-testid="breath-phase">
          {phase === 'inhale' ? 'Wdech' : phase === 'exhale' ? 'Wydech' : 'Oddech'}
        </span>
        <span className="muted breath-rate">
          {phase ? breathsPerMin(rate) : 'prowadzenie oddechu'}
        </span>
      </div>
    </div>
  );
}

export function RelaxScreen({
  view,
  startRate,
  onStartRate,
  pacerSeconds,
  started,
}: {
  view: SessionView;
  startRate: number;
  onStartRate: (r: number) => void;
  pacerSeconds: () => number | null;
  started: boolean;
}) {
  return (
    <section className={`mode-screen relax ${view.playing ? 'is-playing' : ''}`}>
      <TopBar title="Relaks" />
      <BreathCircle pacerSeconds={pacerSeconds} startRate={startRate} running={view.playing && started} />
      <p className="session-time">
        <span className="clock-sm" data-testid="remaining">
          {formatClock(view.remainingMs / 1000)}
        </span>{' '}
        <span className="muted">pozostało</span>
      </p>

      <PlayToggle playing={view.playing} onClick={view.onToggle} />

      <fieldset className="stepper">
        <legend>Twoje tempo oddechu teraz</legend>
        <div className="stepper-row">
          <button aria-label="Wolniej" disabled={startRate <= MIN_START_RATE} onClick={() => onStartRate(startRate - 1)}>
            −
          </button>
          <output aria-live="polite" data-testid="start-rate">
            {startRate} / min
          </output>
          <button aria-label="Szybciej" disabled={startRate >= MAX_START_RATE} onClick={() => onStartRate(startRate + 1)}>
            +
          </button>
        </div>
        <p className="hint muted">Tempo zwolni płynnie do 6 oddechów na minutę w około 3 minuty.</p>
      </fieldset>

      <Choice legend="Czas sesji" name="relax-minutes" options={RELAX_MINUTES} value={view.minutes} onChange={view.onMinutes} format={minutesLabel} />
      <div className="track compact">
        <p className="muted">W tle: {view.file?.title ?? '—'}</p>
        <Availability file={view.file} op={view.op} online={view.online} onDownload={view.onDownload} />
      </div>
      <Status text={view.statusText} />
    </section>
  );
}

export function SleepScreen({ view, now }: { view: SessionView; now: number }) {
  const clock = new Date(now).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  const leftMin = Math.ceil(view.remainingMs / 60_000);
  return (
    <section className={`mode-screen sleep ${view.playing ? 'is-playing' : ''}`}>
      <TopBar title="Sen" />
      <p className="sleep-clock" aria-label={`Godzina ${clock}`}>
        {clock}
      </p>
      <Wave playing={view.playing} className="wave-sleep" />
      <div className="sleep-end">
        <p className="muted">Zatrzymanie za</p>
        <p className="sleep-left" data-testid="remaining">
          {leftMin} min
        </p>
        <div className="sleep-bar" role="progressbar" aria-label="Czas do zatrzymania" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.progress * 100)}>
          <div style={{ width: `${(1 - view.progress) * 100}%` }} />
        </div>
      </div>
      <Choice legend="Minutnik" name="sleep-minutes" options={SLEEP_MINUTES} value={view.minutes} onChange={view.onMinutes} format={minutesLabel} />
      <PlayToggle playing={view.playing} onClick={view.onToggle} />
      <div className="track compact">
        <p className="muted">{view.file?.title ?? '—'} · po czasie dźwięk się zatrzyma</p>
        <Availability file={view.file} op={view.op} online={view.online} onDownload={view.onDownload} />
      </div>
      <Status text={view.statusText} />
    </section>
  );
}
