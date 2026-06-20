/* plan-validator.js — validate + normalize an AI/coach-proposed plan against the
   data contract (plan-schema.js). PURE: no DOM, no IO, no mutation of the input.

   This is the single gate between "model output" and "stored plan". It returns
   structured issues (code + human message + path) so the edge function can
   re-prompt the model precisely, and a NORMALIZED plan (free-form fields dropped,
   stable ids locked, sessions sorted) ready to hand to the existing engine.

   Reference: ../Venture-Planning/ai-coach-design.md §5–6, §11 step 1. */

import {
  KNOWN_TYPES, HIGH_INTENSITY_TYPES, REST_TYPES, DAYS,
  SESSION_FIELDS, TEMPLATE_FIELDS, REQUIRED_TEMPLATE_FIELDS, PLAN_SOURCES, VOLUME_GUARDS,
} from './plan-schema.js';

const isInt = n => typeof n === 'number' && Number.isInteger(n);
const isNonEmptyStr = s => typeof s === 'string' && s.trim().length > 0;
const HI = new Set(HIGH_INTENSITY_TYPES);
const REST = new Set(REST_TYPES);

/* Derive a stable, human-readable id from a session — e.g. phase "P1 Accel",
   week 1, day "Mon" → "P1-W1-Mon" (matches the seed scheme). Used only when a
   session is missing a usable/unique id; provided valid ids are preserved so the
   contract's "ids are never renumbered or reused" holds across re-validation. */
function deriveId(se, index) {
  const phaseToken = isNonEmptyStr(se.phase) ? se.phase.trim().split(/\s+/)[0] : 'S';
  const wk = isInt(se.week) ? se.week : index + 1;
  const day = isNonEmptyStr(se.day) ? se.day.trim() : `D${index + 1}`;
  return `${phaseToken}-W${wk}-${day}`;
}

/* validatePlan(input, opts?) -> { ok, plan, errors, warnings }
   - ok: true only when there are zero errors (warnings are allowed).
   - plan: the normalized plan when ok, else null (never hand back a dubious plan).
   - errors / warnings: arrays of { code, message, path }. */
export function validatePlan(input, opts = {}) {
  const guards = { ...VOLUME_GUARDS, ...(opts.guards || {}) };
  const errors = [];
  const warnings = [];
  const err = (code, message, path) => errors.push({ code, message, path });
  const warn = (code, message, path) => warnings.push({ code, message, path });

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, plan: null, errors: [{ code: 'PLAN_NOT_OBJECT', message: 'Plan must be an object { template, sessions }.', path: '' }], warnings };
  }

  // ---- template (plan header) ----
  const t = input.template;
  let normTemplate = null;
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    err('TEMPLATE_MISSING', 'plan.template is missing or not an object.', 'template');
  } else {
    for (const f of REQUIRED_TEMPLATE_FIELDS) {
      if (!isNonEmptyStr(t[f])) err('TEMPLATE_FIELD_REQUIRED', `template.${f} is required (non-empty string).`, `template.${f}`);
    }
    if (t.source != null && !PLAN_SOURCES.includes(t.source)) {
      err('TEMPLATE_BAD_SOURCE', `template.source must be one of: ${PLAN_SOURCES.join(', ')}.`, 'template.source');
    }
    if (t.planVersion != null && !(isInt(t.planVersion) && t.planVersion >= 1)) {
      err('TEMPLATE_BAD_VERSION', 'template.planVersion must be an integer ≥ 1.', 'template.planVersion');
    }
    // Normalize: copy allow-listed fields only, lock sensible defaults.
    normTemplate = {};
    for (const f of TEMPLATE_FIELDS) if (t[f] !== undefined) normTemplate[f] = t[f];
    normTemplate.source = PLAN_SOURCES.includes(t.source) ? t.source : 'ai';
    normTemplate.planVersion = isInt(t.planVersion) && t.planVersion >= 1 ? t.planVersion : 1;
  }

  // ---- sessions ----
  const sin = input.sessions;
  const normSessions = [];
  if (!Array.isArray(sin)) {
    err('SESSIONS_NOT_ARRAY', 'plan.sessions must be an array.', 'sessions');
  } else {
    if (sin.length < guards.minSessions) err('SESSIONS_EMPTY', `Plan must have at least ${guards.minSessions} session(s).`, 'sessions');
    const seenIds = new Set();
    sin.forEach((se, i) => {
      const path = `sessions[${i}]`;
      if (!se || typeof se !== 'object' || Array.isArray(se)) { err('SESSION_NOT_OBJECT', 'Session must be an object.', path); return; }

      if (!isInt(se.offsetDays) || se.offsetDays < 0) err('SESSION_BAD_OFFSET', `${path}.offsetDays must be an integer ≥ 0.`, `${path}.offsetDays`);
      else if (se.offsetDays > guards.maxOffsetDays) err('SESSION_OFFSET_TOO_LARGE', `${path}.offsetDays exceeds the ${guards.maxOffsetDays}-day ceiling.`, `${path}.offsetDays`);

      if (!KNOWN_TYPES.includes(se.type)) err('SESSION_BAD_TYPE', `${path}.type must be one of: ${KNOWN_TYPES.join(', ')}.`, `${path}.type`);
      if (!isNonEmptyStr(se.phase)) err('SESSION_MISSING_PHASE', `${path}.phase is required.`, `${path}.phase`);
      if (!(isInt(se.week) && se.week >= 1)) err('SESSION_BAD_WEEK', `${path}.week must be an integer ≥ 1.`, `${path}.week`);
      if (!DAYS.includes(se.day)) err('SESSION_BAD_DAY', `${path}.day must be one of: ${DAYS.join(', ')}.`, `${path}.day`);

      // Prescription text is required for non-rest sessions.
      if (!REST.has(se.type) && !(isNonEmptyStr(se.sprint) || isNonEmptyStr(se.gym))) {
        err('SESSION_NO_PRESCRIPTION', `${path} (${se.type}) needs non-empty sprint or gym text.`, path);
      }

      // Normalize: allow-listed fields only (drop free-form keys).
      const n = {};
      for (const f of SESSION_FIELDS) if (se[f] !== undefined) n[f] = se[f];

      // Lock id: keep a provided valid + unique id; otherwise derive a stable one.
      let id = isNonEmptyStr(se.id) ? se.id.trim() : '';
      if (!id || seenIds.has(id)) {
        const base = deriveId(se, i);
        let candidate = base, k = 2;
        while (seenIds.has(candidate)) candidate = `${base}-${k++}`;
        if (id && seenIds.has(id)) warn('SESSION_DUP_ID', `${path}.id "${id}" is duplicated; reassigned "${candidate}".`, `${path}.id`);
        id = candidate;
      }
      seenIds.add(id);
      n.id = id;
      normSessions.push(n);
    });
  }

  // ---- volume guards (defensive: only the structurally-valid sessions) ----
  if (normSessions.length) runVolumeGuards(normSessions, guards, err, warn);

  const ok = errors.length === 0;
  const plan = ok
    ? { template: normTemplate, sessions: normSessions.slice().sort((a, b) => a.offsetDays - b.offsetDays) }
    : null;
  return { ok, plan, errors, warnings };
}

/* The numeric backstops. Computed over 7-day windows keyed by offsetDays, so it
   is independent of however phase/week are labelled. */
function runVolumeGuards(sessions, g, err, warn) {
  const valid = sessions.filter(s => Number.isInteger(s.offsetDays) && s.offsetDays >= 0 && KNOWN_TYPES.includes(s.type));

  // Weekly high-intensity load (7-day windows).
  const byWindow = new Map();
  for (const s of valid) {
    const w = Math.floor(s.offsetDays / 7);
    byWindow.set(w, (byWindow.get(w) || 0) + (HI.has(s.type) ? 1 : 0));
  }
  for (const [w, count] of byWindow) {
    if (count > g.highIntensityPerWeekError) err('VG_WEEKLY_HIGH_CAP', `Week ${w + 1}: ${count} high-intensity (HIGH/RACE) days exceeds the hard cap of ${g.highIntensityPerWeekError}.`, `week:${w}`);
    else if (count > g.highIntensityPerWeekWarn) warn('VG_WEEKLY_HIGH', `Week ${w + 1}: ${count} high-intensity days (> ${g.highIntensityPerWeekWarn}) — confirm this is intended.`, `week:${w}`);
  }

  // Ramp: a jump vs a non-trivial prior week (ignores returning from a 0/deload week).
  const windows = [...byWindow.keys()].sort((a, b) => a - b);
  for (let i = 1; i < windows.length; i++) {
    const prev = byWindow.get(windows[i - 1]) || 0;
    const cur = byWindow.get(windows[i]) || 0;
    if (prev >= 1 && cur - prev > g.rampWeekOverWeekWarn) {
      warn('VG_RAMP', `High-intensity jump week ${windows[i - 1] + 1}→${windows[i] + 1}: ${prev}→${cur} (> +${g.rampWeekOverWeekWarn}).`, `week:${windows[i]}`);
    }
  }

  // Consecutive high-intensity calendar days.
  const highDays = [...new Set(valid.filter(s => HI.has(s.type)).map(s => s.offsetDays))].sort((a, b) => a - b);
  let run = 0, maxRun = 0, prevOff = null;
  for (const off of highDays) {
    run = prevOff !== null && off === prevOff + 1 ? run + 1 : 1;
    if (run > maxRun) maxRun = run;
    prevOff = off;
  }
  if (maxRun > g.consecutiveHighDaysError) err('VG_CONSECUTIVE_HIGH', `${maxRun} consecutive high-intensity days exceeds the hard cap of ${g.consecutiveHighDaysError}.`, 'sessions');
  else if (maxRun > g.consecutiveHighDaysWarn) warn('VG_CONSECUTIVE_HIGH', `${maxRun} consecutive high-intensity days (> ${g.consecutiveHighDaysWarn}) — confirm recovery is adequate.`, 'sessions');

  // A RACE must be followed by a recovery day, not another high day.
  if (g.enforceRestDayAfterRace) {
    const byOff = new Map();
    for (const s of valid) { const a = byOff.get(s.offsetDays) || []; a.push(s.type); byOff.set(s.offsetDays, a); }
    for (const s of valid) {
      if (s.type === 'RACE' && (byOff.get(s.offsetDays + 1) || []).some(ty => HI.has(ty))) {
        err('VG_NO_REST_AFTER_RACE', `RACE on day ${s.offsetDays} is immediately followed by a high-intensity day; insert a recovery day.`, `offset:${s.offsetDays}`);
      }
    }
  }
}

/* Format issues as a compact string to feed back to the model on a retry. */
export function formatIssues(result) {
  const line = (kind, x) => `${kind} ${x.code}${x.path ? ` @ ${x.path}` : ''}: ${x.message}`;
  return [
    ...result.errors.map(e => line('ERROR', e)),
    ...result.warnings.map(w => line('WARN', w)),
  ].join('\n');
}
