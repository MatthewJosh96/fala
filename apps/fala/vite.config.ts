import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { mediaPlugin } from './server/mediaPlugin.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// Staged by `npm run media:stage`; point FALA_MEDIA_DIR at renders/diagnostic for the overnight test.
const mediaDir = path.resolve(process.env.FALA_MEDIA_DIR ?? path.join(here, '.media'));
// GitHub Pages project site: https://matthewjosh96.github.io/fala/. Dev and preview use the
// same path so service worker scope, manifest and media URLs are tested as deployed.
const base = '/fala/';

export default defineConfig({
  base,
  plugins: [
    react(),
    mediaPlugin(mediaDir, base),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // 'prompt': an update waits for the page (src/app/updates.ts) instead of reloading it mid-playback.
      registerType: 'prompt',
      injectRegister: false,
      injectManifest: {
        rollupFormat: 'iife',
        // Manifest icons are added by the plugin itself; listing PNGs here would duplicate them.
        globPatterns: ['**/*.{js,css,html,svg}', 'icons/apple-touch-icon-180.png'],
        globIgnores: ['404.html'],
      },
      manifest: {
        name: 'Fala',
        short_name: 'Fala',
        description: 'Dźwięk do skupienia, relaksu i snu',
        lang: 'pl',
        id: base,
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0B0E14',
        theme_color: '#0B0E14',
        icons: [
          // Relative to the manifest, which sits at <base>manifest.webmanifest.
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // Behind `tailscale serve` the Host header is <machine>.<tailnet>.ts.net; Vite rejects
  // unknown hosts by default (DNS-rebinding protection), so allow only that suffix.
  preview: { port: 4317, strictPort: true, allowedHosts: ['.ts.net'] },
  server: { port: 4318, strictPort: true },
});
