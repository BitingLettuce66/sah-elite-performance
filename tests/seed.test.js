import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, '../public/data/seed.json'), 'utf8'));

describe('seed integrity', () => {
  it('has 281 sessions', () => {
    expect(seed.sessions.length).toBe(281);
  });

  it('every session id is unique', () => {
    const ids = seed.sessions.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every session has the required fields', () => {
    for (const s of seed.sessions) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.offsetDays).toBe('number');
      expect(typeof s.type).toBe('string');
      expect(typeof s.focus).toBe('string');
    }
  });

  it('is a date-agnostic template (no baked dates) bound by startDate', () => {
    expect(seed.sessions.some(s => 'date' in s)).toBe(false);
    expect(typeof seed.startDate).toBe('string');
  });

  it('carries reserved multi-tenant fields', () => {
    expect(seed.athleteId).toBe('self');
    expect(seed.planId).toBe('current');
  });

  it('has no leftover personal "NDIS" mentions (privacy regression guard)', () => {
    expect(JSON.stringify(seed)).not.toMatch(/NDIS/);
  });
});
