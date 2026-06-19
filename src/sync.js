/* SAH Elite Performance — offline-first local↔cloud sync (Phase 2).

   IndexedDB (via db.js) stays the source of truth; this module reconciles it
   with Supabase in the background. The UI never imports sync.js — db.js stamps
   updatedAt + appends mutations to an `outbox` store; this engine drains it and
   pulls remote changes. Design: ../Venture-Planning/backend-architecture.md §5–6.

   Gating: every entry point is inert unless SYNC_ENABLED && auth is configured
   && a session exists. With no .env (e.g. the deployed site / CI) AUTH is off, so
   the app is fully local-only and nothing here runs. Sync activates on sign-in.

   Conflict policy: last-write-wins by updatedAt (sync-logic.reconcile), and a
   frozen prescribedSnapshot is never overwritten. v1 LIMITATION: push uses a
   plain upsert (no server-side conditional), so in the rare case of the SAME
   record edited offline on two devices, the later *push* wins regardless of its
   updatedAt. Acceptable for single-author data; harden with a server-side
   updated_at guard (DB trigger/RPC) before heavy multi-device concurrency. */

import { supabase, AUTH_ENABLED } from './supabase.js';
import * as db from './db.js';
import { toRemoteLog, fromRemoteLog, toRemoteSetting, fromRemoteSetting,
  reconcile, isSyncableSettingKey, maxUpdatedAt } from './sync-logic.js';

export const SYNC_ENABLED = true;   // engine is implemented; still gated by AUTH + a live session

const EPOCH = '1970-01-01T00:00:00Z';
const nowISO = () => new Date().toISOString();

let _session = null;       // cached so db.js can check isEnabled() synchronously
let _syncing = false;      // re-entrancy guard
let _status = { state: 'local-only', pending: 0, lastSyncAt: null, lastError: null };
const _listeners = new Set();
const _emit = () => { for (const fn of _listeners) { try { fn(getStatus()); } catch (e) {} } };
function setState(state, extra) { _status = { ..._status, state, ...extra }; _emit(); }

export function isEnabled() { return SYNC_ENABLED && AUTH_ENABLED && !!supabase && !!_session; }
export function getStatus() { return { ..._status }; }
export function onStatusChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function uid() { return _session && _session.user ? _session.user.id : null; }

// Called once at boot. Restores the session, reacts to login/logout, syncs on
// reconnect. No-op unless sync + auth are configured.
export async function initSync() {
  if (!SYNC_ENABLED || !AUTH_ENABLED || !supabase) return false;
  try { const { data } = await supabase.auth.getSession(); _session = data.session || null; }
  catch (e) { _session = null; }

  supabase.auth.onAuthStateChange((_event, session) => {
    const wasIn = !!_session;
    _session = session || null;
    if (!wasIn && _session) fullSync().catch(() => {});   // just signed in → sync
    if (wasIn && !_session) setState('local-only');       // signed out
    _emit();
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { if (isEnabled()) fullSync().catch(() => {}); });
  }
  if (_session) fullSync().catch(() => {});
  return true;
}

// First sync for this account on this device: enqueue the device's existing
// 'self' data so it propagates to the cloud (the local→cloud identity merge).
// Runs AFTER pull, so it enqueues the post-reconcile winners. Guarded per uid.
async function backfillIfNeeded() {
  const id = uid(); if (!id) return;
  if ((await db.getSetting('sync:backfilled')) === id) return;
  for (const lg of await db.allLogsRaw()) {
    if ((lg.athleteId || 'self') !== 'self') continue;
    const payload = { ...lg, updatedAt: lg.updatedAt || nowISO(), deleted: !!lg.deleted };
    await db.addToOutbox({ table: 'logs', op: 'upsert', key: lg.sessionId, payload, updatedAt: payload.updatedAt });
  }
  for (const s of await db.allSettingsRaw()) {
    if (!isSyncableSettingKey(s.key)) continue;
    const payload = { ...s, updatedAt: s.updatedAt || nowISO(), deleted: !!s.deleted };
    await db.addToOutbox({ table: 'settings', op: 'upsert', key: s.key, payload, updatedAt: payload.updatedAt });
  }
  await db.putSetting('sync:backfilled', id);
}

// Drain the outbox to Supabase. Succeeded mutations are removed; failures stay
// queued for the next attempt.
export async function pushDirty() {
  if (!isEnabled()) return { pushed: 0, failed: 0 };
  const id = uid(); if (!id) return { pushed: 0, failed: 0 };
  let pushed = 0, failed = 0;
  for (const mut of await db.allOutbox()) {
    try {
      if (mut.table === 'logs') {
        const { error } = await supabase.from('logs').upsert(toRemoteLog(mut.payload, id), { onConflict: 'athlete_id,session_id' });
        if (error) throw error;
      } else if (mut.table === 'settings') {
        const { error } = await supabase.from('settings').upsert(toRemoteSetting(mut.payload, id), { onConflict: 'athlete_id,key' });
        if (error) throw error;
      }
      await db.removeFromOutbox(mut.id);
      pushed++;
    } catch (e) { failed++; _status.lastError = e.message || String(e); }
  }
  return { pushed, failed };
}

// Apply one pulled row into IndexedDB via LWW reconcile, WITHOUT re-queueing.
// Exported for unit tests (work against fake-indexeddb; no network needed).
export async function applyRemoteLog(row) {
  const incoming = fromRemoteLog(row);
  const merged = reconcile(await db.getLogRaw(incoming.sessionId), incoming);
  if (merged) await db.putLogQuiet(merged);
  return !!merged;
}
export async function applyRemoteSetting(row) {
  if (!isSyncableSettingKey(row.key)) return false;
  const incoming = fromRemoteSetting(row);
  const merged = reconcile(await db.getSettingRaw(incoming.key), incoming);
  if (merged) await db.putSettingQuiet(merged);
  return !!merged;
}

async function pullTable(table, cursorKey, apply) {
  const since = (await db.getSetting(cursorKey)) || EPOCH;
  const { data, error } = await supabase.from(table).select('*').gt('updated_at', since).order('updated_at', { ascending: true });
  if (error) throw error;
  const rows = data || [];
  for (const row of rows) await apply(row);
  const next = maxUpdatedAt(rows, since);
  if (next !== since) await db.putSetting(cursorKey, next);
  return rows.length;
}

// Pull rows changed since the per-table cursor; reconcile into IndexedDB.
export async function pull() {
  if (!isEnabled()) return { pulled: 0 };
  let pulled = 0;
  pulled += await pullTable('logs', 'sync:cursor:logs', applyRemoteLog);
  pulled += await pullTable('settings', 'sync:cursor:settings', applyRemoteSetting);
  return { pulled };
}

// Pull (cloud→local, protects newer local) → backfill (enqueue winners) → push.
export async function fullSync() {
  if (!isEnabled() || _syncing) return getStatus();
  _syncing = true; setState('syncing');
  try {
    await pull();
    await backfillIfNeeded();
    await pushDirty();
    setState('idle', { lastSyncAt: nowISO(), lastError: null, pending: (await db.allOutbox()).length });
  } catch (e) {
    setState('error', { lastError: e.message || String(e) });
  } finally { _syncing = false; }
  return getStatus();
}
