import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import {
  putLog, loadAllLogs, getLogRaw, putLogQuiet,
  getSetting, putSettingQuiet, getSettingRaw,
  addToOutbox, allOutbox, removeFromOutbox, clearOutbox,
} from '../src/db.js';

describe('sync foundation — stamping', () => {
  it('putLog stamps updatedAt and deleted:false', async () => {
    await putLog({ sessionId: 'S1', athleteId: 'self', planId: 'current', done: true });
    const raw = await getLogRaw('S1');
    expect(typeof raw.updatedAt).toBe('string');
    expect(raw.updatedAt.length).toBeGreaterThan(0);
    expect(raw.deleted).toBe(false);
  });
});

describe('sync foundation — tombstones hidden from reads', () => {
  it('loadAllLogs hides a tombstoned log; getLogRaw still sees it', async () => {
    await putLogQuiet({ sessionId: 'S2', athleteId: 'self', deleted: true, updatedAt: '2026-06-19T00:00:00Z' });
    const map = await loadAllLogs('self');
    expect(map['S2']).toBeUndefined();          // hidden from the app
    expect((await getLogRaw('S2')).deleted).toBe(true); // sync can still see it
  });

  it('getSetting hides a tombstoned setting; getSettingRaw still sees it', async () => {
    await putSettingQuiet({ key: 'targets:ghost', value: { x: 1 }, deleted: true, updatedAt: '2026-06-19T00:00:00Z' });
    expect(await getSetting('targets:ghost')).toBeNull();
    expect((await getSettingRaw('targets:ghost')).deleted).toBe(true);
  });
});

describe('sync foundation — outbox queue', () => {
  it('appends, lists, removes, and clears mutations (FIFO with ids)', async () => {
    await clearOutbox();
    await addToOutbox({ table: 'logs', op: 'upsert', key: 'A', updatedAt: 't1' });
    await addToOutbox({ table: 'logs', op: 'upsert', key: 'B', updatedAt: 't2' });
    await addToOutbox({ table: 'settings', op: 'upsert', key: 'targets:self', updatedAt: 't3' });

    let q = await allOutbox();
    expect(q).toHaveLength(3);
    expect(q.every(m => m.id != null)).toBe(true);  // autoIncrement assigned ids
    expect(q[0].key).toBe('A');                      // insertion order preserved

    await removeFromOutbox(q[0].id);
    q = await allOutbox();
    expect(q).toHaveLength(2);
    expect(q.find(m => m.key === 'A')).toBeUndefined();

    await clearOutbox();
    expect(await allOutbox()).toHaveLength(0);
  });
});
