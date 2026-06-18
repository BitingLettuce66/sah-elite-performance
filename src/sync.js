/* SAH Elite Performance — offline-first local↔cloud sync (STUB — DISABLED).

   Interface only. The app is local-first: IndexedDB (via db.js) is the source of
   truth and everything works offline. This module is the seam where a real
   backend (Supabase) slots in LATER without touching any UI code:

     - db.js calls enqueue() after every local mutation (put/delete).
     - When SYNC_ENABLED flips to true, enqueue() appends to a durable queue and
       schedules pushDirty(); initSync() restores the session and runs fullSync().

   Design + the real implementation plan live in
   ../Venture-Planning/backend-architecture.md (kept outside this repo).
   While SYNC_ENABLED === false every export below is an inert no-op. */

export const SYNC_ENABLED = false;   // flip true only once the backend + auth exist

let _status = { state: 'local-only', lastSync: null, pending: 0 };
const _listeners = new Set();
const _emit = () => _listeners.forEach(fn => { try { fn(getStatus()); } catch (e) {} });

// Called once at boot. No-op while disabled.
export function initSync(/* { supabaseUrl, anonKey, athleteId } */) {
  if (!SYNC_ENABLED) return false;
  // TODO(real): create Supabase client, restore auth session, then fullSync()
  //             and subscribe to remote changes; map local 'self' → auth.uid().
  return true;
}

export function isEnabled() { return SYNC_ENABLED; }

// db.js calls this after every local write so nothing is lost offline.
export function enqueue(/* { store, op:'put'|'delete', key, value, updatedAt } */) {
  if (!SYNC_ENABLED) return;          // local-only: nothing to queue
  // TODO(real): append the mutation to a durable queue store, bump _status.pending,
  //             then debounce-schedule pushDirty().
}

export async function pushDirty() {
  if (!SYNC_ENABLED) return { pushed: 0 };
  // TODO(real): drain the queue to Supabase (last-write-wins by updated_at).
  return { pushed: 0 };
}

export async function pull(/* since */) {
  if (!SYNC_ENABLED) return { pulled: 0 };
  // TODO(real): fetch rows changed since the cursor, merge into IndexedDB (LWW).
  return { pulled: 0 };
}

export async function fullSync() {
  if (!SYNC_ENABLED) return;
  // TODO(real): await pull(cursor); await pushDirty(); advance cursor; _emit().
}

export function getStatus() { return { ..._status }; }
export function onStatusChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
