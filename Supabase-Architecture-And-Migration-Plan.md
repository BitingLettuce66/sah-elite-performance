# Supabase Architecture & Migration Plan

*Design doc — the storage layer's past, present, and path to a multi-athlete coaching hub. Companion to `App-Spec.md §10` (the guardrails), `ARCHITECTURE.md` (the current engineering map), and the deeper venture work in `../Venture-Planning/` (`backend-architecture.md`, `draft-migration.sql`, `v2-build-sequence.md`). No secrets here.*

> **Plain-English orientation (read this first, Sam).**
> The app is a training diary that lives **on your phone**. Today it works with no internet, and nobody else can see it. The plan below adds an **optional cloud backup + sync** (so a second device, or losing your phone, doesn't lose data) and, later, a **coach view** (one login that can see several athletes). The golden rule throughout: **the phone stays the source of truth.** The cloud is a mirror, never a dependency. If the cloud is off or down, the app behaves exactly like it does today. You approve each step; nothing here changes how the app works for you until you flip it on.

---

## 0. Status snapshot (where this actually is)

This is **not** a greenfield design — a large part of it is already built and shipping in a dormant (off) state:

| Piece | State |
|---|---|
| Local-first IndexedDB storage behind `db.js` | **Built, live** |
| `seed.json` as data-not-code plan (date-agnostic template + `startDate`) | **Built, live** |
| Multi-tenant fields reserved (`athleteId='self'`, `planId='current'`) | **Built, live** |
| Prescription snapshot, tombstone deletes, `updatedAt` stamping | **Built, live** |
| Outbox queue in `db.js` (durable mutation log) | **Built** (inert when sync off) |
| Supabase client + magic-link auth (`supabase.js`, `auth.js`) | **Built** (no-op without env) |
| Offline-first sync engine (`sync.js`, `sync-logic.js`) | **Built + unit-tested** (gated off) |
| Phase-1 SQL schema + RLS (`supabase/migrations/0001_phase1.sql`) | **Written** (run-once, athlete-only) |
| Full multi-tenant / coach schema (`../Venture-Planning/draft-migration.sql`) | **Drafted** (DO-NOT-RUN review draft) |

So the migration plan below is mostly about **safely turning on** what exists, then **extending** it toward the coach hub — not building from scratch. The deployed GitHub Pages site today has **no Supabase env vars**, so `AUTH_ENABLED` is `false` and every cloud entry point is an inert no-op: it is the original local-only v1.

---

## 1. Current state — how storage works today

**One storage layer, one source of truth.** Every read/write goes through `src/db.js` (App-Spec §10.7). Nothing else in the app touches storage directly. The store is **IndexedDB** (via the `idb` helper), database `sah-elite`, version 3.

**Three object stores:**

| Store | Key | Holds |
|---|---|---|
| `logs` | `sessionId` (e.g. `P1-W1-Mon`) | One performed-session record per session: `done`, `rpe`, `sleep`, `readiness`, `niggle`, `note`, loads, `sprints`, `prescribedSnapshot`, `updatedAt`, `deleted` |
| `settings` | `key` (e.g. `targets:self`, `bw:self`, `assignment:self`) | Athlete-scoped key/value (targets, bodyweight, plan assignment) + device-local prefs (`onboarded:`, `lastSeen:`, `sync:` cursors) |
| `outbox` | auto-increment `id` | Durable FIFO of local mutations awaiting cloud push. **Empty / unused while sync is off.** |

**The plan is data, not code.** `public/data/seed.json` is a date-agnostic **template**: each session carries an `offsetDays`, and the real calendar date is computed as `startDate + offsetDays`. The file also carries `athleteId: "self"`, `planId: "current"`, `planVersion: 1`, `templateId: "sah-sprint-2026"`, `startDate`, and 281 sessions across 4 phases. The engine (`main.js`, `charts.js`, `share.js`) renders whatever is in this data — no session content is hard-coded.

**Guardrails already honoured in code:**
- **Immutable IDs** — logs are keyed by the stable `sessionId`; nothing renumbers them.
- **Planned vs performed are separate stores** — `seed.json` (plan) vs `logs` (performance), linked only by `sessionId`.
- **Prescription snapshot** — `prescribedSnapshot` is frozen onto a log so a later plan edit never rewrites what was actually trained; sync explicitly refuses to overwrite a frozen snapshot.
- **Reserved multi-tenant fields** — `ATHLETE_ID = 'self'` and `PLAN_ID = 'current'` are exported from `db.js`; `loadAllLogs(athleteId)` already scopes by athlete (legacy records default to `self`).
- **Soft deletes / `updatedAt`** — every write stamps `updatedAt` and clears `deleted`; with sync on, deletes become tombstones (`deleted:true`) instead of hard removals.
- **Export/import JSON** — `backup.js` is the backup + portability format and the migration bridge.

**One existing migration already runs:** `migrateFromLocalStorage()` does a one-time import of logs from the original `localStorage` scaffold into IndexedDB, leaving the old keys as a backup. This is the template for how every future migration behaves — **additive, idempotent, non-destructive.**

---

## 2. Target Supabase data model

The cloud mirrors the local shapes so records move as-is. There are **two schema tiers**, and they are deliberately different sizes:

- **Tier A — shipped now (`supabase/migrations/0001_phase1.sql`):** the minimum to back up + sync **one** athlete's data. Athlete-only; no coach concept yet. This is what gets run first.
- **Tier B — the coaching-hub target (`../Venture-Planning/draft-migration.sql`):** the full multi-tenant schema (coach links, plan templates, versions, metrics, entitlements). This is the destination; it is reached by **additive** migrations on top of Tier A.

### 2a. Tier A — the shipped Phase-1 schema (athlete-only)

```sql
-- profiles — one row per authenticated user
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  role         text not null default 'athlete',   -- 'athlete' | 'coach' (coach arrives in Tier B)
  display_name text,
  created_at   timestamptz not null default now()
);

-- logs — one row per (athlete, session); mirrors IndexedDB `logs`
create table if not exists public.logs (
  athlete_id          uuid not null references auth.users(id) on delete cascade,
  session_id          text not null,
  plan_id             text,
  done                boolean,
  rpe int, sleep int, readiness int,
  niggle text, note text,
  squat_kg numeric, hip_thrust_kg numeric,
  sprints             jsonb,
  prescribed_snapshot jsonb,           -- frozen at completion; never recomputed
  date                text,
  updated_at          timestamptz not null default now(),
  deleted             boolean not null default false,
  primary key (athlete_id, session_id)
);

-- settings — key/value per athlete; mirrors IndexedDB `settings`
create table if not exists public.settings (
  athlete_id uuid not null references auth.users(id) on delete cascade,
  key        text not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (athlete_id, key)
);

-- assignments — binds a plan template to an athlete with a start date
create table if not exists public.assignments (
  id           uuid primary key default gen_random_uuid(),
  athlete_id   uuid not null references auth.users(id) on delete cascade,
  template_id  text,
  start_date   date,
  plan_version int default 1,
  status       text default 'active',
  updated_at   timestamptz not null default now()
);
```

A `handle_new_user()` trigger auto-creates a `profiles` row on signup. **The reserved IDs survive the boundary:** local code always uses `athleteId:'self'` / `planId:'current'`; only at the sync edge is `'self'` swapped for the real `auth.uid()` (outgoing) and back (incoming). No read path in the UI ever changes when sync turns on.

### 2b. Tier B — the coaching-hub target schema

The full set (canonical in `../Venture-Planning/draft-migration.sql`). The shape that makes single-user cleanly become multi-athlete is the **`coach_athlete` link table** — the multi-tenant backbone — plus splitting the plan into a reusable **template + versions + sessions** so a coach can build once and assign to many.

```sql
-- profiles — athletes AND coaches (role flags rather than a single role string)
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_coach   boolean not null default false,
  is_athlete boolean not null default true,
  units text not null default 'metric',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

-- coach_athlete — many-to-many link (THE multi-tenant backbone)
create table coach_athlete (
  id uuid primary key default gen_random_uuid(),
  coach_id   uuid not null references profiles(id) on delete cascade,
  athlete_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'invited' check (status in ('invited','active','revoked')),
  invited_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  unique (coach_id, athlete_id)
);

-- plan_templates — the date-agnostic plan (program is DATA)
create table plan_templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  name text not null, sport text, goal text,
  source text not null default 'ai' check (source in ('ai','coach','imported')),
  current_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

-- plan_versions — append-only version log (forward-only edits)
create table plan_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references plan_templates(id) on delete cascade,
  version int not null,
  notes text, created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (template_id, version)
);

-- template_sessions — the prescription; relative offsets; STABLE immutable ids
create table template_sessions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references plan_templates(id) on delete cascade,
  plan_version int not null,
  offset_days int not null,            -- relative to assignment.start_date
  title text not null,
  kind text not null,                  -- 'gym' | 'sprint' | 'run' | 'mobility' ...
  prescription jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

-- assignments — binds a template+version to one athlete's calendar
create table assignments (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references profiles(id) on delete cascade,
  template_id uuid not null references plan_templates(id) on delete cascade,
  plan_version int not null,
  start_date date not null,
  status text not null default 'active' check (status in ('active','paused','completed','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

-- logs — PERFORMANCE; planned-vs-performed separation; frozen snapshot
create table logs (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references profiles(id) on delete cascade,
  template_id uuid not null references plan_templates(id) on delete cascade,
  session_id uuid not null references template_sessions(id),
  assignment_id uuid not null references assignments(id) on delete cascade,
  date date, done boolean not null default false,
  rpe numeric, sleep numeric, readiness numeric, niggle text, note text,
  squat_kg numeric, hip_thrust_kg numeric,
  sprints jsonb,
  prescribed_snapshot jsonb,           -- frozen at completion; never recomputed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  unique (athlete_id, session_id, assignment_id)
);

-- metrics — bodyweight & body time-series
create table metrics (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references profiles(id) on delete cascade,
  kind text not null, value numeric not null, unit text, date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  unique (athlete_id, kind, date)
);

-- settings — key/value, athlete-scoped (matches local store exactly)
create table settings (
  athlete_id uuid not null references profiles(id) on delete cascade,
  key text not null, value jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  primary key (athlete_id, key)
);

-- entitlements — subscription / access tier (SERVER-written only)
create table entitlements (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  product text not null check (product in ('athlete_pro','coach_seat','team')),
  status text not null default 'trialing' check (status in ('trialing','active','past_due','canceled')),
  seats int, source text check (source in ('stripe','apple_iap','manual')),
  external_ref text, current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

A `touch_updated_at()` trigger bumps `updated_at` on every row update; `updated_at` indexes feed the sync pull cursor.

### 2c. ER description (the relationships that matter)

```
auth.users (Supabase Auth)
   └─1:1─ profiles ──< coach_athlete >── profiles      (coach ↔ athlete, many-to-many)
                │
   profiles (owner) ─1:N─ plan_templates ─1:N─ plan_versions
                                  │
                                  └─1:N─ template_sessions   (the prescription, stable IDs, offsetDays)
                                  │
   profiles (athlete) ─1:N─ assignments ─N:1─ plan_templates  (binds template+version → start_date)
                                  │
                                  └─1:N─ logs ─N:1─ template_sessions   (performed; frozen snapshot)
   profiles (athlete) ─1:N─ metrics
   profiles (athlete) ─1:N─ settings
   profiles ─1:N─ entitlements
```

Read it as: **a coach owns plan_templates** → builds **template_sessions** → **assigns** a template to an athlete with a `start_date` → the athlete performs sessions, producing **logs** that snapshot the prescription. `coach_athlete` is the only line that makes any of this multi-tenant; remove it and you have today's single athlete.

**Why this becomes multi-athlete cleanly:**
- Every athlete-owned table already carries `athlete_id` and is scoped by it. Adding more athletes is more rows, not more tables.
- The plan is a **template** owned by a profile, not a file glued to one user — a coach reuses one template across many athletes via `assignments`.
- The reserved local `athleteId:'self'` is mapped to a real `auth.uid()` only at the sync edge, so the single-user UI is untouched until you deliberately add an athlete picker (Tier B / coach phase).

---

## 3. Row-Level Security (RLS)

RLS is the **entire** authorization boundary. Clients connect directly to Supabase with the public anon key + a per-user JWT; there is no app server in the read/write path, so a row is reachable **only** if a policy says so. The anon key is safe to ship precisely because RLS gates every row.

### 3a. Tier A (shipped) — "you see only your own data"

Every table is `enable row level security`, and each policy is the same simple shape:

```sql
create policy "own logs"     on public.logs     for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "own settings" on public.settings for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "own profile"  on public.profiles for all using (id = auth.uid())         with check (id = auth.uid());
```

In plain English: a logged-in user can read and write rows where the row's `athlete_id` equals **their own** user id, and nothing else. Two athletes on the same database literally cannot see each other.

### 3b. Tier B — adding the coach without weakening the athlete

The coach is added by widening **read** (never write) on athlete-owned tables, through one helper function:

```sql
-- SECURITY DEFINER so it reads coach_athlete without re-triggering that table's
-- own RLS (avoids infinite recursion) and stays fast.
create function public.is_active_coach_of(target_athlete uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from coach_athlete ca
    where ca.coach_id = auth.uid() and ca.athlete_id = target_athlete
      and ca.status = 'active' and ca.deleted = false
  );
$$;

-- Athlete writes own; coach reads linked athletes (no coach write policy = read-only).
create policy logs_athlete_select on logs for select
  using ( athlete_id = auth.uid() or public.is_active_coach_of(athlete_id) );
create policy logs_athlete_update on logs for update
  using ( athlete_id = auth.uid() ) with check ( athlete_id = auth.uid() );
```

The design rules that keep this safe:
- **Coaches are read-only on an athlete's performance** (`logs`, `metrics`): there is a coach SELECT policy and **no** coach INSERT/UPDATE policy, so a coach can watch but never falsify what an athlete trained.
- **Coaches write plans, not logs:** a coach owns `plan_templates`/`template_sessions` and manages `assignments`; that is how they program an athlete.
- **`settings` are never exposed to coaches** (private device/account prefs).
- **`entitlements` are client read-only** — billing rows are written only by a service-role Edge Function (Stripe/IAP webhook), never by a client.
- **The link is consent-based:** `coach_athlete.status` goes `invited → active → revoked`; only an `active` link grants visibility, and either party can manage links involving them.

Critically, Tier B's coach policies are **additive** — they widen reads via `or is_active_coach_of(...)`. The athlete's own-data guarantee is unchanged. The full policy set is in `../Venture-Planning/draft-migration.sql`.

---

## 4. The `db.js` abstraction (storage stays behind one door)

**The interface is the contract** (App-Spec §10.7): the UI calls these functions and never sees IndexedDB, Supabase, or the network. This is what lets the store swap underneath without touching UI code — and it is already implemented.

### 4a. Current interface (live)

```js
// Identity (reserved multi-tenant fields)
export const ATHLETE_ID = 'self';
export const PLAN_ID     = 'current';

// Logs
loadAllLogs(athleteId = 'self') -> Promise<{ [sessionId]: log }>   // tombstones hidden, scoped by athlete
putLog(log)                     -> Promise<key>   // stamps updatedAt + deleted:false; enqueues outbox if sync on
deleteLog(sessionId)            -> Promise        // tombstone if sync on, else hard delete

// Settings (athlete-scoped key/value)
getSetting(key) -> Promise<value|null>
putSetting(key, value) -> Promise<key>            // enqueues outbox if sync on AND key is syncable

// Outbox (durable mutation queue; drained by sync.js)
addToOutbox(mut) / allOutbox() / removeFromOutbox(id) / updateOutbox(mut) / clearOutbox()

// Quiet writers + raw reads (used by sync.js to apply pulled rows WITHOUT re-queueing,
// and to read records including tombstones)
putLogQuiet(rec) / putSettingQuiet(rec)
getLogRaw(id) / getSettingRaw(key) / allLogsRaw() / allSettingsRaw()

// Maintenance / migration
clearLogs()
migrateFromLocalStorage() -> Promise<number>      // idempotent one-time import
```

### 4b. The local-first + sync strategy (built, gated)

The pattern is **write local, mirror later** — and it already exists in `db.js`, `sync.js`, `sync-logic.js`:

1. **Every write commits to IndexedDB first and returns.** It never blocks on the network. The app is fully usable offline.
2. **If (and only if) sync is on**, the same write **also** appends a mutation to the durable `outbox` store. Sync being "on" means `SYNC_ENABLED && AUTH_ENABLED && a live session` — i.e. the env vars exist *and* the user is signed in. With no env (today's site) it is always off and the outbox is never touched.
3. **Reads** come from an in-memory cache hydrated from IndexedDB at boot, so the UI renders synchronously.
4. **`sync.js` runs in the background** on sign-in, on reconnect, on "Sync now", and on an interval. One `fullSync()` = **pull → backfill → push**:
   - **Pull**: fetch cloud rows changed since a per-table cursor (`updated_at`), reconcile each into IndexedDB.
   - **Backfill** (first sync per account per device): enqueue the device's existing `self` data so it propagates up — the local→cloud identity merge.
   - **Push**: coalesce the outbox to the newest mutation per record, then upsert each with a last-write-wins guard.
5. **The `'self'` ↔ `auth.uid()` swap happens only here** (`sync-logic.toRemoteLog/fromRemoteLog`), so no UI read path changes when sync turns on.

**Conflict policy — last-write-wins, hardened (better than naive LWW):**
- Resolution is **LWW by `updatedAt`** (`sync-logic.reconcile`); ties favour local to avoid churn.
- A **frozen `prescribedSnapshot` is never overwritten** by an incoming row — what was actually trained is sacred.
- **Deletes are tombstones** so a deletion on one device propagates to others; reads filter them out.
- Push is **idempotent** (upsert by PK), **coalesced** (newest per record), **LWW-guarded** (reads remote `updated_at` and skips rather than clobbering a newer cloud row), and **retried** then **parked** after 5 failures so one bad row can't block the queue.
- *Known residual:* the read-then-write guard has a tiny race window under true simultaneous multi-device writes. Fine for single-author use; closed fully later by a server-side `updated_at` guard (DB trigger/RPC). **Tracked, not urgent.**

This is materially stronger than the "last-write-wins or better" the brief asked for — it is LWW plus snapshot-protection, tombstones, coalescing, and a guarded idempotent push.

### 4c. What `db.js` still needs for Tier B

Additive only, when the coach phase arrives:
- New entity reads/writes (`metrics`, `assignments`, `plan_templates`/`template_sessions`) behind the same door, each scoped by `athleteId`.
- A real athlete switch: today `loadAllLogs(athleteId)` already takes the parameter; the coach UI passes a real id instead of `'self'`. No UI read path below `db.js` changes shape.

---

## 5. Migration plan (incremental, each step shippable)

Each step is additive, independently shippable, and keeps **export/import JSON working throughout** as the safety net. Steps 0–2 are largely **built** — they are "turn on + verify," not "write from scratch." Steps 3+ are forward work.

> Order of operations every step: **back up (export JSON) → ship the change with cloud OFF → flip on for one test account → verify the app is byte-identical with cloud off → only then consider it done.**

**Step 0 — Stand up the Supabase project (one-off, no app change).**
Plain English: create the cloud database, run the Tier-A schema once, switch on Row-Level Security. Nothing in the app changes; the live site has no keys, so it stays local-only. *Verify: SQL runs clean; RLS is ON for every table.* Files: `supabase/migrations/0001_phase1.sql`, `../Venture-Planning/GO-LIVE-RUNBOOK.md`.

**Step 1 — Turn on sign-in (auth), still no sync.**
Plain English: add a "Sign in" button (one-tap email magic link). Signed out, the app is exactly as it is now. Signed in, still nothing syncs yet — we're only proving login works. *Verify: a magic link signs you in/out; signed-out behaviour is unchanged.* Files: `src/auth.js`, `src/supabase.js` (built; needs env + a small UI hook in `main.js`).

**Step 2 — Turn on cloud sync for your own account (the big one).**
Plain English: now your phone quietly mirrors to the cloud in the background. Make a change offline → it shows up after you reconnect; open the app on a second device → your data appears. The phone is still the boss; the cloud just catches up. *Verify (against the existing tests in `tests/`): offline edits queue and push on reconnect; a second device pulls; deleting on one device removes on the other; a frozen snapshot is never overwritten; export/import still round-trips.* Files: `src/sync.js`, `src/sync-logic.js`, `src/db.js` (engine built + unit-tested; this step is enabling it for the real account and a soak test).

**Step 3 — Add `metrics` to the cloud (bodyweight / time-series).**
Plain English: bodyweight and similar numbers start backing up too, same offline-first way. *Verify: metrics sync like logs; charts unchanged offline.* Adds the `metrics` table + its sync mapping behind `db.js`.

**Step 4 — Promote the plan to a cloud template (still your data only).**
Plain English: move the plan from a shipped file into the database as a reusable template + versions, so it can later be edited in-app and assigned. Your current `seed.json` becomes "template #1, version 1." Nothing about how *you* see the plan changes. *Verify: the app reads the plan from the template and renders identically; `seed.json` stays as the offline default + seed-on-first-run.* Adds `plan_templates`, `plan_versions`, `template_sessions`, real `assignments`.

**Step 5 — Add the coach concept (read-only) and the link table.**
Plain English: introduce a second kind of login — a coach — who can be *linked* to an athlete and *see* their training (not change their logs). One-direction first: coach views. *Verify: a coach sees only linked, active athletes; cannot write an athlete's logs; an athlete still sees only their own data.* Adds `coach_athlete`, `is_active_coach_of()`, the additive coach SELECT policies (Tier B RLS).

**Step 6 — Coach can program: assign templates, edit future weeks.**
Plain English: the coach can now build/assign a plan to an athlete and amend **future** weeks (forward-only; past stays frozen). *Verify: a forward-only edit bumps `planVersion`; logged history is untouched; the athlete's app picks up the new future sessions.*

**Step 7 — Entitlements + billing, then AI coach (commercial).**
Plain English: paid tiers and (later) AI-generated plans. Billing rows are written only by a trusted server function, never the app. Out of scope to detail here — see `../Venture-Planning/monetisation-plan.md`, `v2-build-sequence.md` Phases 4–5, and `ai-coach-design.md`.

Throughout: **export/import JSON remains the backup + migration bridge.** Before any schema-touching step, an export is the rollback. If sync ever misbehaves, turning it off returns the app to a working local-only state with no data loss.

---

## 6. Risks & how the guardrails are preserved

| Risk | Mitigation (and which guardrail it protects) |
|---|---|
| **Turning on sync corrupts or loses local data** | Writes always commit to IndexedDB first; cloud is a mirror. Sync is gated (`AUTH_ENABLED` + signed in); off by default. Export JSON before every step = instant rollback. *(Local-first; export bridge §10.8)* |
| **A plan edit silently rewrites trained history** | `prescribedSnapshot` frozen onto each log; `reconcile()` refuses to overwrite it; planned vs performed live in separate stores. *(§10.3, §10.4)* |
| **Conflicts from two devices** | Hardened LWW by `updatedAt`: coalesced, idempotent, LWW-guarded, retried/parked push; deletes as tombstones. Residual race is documented and closed later by a server-side guard. *(§10 sync)* |
| **A user reads another user's data** | RLS ON for every table; every policy is `athlete_id = auth.uid()`; the anon key only ever resolves rows the JWT owns. Coach access is additive read-only via a SECURITY-DEFINER helper. *(multi-tenant safety)* |
| **Coach falsifies an athlete's logs** | Coaches have a SELECT policy but **no** INSERT/UPDATE policy on `logs`/`metrics`. Coaches write plans, not performance. |
| **Single-user assumptions get baked in, forcing a rebuild** | `athleteId`/`planId` already reserved and scoped in `db.js`; `loadAllLogs` already takes an athleteId; the `'self'`↔`uid` swap is isolated to the sync edge. Adding athletes is rows, not a refactor. *(§10.6)* |
| **Plan content leaks into code** | Plan stays data (`seed.json` → cloud template); the engine renders whatever's in the data; IDs stay stable and immutable. *(§10.1, §10.2)* |
| **iOS evicts IndexedDB** | `navigator.storage.persist()` + daily use + export backup today; cloud sync (Step 2) makes eviction a non-event. |
| **Secrets exposed in the client** | Only the public anon URL + key ship (safe under RLS). The `service_role` key never touches the client; billing/entitlement writes go through server-side Edge Functions only. |
| **A bad sync row blocks everything** | Push is per-record and partial-failure-safe; a permanently failing mutation is parked (dead-lettered) after 5 attempts so the queue keeps draining. |

---

## References

- `App-Spec.md` §10 — the longevity guardrails (source of truth for the rules).
- `ARCHITECTURE.md` — current engineering map + data-flow diagram.
- `supabase/migrations/0001_phase1.sql` — the shipped Tier-A schema + RLS.
- `../Venture-Planning/backend-architecture.md` — full backend design (§2 model, §3 RLS, §5–6 sync, §6 `sync.js` interface).
- `../Venture-Planning/draft-migration.sql` — the full Tier-B multi-tenant schema (review draft, do-not-run).
- `../Venture-Planning/v2-build-sequence.md` — phased build order (auth → sync → coach → billing → AI).
- `../Venture-Planning/GO-LIVE-RUNBOOK.md` — the operational turn-on checklist.
- Code: `src/db.js`, `src/sync.js`, `src/sync-logic.js`, `src/supabase.js`, `src/auth.js`; tests in `tests/`.
```
