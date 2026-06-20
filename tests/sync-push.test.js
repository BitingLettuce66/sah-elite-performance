import { describe, it, expect } from 'vitest';
import { coalesceOutbox } from '../src/sync.js';

describe('coalesceOutbox (push hardening)', () => {
  it('keeps only the newest mutation per (table,key), supersedes the rest', () => {
    const q = [
      { id: 1, table: 'logs', key: 'A', updatedAt: '2026-06-19T00:00:00Z' },
      { id: 2, table: 'logs', key: 'A', updatedAt: '2026-06-19T03:00:00Z' }, // newer dup of A
      { id: 3, table: 'logs', key: 'B', updatedAt: '2026-06-19T01:00:00Z' },
      { id: 4, table: 'settings', key: 'A', updatedAt: '2026-06-19T00:00:00Z' }, // same key, other table
    ];
    const { keep, superseded } = coalesceOutbox(q);
    expect(keep.map(m => m.id).sort()).toEqual([2, 3, 4]); // newest A, B, settings:A
    expect(keep.find(m => m.table === 'logs' && m.key === 'A').id).toBe(2);
    expect(superseded.map(m => m.id)).toEqual([1]);        // older A dropped
  });

  it('excludes parked (dead) mutations from the push set', () => {
    const q = [
      { id: 1, table: 'logs', key: 'A', updatedAt: 't1' },
      { id: 2, table: 'logs', key: 'C', updatedAt: 't1', dead: true },
    ];
    const { keep } = coalesceOutbox(q);
    expect(keep.map(m => m.id)).toEqual([1]); // dead C not pushed
  });

  it('returns keep in stable insertion order (by id)', () => {
    const q = [
      { id: 5, table: 'logs', key: 'Z', updatedAt: 't1' },
      { id: 2, table: 'logs', key: 'Y', updatedAt: 't1' },
    ];
    expect(coalesceOutbox(q).keep.map(m => m.id)).toEqual([2, 5]);
  });
});
