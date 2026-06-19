/* SAH Elite Performance — pure sync logic (no DOM, no IndexedDB, no network).
   The translation + conflict rules for cloud sync (Phase 2), kept pure so they
   can be unit-tested. The impure engine (outbox, Supabase I/O, scheduling) lives
   in sync.js; the local↔cloud field mapping and last-write-wins live here.

   Design: backend-architecture.md §5–6. Local records keep camelCase + the
   'self'/'current' identity; cloud rows are snake_case keyed by athlete_id=uid.
   Conflict = last-write-wins on updatedAt; a frozen prescribedSnapshot is never
   overwritten by an incoming row. Deletes propagate as tombstones (deleted=true). */

// Local identity constants mirror db.js (kept here too so this module stays
// dependency-free and avoids a db.js↔sync.js import cycle).
export const LOCAL_ATHLETE = 'self';
export const LOCAL_PLAN = 'current';

// --- logs: local (camelCase) ↔ cloud row (snake_case) ---
// Outgoing: stamp the real owner uid; everything else maps 1:1 by name.
export function toRemoteLog(local, uid) {
  return {
    athlete_id: uid,
    session_id: local.sessionId,
    plan_id: local.planId || LOCAL_PLAN,
    done: local.done ?? null,
    rpe: local.rpe ?? null,
    sleep: local.sleep ?? null,
    readiness: local.readiness ?? null,
    niggle: local.niggle ?? null,
    note: local.note ?? null,
    squat_kg: local.squatKg ?? null,
    hip_thrust_kg: local.hipThrustKg ?? null,
    sprints: local.sprints ?? null,
    prescribed_snapshot: local.prescribedSnapshot ?? null,
    date: local.date ?? null,
    updated_at: local.updatedAt,
    deleted: !!local.deleted,
  };
}
// Incoming: map the owner uid back to the stable local 'self' so existing read
// paths (which scope by athleteId='self') keep working unchanged.
export function fromRemoteLog(row, localAthlete = LOCAL_ATHLETE) {
  return {
    sessionId: row.session_id,
    athleteId: localAthlete,
    planId: row.plan_id || LOCAL_PLAN,
    done: row.done ?? undefined,
    rpe: row.rpe ?? null,
    sleep: row.sleep ?? null,
    readiness: row.readiness ?? null,
    niggle: row.niggle ?? undefined,
    note: row.note ?? undefined,
    squatKg: row.squat_kg ?? null,
    hipThrustKg: row.hip_thrust_kg ?? null,
    sprints: row.sprints ?? undefined,
    prescribedSnapshot: row.prescribed_snapshot ?? undefined,
    date: row.date ?? undefined,
    updatedAt: row.updated_at,
    deleted: !!row.deleted,
  };
}

// --- settings: which keys sync, and the row mapping ---
// Account/training data syncs; device-local UI prefs and the sync cursor stay
// on-device. Keys are athlete-scoped, e.g. "targets:self", "bw:self".
const SYNCABLE_SETTING_PREFIXES = ['targets:', 'bw:', 'assignment:'];
const LOCAL_ONLY_SETTING_PREFIXES = ['onboarded:', 'lastSeen:', 'sync:'];
export function isSyncableSettingKey(key) {
  if (typeof key !== 'string') return false;
  if (LOCAL_ONLY_SETTING_PREFIXES.some(p => key.startsWith(p))) return false;
  return SYNCABLE_SETTING_PREFIXES.some(p => key.startsWith(p));
}
export function toRemoteSetting(local, uid) {
  return { athlete_id: uid, key: local.key, value: local.value ?? null,
    updated_at: local.updatedAt, deleted: !!local.deleted };
}
export function fromRemoteSetting(row) {
  return { key: row.key, value: row.value ?? null,
    updatedAt: row.updated_at, deleted: !!row.deleted };
}

// --- conflict resolution: last-write-wins on updatedAt ---
// Returns the record to STORE locally, or null when the local copy already wins
// (so the caller can skip a no-op write). A frozen prescribedSnapshot on the
// local record is preserved even when the remote row otherwise wins.
export function reconcile(local, remote) {
  if (!remote) return null;
  if (!local) return remote;
  const lt = local.updatedAt || '';
  const rt = remote.updatedAt || '';
  if (rt > lt) {
    if (local.prescribedSnapshot && !remote.prescribedSnapshot) {
      return { ...remote, prescribedSnapshot: local.prescribedSnapshot };
    }
    return remote;
  }
  return null; // local newer or equal → keep local (ties favour local, avoids churn)
}

// Highest updated_at across rows (advances the per-table pull cursor). Returns
// `prev` when rows is empty so the cursor never regresses.
export function maxUpdatedAt(rows, prev = '') {
  let max = prev || '';
  for (const r of rows) { const u = r.updated_at || r.updatedAt || ''; if (u > max) max = u; }
  return max;
}
