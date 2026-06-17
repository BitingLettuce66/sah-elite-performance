# SAH Elite Performance

A local-first **iPhone PWA** training log for following a structured training programme. Pre-loaded with a sprint/strength programme, works offline, and keeps all data on-device (IndexedDB). Includes a progress dashboard and a one-tap shareable-card generator. Dark, minimalist theme.

## Stack
- **Vite** + **vite-plugin-pwa** — dev server, and auto-generated service worker + web manifest (installable + offline).
- Vanilla JS modules — `src/main.js` (app), `src/db.js` (IndexedDB via `idb`), `src/charts.js` (Chart.js), `src/share.js` (Canvas cards), `src/sprints.js` (sprint metrics).
- Programme data in `public/data/seed.json` (a date-agnostic template, bound to a start date per athlete).

## Develop
```
npm install
npm run dev        # http://localhost:5173  (and a Network URL for phones on the same wifi)
```
Build a static bundle:
```
npm run build      # → dist/   (preview with: npm run preview)
```

## Deploy
Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to GitHub Pages. Install on iOS via Safari → Share → **Add to Home Screen** (offline once installed; requires HTTPS).

## Notes
- All training data lives only on the device (IndexedDB); use the in-app **Export backup** for portability.
- `public/data/seed.json` is precached by the service worker (`vite.config.js` → `workbox.globPatterns`). If you move it, update the `fetch('./data/seed.json')` path in `src/main.js`.
