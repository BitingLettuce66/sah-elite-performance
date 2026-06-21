import { describe, it, expect } from 'vitest';
import {
  normalizeIntake, generatePlanLocal, generateValidatedPlan,
  buildCoachSystemPrompt, buildCoachUserPrompt,
  coachEndpoint, coachConfigured, requestCoachPlan,
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
