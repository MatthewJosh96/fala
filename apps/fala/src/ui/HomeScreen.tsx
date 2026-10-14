import type { JSX } from 'react';
import type { UpdateState } from '../app/updates';
import type { Mode } from '../offline/mediaIndex';
import { greeting } from '../session/greeting';
import { Chevron, FocusIcon, RelaxIcon, SleepIcon, Wave } from './parts';

const CARDS: { mode: Mode; title: string; desc: string; Icon: () => JSX.Element }[] = [
  { mode: 'focus', title: 'Skupienie', desc: 'Muzyka do głębokiej pracy', Icon: FocusIcon },
  { mode: 'relax', title: 'Relaks', desc: 'Zwolnij oddech', Icon: RelaxIcon },
  { mode: 'sleep', title: 'Sen', desc: 'Spokojne zakończenie dnia', Icon: SleepIcon },
];

export interface ResumeChip {
  label: string;
  /** True when a session is already running: the chip only navigates back to it. */
  live: boolean;
  onClick: () => void;
}

export interface UpdateNotice {
  state: UpdateState;
  /** False while sound plays or a file is being stored. */
  canApply: boolean;
  onApply: () => void;
}

function UpdateNote({ update }: { update: UpdateNotice }) {
  const busy = update.state === 'applying' || update.state === 'activated';
  return (
    <p className="update-note" data-testid="update" role="status">
      {busy ? (
        'Aktualizuję…'
      ) : (
        <>
          {update.state === 'controlling' ? 'Aktualizacja gotowa' : 'Dostępna aktualizacja'}
          {update.canApply ? (
            <button className="link-btn" onClick={update.onApply}>
              {update.state === 'controlling' ? 'Uruchom ponownie' : 'Zaktualizuj'}
            </button>
          ) : (
            <span className="muted"> · po zatrzymaniu dźwięku</span>
          )}
        </>
      )}
    </p>
  );
}

export function HomeScreen({
  hour,
  resume,
  playing,
  activeMode,
  onStart,
  update,
}: {
  hour: number;
  resume: ResumeChip | null;
  playing: boolean;
  activeMode: Mode | null;
  onStart: (m: Mode) => void;
  update: UpdateNotice | null;
}) {
  const g = greeting(hour);
  return (
    <section className="home">
      <header className="home-head">
        <span className="wordmark">fala</span>
        <a className="icon-btn" href="#/informacje" aria-label="Informacje">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v6M12 7.5v.5" />
          </svg>
        </a>
      </header>

      <div className="greeting">
        <h1>{g.title}</h1>
        <p className="muted">{g.subtitle}</p>
      </div>

      <Wave playing={playing} className="wave-hero" />

      {resume && (
        <button className={`resume ${resume.live ? 'live' : ''}`} onClick={resume.onClick} data-testid="resume">
          <span className="resume-icon" aria-hidden="true">
            {resume.live ? (
              <svg viewBox="0 0 24 24">
                <rect x="6.5" y="5" width="3.5" height="14" rx="1.2" />
                <rect x="14" y="5" width="3.5" height="14" rx="1.2" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24">
                <path d="M8 5.2v13.6c0 .8.9 1.3 1.6.8l10-6.8a1 1 0 0 0 0-1.6l-10-6.8C8.9 3.9 8 4.4 8 5.2z" />
              </svg>
            )}
          </span>
          <span className="resume-text">{resume.label}</span>
          <Chevron />
        </button>
      )}

      <nav className="cards" aria-label="Tryby">
        {CARDS.map(({ mode, title, desc, Icon }) => (
          <button key={mode} className={`mode-card ${activeMode === mode ? 'active' : ''}`} onClick={() => onStart(mode)} data-mode={mode}>
            <span className="mode-icon">
              <Icon />
            </span>
            <span className="mode-text">
              <span className="mode-title">{title}</span>
              <span className="mode-desc">{desc}</span>
            </span>
            <Chevron />
          </button>
        ))}
      </nav>

      {update && <UpdateNote update={update} />}

      <footer className="home-foot">
        <a href="#/pobrane">Pobrane</a>
        <span aria-hidden="true">·</span>
        <a href="#/informacje">Informacje</a>
        <span aria-hidden="true">·</span>
        <span className="muted">wersja robocza</span>
      </footer>
    </section>
  );
}
