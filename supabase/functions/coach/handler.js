/* handler.js — the coach Edge Function's pure core (no Deno, no IO, no key).

   Runs the SAME safety modules the app already uses — the red-flag classifier
   (red-flags.js) and the plan validator + re-prompt loop (coach.js → plan-
   validator.js) — on the SERVER, after Claude drafts a plan. So an unsafe or
   over-aggressive plan can never reach the client, even if the client-side gate
   was bypassed. No rules are duplicated here; we import the one source of truth.

   index.ts injects the real Claude caller; tests inject a mock. Keeping this pure
   is what lets the server safety net be unit-tested fully offline. */

import { normalizeIntake, generateValidatedPlan } from '../../../src/coach.js';
import { scanRedFlags } from '../../../src/red-flags.js';

export const COACH_MAX_ATTEMPTS = 3;

/* handleCoach({ intake, callClaude, maxAttempts }) -> { status, body }

   - callClaude(intake, priorIssues) returns a FLAT plan (the real model, or a mock).
     priorIssues is the validator's feedback from a rejected draft, fed back so the
     model can fix exactly what failed.
   - 422 + advice if the intake trips a red flag — NO model call is made.
   - Otherwise runs the existing generate→validate→re-prompt loop server-side and
     returns 200 {plan} only when a draft passes the validator; if every attempt
     breaches the caps, returns 422 {error} — never an unsafe plan. A generation/
     upstream failure surfaces as 502. */
export async function handleCoach({ intake, callClaude, maxAttempts = COACH_MAX_ATTEMPTS }) {
  const clean = normalizeIntake(intake);

  // 1) Server-side red-flag re-check — fires regardless of the client.
  const flags = scanRedFlags(clean.notes);
  if (flags.flagged) {
    return { status: 422, body: { error: flags.advice, redFlag: true, categories: flags.categories } };
  }

  // 2) Server-side validate + re-prompt loop, reusing the app's pure validator.
  const res = await generateValidatedPlan(clean, {
    generate: (i, priorIssues) => callClaude(i, priorIssues),
    maxAttempts,
  });
  if (res.ok) return { status: 200, body: { plan: res.data } };

  // Distinguish "model/upstream failed" (502) from "draft kept breaching caps" (422).
  const upstreamFailed = (res.errors || []).some(e => e.code === 'COACH_GENERATE_FAILED');
  return {
    status: upstreamFailed ? 502 : 422,
    body: {
      error: upstreamFailed
        ? ((res.errors[0] && res.errors[0].message) || 'The coach is unavailable right now.')
        : 'The coach could not produce a plan within the safety limits. Try adjusting your goal or sessions per week.',
      issues: (res.errors || []).map(e => e.message),
      attempts: res.attempts,
    },
  };
}
