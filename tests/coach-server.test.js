import { describe, it, expect } from 'vitest';
import { handleCoach, handleRegenSession } from '../supabase/functions/coach/handler.js';
import { loadPlan } from '../src/plan-validator.js';

// Mocked Claude outputs — NO real API, no key, no network.
const SAFE_PLAN = {
  name: 'Safe plan', startDate: '2026-07-01', source: 'ai',
  sessions: [
    { phase: 'P', week: 1, day: 'Mon', type: 'HIGH', offsetDays: 0, sprint: '6x30m' },
    { phase: 'P', week: 1, day: 'Wed', type: 'LOW', offsetDays: 2, sprint: '8x100m' },
    { phase: 'P', week: 1, day: 'Fri', type: 'RECOVERY', offsetDays: 4 },
  ],
};
// 7 consecutive HIGH days — breaches both the consecutive-day and rolling-7 caps.
const OVER_CAP_PLAN = {
  name: 'Reckless plan', startDate: '2026-07-01',
  sessions: [0, 1, 2, 3, 4, 5, 6].map(o => ({
    phase: 'P', week: 1, day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][o],
    type: 'HIGH', offsetDays: o, sprint: 'max effort',
  })),
};

const intake = { sport: 'sprints', goal: 'speed', weeks: 4, daysPerWeek: 3, startDate: '2026-07-01', notes: '' };

describe('coach edge function — server-side safety re-check', () => {
  it('blocks generation on a red-flag intake (no model call)', async () => {
    let called = false;
    const callClaude = () => { called = true; return SAFE_PLAN; };
    const r = await handleCoach({ intake: { ...intake, notes: 'sharp chest pain and shortness of breath' }, callClaude });
    expect(called).toBe(false);                 // never reached the model
    expect(r.status).toBe(422);
    expect(r.body.redFlag).toBe(true);
    expect(r.body.error).toMatch(/professional|doctor/i);
  });

  it('returns a validated plan on the happy path', async () => {
    const r = await handleCoach({ intake, callClaude: () => SAFE_PLAN });
    expect(r.status).toBe(200);
    expect(r.body.plan).toBeTruthy();
    expect(r.body.plan.template).toBeUndefined();   // flat, engine-ready
    expect(r.body.plan.sessions.length).toBe(3);
  });

  it('catches an OVER-THE-CAPS plan and the re-prompt loop fixes it', async () => {
    let calls = 0;
    // First draft breaches the caps; once the server feeds the issues back, return safe.
    const callClaude = (_i, priorIssues) => { calls++; return priorIssues ? SAFE_PLAN : OVER_CAP_PLAN; };
    const r = await handleCoach({ intake, callClaude });
    expect(calls).toBe(2);                        // the re-prompt fired
    expect(r.status).toBe(200);
    expect(r.body.plan.sessions.length).toBe(3);
  });

  it('feeds the validator issues back into the re-prompt', async () => {
    const seen = [];
    const callClaude = (_i, priorIssues) => { seen.push(priorIssues); return priorIssues ? SAFE_PLAN : OVER_CAP_PLAN; };
    await handleCoach({ intake, callClaude });
    expect(seen[0]).toBe('');                                          // first attempt has no issues
    expect(seen[1]).toMatch(/VG_CONSECUTIVE_HIGH|VG_ROLLING_HIGH_CAP/); // retry carries the breach
  });

  it('returns a clean error (never an unsafe plan) when every draft breaches the caps', async () => {
    let calls = 0;
    const callClaude = () => { calls++; return OVER_CAP_PLAN; };
    const r = await handleCoach({ intake, callClaude, maxAttempts: 3 });
    expect(calls).toBe(3);                        // tried up to the limit
    expect(r.status).toBe(422);
    expect(r.body.plan).toBeUndefined();          // no unsafe plan leaked
    expect(r.body.issues.join(' ')).toMatch(/7-day window|consecutive/);
    expect(r.body.attempts).toBe(3);
  });

  it('surfaces an upstream/model failure as 502', async () => {
    const callClaude = () => { throw new Error('Anthropic error 529: overloaded'); };
    const r = await handleCoach({ intake, callClaude });
    expect(r.status).toBe(502);
    expect(r.body.plan).toBeUndefined();
    expect(r.body.error).toMatch(/overloaded|unavailable/i);
  });
});

describe('coach edge function — single-session regen (handleRegenSession)', () => {
  // Validated base with ids: RACE at offset 0, target RECOVERY at offset 1.
  const base = loadPlan({
    name: 'Race base', startDate: '2026-07-01',
    sessions: [
      { phase: 'P', week: 1, day: 'Mon', type: 'RACE', offsetDays: 0, sprint: 'Race 100m' },
      { phase: 'P', week: 1, day: 'Tue', type: 'RECOVERY', offsetDays: 1 },
    ],
  }).data;
  const targetId = base.sessions[1].id;

  it('returns a validated swapped plan on a safe replacement', async () => {
    const callClaudeSession = () => ({ type: 'TAPER', sprint: 'easy strides' });   // valid after a RACE
    const r = await handleRegenSession({ plan: base, sessionId: targetId, feedback: '', callClaudeSession });
    expect(r.status).toBe(200);
    expect(loadPlan(r.body.plan).ok).toBe(true);
    expect(r.body.plan.sessions.find(s => s.id === targetId).type).toBe('TAPER');
    expect(r.body.plan.sessions.find(s => s.offsetDays === 0).type).toBe('RACE');   // only target changed
  });

  it('returns 422 with no plan when every replacement breaches a neighbour rule', async () => {
    const callClaudeSession = () => ({ type: 'HIGH', sprint: 'max' });   // HIGH after a RACE → always rejected
    const r = await handleRegenSession({ plan: base, sessionId: targetId, feedback: '', callClaudeSession, maxAttempts: 3 });
    expect(r.status).toBe(422);
    expect(r.body.plan).toBeUndefined();
    expect(r.body.issues.join(' ')).toMatch(/recovery day|VG_NO_REST_AFTER_RACE|RACE/i);
  });

  it('blocks regen on red-flag feedback (no model call)', async () => {
    let called = 0;
    const callClaudeSession = () => { called++; return { type: 'LOW', sprint: 'x' }; };
    const r = await handleRegenSession({ plan: base, sessionId: targetId, feedback: 'sharp chest pain when I run', callClaudeSession });
    expect(called).toBe(0);
    expect(r.status).toBe(422);
    expect(r.body.redFlag).toBe(true);
  });

  it('surfaces an upstream failure as 502', async () => {
    const callClaudeSession = () => { throw new Error('Anthropic error 529: overloaded'); };
    const r = await handleRegenSession({ plan: base, sessionId: targetId, feedback: '', callClaudeSession });
    expect(r.status).toBe(502);
    expect(r.body.plan).toBeUndefined();
  });
});
