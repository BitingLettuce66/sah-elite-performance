import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validatePlan, formatIssues } from '../src/plan-validator.js';

const seed = JSON.parse(readFileSync(new URL('../public/data/seed.json', import.meta.url)));

// The real coach-built plan, reshaped into the { template, sessions } contract.
function seedAsPlan() {
  return {
    template: {
      templateId: seed.templateId, name: '16-week sprint plan', sport: 'sprints',
      goal: 'Season build', source: 'imported', planVersion: seed.planVersion,
      rules: seed.rules, phases: seed.phases,
    },
    sessions: seed.sessions.map(s => ({ ...s })),
  };
}

const session = (over = {}) => ({
  id: 'P1-W1-Mon', phase: 'P1 Accel', week: 1, day: 'Mon', type: 'HIGH',
  focus: 'Establish', surface: 'Track', sprint: '6×20m', gym: 'Squat 3×5', offsetDays: 0, ...over,
});
const plan = (sessions, template = { name: 'Test plan' }) => ({ template, sessions });

// Build N high-intensity sessions at the given offsets (default sequential).
const highAt = offsets => offsets.map((o, i) => session({ id: `S${o}`, day: 'Mon', offsetDays: o, type: 'HIGH', sprint: 'max effort' }));

describe('validatePlan — structure', () => {
  it('accepts the real coach seed plan with no errors', () => {
    const r = validatePlan(seedAsPlan());
    expect(r.errors, formatIssues(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.plan.sessions.length).toBe(seed.sessions.length);
  });

  it('accepts a minimal valid plan', () => {
    const r = validatePlan(plan([session()]));
    expect(r.ok).toBe(true);
  });

  it('rejects a non-object plan', () => {
    expect(validatePlan(null).ok).toBe(false);
    expect(validatePlan([]).errors[0].code).toBe('PLAN_NOT_OBJECT');
  });

  it('rejects a missing template and a missing template.name', () => {
    expect(validatePlan({ sessions: [session()] }).errors.some(e => e.code === 'TEMPLATE_MISSING')).toBe(true);
    expect(validatePlan(plan([session()], {})).errors.some(e => e.code === 'TEMPLATE_FIELD_REQUIRED')).toBe(true);
  });

  it('rejects empty / non-array sessions', () => {
    expect(validatePlan(plan([])).errors.some(e => e.code === 'SESSIONS_EMPTY')).toBe(true);
    expect(validatePlan({ template: { name: 'x' }, sessions: 'nope' }).errors.some(e => e.code === 'SESSIONS_NOT_ARRAY')).toBe(true);
  });
});

describe('validatePlan — session rules', () => {
  it('rejects an unknown type', () => {
    expect(validatePlan(plan([session({ type: 'TURBO' })])).errors.some(e => e.code === 'SESSION_BAD_TYPE')).toBe(true);
  });

  it('rejects a negative or non-integer offsetDays', () => {
    expect(validatePlan(plan([session({ offsetDays: -1 })])).errors.some(e => e.code === 'SESSION_BAD_OFFSET')).toBe(true);
    expect(validatePlan(plan([session({ offsetDays: 1.5 })])).errors.some(e => e.code === 'SESSION_BAD_OFFSET')).toBe(true);
  });

  it('rejects a bad day and a bad week', () => {
    expect(validatePlan(plan([session({ day: 'Funday' })])).errors.some(e => e.code === 'SESSION_BAD_DAY')).toBe(true);
    expect(validatePlan(plan([session({ week: 0 })])).errors.some(e => e.code === 'SESSION_BAD_WEEK')).toBe(true);
  });

  it('requires prescription text on a non-rest session', () => {
    const r = validatePlan(plan([session({ sprint: '', gym: '' })]));
    expect(r.errors.some(e => e.code === 'SESSION_NO_PRESCRIPTION')).toBe(true);
  });

  it('allows an empty prescription on a RECOVERY (rest) session', () => {
    const r = validatePlan(plan([session({ type: 'RECOVERY', sprint: '', gym: '' })]));
    expect(r.ok).toBe(true);
  });

  it('drops free-form fields not in the schema', () => {
    const r = validatePlan(plan([session({ evil: 'ignore me', anotherKey: 1 })]));
    expect(r.ok).toBe(true);
    expect(r.plan.sessions[0]).not.toHaveProperty('evil');
    expect(r.plan.sessions[0]).not.toHaveProperty('anotherKey');
  });
});

describe('validatePlan — id locking', () => {
  it('assigns a stable id when one is missing', () => {
    const s = session(); delete s.id;
    const r = validatePlan(plan([s]));
    expect(r.ok).toBe(true);
    expect(r.plan.sessions[0].id).toBe('P1-W1-Mon');
  });

  it('reassigns and warns on a duplicate id, keeping ids unique', () => {
    const r = validatePlan(plan([
      session({ id: 'DUP', offsetDays: 0, day: 'Mon' }),
      session({ id: 'DUP', offsetDays: 1, day: 'Tue' }),
    ]));
    const ids = r.plan.sessions.map(s => s.id);
    expect(new Set(ids).size).toBe(2);
    expect(r.warnings.some(w => w.code === 'SESSION_DUP_ID')).toBe(true);
  });

  it('preserves a provided valid unique id', () => {
    const r = validatePlan(plan([session({ id: 'CUSTOM-1' })]));
    expect(r.plan.sessions[0].id).toBe('CUSTOM-1');
  });
});

describe('validatePlan — volume guards', () => {
  it('rejects more than the hard weekly high-intensity cap', () => {
    // 7 HIGH days in one 7-day window (offsets 0..6) > hard cap 6.
    const r = validatePlan(plan(highAt([0, 1, 2, 3, 4, 5, 6])));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'VG_WEEKLY_HIGH_CAP')).toBe(true);
  });

  it('warns (but does not reject) above the soft weekly cap', () => {
    // 5 HIGH days in window 0, spaced so no >3 run: offsets 0,1,3,5,6.
    const r = validatePlan(plan(highAt([0, 1, 3, 5, 6])));
    expect(r.ok).toBe(true);
    expect(r.warnings.some(w => w.code === 'VG_WEEKLY_HIGH')).toBe(true);
  });

  it('rejects a RACE not followed by a recovery day', () => {
    const r = validatePlan(plan([
      session({ id: 'r', type: 'RACE', day: 'Sat', offsetDays: 0, sprint: 'Race 100m' }),
      session({ id: 'h', type: 'HIGH', day: 'Sun', offsetDays: 1, sprint: 'max effort' }),
    ]));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'VG_NO_REST_AFTER_RACE')).toBe(true);
  });

  it('returns sessions sorted by offsetDays', () => {
    const r = validatePlan(plan([
      session({ id: 'b', offsetDays: 5, day: 'Sat' }),
      session({ id: 'a', offsetDays: 2, day: 'Wed' }),
    ]));
    expect(r.plan.sessions.map(s => s.offsetDays)).toEqual([2, 5]);
  });

  it('does not mutate the caller input', () => {
    const s = session({ evil: 'keep' });
    validatePlan(plan([s]));
    expect(s).toHaveProperty('evil', 'keep');
  });
});

// Rest-after-hard-day rules (ai-coach-design §5 rule 4). A RACE must be followed
// by a true recovery day (RECOVERY/DELOAD/TAPER) or rest; a DELOAD must not be
// spiked straight back into a hard (HIGH/RACE) day. Recovery-class days
// (DELOAD/TAPER) count as rest after a RACE so the real coach seed plan — which
// follows a race with a deload, and deloads with easy days — still validates.
describe('validatePlan — rest after a hard day', () => {
  const race = over => session({ id: 'race', type: 'RACE', day: 'Sat', offsetDays: 0, sprint: 'Race 100m', ...over });
  const deload = over => session({ id: 'dl', type: 'DELOAD', day: 'Mon', offsetDays: 0, sprint: 'Technical, low volume', ...over });
  const after = over => session({ id: 'next', day: 'Sun', offsetDays: 1, sprint: 'work', ...over });

  it('rejects a RACE followed by a MOD day (previously accepted)', () => {
    const r = validatePlan(plan([race(), after({ type: 'MOD' })]));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'VG_NO_REST_AFTER_RACE')).toBe(true);
  });

  it('rejects a RACE followed by a LOW day (no easy session the day after a race)', () => {
    const r = validatePlan(plan([race(), after({ type: 'LOW' })]));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'VG_NO_REST_AFTER_RACE')).toBe(true);
  });

  it('still rejects a RACE followed by a HIGH day (control)', () => {
    const r = validatePlan(plan([race(), after({ type: 'HIGH', sprint: 'max effort' })]));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'VG_NO_REST_AFTER_RACE')).toBe(true);
  });

  it('accepts a RACE followed by a DELOAD day (seed-style: offset 195→196)', () => {
    const r = validatePlan(plan([race(), after({ type: 'DELOAD' })]));
    expect(r.errors, formatIssues(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('accepts a RACE followed by a RECOVERY day or by nothing', () => {
    expect(validatePlan(plan([race(), after({ type: 'RECOVERY', sprint: '' })])).ok).toBe(true);
    expect(validatePlan(plan([race()])).ok).toBe(true); // next day empty = rest
  });

  it('rejects a DELOAD followed by a HIGH day (previously accepted)', () => {
    const r = validatePlan(plan([deload(), after({ type: 'HIGH', day: 'Tue', sprint: 'max effort' })]));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'VG_NO_REST_AFTER_DELOAD')).toBe(true);
  });

  it('accepts a DELOAD followed by an easy LOW day (seed-style: offset 14→15)', () => {
    const r = validatePlan(plan([deload(), after({ type: 'LOW', day: 'Tue' })]));
    expect(r.errors, formatIssues(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('lets the DELOAD-rest guard be turned off per call', () => {
    const r = validatePlan(plan([deload(), after({ type: 'HIGH', day: 'Tue', sprint: 'max effort' })]), { guards: { enforceRestDayAfterDeload: false } });
    expect(r.errors.some(e => e.code === 'VG_NO_REST_AFTER_DELOAD')).toBe(false);
    expect(r.ok).toBe(true);
  });
});
