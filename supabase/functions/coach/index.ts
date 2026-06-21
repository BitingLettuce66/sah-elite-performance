// supabase/functions/coach/index.ts — the AI coach's brain (server-side).
//
// Calls Claude (claude-opus-4-8) to draft a training plan from an athlete intake.
// Runs server-side ONLY because the Anthropic API key must never reach the client
// (same rule as the Supabase service key). The client validates whatever this
// returns through plan-validator.js, so this prompt is guidance, not the gate.
//
// Self-contained on purpose (no imports from ../../src) so `supabase functions
// deploy coach` bundles cleanly. The contract below MIRRORS src/plan-schema.js +
// src/coach.js — keep them in sync; the client-side validator is the backstop.
//
// Deploy:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase functions deploy coach
// Invoked by the PWA at: ${VITE_SUPABASE_URL}/functions/v1/coach

const KNOWN_TYPES = ['HIGH', 'MOD', 'LOW', 'DELOAD', 'TAPER', 'RECOVERY', 'RACE'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MODEL = 'claude-opus-4-8';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

// JSON-schema for structured output. Mirrors the session contract; the client
// validator enforces the numeric volume guards and date format.
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

function systemPrompt(): string {
  return [
    'You are an elite strength-and-sport coach. You design safe, periodised training plans.',
    'You give training guidance only — NOT medical advice. Never diagnose or treat.',
    '',
    `Each session.type ∈ ${KNOWN_TYPES.join(', ')}; day ∈ ${DAYS.join(', ')}; week ≥ 1.`,
    'offsetDays = whole days from startDate, 0-based and strictly increasing across the plan.',
    'HIGH/MOD/LOW/TAPER need non-empty sprint or gym text. RECOVERY/DELOAD may be empty (rest).',
    'Plain text only — no HTML, no double-quote characters inside any field value.',
    '',
    'Hard safety limits (a plan breaking these is rejected by the app):',
    '- At most 3 consecutive high-intensity (HIGH/RACE) days; aim for ≤ 2.',
    '- At most 5 high-intensity days in any rolling 7-day window; aim for ≤ 4.',
    '- A RACE day must be followed by a recovery day (RECOVERY/DELOAD/TAPER) or rest.',
    '- A DELOAD day must not be immediately followed by a hard (HIGH/RACE) day.',
  ].join('\n');
}

function userPrompt(intake: Record<string, unknown>, priorIssues: string): string {
  const i = intake || {};
  const lines = [
    `Sport: ${i.sport ?? 'general fitness'}`,
    `Goal: ${i.goal || '(general improvement)'}`,
    `Plan length: ${i.weeks ?? 8} weeks, ${i.daysPerWeek ?? 3} sessions/week`,
    `Equipment available: ${Array.isArray(i.equipment) && i.equipment.length ? (i.equipment as string[]).join(', ') : 'minimal'}`,
    `Start date: ${i.startDate || '(today)'}`,
  ];
  if (i.notes) lines.push(`Athlete notes: ${i.notes}`);
  if (priorIssues) {
    lines.push('', 'Your previous draft was REJECTED for these reasons — fix them and return a corrected plan:', String(priorIssues));
  }
  lines.push('', 'Return the complete plan as a single JSON object.');
  return lines.join('\n');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'Coach is not configured (missing ANTHROPIC_API_KEY).' }, 503);

  let intake: Record<string, unknown> = {};
  let priorIssues = '';
  try {
    const body = await req.json();
    intake = body?.intake ?? {};
    priorIssues = body?.priorIssues ?? '';
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  let resp: Response;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
        system: systemPrompt(),
        messages: [{ role: 'user', content: userPrompt(intake, priorIssues) }],
      }),
    });
  } catch (e) {
    return json({ error: `Upstream request failed: ${(e as Error).message}` }, 502);
  }

  if (!resp.ok) {
    const text = await resp.text();
    return json({ error: `Anthropic error ${resp.status}: ${text.slice(0, 300)}` }, 502);
  }

  const data = await resp.json();
  if (data.stop_reason === 'refusal') {
    return json({ error: 'The coach declined this request. Please rephrase your goals.' }, 422);
  }
  // With structured output the plan JSON is the text content; concatenate text blocks.
  const text = (data.content || [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('');
  let plan: unknown;
  try {
    plan = JSON.parse(text);
  } catch {
    return json({ error: 'Coach returned unparseable output.' }, 502);
  }
  return json({ plan });
});
