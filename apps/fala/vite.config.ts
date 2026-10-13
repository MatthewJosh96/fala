import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { mediaPlugin } from './server/mediaPlugin.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.resolve(process.env.FALA_MEDIA_DIR ?? path.join(here, '../../renders/diagnostic'));

export default defineConfig({
  plugins: [
    react(),
    mediaPlugin(mediaDir),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      injectManifest: {
        rollupFormat: 'iife',
        // Manifest icons are added by the plugin itself; listing PNGs here would duplicate them.
        globPatterns: ['**/*.{js,css,html,svg}', 'icons/apple-touch-icon-180.png'],
      },
      manifest: {
        name: 'Fala',
        short_name: 'Fala',
        description: 'Dźwięk do skupienia, relaksu i snu',
        lang: 'pl',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0B0E14',
        theme_color: '#0B0E14',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
