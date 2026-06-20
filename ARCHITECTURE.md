# Architecture

How SAH Elite Performance is put together, and how data flows. This is the
engineering companion to `MANIFESTO.md` (why) and `App-Spec.md §10` (the
guardrails). Public-safe — no secrets, no personal data.

## One sentence

A **local-first** PWA: the phone's IndexedDB is the source of truth and the app
works fully offline; cloud sync (when signed in) is a background mirror, never a
dependency.

## The golden rule: program is data

The engine (`main.js`, `charts.js`, `share.js`) is generic — it renders whatever
sessions are in the plan data (`public/data/seed.json`). Session content is never
hard-coded into components. A plan is a date-agnostic **template** (`offsetDays`)
bound to a calendar by an **assignment** (`startDate`); dates are computed as
`startDate + offsetDays`. This is what lets a future AI coach (or a human coach)
emit new plan *data* that the existing engine renders unchanged.

## Module map (`src/`)

| Module | Responsibility | Depends on |
|---|---|---|
| `main.js` | App shell, views (Today/History/Progress/Share), sheets, state, event wiring | everything below |
| `db.js` | **The only storage layer.** IndexedDB reads/writes; stamps `updatedAt`/`deleted`; appends to the outbox when sync is on | `idb`, `sync.js` (flag), `sync-logic.js` |
| `sync.js` | Offline-first cloud engine: outbox drain (push), pull+reconcile, backfill, scheduling, status | `supabase.js`, `db.js`, `sync-logic.js` |
| `sync-logic.js` | **Pure** local↔cloud translation + last-write-wins reconcile (no DOM/IO) | — |
| `supabase.js` | Supabase client, env-gated (`AUTH_ENABLED`) | `@supabase/supabase-js` |
| `auth.js` | Magic-link auth wrappers (no-ops when auth isn't configured) | `supabase.js` |
| `logic.js` | Pure programme logic (dates, streak, status) | — |
| `sprints.js` | Pure sprint-time aggregation (PBs, progression) | — |
| `format.js` | Pure presentation helpers + display constants | — |
| `backup.js` | Pure JSON backup serialise/validate/normalise | — |
| `charts.js` / `share.js` | Chart.js dashboards / Canvas share-card rendering | Chart.js |

Pure modules (`logic`, `sprints`, `format`, `backup`, `sync-logic`) hold the
testable brains; `main.js`/`db.js`/`sync.js` wire them to the DOM, IndexedDB, and
network. Tests live in `tests/` (Vitest).

## Data flow: local → outbox → cloud

```
 UI (main.js)
   │  putLog / putSetting / deleteLog
   ▼
 db.js ──► IndexedDB  (logs, settings)        ← SOURCE OF TRUTH, always written first
   │         + stamps updatedAt, deleted
   │
   └─(only if signed in)─► outbox store  (durable queue of mutations)
                                │
                 sync.js (on sign-in / reconnect / "Sync now" / interval)
                                │
              fullSync(): pull ─► reconcile (LWW) ─► backfill ─► pushDirty
                                │                                    │
                                ▼                                    ▼
                   cloud → local (cursor by                local → cloud (upsert,
                   updated_at, tombstones)                 LWW-guarded, retried)
                                ▲                                    │
                                └──────────── Supabase (Postgres + RLS) ◄┘
```

- **Writes never block on the network.** They commit to IndexedDB and return; the
  outbox propagates later. The app is fully usable with no connection.
- **Reads** come from an in-memory cache hydrated from IndexedDB on boot, so the
  UI renders synchronously.
- **Identity** stays local: code always uses `athleteId: 'self'`. Only at the sync
  boundary is `'self'` mapped to the real `auth.uid()` (outgoing) and back
  (incoming), so no read path changes when sync turns on.

## Conflict + deletion rules

- **Last-write-wins** by `updatedAt` (`sync-logic.reconcile`). Ties favour local.
- A **frozen `prescribedSnapshot`** (what was actually trained) is never
  overwritten by an incoming row.
- **Deletes are tombstones** (`deleted: true`) so a deletion propagates to other
  devices; reads filter tombstones out.
- Push is **idempotent** (upsert by primary key), **coalesced** (newest per
  record), **LWW-guarded** (skip rather than clobber a newer cloud row), and
  **retried** (parked after repeated failure so one bad row can't block the queue).

## Gating (why the live site is unaffected)

`supabase.js` reads `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` at build time.
With no env (the current production build), `AUTH_ENABLED` is `false`: the auth UI
is hidden and every sync entry point is an inert no-op — the app behaves exactly
like the original local-only v1. Sync activates only once those env vars are
present **and** a user signs in.

## Deploy

Static build (`vite build`) → GitHub Pages via `.github/workflows/deploy.yml` on
push to `main`. `vite.config.js` uses a relative `base` for the Pages subpath.
Export/import JSON is the backup + migration bridge (App-Spec §10.8).
