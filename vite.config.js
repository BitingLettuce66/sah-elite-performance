import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// SAH Elite Performance — Vite config.
// base './' keeps asset paths relative so the built app works from any
// static-host subpath (e.g. GitHub Pages /repo/). vite-plugin-pwa generates
// the manifest + service worker (replacing the hand-written _legacy/ ones).
export default defineConfig({
  base: './',
  server: { port: 5173, host: true },
  preview: { port: 5173, host: true },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        name: 'SAH Elite Performance',
        short_name: 'SAH Elite',
        description:
          "Sam Hunter's personal training log — programme, daily log, progress and shareable cards.",
        start_url: './?source=pwa',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0B0B0C',
        theme_color: '#0B0B0C',
        icons: [
          { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Precache the shell + the seeded programme so the app opens offline.
        globPatterns: ['**/*.{js,css,html,png,svg,json}'],
      },
      devOptions: { enabled: true },
    }),
  ],
});
