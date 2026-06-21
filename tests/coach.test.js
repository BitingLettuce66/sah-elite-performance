import { describe, it, expect } from 'vitest';
import {
  normalizeIntake, generatePlanLocal, generateValidatedPlan,
  buildCoachSystemPrompt, buildCoachUserPrompt,
  coachEndpoint, coachConfigured, requestCoachPlan,
  swapSessionById, regenerateSessionLocal, regenerateOneSession,
} from '../src/coach.js';
import { loadPlan } from '../src/plan-validator.js';
import { addDays } from '../src/logic.js';

const intake = { sport: 'sprints', goal: 'faster 100m', weeks: 6, daysPerWeek: 3, equipment: ['track', 'gym'], startDate: '2026-07-01', notes: '' };

describe('normalizeIntake', () => {
  it('clamps numbers, filters equipment, defaults sport, keeps notes', () => {
    const n = normalizeIntake({ sport: 'bogus', weeks: 99, daysPerWeek: 0, equipment: ['track', 'junk'], notes: '  sore hamstring ', startDate: 'nope' });
    expect(n.sport).toBe('general fitness');
    expect(n.weeks).toBe(16);              // clamped to max
    expect(n.daysPerWeek).toBe(1);         // clamped to min
    expect(n.equipment).toEqual(['track']);
    expect(n.notes).toBe('sore hamstring');
    expect(n.startDate).toBe(null);        // junk date dropped
  });
  it('survives non-object input', () => {
    expect(normalizeIntake(null).sport).toBe('general fitness');
  });
});

describe('generatePlanLocal', () => {
  it('produces a plan that passes the validator gate', () => {
    const r = loadPlan(generatePlanLocal(intake));
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it('has weeks × daysPerWeek sessions and honours the start date', () => {
    const plan = generatePlanLocal(intake);
    expect(plan.sessions.length).toBe(6 * 3);
    expect(plan.startDate).toBe('2026-07-01');
    const s0 = plan.sessions.find(s => s.offsetDays === 0);
    expect(addDays(plan.startDate, s0.offsetDays)).toBe('2026-07-01');
  });
  it('never schedules two high-intensity days back-to-back', () => {
    const plan = generatePlanLocal({ ...intake, weeks: 12, daysPerWeek: 6 });
    const high = new Set(plan.sessions.filter(s => ['HIGH', 'RACE'].includes(s.type)).map(s => s.offsetDays));
    for (const o of high) expect(high.has(o + 1)).toBe(false);
    expect(loadPlan(plan).ok).toBe(true);
  });
  it('is deterministic', () => {
    expect(JSON.stringify(generatePlanLocal(intake))).toBe(JSON.stringify(generatePlanLocal(intake)));
  });
});

describe('generateValidatedPlan — the generate→validate→re-prompt loop', () => {
  it('returns an engine-ready plan on the happy path (local generator)', async () => {
    const r = await generateValidatedPlan(intake);
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.data.template).toBeUndefined();           // flat engine shape
    expect(r.data.sessions.length).toBe(18);
  });
  it('re-prompts with the issues and succeeds on a later attempt', async () => {
    let calls = 0;
    const generate = (i, priorIssues) => {
      calls++;
      // First draft is invalid; once the loop feeds issues back, return a valid plan.
      return priorIssues ? generatePlanLocal(i)
        : { name: 'bad', startDate: '2026-07-01', sessions: [{ week: 1, day: 'Mon', type: 'NOPE', offsetDays: 0, sprint: 'x' }] };
    };
    const r = await generateValidatedPlan(intake, { generate });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.attempts).toBe(2);
    expect(calls).toBe(2);
  });
  it('gives up after maxAttempts with structured errors', async () => {
    const generate = () => ({ name: 'bad', startDate: '2026-07-01', sessions: [{ week: 1, day: 'Mon', type: 'NOPE', offsetDays: 0, sprint: 'x' }] });
    const r = await generateValidatedPlan(intake, { generate, maxAttempts: 2 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.errors.some(e => e.code === 'SESSION_BAD_TYPE')).toBe(true);
  });
  it('surfaces a generator throw as a structured error', async () => {
    const generate = () => { throw new Error('network down'); };
    const r = await generateValidatedPlan(intake, { generate });
    expect(r.ok).toBe(false);
    expect(r.errors[0].code).toBe('COACH_GENERATE_FAILED');
    expect(r.errors[0].message).toContain('network down');
  });
});

describe('prompt construction', () => {
  it('system prompt embeds the contract from the schema', () => {
    const sys = buildCoachSystemPrompt();
    expect(sys).toContain('RACE');
    expect(sys).toContain('rolling 7-day window');
    expect(sys).toMatch(/not.*medical advice/i);
  });
  it('user prompt includes the athlete and folds in prior issues', () => {
    const u = buildCoachUserPrompt(intake, 'ERROR VG_ROLLING_HIGH_CAP: too many');
    expect(u).toContain('sprints');
    expect(u).toContain('faster 100m');
    expect(u).toContain('REJECTED');
    expect(u).toContain('VG_ROLLING_HIGH_CAP');
  });
});

describe('endpoint resolution + network seam', () => {
  it('derives the function URL from the Supabase env', () => {
    expect(coachEndpoint({ VITE_SUPABASE_URL: 'https://x.supabase.co' })).toBe('https://x.supabase.co/functions/v1/coach');
    expect(coachConfigured({ VITE_SUPABASE_URL: 'https://x.supabase.co' })).toBe(true);
  });
  it('is unconfigured when the env is missing or a placeholder', () => {
    expect(coachEndpoint({})).toBe(null);
    expect(coachEndpoint({ VITE_SUPABASE_URL: 'https://PASTE_ME.supabase.co' })).toBe(null);
    expect(coachConfigured({})).toBe(false);
  });
  it('requestCoachPlan posts the intake and returns the plan', async () => {
    let seen;
    const fakeFetch = async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ plan: { name: 'P', startDate: '2026-07-01', sessions: [] } }) }; };
    const plan = await requestCoachPlan(intake, 'prior issues', { endpoint: 'https://x/functions/v1/coach', fetch: fakeFetch, env: { VITE_SUPABASE_ANON_KEY: 'anon' } });
    expect(plan.name).toBe('P');
    expect(seen.url).toContain('/functions/v1/coach');
    expect(seen.body.intake.sport).toBe('sprints');
    expect(seen.body.priorIssues).toBe('prior issues');
  });
  it('requestCoachPlan throws on an HTTP error', async () => {
    const fakeFetch = async () => ({ ok: false, status: 502, json: async () => ({ error: 'upstream' }) });
    await expect(requestCoachPlan(intake, '', { endpoint: 'https://x/functions/v1/coach', fetch: fakeFetch, env: {} }))
      .rejects.toThrow(/502/);
  });
});

describe('regenerate ONE session', () => {
  // A validated base plan (sessions carry ids). RACE at offset 0, target RECOVERY at offset 1.
  const raceBase = loadPlan({
    name: 'Race base', startDate: '2026-07-01',
    sessions: [
      { phase: 'P', week: 1, day: 'Mon', type: 'RACE', offsetDays: 0, sprint: 'Race 100m' },
      { phase: 'P', week: 1, day: 'Tue', type: 'RECOVERY', offsetDays: 1 },
    ],
  }).data;
  const targetId = raceBase.sessions[1].id;

  it('swapSessionById force-pins the slot even when the patch tries to move it', () => {
    const out = swapSessionById(raceBase, targetId, { id: 'evil', offsetDays: 999, day: 'Sun', week: 9, phase: 'X', type: 'LOW', sprint: 'z' });
    const s = out.sessions.find(x => x.offsetDays === 1);
    expect(s.id).toBe(targetId);     // id locked
    expect(s.day).toBe('Tue');       // slot locked
    expect(s.week).toBe(1);
    expect(s.offsetDays).toBe(1);
    expect(s.type).toBe('LOW');      // content changed
    expect(s.sprint).toBe('z');
  });

  it('offline regen produces a valid full plan and preserves the slot', async () => {
    const r = await regenerateOneSession(raceBase, targetId);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.data.template).toBeUndefined();   // flat, engine-ready
    const s = r.data.sessions.find(x => x.id === targetId);
    expect(s.offsetDays).toBe(1);              // slot intact
    expect(loadPlan(r.data).ok).toBe(true);
  });

  it('rejects an unsafe replacement then succeeds on the re-prompt, feeding issues back', async () => {
    const seen = [];
    // First draft: HIGH the day after a RACE → VG_NO_REST_AFTER_RACE. Then a safe TAPER.
    const generate = (_p, _old, priorIssues) => {
      seen.push(priorIssues);
      return priorIssues ? { type: 'TAPER', sprint: 'easy strides' } : { type: 'HIGH', sprint: 'max' };
    };
    const r = await regenerateOneSession(raceBase, targetId, { generate });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.attempts).toBe(2);
    expect(seen[0]).toBe('');
    expect(seen[1]).toMatch(/VG_NO_REST_AFTER_RACE/);   // the breach was fed back
    expect(r.data.sessions.find(x => x.id === targetId).type).toBe('TAPER');
    // only the target changed
    expect(r.data.sessions.find(x => x.offsetDays === 0).type).toBe('RACE');
  });

  it('returns a clean failure (no plan) when every replacement breaches a neighbour rule', async () => {
    const generate = () => ({ type: 'HIGH', sprint: 'max' });   // always unsafe after a RACE
    const r = await regenerateOneSession(raceBase, targetId, { generate, maxAttempts: 3 });
    expect(r.ok).toBe(false);
    expect(r.data).toBe(null);
    expect(r.swappedSessionId).toBe(targetId);
    expect(r.errors.some(e => e.code === 'VG_NO_REST_AFTER_RACE')).toBe(true);
    // input plan untouched
    expect(raceBase.sessions.find(x => x.id === targetId).type).toBe('RECOVERY');
  });

  it('surfaces a generator throw and an unknown session id', async () => {
    const thrown = await regenerateOneSession(raceBase, targetId, { generate: () => { throw new Error('coach down'); } });
    expect(thrown.ok).toBe(false);
    expect(thrown.errors[0].code).toBe('COACH_GENERATE_FAILED');

    let called = false;
    const missing = await regenerateOneSession(raceBase, 'NOPE', { generate: () => { called = true; return {}; } });
    expect(missing.ok).toBe(false);
    expect(missing.errors[0].code).toBe('REGEN_SESSION_NOT_FOUND');
    expect(missing.attempts).toBe(0);
    expect(called).toBe(false);                 // never calls the model for a missing id
  });

  it('regenerateSessionLocal stays safe next to hard days and is deterministic', () => {
    // Day after a RACE → must become a recovery day.
    const afterRace = regenerateSessionLocal(raceBase, targetId);
    expect(afterRace.sessions.find(x => x.id === targetId).type).toBe('RECOVERY');
    expect(loadPlan(afterRace).ok).toBe(true);
    expect(JSON.stringify(regenerateSessionLocal(raceBase, targetId))).toBe(JSON.stringify(afterRace));

    // Adjacent to a HIGH (not after a race) → picks a non-high type, still valid.
    const adj = loadPlan({ name: 'Adj', startDate: '2026-07-01', sessions: [
      { phase: 'P', week: 1, day: 'Mon', type: 'HIGH', offsetDays: 0, sprint: 'a' },
      { phase: 'P', week: 1, day: 'Tue', type: 'LOW', offsetDays: 1, sprint: 'b' },
    ] }).data;
    const tid = adj.sessions.find(x => x.offsetDays === 1).id;
    const out = regenerateSessionLocal(adj, tid);
    expect(['MOD', 'LOW', 'RECOVERY']).toContain(out.sessions.find(x => x.id === tid).type);
    expect(loadPlan(out).ok).toBe(true);
  });
});
