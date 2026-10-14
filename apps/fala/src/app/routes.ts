import type { Mode } from '../offline/mediaIndex';

// Hash routes: GitHub Pages serves only real files, so path routes would need a 404 trick.
export type Route = 'home' | 'focus' | 'relax' | 'sleep' | 'info' | 'downloads' | 'player';

const HASHES: Record<Route, string> = {
  home: '#/',
  focus: '#/skupienie',
  relax: '#/relaks',
  sleep: '#/sen',
  info: '#/informacje',
  downloads: '#/pobrane',
  player: '#/odtwarzacz',
};

export const hrefFor = (r: Route) => HASHES[r];

export function parseRoute(hash: string): Route {
  const h = hash.replace(/\/+$/, '') || '#';
  for (const [route, value] of Object.entries(HASHES) as [Route, string][]) {
    if (value.replace(/\/+$/, '') === h) return route;
  }
  return 'home';
}

export const MODE_ROUTE: Record<Mode, Route> = { focus: 'focus', relax: 'relax', sleep: 'sleep' };
export const MODE_LABEL: Record<Mode, string> = { focus: 'Skupienie', relax: 'Relaks', sleep: 'Sen' };

export const routeMode = (r: Route): Mode | null => (r === 'focus' || r === 'relax' || r === 'sleep' ? r : null);
