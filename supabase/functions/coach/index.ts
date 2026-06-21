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
import { handleCoach } from './handler.js';

const MODEL = 'claude-opus-4-8';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

// Structured-output schema (API-call shape). Type/day enums reuse the contract
// constants; the client + server validators enforce the numeric guards + dates.
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
    sessions: {
      type: 'array',
      items: {
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
      },
    },
  },
};

// One Claude call → a flat plan. Throws on HTTP error / refusal / unparseable
// output so the handler's loop records a generation failure (→ 502).
function makeCallClaude(apiKey: string) {
  return async (intake: Record<string, unknown>, priorIssues: string) => {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
        system: buildCoachSystemPrompt(),
        messages: [{ role: 'user', content: buildCoachUserPrompt(intake, priorIssues) }],
      }),
    });
    if (!resp.ok) throw new Error(`Anthropic error ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    if (data.stop_reason === 'refusal') throw new Error('The coach declined this request.');
    const text = (data.content || []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('');
    return JSON.parse(text);   // throws on unparseable → recorded as a generation failure
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'Coach is not configured (missing ANTHROPIC_API_KEY).' }, 503);

  let intake: Record<string, unknown> = {};
  try {
    intake = (await req.json())?.intake ?? {};
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  // The handler runs the red-flag re-check + validate/re-prompt loop; the model
  // call is injected so the safety logic is identical to what the tests exercise.
  const { status, body } = await handleCoach({ intake, callClaude: makeCallClaude(apiKey) });
  return json(body, status);
});
