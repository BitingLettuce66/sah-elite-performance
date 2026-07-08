import { describe, it, expect } from 'vitest';
import { addDays, sortByDate, findToday, computeStreak, statusOf } from '../src/logic.js';

describe('addDays', () => {
  it('adds days across month/year boundaries (DST-safe)', () => {
    expect(addDays('2026-06-15', 0)).toBe('2026-06-15');
    expect(addDays('2026-06-15', 3)).toBe('2026-06-18');
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-06-15', 286)).toBe('2027-03-28');
  });
});

describe('sortByDate', () => {
  it('sorts ascending without mutating the input', () => {
    const input = [{ date: '2026-06-17' }, { date: '2026-06-15' }, { date: '2026-06-16' }];
    const out = sortByDate(input);
    expect(out.map(s => s.date)).toEqual(['2026-06-15', '2026-06-16', '2026-06-17']);
    expect(input[0].date).toBe('2026-06-17'); // original untouched
  });
});

const SESSIONS = [
  { id: 'a', date: '2026-06-15' },
  { id: 'b', date: '2026-06-16' },
  { id: 'c', date: '2026-06-17' },
  { id: 'd', date: '2026-06-18' },
];

describe('findToday', () => {
  it("returns today's session when one is dated today", () => {
    expect(findToday(SESSIONS, '2026-06-16').id).toBe('b');
  });
  it('returns the next upcoming session when none is dated today', () => {
    expect(findToday(SESSIONS, '2026-06-14').id).toBe('a'); // nothing on the 14th → next is the 15th
  });
  it('returns null when the programme is over', () => {
    expect(findToday(SESSIONS, '2027-01-01')).toBe(null);
  });
});

describe('computeStreak', () => {
  it('counts consecutive completed sessions back from today', () => {
    const logs = { a: { done: true }, b: { done: true }, c: { done: true } };
    expect(computeStreak(SESSIONS, logs, '2026-06-17')).toBe(3);
  });
  it('stops at the first gap', () => {
    const logs = { a: { done: true }, b: { done: false }, c: { done: true } };
    expect(computeStreak(SESSIONS, logs, '2026-06-17')).toBe(1); // c then b breaks
  });
  it('is 0 with no logs', () => {
    expect(computeStreak(SESSIONS, {}, '2026-06-17')).toBe(0);
  });
  it('skips rest (RECOVERY) days so a weekly rest day does not reset the streak', () => {
    const sessions = [
      { id: 'a', date: '2026-06-15', type: 'HIGH' },
      { id: 'b', date: '2026-06-16', type: 'RECOVERY' }, // rest day, never marked done
      { id: 'c', date: '2026-06-17', type: 'HIGH' },
    ];
    const logs = { a: { done: true }, c: { done: true } };
    expect(computeStreak(sessions, logs, '2026-06-17')).toBe(2);
  });
});

describe('statusOf', () => {
  it('done when logged done', () => {
    expect(statusOf({ date: '2026-06-15' }, { done: true }, '2026-06-18')).toBe('done');
  });
  it('missed when past and not done', () => {
    expect(statusOf({ date: '2026-06-15' }, { done: false }, '2026-06-18')).toBe('missed');
  });
  it('future when on/after today and not done', () => {
    expect(statusOf({ date: '2026-06-20' }, null, '2026-06-18')).toBe('future');
    expect(statusOf({ date: '2026-06-18' }, null, '2026-06-18')).toBe('future');
  });
});
