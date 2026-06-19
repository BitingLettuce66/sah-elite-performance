import { describe, it, expect } from 'vitest';
import {
  toRemoteLog, fromRemoteLog, isSyncableSettingKey,
  toRemoteSetting, fromRemoteSetting, reconcile, maxUpdatedAt,
  LOCAL_ATHLETE, LOCAL_PLAN,
} from '../src/sync-logic.js';

const UID = '11111111-2222-3333-4444-555555555555';

describe('log translation', () => {
  it('maps local → remote, stamping the owner uid and snake_casing fields', () => {
    const local = { sessionId: 'P1-W1-Mon', athleteId: 'self', planId: 'current',
      done: true, rpe: 7, squatKg: 84, hipThrustKg: 100, sprints: [{ dist: '30m', time: 3.9 }],
      prescribedSnapshot: { focus: 'Establish' }, date: '2026-06-15', updatedAt: '2026-06-19T00:00:00Z' };
    const r = toRemoteLog(local, UID);
    expect(r.athlete_id).toBe(UID);
    expect(r.session_id).toBe('P1-W1-Mon');
    expect(r.squat_kg).toBe(84);
    expect(r.hip_thrust_kg).toBe(100);
    expect(r.prescribed_snapshot).toEqual({ focus: 'Establish' });
    expect(r.updated_at).toBe('2026-06-19T00:00:00Z');
    expect(r.deleted).toBe(false);
  });

  it('maps remote → local, restoring the stable self identity (not the uid)', () => {
    const row = { athlete_id: UID, session_id: 'P2-W3-Wed', plan_id: 'current',
      done: true, rpe: 8, squat_kg: 90, hip_thrust_kg: null, sprints: null,
      prescribed_snapshot: null, date: '2026-07-01', updated_at: '2026-07-01T10:00:00Z', deleted: false };
    const local = fromRemoteLog(row);
    expect(local.athleteId).toBe(LOCAL_ATHLETE); // uid hidden from local code
    expect(local.sessionId).toBe('P2-W3-Wed');
    expect(local.planId).toBe(LOCAL_PLAN);
    expect(local.squatKg).toBe(90);
    expect(local.updatedAt).toBe('2026-07-01T10:00:00Z');
  });

  it('round-trips a log through remote and back without losing fields', () => {
    const local = { sessionId: 'P1-W1-Fri', athleteId: 'self', planId: 'current',
      done: true, rpe: 6, note: 'felt sharp', squatKg: 80, hipThrustKg: null,
      sprints: [{ dist: '20m', time: 2.8 }], date: '2026-06-19', updatedAt: '2026-06-19T09:00:00Z', deleted: false };
    const back = fromRemoteLog(toRemoteLog(local, UID));
    expect(back.sessionId).toBe(local.sessionId);
    expect(back.rpe).toBe(6);
    expect(back.note).toBe('felt sharp');
    expect(back.squatKg).toBe(80);
    expect(back.sprints).toEqual([{ dist: '20m', time: 2.8 }]);
  });
});

describe('isSyncableSettingKey', () => {
  it('syncs training data, not device-local prefs or the cursor', () => {
    expect(isSyncableSettingKey('targets:self')).toBe(true);
    expect(isSyncableSettingKey('bw:self')).toBe(true);
    expect(isSyncableSettingKey('assignment:self')).toBe(true);
    expect(isSyncableSettingKey('onboarded:self')).toBe(false);
    expect(isSyncableSettingKey('lastSeen:self')).toBe(false);
    expect(isSyncableSettingKey('sync:cursor:logs')).toBe(false);
    expect(isSyncableSettingKey(null)).toBe(false);
  });
});

describe('setting translation', () => {
  it('round-trips a setting through remote and back', () => {
    const local = { key: 'targets:self', value: { '30m': 3.6 }, updatedAt: '2026-06-19T00:00:00Z', deleted: false };
    const back = fromRemoteSetting(toRemoteSetting(local, UID));
    expect(back.key).toBe('targets:self');
    expect(back.value).toEqual({ '30m': 3.6 });
    expect(back.updatedAt).toBe('2026-06-19T00:00:00Z');
  });
});

describe('reconcile (last-write-wins)', () => {
  it('takes the remote when it is strictly newer', () => {
    const local = { sessionId: 'x', updatedAt: '2026-06-19T00:00:00Z' };
    const remote = { sessionId: 'x', updatedAt: '2026-06-20T00:00:00Z', done: true };
    expect(reconcile(local, remote)).toBe(remote);
  });

  it('keeps local (returns null) when local is newer or equal', () => {
    const local = { sessionId: 'x', updatedAt: '2026-06-21T00:00:00Z' };
    const remote = { sessionId: 'x', updatedAt: '2026-06-20T00:00:00Z' };
    expect(reconcile(local, remote)).toBeNull();
    expect(reconcile({ updatedAt: 'T' }, { updatedAt: 'T' })).toBeNull(); // tie favours local
  });

  it('returns the remote when there is no local copy, and null when no remote', () => {
    const remote = { sessionId: 'x', updatedAt: '2026-06-20T00:00:00Z' };
    expect(reconcile(null, remote)).toBe(remote);
    expect(reconcile({ updatedAt: 'T' }, null)).toBeNull();
  });

  it('never lets a newer remote erase a frozen prescribedSnapshot', () => {
    const local = { sessionId: 'x', updatedAt: '2026-06-19T00:00:00Z', prescribedSnapshot: { focus: 'Establish' } };
    const remote = { sessionId: 'x', updatedAt: '2026-06-25T00:00:00Z', done: true }; // newer, no snapshot
    const out = reconcile(local, remote);
    expect(out.done).toBe(true);                                // remote wins overall
    expect(out.prescribedSnapshot).toEqual({ focus: 'Establish' }); // snapshot preserved
  });
});

describe('maxUpdatedAt', () => {
  it('returns the highest updated_at, never regressing below prev', () => {
    const rows = [{ updated_at: '2026-06-19T00:00:00Z' }, { updated_at: '2026-06-21T00:00:00Z' }, { updated_at: '2026-06-20T00:00:00Z' }];
    expect(maxUpdatedAt(rows)).toBe('2026-06-21T00:00:00Z');
    expect(maxUpdatedAt([], '2026-06-22T00:00:00Z')).toBe('2026-06-22T00:00:00Z');
    expect(maxUpdatedAt(rows, '2026-06-30T00:00:00Z')).toBe('2026-06-30T00:00:00Z');
  });
});
