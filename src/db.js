/* SAH Elite Performance — IndexedDB layer (via the `idb` helper).
   Durable on-device storage for logs (replaces the localStorage scaffold).
   Structured so an `athlete` layer / `metrics` store can be added later
   without a rewrite — bump DB_VERSION and add stores in upgrade(). */

import { openDB } from 'idb';
import { enqueue } from './sync.js';   // no-op while sync is disabled; capture point for cloud sync

const DB_NAME = 'sah-elite';
const DB_VERSION = 2;
const LOGS = 'logs';
const SETTINGS = 'settings';

// Multi-tenant defaults — every record is scoped to an athlete + plan so the
// same engine can serve many athletes later without a rewrite (App-Spec §10.6).
export const ATHLETE_ID = 'self';
export const PLAN_ID = 'current';

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
      },
    });
  }
  return _dbp;
}

// Read one athlete's logs into a { [sessionId]: log } map for the cache.
// Legacy logs without an athleteId are treated as the default athlete.
export async function loadAllLogs(athleteId = ATHLETE_ID) {
  const all = await (await db()).getAll(LOGS);
  const map = {};
  for (const log of all) if ((log.athleteId || ATHLETE_ID) === athleteId) map[log.sessionId] = log;
  return map;
}

// Insert/update one log (must carry a `sessionId`).
export async function putLog(log) {
  const r = await (await db()).put(LOGS, log);
  enqueue({ store: LOGS, op: 'put', key: log.sessionId, value: log });
  return r;
}
// Remove one log entirely.
export async function deleteLog(sessionId) {
  const r = await (await db()).delete(LOGS, sessionId);
  enqueue({ store: LOGS, op: 'delete', key: sessionId });
  return r;
}

// Key/value settings (athlete-scoped keys, e.g. `targets:self`).
export async function getSetting(key) {
  const r = await (await db()).get(SETTINGS, key);
  return r ? r.value : null;
}
export async function putSetting(key, value) {
  const r = await (await db()).put(SETTINGS, { key, value });
  enqueue({ store: SETTINGS, op: 'put', key, value });
  return r;
}

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
