/* coach.js — the AI coach: turn an athlete intake into a VALIDATED training plan.

   "AI proposes, the schema disposes." The real brain is Claude, reached through a
   Supabase Edge Function (server-side — the API key must never ship in the client).
   When that function isn't configured (local dev, offline, no key yet) we fall back
   to a deterministic rule-based generator so the whole flow still works end-to-end.

   Either way the candidate plan goes through the SAME gate as every other plan
   (loadPlan → validatePlan), and the generate→validate loop re-prompts the model
   with the structured issues when a draft fails. PURE except for requestCoachPlan,
   which does the network call.

   Reference: MANIFESTO (the moat), plan-schema.js (the contract), plan-validator.js. */

import {
  KNOWN_TYPES, HIGH_INTENSITY_TYPES, DAYS, VOLUME_GUARDS, PLAN_SOURCES,
} from './plan-schema.js';
import { loadPlan, formatIssues } from './plan-validator.js';

// ---- intake ----------------------------------------------------------------

export const SPORTS = ['sprints', 'middle-distance', 'distance', 'team sport', 'general fitness'];
export const EQUIPMENT = ['track', 'gym', 'grass field', 'treadmill', 'minimal'];
const clampInt = (n, lo, hi, dflt) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : dflt;
  return Math.max(lo, Math.min(hi, v));
};
const isISODate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/* Normalize raw form input into a clean intake object. Defensive: clamps numbers,
   drops junk, keeps free-text (which the red-flag gate screens separately). */
export function normalizeIntake(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    sport: SPORTS.includes(r.sport) ? r.sport : 'general fitness',
    goal: typeof r.goal === 'string' ? r.goal.trim().slice(0, 200) : '',
    weeks: clampInt(r.weeks, 1, 16, 8),            // horizon (cap 16 → bounded output)
    daysPerWeek: clampInt(r.daysPerWeek, 1, 6, 3),
    equipment: Array.isArray(r.equipment) ? r.equipment.filter(e => EQUIPMENT.includes(e)) : [],
    startDate: isISODate(r.startDate) ? r.startDate : null,   // caller supplies; UI defaults to today
    notes: typeof r.notes === 'string' ? r.notes.trim().slice(0, 2000) : '',   // free-text (injuries / how you feel)
  };
}

// ---- prompt construction (used by the Edge Function / real model) -----------

/* The system prompt hands Claude the exact data contract so its output validates
   first time. Built from the schema constants so it can never drift from the
   validator. */
export function buildCoachSystemPrompt(guards = VOLUME_GUARDS) {
  return [
    'You are an elite strength-and-sport coach. You design safe, periodised training plans.',
    'You give training guidance only — NOT medical advice. Never diagnose or treat.',
    '',
    'Output a single JSON object: { name, sport, goal, source:"ai", startDate, sessions:[...] }.',
    'Each session: { phase, week, day, type, offsetDays, focus, surface, sprint, gym, warmup, cooldown }.',
    `- type ∈ ${KNOWN_TYPES.join(', ')}.`,
    `- day ∈ ${DAYS.join(', ')}; week ≥ 1; offsetDays = whole days from startDate (0-based).`,
    '- HIGH/MOD/LOW/TAPER need non-empty sprint or gym text. RECOVERY/DELOAD may be empty (rest).',
    '- Use plain text only. No HTML, no double-quotes inside field values.',
    '',
    'Hard safety limits (a plan breaking these is rejected):',
    `- ≤ ${guards.consecutiveHighDaysError} consecutive high-intensity (${HIGH_INTENSITY_TYPES.join('/')}) days; aim for ≤ ${guards.consecutiveHighDaysWarn}.`,
    `- ≤ ${guards.highIntensityRolling7Error} high-intensity days in any rolling 7-day window; aim for ≤ ${guards.highIntensityRolling7Warn}.`,
    '- A RACE day must be followed by a recovery day (RECOVERY/DELOAD/TAPER) or rest.',
    '- A DELOAD day must not be immediately followed by a hard (HIGH/RACE) day.',
  ].join('\n');
}

/* The user message describes the athlete. priorIssues (from a rejected draft) are
   fed back so the model can fix exactly what failed. */
export function buildCoachUserPrompt(intake, priorIssues = '') {
  const i = normalizeIntake(intake);
  const lines = [
    `Sport: ${i.sport}`,
    `Goal: ${i.goal || '(general improvement)'}`,
    `Plan length: ${i.weeks} weeks, ${i.daysPerWeek} sessions/week`,
    `Equipment available: ${i.equipment.length ? i.equipment.join(', ') : 'minimal'}`,
    `Start date: ${i.startDate || '(today)'}`,
  ];
  if (i.notes) lines.push(`Athlete notes: ${i.notes}`);
  if (priorIssues) {
    lines.push('', 'Your previous draft was REJECTED for these reasons — fix them and return a corrected plan:', priorIssues);
  }
  return lines.join('\n');
}

// ---- local fallback generator (deterministic, always valid) ----------------

const SPRINT_TEXT = {
  HIGH: 'Speed: 6×30m @95%, full recovery between reps.',
  MOD: 'Threshold: 5×3min @ controlled hard effort, 90s jog.',
  LOW: 'Tempo: 8×100m @70% on grass, walk back.',
  TAPER: 'Sharpener: 3×30m @90%, long recovery.',
};
// Evenly spread `dpw` training days across Mon–Sun.
const spreadDays = dpw => Array.from({ length: dpw }, (_, i) => Math.min(6, Math.round((i * 7) / dpw)));

/* A simple but SAFE periodised plan: one HIGH day per week (never back-to-back),
   the rest easy, every 4th week a deload. Returns the FLAT engine shape. Good
   enough to render and to keep the flow working without the model. */
export function generatePlanLocal(intake) {
  const i = normalizeIntake(intake);
  const start = i.startDate || '2026-01-01';
  const cols = spreadDays(i.daysPerWeek);
  const wantGym = i.equipment.includes('gym');
  const surface = i.equipment.includes('track') ? 'Track' : i.equipment.includes('grass field') ? 'Grass' : 'Road';
  const sessions = [];
  for (let w = 0; w < i.weeks; w++) {
    const deload = (w + 1) % 4 === 0;
    cols.forEach((dayIdx, n) => {
      const type = deload ? (n === 0 ? 'DELOAD' : 'LOW') : (n === 0 ? 'HIGH' : n === 1 ? 'MOD' : 'LOW');
      const isRest = type === 'DELOAD';
      sessions.push({
        phase: `Block ${Math.floor(w / 4) + 1}`,
        week: w + 1,
        day: DAYS[dayIdx],
        type,
        offsetDays: w * 7 + dayIdx,
        focus: deload ? (n === 0 ? 'Deload' : 'Easy') : (n === 0 ? 'Quality' : 'Aerobic'),
        surface,
        sprint: isRest ? '' : (SPRINT_TEXT[type] || SPRINT_TEXT.LOW),
        gym: !isRest && wantGym && type !== 'LOW' ? 'Squat 3×5, RDL 3×8, core 3 sets.' : '',
        warmup: isRest ? '' : 'Jog 8min, mobility, 4 build-ups.',
        cooldown: isRest ? '' : 'Walk 5min, stretch.',
      });
    });
  }
  return {
    name: `${i.sport} plan${i.goal ? ` — ${i.goal}` : ''}`.slice(0, 80),
    sport: i.sport,
    goal: i.goal || 'General improvement',
    source: 'ai',
    startDate: start,
    sessions,
  };
}

// ---- the generate → validate → re-prompt loop ------------------------------

/* Orchestrate generation against the validator gate. `generate(intake, priorIssues)`
   returns a flat plan (the model or the local generator); `validate` is loadPlan by
   default. On a rejected draft we re-prompt with the structured issues, up to
   maxAttempts. Returns { ok, data, errors, warnings, attempts }. Pure — inject
   generate/validate so it's fully testable. */
export async function generateValidatedPlan(intake, opts = {}) {
  const generate = opts.generate || (i => generatePlanLocal(i));
  const validate = opts.validate || (raw => loadPlan(raw));
  const maxAttempts = opts.maxAttempts || 3;
  let priorIssues = '';
  let last = { ok: false, data: null, errors: [], warnings: [] };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw;
    try {
      raw = await generate(intake, priorIssues);
    } catch (e) {
      last = { ok: false, data: null, errors: [{ code: 'COACH_GENERATE_FAILED', message: e.message || 'Generation failed.', path: '' }], warnings: [] };
      break;
    }
    const res = validate(raw);
    if (res.ok) return { ...res, attempts: attempt };
    last = res;
    priorIssues = formatIssues(res);   // feed the exact failures back into the next draft
  }
  return { ...last, attempts: maxAttempts };
}

// ---- regenerate ONE session ------------------------------------------------
//
// Treat a single-session regen as a WHOLE-plan generation whose draft is the
// current plan with exactly one session replaced in its fixed slot, then drive
// the SAME generateValidatedPlan loop with the default loadPlan validate — so the
// entire swapped plan re-passes every neighbour-spanning guard (consecutive-high,
// rolling-7, rest-after-RACE/DELOAD). No safety rule is duplicated.

/* Replace one session by id, FORCING the slot (id/offsetDays/day/week/phase) back
   to the original so the calendar position and the log key can never move — only
   type/focus/surface/sprint/gym/warmup/cooldown can change. Returns a flat plan. */
export function swapSessionById(plan, sessionId, patch) {
  const sessions = (plan.sessions || []).map(s => {
    if (s.id !== sessionId) return s;
    return { ...s, ...patch, id: s.id, offsetDays: s.offsetDays, day: s.day, week: s.week, phase: s.phase };
  });
  return { ...plan, sessions };
}

// Downgrade-biased alternatives (a "regenerate" usually means "this doesn't fit");
// all three are non-high-intensity so they can't trip the high-load guards.
const SAFE_TYPE_LADDER = ['MOD', 'LOW', 'RECOVERY'];

/* Deterministic offline replacement for one session, safe by construction: it
   reads the neighbour the day before and never produces a type that would breach a
   rest rule (only RECOVERY/DELOAD/TAPER may follow a RACE). Returns a flat plan. */
export function regenerateSessionLocal(plan, sessionId, feedback = '') {
  const old = (plan.sessions || []).find(s => s.id === sessionId);
  if (!old) return plan;
  const prevTypes = (plan.sessions || []).filter(s => s.offsetDays === old.offsetDays - 1).map(s => s.type);
  let candidates = SAFE_TYPE_LADDER.filter(t => t !== old.type);
  if (prevTypes.includes('RACE')) candidates = ['RECOVERY'];   // day after a race must be recovery
  const type = candidates[0] || 'RECOVERY';
  const isRest = type === 'RECOVERY';
  return swapSessionById(plan, sessionId, {
    type,
    focus: isRest ? 'Recovery' : 'Reworked',
    sprint: isRest ? '' : (SPRINT_TEXT[type] || SPRINT_TEXT.LOW),
    gym: '',
  });
}

/* regenerateOneSession(plan, sessionId, opts?) -> { ok, data, errors, warnings, attempts, swappedSessionId }
   opts.generate(plan, oldSession, priorIssues) returns either a full plan or a single
   replacement session (the live model path); omit it to use the local generator. The
   draft is always funnelled back to the FULL plan with the slot re-pinned, so loadPlan
   re-validates everything. On not-found / persistent breach / generator throw it
   returns ok:false and the caller installs nothing. */
export async function regenerateOneSession(plan, sessionId, opts = {}) {
  const old = (plan.sessions || []).find(s => s.id === sessionId);
  if (!old) {
    return { ok: false, data: null, errors: [{ code: 'REGEN_SESSION_NOT_FOUND', message: `No session with id "${sessionId}".`, path: '' }], warnings: [], attempts: 0, swappedSessionId: sessionId };
  }
  const generateFull = async (p, priorIssues) => {
    const draft = opts.generate ? await opts.generate(p, old, priorIssues) : regenerateSessionLocal(p, sessionId, opts.feedback);
    // A full-plan draft → re-pin the slot; a single-session draft → swap it into the plan.
    return (draft && Array.isArray(draft.sessions)) ? swapSessionById(draft, sessionId, {}) : swapSessionById(p, sessionId, draft || {});
  };
  const res = await generateValidatedPlan(plan, { generate: generateFull, validate: opts.validate, maxAttempts: opts.maxAttempts || 3 });
  return { ...res, swappedSessionId: sessionId };
}

// ---- the network seam to the Edge Function ---------------------------------

/* Resolve the coach endpoint from the Supabase env (same project as auth/sync).
   Returns null when unconfigured → caller uses the local generator. */
export function coachEndpoint(env = (import.meta && import.meta.env) || {}) {
  const url = env.VITE_SUPABASE_URL;
  if (!url || /PASTE_/.test(url)) return null;
  return `${url.replace(/\/$/, '')}/functions/v1/coach`;
}
export const coachConfigured = (env) => !!coachEndpoint(env);

/* Call the Edge Function (Claude). Returns a FLAT plan to be validated by the
   caller's loop. Throws on network/HTTP error so the loop can surface it. */
export async function requestCoachPlan(intake, priorIssues = '', opts = {}) {
  const env = opts.env || (import.meta && import.meta.env) || {};
  const endpoint = opts.endpoint || coachEndpoint(env);
  if (!endpoint) throw new Error('Coach endpoint not configured.');
  const fetchImpl = opts.fetch || fetch;
  const anon = env.VITE_SUPABASE_ANON_KEY;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(anon ? { apikey: anon, authorization: `Bearer ${opts.token || anon}` } : {}),
    },
    body: JSON.stringify({ intake: normalizeIntake(intake), priorIssues }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (e) { /* ignore */ }
    throw new Error(`Coach request failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const body = await res.json();
  if (!body || !body.plan) throw new Error('Coach returned no plan.');
  return body.plan;
}

/* Ask the Edge Function for ONE replacement session (mode:'regen'). Returns the
   single session object; used as regenerateOneSession's opts.generate on the live
   path. Throws on network/HTTP error so the loop can surface it. */
export async function requestRegenSession(plan, sessionId, feedback = '', priorIssues = '', opts = {}) {
  const env = opts.env || (import.meta && import.meta.env) || {};
  const endpoint = opts.endpoint || coachEndpoint(env);
  if (!endpoint) throw new Error('Coach endpoint not configured.');
  const fetchImpl = opts.fetch || fetch;
  const anon = env.VITE_SUPABASE_ANON_KEY;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(anon ? { apikey: anon, authorization: `Bearer ${opts.token || anon}` } : {}),
    },
    body: JSON.stringify({ mode: 'regen', plan, sessionId, feedback, priorIssues }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (e) { /* ignore */ }
    throw new Error(`Coach request failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const body = await res.json();
  if (!body || !body.session) throw new Error('Coach returned no session.');
  return body.session;
}
