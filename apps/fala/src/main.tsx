import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { handoffGuard } from './app/handoff';
import { updates } from './app/updates';
import { HtmlAudioPlayer } from './player/htmlAudioPlayer';
import './styles.css';

// Updates never reload by themselves: App applies them when nothing plays or stores.
const updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh: () => updates.markWaiting(),
  onNeedReload: () => updates.markControlling(),
});
updates.setApply(() => void updateServiceWorker(true));
// The plugin reports a takeover only for pages that were controlled when they registered;
// this covers the rest (e.g. the very first session after installing).
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  // A takeover finished: the next waiting worker gets its own fallback again.
  handoffGuard.reset();
  if (updates.get() === 'applying') updates.markControlling();
});

const player = new HtmlAudioPlayer();
createRoot(document.getElementById('root')!).render(<App player={player} />);
