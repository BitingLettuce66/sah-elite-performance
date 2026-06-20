/* SAH Elite Performance — IndexedDB layer (via the `idb` helper).
   Durable on-device storage and the SINGLE place all storage happens (App-Spec
   §10.7). IndexedDB stays the source of truth; cloud sync (Phase 2) sits behind
   this layer: write fns stamp `updatedAt` + `deleted` and, when sync is active,
   append the mutation to a durable `outbox` store that sync.js drains. With sync
   off, behaviour is identical to v1 (hard deletes, no queue). */

import { openDB } from 'idb';
import { isEnabled } from './sync.js';            // true only when sync + an auth session exist
import { isSyncableSettingKey } from './sync-logic.js';

const DB_NAME = 'sah-elite';
const DB_VERSION = 3;            // v3 adds the outbox store for cloud sync
const LOGS = 'logs';
const SETTINGS = 'settings';
const OUTBOX = 'outbox';

// Multi-tenant defaults — every record is scoped to an athlete + plan so the
// same engine can serve many athletes later without a rewrite (App-Spec §10.6).
export const ATHLETE_ID = 'self';
export const PLAN_ID = 'current';

const nowISO = () => new Date().toISOString();
// Is cloud sync actively running (enabled + signed in)? Guarded so a sync.js
// load-order hiccup can never break a local write.
function syncOn() { try { return isEnabled(); } catch (e) { return false; } }

let _dbp;
function db() {
  if (!_dbp) {
    _dbp = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(LOGS)) {
          // One record per session, keyed by its stable session id.
          d.createObjectStore(LOGS, { keyPath: 'sessionId' });
        }
        if (!d.objectStoreNames.contains(SETTINGS)) {
          // Key/value store for athlete settings (e.g. sprint target times).
          d.createObjectStore(SETTINGS, { keyPath: 'key' });
        }
        if (!d.objectStoreNames.contains(OUTBOX)) {
          // Durable FIFO of local mutations awaiting push to the cloud.
          d.createObjectStore(OUTBOX, { keyPath: 'id', autoIncrement: true });
        }
      },
    });
  }
  return _dbp;
}

/**
 * Read one athlete's (non-deleted) logs into a `{ [sessionId]: log }` map for the
 * in-memory cache. Tombstones are hidden; legacy logs without an athleteId are
 * treated as the default athlete.
 * @param {string} [athleteId='self']
 * @returns {Promise<Object<string, Object>>}
 */
export async function loadAllLogs(athleteId = ATHLETE_ID) {
  const all = await (await db()).getAll(LOGS);
  const map = {};
  for (const log of all) {
    if (log.deleted) continue;                                   // tombstones are hidden
    if ((log.athleteId || ATHLETE_ID) === athleteId) map[log.sessionId] = log;
  }
  return map;
}

/**
 * Insert/update one log (must carry a `sessionId`). Stamps `updatedAt` + clears
 * `deleted`, then enqueues an outbox mutation when sync is active.
 * @param {Object} log  Must include `sessionId`.
 * @returns {Promise<IDBValidKey>}
 */
export async function putLog(log) {
  const stamped = { ...log, updatedAt: nowISO(), deleted: false };
  const r = await (await db()).put(LOGS, stamped);
  if (syncOn()) await addToOutbox({ table: 'logs', op: 'upsert', key: stamped.sessionId, payload: stamped, updatedAt: stamped.updatedAt });
  return r;
}
/**
 * Remove one log. With sync on, write a tombstone (`deleted:true`) so the delete
 * propagates to other devices; with sync off, hard-delete as in v1.
 * @param {string} sessionId
 * @returns {Promise<*>}
 */
export async function deleteLog(sessionId) {
  const conn = await db();
  if (syncOn()) {
    const existing = await conn.get(LOGS, sessionId);
    const tomb = { ...(existing || { sessionId }), sessionId, deleted: true, updatedAt: nowISO() };
    const r = await conn.put(LOGS, tomb);
    await addToOutbox({ table: 'logs', op: 'upsert', key: sessionId, payload: tomb, updatedAt: tomb.updatedAt });
    return r;
  }
  return conn.delete(LOGS, sessionId);
}

/**
 * Read a settings value by athlete-scoped key (e.g. `targets:self`).
 * @param {string} key
 * @returns {Promise<*|null>} The stored value, or null if missing/tombstoned.
 */
export async function getSetting(key) {
  const r = await (await db()).get(SETTINGS, key);
  return r && !r.deleted ? r.value : null;
}
/**
 * Write a settings value. Stamps `updatedAt`; enqueues for sync when active and
 * the key is syncable (training data, not device-local prefs).
 * @param {string} key
 * @param {*} value
 * @returns {Promise<IDBValidKey>}
 */
export async function putSetting(key, value) {
  const rec = { key, value, updatedAt: nowISO(), deleted: false };
  const r = await (await db()).put(SETTINGS, rec);
  if (syncOn() && isSyncableSettingKey(key)) await addToOutbox({ table: 'settings', op: 'upsert', key, payload: rec, updatedAt: rec.updatedAt });
  return r;
}

// --- Outbox queue (durable, drained by sync.js) ---
export async function addToOutbox(mut) { return (await db()).add(OUTBOX, mut); }
export async function allOutbox() { return (await db()).getAll(OUTBOX); }
export async function removeFromOutbox(id) { return (await db()).delete(OUTBOX, id); }
export async function updateOutbox(mut) { return (await db()).put(OUTBOX, mut); }  // in-place (attempt counter / dead flag)
export async function clearOutbox() { return (await db()).clear(OUTBOX); }
export async function clearLogs() { return (await db()).clear(LOGS); }   // reset local logs (device reset / tests)

// --- Quiet writers + raw reads for sync.js (apply pulled rows WITHOUT
//     re-queueing them, and read records including tombstones) ---
export async function putLogQuiet(rec) { return (await db()).put(LOGS, rec); }
export async function putSettingQuiet(rec) { return (await db()).put(SETTINGS, rec); }
export async function getLogRaw(sessionId) { return (await db()).get(LOGS, sessionId); }
export async function getSettingRaw(key) { return (await db()).get(SETTINGS, key); }
export async function allLogsRaw() { return (await db()).getAll(LOGS); }
export async function allSettingsRaw() { return (await db()).getAll(SETTINGS); }

// One-time import of logs saved by the old localStorage scaffold.
// Leaves the old keys in place as a backup; returns how many were imported.
const MIGRATED_FLAG = 'logs-migrated-idb';
export async function migrateFromLocalStorage() {
  if (localStorage.getItem(MIGRATED_FLAG)) return 0;
  const conn = await db();
  const tx = conn.transaction(LOGS, 'readwrite');
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('log:')) continue;
    try {
      const v = JSON.parse(localStorage.getItem(key));
      if (v && typeof v === 'object') {
        await tx.store.put({ athleteId: ATHLETE_ID, planId: PLAN_ID, ...v, sessionId: key.slice(4) });
        n++;
      }
    } catch (e) { /* skip a corrupt entry */ }
  }
  await tx.done;
  localStorage.setItem(MIGRATED_FLAG, '1');
  return n;
}
