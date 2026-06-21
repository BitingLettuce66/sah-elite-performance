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
  it('rejects too many high-intensity days in a rolling 7-day window', () => {
    // 7 HIGH days within a 7-day window (offsets 0..6) > rolling error cap (5).
    const r = validatePlan(plan(highAt([0, 1, 2, 3, 4, 5, 6])));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'VG_ROLLING_HIGH_CAP')).toBe(true);
  });

  it('warns (but does not reject) at 5 high days in a rolling 7-day window', () => {
    // 5 HIGH in window 0, spaced so no >2 consecutive run: offsets 0,1,3,5,6.
    const r = validatePlan(plan(highAt([0, 1, 3, 5, 6])));
    expect(r.ok).toBe(true);
    expect(r.warnings.some(w => w.code === 'VG_ROLLING_HIGH')).toBe(true);
  });

  it('catches high-intensity load straddling a fixed-week boundary', () => {
    // Regression guard: the rolling window must NOT degrade into fixed
    // Math.floor(off/7) buckets. HIGH on offsets 5,6,8,9,11,12 buckets as
    // {window0: 2, window1: 4} — neither trips the soft cap (4 is not > 4) and
    // the longest consecutive run is 2 (not > 2), so a fixed-bucket guard would
    // return ok with ZERO issues. But the densest rolling 7-day window (days
    // 6–12) holds 5 high days, which must at least warn.
    const r = validatePlan(plan(highAt([5, 6, 8, 9, 11, 12])));
    expect(r.warnings.some(w => w.code === 'VG_ROLLING_HIGH'), formatIssues(r)).toBe(true);
    // 5 is between the soft cap (4) and the hard cap (5): a warning, not a reject.
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    // And it must NOT be the consecutive-day guard surfacing it (max run = 2),
    // proving the rolling weekly window is what catches the straddle.
    expect(r.warnings.some(w => w.code === 'VG_CONSECUTIVE_HIGH')).toBe(false);
  });

  it('rejects multiple high-intensity sessions stacked on one calendar day', () => {
    const r = validatePlan(plan([
      session({ id: 'a', offsetDays: 0, type: 'HIGH', sprint: 'AM max' }),
      session({ id: 'b', offsetDays: 0, type: 'HIGH', sprint: 'midday max' }),
      session({ id: 'c', offsetDays: 0, type: 'HIGH', sprint: 'PM max' }),
    ]));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'VG_DAILY_HIGH_CAP')).toBe(true);
  });

  it('accepts a legit two-a-day (two high-intensity sessions on one day)', () => {
    const r = validatePlan(plan([
      session({ id: 'a', offsetDays: 0, type: 'HIGH', sprint: 'AM speed' }),
      session({ id: 'b', offsetDays: 0, type: 'RACE', sprint: 'PM 100m' }),
    ]));
    expect(r.errors.some(e => e.code === 'VG_DAILY_HIGH_CAP')).toBe(false);
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

describe('validatePlan — content safety & bounds', () => {
  it('accepts a DELOAD day with empty prescription (complete-rest deload)', () => {
    expect(validatePlan(plan([session({ type: 'DELOAD', sprint: '', gym: '' })])).ok).toBe(true);
  });

  it('still requires prescription text on a TAPER day', () => {
    expect(validatePlan(plan([session({ type: 'TAPER', sprint: '', gym: '' })])).errors.some(e => e.code === 'SESSION_NO_PRESCRIPTION')).toBe(true);
  });

  it('rejects a non-string free-text field (type confusion)', () => {
    const r = validatePlan(plan([session({ gym: { a: 1 } })]));
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.code === 'SESSION_FIELD_NOT_STRING')).toBe(true);
  });

  it('rejects markup/script in a prescription field, but allows a legit "<"', () => {
    expect(validatePlan(plan([session({ sprint: '<script>alert(1)</script> 6x20m' })])).errors.some(e => e.code === 'SESSION_UNSAFE_TEXT')).toBe(true);
    expect(validatePlan(plan([session({ gym: 'Back squat 3x5 @ RPE <8' })])).errors.some(e => e.code === 'SESSION_UNSAFE_TEXT')).toBe(false);
  });

  it('rejects an over-long prescription and an over-long id', () => {
    expect(validatePlan(plan([session({ sprint: 'x'.repeat(3000) })])).errors.some(e => e.code === 'SESSION_TEXT_TOO_LONG')).toBe(true);
    expect(validatePlan(plan([session({ id: 'A'.repeat(80) })])).errors.some(e => e.code === 'SESSION_ID_TOO_LONG')).toBe(true);
  });

  it('rejects a double-quote in a prescription field (attribute-injection breakout)', () => {
    // The renderer drops this text into a double-quoted HTML attribute and does
    // not escape "; a quote would break out and inject an event handler.
    const r = validatePlan(plan([session({ focus: 'speed" onmouseover="alert(document.cookie)' })]));
    expect(r.ok, formatIssues(r)).toBe(false);
    expect(r.errors.some(e => e.code === 'SESSION_UNSAFE_TEXT')).toBe(true);
  });

  it('drops an unsafe provided id and derives a safe one (renders unescaped into data-id)', () => {
    const r = validatePlan(plan([session({ id: 'x" onclick="alert(1)', phase: 'P1 Accel', week: 1, day: 'Mon' })]));
    expect(r.ok, formatIssues(r)).toBe(true);                       // plan stays valid
    expect(r.warnings.some(w => w.code === 'SESSION_ID_UNSAFE')).toBe(true);
    expect(r.plan.sessions[0].id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(r.plan.sessions[0].id).not.toContain('"');
  });

  it('cannot carry unsafe chars from a tainted phase into a derived id', () => {
    // No id provided, so the id is derived from phase/week/day; a hostile phase
    // must not taint it.
    const r = validatePlan(plan([session({ id: undefined, phase: 'P1" onclick="x', week: 1, day: 'Mon' })]));
    expect(r.ok, formatIssues(r)).toBe(true);
    expect(r.plan.sessions[0].id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(r.plan.sessions[0].id).not.toContain('"');
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
