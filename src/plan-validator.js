/* plan-validator.js — validate + normalize an AI/coach-proposed plan against the
   data contract (plan-schema.js). PURE: no DOM, no IO, no mutation of the input.

   This is the single gate between "model output" and "stored plan". It returns
   structured issues (code + human message + path) so the edge function can
   re-prompt the model precisely, and a NORMALIZED plan (free-form fields dropped,
   stable ids locked, sessions sorted) ready to hand to the existing engine.

   Reference: ../Venture-Planning/ai-coach-design.md §5–6, §11 step 1. */

import {
  KNOWN_TYPES, HIGH_INTENSITY_TYPES, REST_TYPES, RECOVERY_DAY_TYPES, DAYS,
  SESSION_FIELDS, TEMPLATE_FIELDS, REQUIRED_TEMPLATE_FIELDS, PLAN_SOURCES, VOLUME_GUARDS,
} from './plan-schema.js';

const isInt = n => typeof n === 'number' && Number.isInteger(n);
const isNonEmptyStr = s => typeof s === 'string' && s.trim().length > 0;
// A real calendar date in YYYY-MM-DD form — the format the engine's addDays()
// parses. Rejects junk ("next monday") and impossible dates ("2026-02-30").
const isISODate = s => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};
const HI = new Set(HIGH_INTENSITY_TYPES);
const REST = new Set(REST_TYPES);
const RECOVERY_DAY = new Set(RECOVERY_DAY_TYPES);
// Free-text fields validated for type/length/safety (phase/day are checked separately).
const TEXT_FIELDS = ['focus', 'surface', 'sprint', 'gym', 'warmup', 'cooldown'];
// Markup/script markers, plus the double-quote, rejected outright. Kept narrow so
// legitimate text like "RPE <8" still passes: the renderer escapes <, > and & on
// output, so those are safe in element context. A double-quote is NOT escaped by
// the renderer, so a value rendered inside a double-quoted HTML attribute (e.g.
// `aria-label="… ${focus} …"`) could break out and inject an event handler. Since
// < and > are already neutralised on render, blocking the " delimiter is what
// actually closes the attribute-injection vector — not the (now-corrected) earlier
// assumption that render-escaping alone covered it.
const UNSAFE_TEXT = /<\s*\/?\s*(script|img|iframe|svg)\b|javascript:|"/i;

// A session id is interpolated UNescaped into HTML attributes by the renderer
// (e.g. `data-id="${id}"`), so it must be restricted to characters that cannot
// break out of a double-quoted attribute. Matches the seed scheme ("P1-W1-Mon").
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const safeIdChars = s => String(s).replace(/[^A-Za-z0-9._-]/g, '');

/* Derive a stable, human-readable id from a session — e.g. phase "P1 Accel",
   week 1, day "Mon" → "P1-W1-Mon" (matches the seed scheme). Used only when a
   session is missing a usable/unique id; provided valid ids are preserved so the
   contract's "ids are never renumbered or reused" holds across re-validation. */
function deriveId(se, index) {
  // Sanitise the phase/day tokens to the safe charset so a tainted phase
  // (e.g. `P1" onclick="…`) can never carry unsafe chars into the derived id.
  const phaseToken = (isNonEmptyStr(se.phase) ? safeIdChars(se.phase.trim().split(/\s+/)[0]) : '') || 'S';
  const wk = isInt(se.week) ? se.week : index + 1;
  const day = (isNonEmptyStr(se.day) ? safeIdChars(se.day.trim()) : '') || `D${index + 1}`;
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
    // startDate is OPTIONAL by design — the template is date-agnostic and an
    // assignment binds it to a start date (main.js). But if a plan does carry one,
    // it must be a real YYYY-MM-DD date, or addDays() yields Invalid Date on render.
    if (t.startDate != null && !isISODate(t.startDate)) {
      err('TEMPLATE_BAD_START_DATE', 'template.startDate, when present, must be a real calendar date in YYYY-MM-DD form.', 'template.startDate');
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

      // Free-text fields must be strings, length-bounded, and free of markup/script.
      for (const tf of TEXT_FIELDS) {
        const v = se[tf];
        if (v === undefined) continue;
        if (typeof v !== 'string') err('SESSION_FIELD_NOT_STRING', `${path}.${tf} must be a string.`, `${path}.${tf}`);
        else if (v.length > guards.maxTextLength) err('SESSION_TEXT_TOO_LONG', `${path}.${tf} exceeds the ${guards.maxTextLength}-character limit.`, `${path}.${tf}`);
        else if (UNSAFE_TEXT.test(v)) err('SESSION_UNSAFE_TEXT', `${path}.${tf} contains markup, script, or a double-quote that is unsafe to render.`, `${path}.${tf}`);
      }
      // Bound the id length (a provided id is otherwise kept verbatim).
      if (isNonEmptyStr(se.id) && se.id.trim().length > guards.maxIdLength) {
        err('SESSION_ID_TOO_LONG', `${path}.id exceeds the ${guards.maxIdLength}-character limit.`, `${path}.id`);
      }

      // Normalize: allow-listed fields only (drop free-form keys).
      const n = {};
      for (const f of SESSION_FIELDS) if (se[f] !== undefined) n[f] = se[f];

      // Lock id: keep a provided valid + unique id; otherwise derive a stable one.
      let id = isNonEmptyStr(se.id) ? se.id.trim() : '';
      // A provided id with unsafe characters can't ship (it renders unescaped into
      // attributes); drop it and derive a safe one, so the plan stays valid.
      if (id && !SAFE_ID.test(id)) {
        warn('SESSION_ID_UNSAFE', `${path}.id "${id}" has characters unsafe to render; a safe id was derived.`, `${path}.id`);
        id = '';
      }
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

  const highOffsets = valid.filter(s => HI.has(s.type)).map(s => s.offsetDays);

  // Per-calendar-day high-intensity cap (catches several max efforts stacked on one day).
  const perDay = new Map();
  for (const o of highOffsets) perDay.set(o, (perDay.get(o) || 0) + 1);
  for (const [day, count] of perDay) {
    if (count > g.highIntensityPerDayError) err('VG_DAILY_HIGH_CAP', `Day ${day}: ${count} high-intensity (HIGH/RACE) sessions on one calendar day exceeds the cap of ${g.highIntensityPerDayError}.`, `offset:${day}`);
  }

  // Rolling 7-day high-intensity window (catches load spread across fixed-week boundaries).
  const sortedHigh = [...highOffsets].sort((a, b) => a - b);
  let peak = 0, peakAt = 0;
  for (const d of sortedHigh) {
    const c = sortedHigh.filter(o => o >= d && o <= d + 6).length;
    if (c > peak) { peak = c; peakAt = d; }
  }
  if (peak > g.highIntensityRolling7Error) err('VG_ROLLING_HIGH_CAP', `${peak} high-intensity days within a 7-day window (from day ${peakAt}) exceeds the cap of ${g.highIntensityRolling7Error}.`, `offset:${peakAt}`);
  else if (peak > g.highIntensityRolling7Warn) warn('VG_ROLLING_HIGH', `${peak} high-intensity days within a 7-day window (from day ${peakAt}) — confirm this is intended.`, `offset:${peakAt}`);

  // Fixed 7-day buckets, used only for the week-over-week ramp check below.
  const byWindow = new Map();
  for (const s of valid) {
    const w = Math.floor(s.offsetDays / 7);
    byWindow.set(w, (byWindow.get(w) || 0) + (HI.has(s.type) ? 1 : 0));
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

  // Rest after a hard day (ai-coach-design §5 rule 4). Build the day→types index
  // once and apply both rules:
  //   • RACE → the next day must be a recovery day (RECOVERY/DELOAD/TAPER) or empty.
  //     Any other training session there (HIGH/RACE/MOD/LOW) is an error. DELOAD/
  //     TAPER count as recovery here on purpose — the seed follows a race with a
  //     deload (offset 195→196), which is legitimate.
  //   • DELOAD → the next day must not be a hard (HIGH/RACE) day. Looser than the
  //     RACE rule by design: the seed routinely follows a deload with an easy LOW
  //     day (e.g. 14→15), so only a hard day straight after a deload is rejected.
  if (g.enforceRestDayAfterRace || g.enforceRestDayAfterDeload) {
    const byOff = new Map();
    for (const s of valid) { const a = byOff.get(s.offsetDays) || []; a.push(s.type); byOff.set(s.offsetDays, a); }
    for (const s of valid) {
      const next = byOff.get(s.offsetDays + 1) || [];
      if (g.enforceRestDayAfterRace && s.type === 'RACE' && next.some(ty => !RECOVERY_DAY.has(ty))) {
        err('VG_NO_REST_AFTER_RACE', `RACE on day ${s.offsetDays} must be followed by a recovery day (${RECOVERY_DAY_TYPES.join('/')}) or rest; day ${s.offsetDays + 1} has a training session (${next.join(', ')}).`, `offset:${s.offsetDays}`);
      }
      if (g.enforceRestDayAfterDeload && s.type === 'DELOAD' && next.some(ty => HI.has(ty))) {
        err('VG_NO_REST_AFTER_DELOAD', `DELOAD on day ${s.offsetDays} is immediately followed by a hard (${HIGH_INTENSITY_TYPES.join('/')}) day; insert an easier day first.`, `offset:${s.offsetDays}`);
      }
    }
  }
}

/* Bridge the normalized { template, sessions } shape to the FLAT object the
   existing engine renders: main.js reads sessions/startDate/rules/planVersion/
   athleteId/… straight off the plan root (see seed.json + state.data), not under a
   `template` key. Spreads the header fields to the root and keeps sessions. Pass
   the `plan` from a successful validatePlan() result; returns null for a bad/null
   plan. The template stays date-agnostic — startDate is only carried if the plan
   set one; otherwise an assignment supplies it. */
export function toEngineData(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const { template, sessions } = plan;
  return { ...(template || {}), sessions: Array.isArray(sessions) ? sessions : [] };
}

/* Format issues as a compact string to feed back to the model on a retry. */
export function formatIssues(result) {
  const line = (kind, x) => `${kind} ${x.code}${x.path ? ` @ ${x.path}` : ''}: ${x.message}`;
  return [
    ...result.errors.map(e => line('ERROR', e)),
    ...result.warnings.map(w => line('WARN', w)),
  ].join('\n');
}
