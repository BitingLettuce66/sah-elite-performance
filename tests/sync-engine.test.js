/* Engine-level sync tests against an in-memory fake Supabase (no network).
   Covers: offline outbox replay, two-device LWW (pull + push guard),
   delete/tombstone propagation, backfill idempotency, and auth transitions. */
import 'fake-indexeddb/auto';
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';

// A minimal fake of the Supabase client + auth, backed by in-memory tables.
// Built in vi.hoisted so the vi.mock factory can reference it.
const h = vi.hoisted(() => {
  const session = { user: { id: 'uid-123' } };
  const store = { logs: new Map(), settings: new Map() };
  const pkOf = (table, r) => table === 'logs' ? `${r.athlete_id}|${r.session_id}` : `${r.athlete_id}|${r.key}`;
  let authCb = null;
  let currentSession = session;
  function from(table) {
    const filters = [];
    const rows = () => {
      let rs = [...store[table].values()];
      for (const [c, v] of filters) {
        if (c[0] === '>') { const col = c.slice(1); rs = rs.filter(r => (r[col] || '') > v); }
        else rs = rs.filter(r => r[c] === v);
      }
      return rs;
    };
    const builder = {
      select() { return builder; },
      eq(c, v) { filters.push([c, v]); return builder; },
      gt(c, v) { filters.push(['>' + c, v]); return builder; },
      order() { return Promise.resolve({ data: rows(), error: null }); },
      maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
      upsert(row) { store[table].set(pkOf(table, row), { ...row }); return Promise.resolve({ error: null }); },
    };
    return builder;
  }
  const client = {
    from,
    auth: {
      getSession: async () => ({ data: { session: currentSession } }),
      onAuthStateChange: (cb) => { authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
    },
  };
  return {
    client, store, session,
    fireAuth: (event, s) => { currentSession = s; if (authCb) authCb(event, s); },
    resetCloud: () => { store.logs.clear(); store.settings.clear(); },
  };
});
vi.mock('../src/supabase.js', () => ({ supabase: h.client, AUTH_ENABLED: true }));

import { initSync, pushDirty, pull, fullSync, getStatus } from '../src/sync.js';
import {
  putLog, putLogQuiet, deleteLog, loadAllLogs, getLogRaw,
  addToOutbox, allOutbox, clearOutbox, clearLogs, putSettingQuiet, getSetting,
} from '../src/db.js';

const CLOUD = h.store;
const uidKey = (sid) => `uid-123|${sid}`;
const cloudLog = (sid, o) => ({ athlete_id: 'uid-123', session_id: sid, plan_id: 'current', deleted: false, ...o });
const settle = async () => { for (let i = 0; i < 100 && getStatus().state === 'syncing'; i++) await new Promise(r => setTimeout(r, 5)); };

beforeAll(async () => { await initSync(); });   // wires _session (signed in) + the auth callback

beforeEach(async () => {
  h.resetCloud();
  await clearLogs(); await clearOutbox();
  for (const k of ['sync:cursor:logs', 'sync:cursor:settings', 'sync:backfilled']) {
    await putSettingQuiet({ key: k, value: null, deleted: true, updatedAt: '2026-01-01T00:00:00Z' });
  }
});

describe('offline outbox replay', () => {
  it('queues writes locally, then pushes them all on drain', async () => {
    await putLog({ sessionId: 'OB1', athleteId: 'self', done: true });
    await putLog({ sessionId: 'OB2', athleteId: 'self', done: false });
    expect((await allOutbox()).filter(m => !m.dead)).toHaveLength(2);
    const res = await pushDirty();
    expect(res.pushed).toBe(2);
    expect(CLOUD.logs.size).toBe(2);
    expect(await allOutbox()).toHaveLength(0);   // queue drained
  });
});

describe('two-device conflict (last-write-wins)', () => {
  it('pull takes the cloud row when it is newer than local', async () => {
    await putLogQuiet({ sessionId: 'C1', athleteId: 'self', done: false, deleted: false, updatedAt: '2026-06-19T00:00:00Z' });
    CLOUD.logs.set(uidKey('C1'), cloudLog('C1', { done: true, updated_at: '2026-06-25T00:00:00Z' }));
    await pull();
    expect((await loadAllLogs('self'))['C1'].done).toBe(true);   // device B's newer edit wins
  });

  it('push SKIPS rather than clobbering a newer cloud row', async () => {
    await addToOutbox({ table: 'logs', key: 'C3', updatedAt: '2026-06-20T00:00:00Z',
      payload: { sessionId: 'C3', athleteId: 'self', done: false, updatedAt: '2026-06-20T00:00:00Z', deleted: false } });
    CLOUD.logs.set(uidKey('C3'), cloudLog('C3', { done: true, updated_at: '2026-06-25T00:00:00Z' })); // cloud newer
    const res = await pushDirty();
    expect(res.skipped).toBe(1);
    expect(res.pushed).toBe(0);
    expect(CLOUD.logs.get(uidKey('C3')).done).toBe(true);        // not clobbered
  });

  it('push overwrites an older cloud row', async () => {
    await addToOutbox({ table: 'logs', key: 'C4', updatedAt: '2026-06-30T00:00:00Z',
      payload: { sessionId: 'C4', athleteId: 'self', done: true, updatedAt: '2026-06-30T00:00:00Z', deleted: false } });
    CLOUD.logs.set(uidKey('C4'), cloudLog('C4', { done: false, updated_at: '2026-06-20T00:00:00Z' })); // cloud older
    const res = await pushDirty();
    expect(res.pushed).toBe(1);
    expect(CLOUD.logs.get(uidKey('C4')).done).toBe(true);        // local wins
  });
});

describe('delete / tombstone propagation', () => {
  it('a local delete becomes a tombstone that pushes to the cloud', async () => {
    await putLog({ sessionId: 'D1', athleteId: 'self', done: true });
    await pushDirty();
    expect(CLOUD.logs.get(uidKey('D1')).deleted).toBe(false);
    await deleteLog('D1');                                        // sync on → tombstone
    expect((await getLogRaw('D1')).deleted).toBe(true);
    await pushDirty();
    expect(CLOUD.logs.get(uidKey('D1')).deleted).toBe(true);     // tombstone propagated
  });
});

describe('backfill idempotency', () => {
  it('first sync backfills local data; a second sync does not re-enqueue', async () => {
    await putLogQuiet({ sessionId: 'B1', athleteId: 'self', done: true, deleted: false, updatedAt: '2026-06-19T00:00:00Z' });
    await fullSync();
    expect(CLOUD.logs.has(uidKey('B1'))).toBe(true);
    expect(await getSetting('sync:backfilled')).toBe('uid-123');
    await clearOutbox();
    await fullSync();
    expect(await allOutbox()).toHaveLength(0);                    // no re-backfill
  });
});

describe('auth transitions', () => {
  it('stops queueing when signed out, and syncs pending data on sign-in', async () => {
    h.fireAuth('SIGNED_OUT', null);
    await putLog({ sessionId: 'A1', athleteId: 'self', done: true });  // written locally...
    expect(await allOutbox()).toHaveLength(0);                         // ...but NOT queued (sync off)

    h.fireAuth('SIGNED_IN', h.session);   // triggers an auto fullSync (backfills A1)
    await settle();
    expect(CLOUD.logs.has(uidKey('A1'))).toBe(true);                  // synced after sign-in
  });
});
