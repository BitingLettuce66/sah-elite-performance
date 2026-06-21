/* plan-schema.js — the AI-coach plan DATA CONTRACT (pure, no IO).

   Single source of truth for what a valid plan looks like: the same shape the
   existing engine already renders (`public/data/seed.json`), expressed as a
   reusable template + sessions. "AI proposes, the schema disposes" — the
   validator (plan-validator.js) enforces every rule here, so a hallucinated or
   over-aggressive plan is rejected, never rendered.

   Works unchanged in the browser, in a Supabase Edge Function (Deno), and under
   Vitest — no DOM, no Node/Deno-specific APIs.

   Reference: ../Venture-Planning/ai-coach-design.md §5 (contract) + §6 (safety),
   App-Spec.md §10 (architecture guardrails). */

// Session intensity/type tags the engine knows. 'MOD' is part of the AI contract
// (ai-coach-design §5); the current pill renderer (format.js) styles unknown
// types as LOW, so a MOD session renders as a LOW pill until a MOD pill style is
// added — a tracked one-line follow-up, not a blocker (it still renders fine).
export const KNOWN_TYPES = ['HIGH', 'MOD', 'LOW', 'DELOAD', 'TAPER', 'RECOVERY', 'RACE'];

// The high-CNS days the volume guards police.
export const HIGH_INTENSITY_TYPES = ['HIGH', 'RACE'];

// Types for which prescription text (sprint/gym) may legitimately be empty —
// it's a rest day, the card renders a "Rest" callout.
export const REST_TYPES = ['RECOVERY'];

// Types that count as adequate recovery the day AFTER a hard (RACE) day — a true
// rest day (RECOVERY), or a deliberately reduced-load day (DELOAD/TAPER). Wider
// than REST_TYPES on purpose: the real coach seed plan follows a RACE with a
// DELOAD (offset 195→196), so a DELOAD/TAPER the day after a race is legitimate
// recovery, not a violation. Used only by the rest-after-RACE volume guard.
export const RECOVERY_DAY_TYPES = ['RECOVERY', 'DELOAD', 'TAPER'];

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Allow-listed session fields — anything else the model emits is DROPPED
// (contract rule: "no free-form fields beyond the schema").
export const SESSION_FIELDS = ['id', 'phase', 'week', 'day', 'type', 'focus', 'surface', 'sprint', 'gym', 'warmup', 'cooldown', 'offsetDays'];

// Allow-listed template (plan header) fields, and the minimum required.
export const TEMPLATE_FIELDS = ['templateId', 'name', 'sport', 'goal', 'source', 'planVersion', 'rules', 'warmup', 'cooldown', 'phases', 'startDate', 'athleteId', 'planId'];
export const REQUIRED_TEMPLATE_FIELDS = ['name'];
export const PLAN_SOURCES = ['ai', 'coach', 'imported'];

/* Numeric volume backstops — a hard limit on an over-aggressive plan regardless
   of what the model proposes. Thresholds are calibrated against the real,
   coach-built seed plan (max 4 high-intensity days in any 7-day window, never
   two high days back-to-back, every RACE followed by a recovery day, no hard day
   straight after a DELOAD) so a legitimate plan passes cleanly while reckless
   ones are caught. All tunable per call via
   validatePlan(plan, { guards: {...} }). */
export const VOLUME_GUARDS = {
  highIntensityPerWeekWarn: 4,    // > this in a 7-day window → warning
  highIntensityPerWeekError: 6,   // > this → error (reject)
  consecutiveHighDaysWarn: 2,     // > this many back-to-back high days → warning
  consecutiveHighDaysError: 3,    // > this → error
  rampWeekOverWeekWarn: 2,        // high-day jump vs a non-trivial prior week → warning
  enforceRestDayAfterRace: true,  // the day after a RACE must be a recovery day (RECOVERY/DELOAD/TAPER) or empty → error on any other training session
  enforceRestDayAfterDeload: true,// a DELOAD may not be immediately followed by a hard (HIGH/RACE) day → error
  minSessions: 1,
  maxOffsetDays: 730,             // ~2 years — sanity ceiling on offsetDays
};
