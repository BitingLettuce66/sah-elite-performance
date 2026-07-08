// supabase/functions/coach/index.ts — the AI coach's brain (server-side).
//
// Calls Claude (claude-opus-4-8) to draft a training plan, then re-runs the app's
// OWN safety modules on the result before returning it — so an unsafe plan never
// reaches the client (handler.js). Runs server-side ONLY because the Anthropic key
// must never reach the browser (same rule as the Supabase service key).
//
// Reuses the app's pure modules across the repo (no rule duplication): the prompt
// builders + re-prompt loop from src/coach.js, the validator (via that loop), and
// the red-flag classifier from src/red-flags.js. The Supabase bundler follows
// these relative imports — they ship in the deployed function.
//
// Deploy:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase functions deploy coach
// Invoked by the PWA at: ${VITE_SUPABASE_URL}/functions/v1/coach

import { buildCoachSystemPrompt, buildCoachUserPrompt } from '../../../src/coach.js';
import { KNOWN_TYPES, DAYS } from '../../../src/plan-schema.js';
import { handleCoach, handleRegenSession } from './handler.js';
import { readAnthropicSSE, decodeStream } from './sse.js';

const MODEL = 'claude-opus-4-8';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

// Structured-output schemas (API-call shape). Type/day enums reuse the contract
// constants; the client + server validators enforce the numeric guards + dates.
const SESSION_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['week', 'day', 'type', 'offsetDays'],
  properties: {
    phase: { type: 'string' },
    week: { type: 'integer' },
    day: { type: 'string', enum: DAYS },
    type: { type: 'string', enum: KNOWN_TYPES },
    offsetDays: { type: 'integer' },
    focus: { type: 'string' },
    surface: { type: 'string' },
    sprint: { type: 'string' },
    gym: { type: 'string' },
    warmup: { type: 'string' },
    cooldown: { type: 'string' },
  },
};
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'startDate', 'sessions'],
  properties: {
    name: { type: 'string' },
    sport: { type: 'string' },
    goal: { type: 'string' },
    source: { type: 'string', enum: ['ai'] },
    startDate: { type: 'string', description: 'YYYY-MM-DD' },
    sessions: { type: 'array', items: SESSION_ITEM_SCHEMA },
  },
};
// One replacement session (regen mode) — same shape, plus its locked id.
const SESSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'week', 'day', 'type', 'offsetDays'],
  properties: { id: { type: 'string' }, ...SESSION_ITEM_SCHEMA.properties },
};

// Shared streaming call → the model's text. STREAMS so a long output can't truncate
// or hit an HTTP timeout. Throws on HTTP error / refusal / truncation / stream error
// so the handler's loop records a generation failure.
async function streamClaude(apiKey: string, body: Record<string, unknown>) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: true, thinking: { type: 'adaptive' }, ...body }),
  });
  if (!resp.ok) throw new Error(`Anthropic error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  if (!resp.body) throw new Error('Anthropic returned an empty stream.');
  const { text, stopReason, error } = await readAnthropicSSE(decodeStream(resp.body));
  if (error) throw new Error(`Anthropic stream error: ${error}`);
  if (stopReason === 'refusal') throw new Error('The coach declined this request.');
  if (stopReason === 'max_tokens') throw new Error('The response was too long to finish — try fewer weeks/sessions or simpler feedback.');
  return text;
}

// Full-plan generation (coach mode). 64K headroom for long plans; streaming makes it safe.
function makeCallClaude(apiKey: string) {
  return async (intake: Record<string, unknown>, priorIssues: string) =>
    JSON.parse(await streamClaude(apiKey, {
      max_tokens: 64000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
      system: buildCoachSystemPrompt(),
      messages: [{ role: 'user', content: buildCoachUserPrompt(intake, priorIssues) }],
    }));
}

// One replacement session (regen mode): the model gets the whole plan as context and
// the target's fixed slot, and returns ONE session. The slot is re-pinned + the whole
// plan re-validated server-side, so this prompt is guidance, not the gate.
function makeCallClaudeSession(apiKey: string) {
  return async (plan: { sessions?: Array<Record<string, unknown>>; name?: string; sport?: string; startDate?: string }, sessionId: string, feedback: string, priorIssues: string) => {
    const target = (plan.sessions || []).find(s => s.id === sessionId) || {};
    const content = [
      "The athlete's current full plan (JSON):",
      JSON.stringify({ name: plan.name, sport: plan.sport, startDate: plan.startDate, sessions: plan.sessions }),
      '',
      `Replace ONLY the session with id "${sessionId}" (day ${target.day}, week ${target.week}, offsetDays ${target.offsetDays}). Keep its slot exactly — same id, day, week, offsetDays, phase. Choose a type/prescription that fits the surrounding sessions and respects every safety limit.`,
      feedback ? `Athlete feedback: ${feedback}` : '',
      priorIssues ? `Your previous replacement was REJECTED — fix these and try again:\n${priorIssues}` : '',
      'Return ONLY the single replacement session as JSON.',
    ].filter(Boolean).join('\n');
    return JSON.parse(await streamClaude(apiKey, {
      max_tokens: 4000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SESSION_SCHEMA } },
      system: buildCoachSystemPrompt(),
      messages: [{ role: 'user', content }],
    }));
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'Coach is not configured (missing ANTHROPIC_API_KEY).' }, 503);

  let payload: Record<string, unknown> = {};
  try {
    payload = (await req.json()) ?? {};
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  // The handlers run the red-flag re-check + validate/re-prompt loop; the model call
  // is injected so the safety logic is identical to what the offline tests exercise.
  if (payload.mode === 'regen') {
    const { status, body } = await handleRegenSession({
      plan: payload.plan as Record<string, unknown>,
      sessionId: payload.sessionId as string,
      feedback: (payload.feedback as string) || '',
      callClaudeSession: makeCallClaudeSession(apiKey),
    });
    return json(body, status);
  }

  const { status, body } = await handleCoach({ intake: payload.intake ?? {}, callClaude: makeCallClaude(apiKey) });
  return json(body, status);
});
