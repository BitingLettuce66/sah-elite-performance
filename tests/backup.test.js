import { describe, it, expect } from 'vitest';
import { buildBackup, validateBackup, normalizeImported, BACKUP_TYPE } from '../src/backup.js';

describe('buildBackup', () => {
  it('wraps logs in a tagged payload with athlete/plan + timestamp', () => {
    const logs = [{ sessionId: 'P1-W1-Mon', done: true }];
    const out = buildBackup(logs, { athleteId: 'self', planId: 'current', exportedAt: '2026-06-19T00:00:00Z' });
    expect(out.type).toBe(BACKUP_TYPE);
    expect(out.version).toBe(1);
    expect(out.athleteId).toBe('self');
    expect(out.planId).toBe('current');
    expect(out.exportedAt).toBe('2026-06-19T00:00:00Z');
    expect(out.logs).toBe(logs);
  });
});

describe('validateBackup', () => {
  it('accepts a {logs:[...]} object, keeping only well-formed entries', () => {
    const data = { logs: [
      { sessionId: 'P1-W1-Mon', done: true },
      { done: true },                 // no sessionId → dropped
      null,                           // junk → dropped
      { sessionId: 42 },              // non-string id → dropped
    ] };
    const r = validateBackup(data);
    expect(r.ok).toBe(true);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0].sessionId).toBe('P1-W1-Mon');
  });

  it('accepts a bare array of logs', () => {
    const r = validateBackup([{ sessionId: 'P2-W3-Wed' }]);
    expect(r.ok).toBe(true);
    expect(r.logs).toHaveLength(1);
  });

  it('rejects a file with no logs array', () => {
    expect(validateBackup({ foo: 'bar' }).ok).toBe(false);
    expect(validateBackup(null).ok).toBe(false);
  });

  it('rejects when no entry is well-formed', () => {
    const r = validateBackup({ logs: [{ done: true }, 5] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no valid log/i);
  });

  it('drops tombstones so a deleted session is not resurrected on import', () => {
    const r = validateBackup({ logs: [
      { sessionId: 'P1-W1-Mon', deleted: true },   // tombstone → dropped
      { sessionId: 'P1-W1-Wed', done: true },
    ] });
    expect(r.ok).toBe(true);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0].sessionId).toBe('P1-W1-Wed');
  });
});

describe('normalizeImported', () => {
  it('stamps athlete/plan while preserving each sessionId and fields', () => {
    const out = normalizeImported(
      [{ sessionId: 'P1-W1-Mon', rpe: 7, athleteId: 'other' }],
      { athleteId: 'self', planId: 'current' });
    expect(out[0].sessionId).toBe('P1-W1-Mon');
    expect(out[0].rpe).toBe(7);
    expect(out[0].athleteId).toBe('other'); // the log's own value wins over the default
    expect(out[0].planId).toBe('current');
  });

  it('sanitises to known fields/types and drops hostile or malformed values', () => {
    const out = normalizeImported([{
      sessionId: 'P1-W1-Mon',
      rpe: '7x',                       // non-numeric → dropped
      squatKg: '"><img src=x onerror=alert(1)>', // injection attempt → dropped
      hipThrustKg: 120,               // valid → kept
      note: 'felt strong',
      sprints: [{ dist: '30m', time: 3.7 }, { dist: 'x', time: 'bad' }, { junk: 1 }],
      evil: '<script>alert(1)</script>',  // unknown field → dropped
    }], { athleteId: 'self', planId: 'current' });
    const r = out[0];
    expect(r).not.toHaveProperty('rpe');
    expect(r).not.toHaveProperty('squatKg');
    expect(r.hipThrustKg).toBe(120);
    expect(r.note).toBe('felt strong');
    expect(r.sprints).toEqual([{ dist: '30m', time: 3.7 }]);
    expect(r).not.toHaveProperty('evil');
  });
});
