import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { HtmlAudioPlayer } from './player/htmlAudioPlayer';
import './styles.css';

registerSW({ immediate: true });

const player = new HtmlAudioPlayer();
createRoot(document.getElementById('root')!).render(<App player={player} />);
