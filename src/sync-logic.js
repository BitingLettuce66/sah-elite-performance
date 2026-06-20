/**
 * @file Pure sync logic — no DOM, no IndexedDB, no network.
 * The translation + conflict rules for cloud sync (Phase 2), kept pure so they
 * can be unit-tested. The impure engine (outbox, Supabase I/O, scheduling) lives
 * in sync.js; the local↔cloud field mapping and last-write-wins live here.
 *
 * Design: ../Venture-Planning/backend-architecture.md §5–6. Local records keep
 * camelCase + the 'self'/'current' identity; cloud rows are snake_case keyed by
 * athlete_id = uid. Conflict = last-write-wins on updatedAt; a frozen
 * prescribedSnapshot is never overwritten. Deletes propagate as tombstones.
 *
 * @typedef {Object} LocalLog   A log as stored locally (camelCase, athleteId='self').
 * @typedef {Object} CloudLog   A log row as stored in Postgres (snake_case, athlete_id=uid).
 */

/** Local identity placeholders, mirrored from db.js to keep this module dependency-free. */
export const LOCAL_ATHLETE = 'self';
export const LOCAL_PLAN = 'current';

/**
 * Map a local log to its cloud row, stamping the real owner uid (outgoing).
 * @param {LocalLog} local
 * @param {string} uid  The authenticated user's id (auth.uid()).
 * @returns {CloudLog}
 */
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

/**
 * Map a cloud row back to a local log, restoring the stable local identity so
 * existing read paths (scoped by athleteId='self') keep working unchanged.
 * @param {CloudLog} row
 * @param {string} [localAthlete='self']
 * @returns {LocalLog}
 */
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

// Account/training data syncs; device-local UI prefs and the sync cursor stay
// on-device. Keys are athlete-scoped, e.g. "targets:self", "bw:self".
const SYNCABLE_SETTING_PREFIXES = ['targets:', 'bw:', 'assignment:'];
const LOCAL_ONLY_SETTING_PREFIXES = ['onboarded:', 'lastSeen:', 'sync:'];

/**
 * Should a settings key be synced to the cloud? Training data yes; device-local
 * prefs and the sync cursor no.
 * @param {string} key
 * @returns {boolean}
 */
export function isSyncableSettingKey(key) {
  if (typeof key !== 'string') return false;
  if (LOCAL_ONLY_SETTING_PREFIXES.some(p => key.startsWith(p))) return false;
  return SYNCABLE_SETTING_PREFIXES.some(p => key.startsWith(p));
}

/**
 * Map a local settings record to its cloud row (outgoing).
 * @param {{key:string,value:*,updatedAt:string,deleted?:boolean}} local
 * @param {string} uid
 * @returns {{athlete_id:string,key:string,value:*,updated_at:string,deleted:boolean}}
 */
export function toRemoteSetting(local, uid) {
  return { athlete_id: uid, key: local.key, value: local.value ?? null,
    updated_at: local.updatedAt, deleted: !!local.deleted };
}

/**
 * Map a cloud settings row back to a local record (incoming).
 * @param {{key:string,value:*,updated_at:string,deleted?:boolean}} row
 * @returns {{key:string,value:*,updatedAt:string,deleted:boolean}}
 */
export function fromRemoteSetting(row) {
  return { key: row.key, value: row.value ?? null,
    updatedAt: row.updated_at, deleted: !!row.deleted };
}

/**
 * Last-write-wins reconcile. Returns the record to STORE locally, or null when
 * the local copy already wins (so the caller skips a no-op write). A frozen
 * prescribedSnapshot on the local record is preserved even when the remote wins.
 * Ties favour local (avoids churn).
 * @param {Object|null|undefined} local
 * @param {Object|null|undefined} remote
 * @returns {Object|null}
 */
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
  return null;
}

/**
 * Highest updated_at across rows — advances the per-table pull cursor. Returns
 * `prev` when rows is empty so the cursor never regresses.
 * @param {Array<{updated_at?:string,updatedAt?:string}>} rows
 * @param {string} [prev='']
 * @returns {string}
 */
export function maxUpdatedAt(rows, prev = '') {
  let max = prev || '';
  for (const r of rows) { const u = r.updated_at || r.updatedAt || ''; if (u > max) max = u; }
  return max;
}
