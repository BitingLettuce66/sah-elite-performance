import 'fake-indexeddb/auto';   // polyfills indexedDB before db.js opens it
import { describe, it, expect } from 'vitest';
import { putLog, loadAllLogs, deleteLog, getSetting, putSetting } from '../src/db.js';

describe('db logs', () => {
  it('saves and loads a log, scoped by athleteId', async () => {
    await putLog({ sessionId: 'T1', athleteId: 'A', planId: 'p', done: true, rpe: 7 });
    const map = await loadAllLogs('A');
    expect(map['T1'].done).toBe(true);
    expect(map['T1'].rpe).toBe(7);
  });

  it('does not leak logs across athletes', async () => {
    await putLog({ sessionId: 'T2', athleteId: 'A', planId: 'p', done: true });
    await putLog({ sessionId: 'T3', athleteId: 'B', planId: 'p', done: true });
    const a = await loadAllLogs('A');
    const b = await loadAllLogs('B');
    expect(a['T3']).toBeUndefined();
    expect(b['T2']).toBeUndefined();
    expect(b['T3']).toBeDefined();
  });

  it('deletes a log', async () => {
    await putLog({ sessionId: 'T4', athleteId: 'A', planId: 'p', done: true });
    await deleteLog('T4');
    expect((await loadAllLogs('A'))['T4']).toBeUndefined();
  });

  it('export → import round-trip preserves logs', async () => {
    const ath = 'RT';
    await putLog({ sessionId: 'R1', athleteId: ath, planId: 'p', done: true, squatKg: 100 });
    await putLog({ sessionId: 'R2', athleteId: ath, planId: 'p', done: true, sprints: [{ dist: '30m fly', time: 3.6 }] });
    const exported = Object.values(await loadAllLogs(ath));     // simulate Export backup
    await deleteLog('R1'); await deleteLog('R2');               // wipe device
    expect(Object.keys(await loadAllLogs(ath)).length).toBe(0);
    for (const lg of exported) await putLog(lg);               // simulate Import backup
    const restored = await loadAllLogs(ath);
    expect(Object.keys(restored).sort()).toEqual(['R1', 'R2']);
    expect(restored['R1'].squatKg).toBe(100);
    expect(restored['R2'].sprints[0].time).toBe(3.6);
  });
});

describe('db settings', () => {
  it('returns null for a missing key', async () => {
    expect(await getSetting('missing:key')).toBe(null);
  });
  it('stores and reads a key/value', async () => {
    await putSetting('targets:self', { '30m fly': 3.55 });
    expect((await getSetting('targets:self'))['30m fly']).toBe(3.55);
  });
});
