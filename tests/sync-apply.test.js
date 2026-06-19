import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { applyRemoteLog, applyRemoteSetting } from '../src/sync.js';
import { putLogQuiet, getLogRaw, loadAllLogs, getSetting } from '../src/db.js';

const logRow = (o) => ({ athlete_id: 'uid', plan_id: 'current', done: null, deleted: false, ...o });

describe('applyRemoteLog (pull → LWW → IndexedDB)', () => {
  it('stores a brand-new remote log', async () => {
    expect(await applyRemoteLog(logRow({ session_id: 'X1', done: true, updated_at: '2026-06-20T00:00:00Z' }))).toBe(true);
    expect((await loadAllLogs('self'))['X1'].done).toBe(true);
  });

  it('ignores an older remote (newer local wins)', async () => {
    await putLogQuiet({ sessionId: 'X2', athleteId: 'self', done: true, deleted: false, updatedAt: '2026-06-25T00:00:00Z' });
    const changed = await applyRemoteLog(logRow({ session_id: 'X2', done: false, updated_at: '2026-06-20T00:00:00Z' }));
    expect(changed).toBe(false);
    expect((await loadAllLogs('self'))['X2'].done).toBe(true); // local kept
  });

  it('applies a newer remote (overwrites older local)', async () => {
    await putLogQuiet({ sessionId: 'X3', athleteId: 'self', done: true, deleted: false, updatedAt: '2026-06-20T00:00:00Z' });
    expect(await applyRemoteLog(logRow({ session_id: 'X3', done: false, updated_at: '2026-06-30T00:00:00Z' }))).toBe(true);
    expect((await loadAllLogs('self'))['X3'].done).toBe(false);
  });

  it('applies a remote tombstone (hidden from the app, retained raw)', async () => {
    await putLogQuiet({ sessionId: 'X4', athleteId: 'self', done: true, deleted: false, updatedAt: '2026-06-20T00:00:00Z' });
    await applyRemoteLog(logRow({ session_id: 'X4', deleted: true, updated_at: '2026-06-21T00:00:00Z' }));
    expect((await loadAllLogs('self'))['X4']).toBeUndefined();
    expect((await getLogRaw('X4')).deleted).toBe(true);
  });

  it('preserves a frozen prescribedSnapshot even when the remote wins', async () => {
    await putLogQuiet({ sessionId: 'X5', athleteId: 'self', done: false, deleted: false,
      prescribedSnapshot: { focus: 'Establish' }, updatedAt: '2026-06-19T00:00:00Z' });
    await applyRemoteLog(logRow({ session_id: 'X5', done: true, prescribed_snapshot: null, updated_at: '2026-06-25T00:00:00Z' }));
    const raw = await getLogRaw('X5');
    expect(raw.done).toBe(true);                                  // remote field applied
    expect(raw.prescribedSnapshot).toEqual({ focus: 'Establish' }); // snapshot kept
  });
});

describe('applyRemoteSetting', () => {
  it('ignores device-local (non-syncable) keys', async () => {
    expect(await applyRemoteSetting({ key: 'onboarded:self', value: true, updated_at: '2026-06-20T00:00:00Z', deleted: false })).toBe(false);
    expect(await getSetting('onboarded:self')).toBeNull();
  });

  it('applies a syncable setting', async () => {
    expect(await applyRemoteSetting({ key: 'targets:self', value: { '30m': 3.5 }, updated_at: '2026-06-20T00:00:00Z', deleted: false })).toBe(true);
    expect(await getSetting('targets:self')).toEqual({ '30m': 3.5 });
  });
});
