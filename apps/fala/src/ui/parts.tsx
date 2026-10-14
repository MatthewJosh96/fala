import type { ReactNode } from 'react';
import type { CatalogueFile } from '../offline/catalogue';
import { formatMB } from './format';

export type TrackOp =
  | { kind: 'downloading' | 'verifying'; pct: number; bytes: number }
  | { kind: 'verified'; at: string }
  | { kind: 'error'; message: string };

export function Wave({ playing, className = '' }: { playing?: boolean; className?: string }) {
  return (
    <svg className={`wave ${playing ? 'is-moving' : ''} ${className}`} viewBox="0 0 400 80" preserveAspectRatio="none" aria-hidden="true">
      <path className="wave-glow" d="M-400 44 C -340 4, -260 4, -200 44 S -60 84, 0 44 S 140 4, 200 44 S 340 84, 400 44 S 540 4, 600 44 S 740 84, 800 44" />
      <path className="wave-line" d="M-400 44 C -340 4, -260 4, -200 44 S -60 84, 0 44 S 140 4, 200 44 S 340 84, 400 44 S 540 4, 600 44 S 740 84, 800 44" />
    </svg>
  );
}

const R = 118;
const C = 2 * Math.PI * R;

export function Ring({ progress, children, label }: { progress: number; children: ReactNode; label: string }) {
  return (
    <div className="ring" role="img" aria-label={label}>
      <svg viewBox="0 0 260 260" aria-hidden="true">
        <circle className="ring-track" cx="130" cy="130" r={R} />
        <circle
          className="ring-progress"
          cx="130"
          cy="130"
          r={R}
          strokeDasharray={C}
          strokeDashoffset={C * Math.min(Math.max(progress, 0), 1)}
        />
      </svg>
      <div className="ring-label">{children}</div>
    </div>
  );
}

export function TopBar({ title, backHref = '#/', right }: { title: string; backHref?: string; right?: ReactNode }) {
  return (
    <header className="topbar">
      <a className="icon-btn" href={backHref} aria-label="Wróć">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </a>
      <h1 className="topbar-title">{title}</h1>
      <span className="topbar-right">{right}</span>
    </header>
  );
}

export function PlayToggle({ playing, onClick, label }: { playing: boolean; onClick: () => void; label?: string }) {
  return (
    <div className="controls">
      <button className={`toggle ${playing ? 'on' : ''}`} onClick={onClick} aria-label={playing ? 'Pauza' : 'Odtwórz'} data-testid="toggle">
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
      <span className="toggle-label" aria-hidden="true">
        {label ?? (playing ? 'Pauza' : 'Odtwórz')}
      </span>
    </div>
  );
}

export function Choice<T extends string | number>({
  legend,
  name,
  options,
  value,
  onChange,
  format = String,
}: {
  legend: string;
  name: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  format?: (v: T) => string;
}) {
  return (
    <fieldset className="choice">
      <legend>{legend}</legend>
      <div className="choice-row">
        {options.map((o) => (
          <label key={String(o)} className={o === value ? 'on' : ''}>
            <input type="radio" name={name} checked={o === value} onChange={() => onChange(o)} />
            <span>{format(o)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Availability({
  file,
  op,
  online,
  onDownload,
}: {
  file: CatalogueFile | null;
  op?: TrackOp;
  online: boolean;
  onDownload: (f: CatalogueFile) => void;
}) {
  if (!file) return null;
  let body: ReactNode;
  if (op?.kind === 'downloading' || op?.kind === 'verifying') {
    body = (
      <span className="avail busy" role="status">
        {op.kind === 'downloading' ? 'Pobieranie' : 'Sprawdzanie'} {Math.floor(op.pct)}%
      </span>
    );
  } else if (file.stored) {
    body = (
      <span className="avail ok">
        <span className="dot" aria-hidden="true" />
        Dostępne offline
      </span>
    );
  } else if (!online) {
    body = <span className="avail">Niedostępne offline</span>;
  } else {
    body = (
      <button className="avail-btn" onClick={() => onDownload(file)} data-testid="download">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" />
        </svg>
        {op?.kind === 'error' ? 'Ponów pobieranie' : 'Pobierz offline'} · {formatMB(file.size)}
      </button>
    );
  }
  return (
    <div className="availability" data-testid="availability">
      {body}
      {op?.kind === 'error' && <p className="error">Nie udało się: {op.message}</p>}
    </div>
  );
}

export const FocusIcon = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="11" />
    <circle cx="16" cy="16" r="4.5" />
  </svg>
);

export const RelaxIcon = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M7 25c0-10 6-17 19-18-1 13-8 19-18 19" />
    <path d="M7 25l10-10" />
  </svg>
);

export const SleepIcon = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M24 20.5A10 10 0 0 1 11.5 8a10 10 0 1 0 12.5 12.5z" />
  </svg>
);

export const Chevron = () => (
  <svg className="chev" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 5l7 7-7 7" />
  </svg>
);
