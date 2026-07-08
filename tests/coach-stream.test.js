import { describe, it, expect } from 'vitest';
import { readAnthropicSSE } from '../supabase/functions/coach/sse.js';
import { loadPlan } from '../src/plan-validator.js';
import { generatePlanLocal } from '../src/coach.js';

// Build an Anthropic-style SSE body from a list of event objects.
const sse = events => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
// Stream JSON text as text_delta events, broken into small pieces.
const textDeltas = (str, size = 5) => {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: str.slice(i, i + size) } });
  return out;
};
// Yield the SSE body in arbitrary-sized chunks (mimics network framing).
async function* chunked(str, size = 7) { for (let i = 0; i < str.length; i += size) yield str.slice(i, i + size); }

describe('readAnthropicSSE — long-plan streaming parser', () => {
  it('accumulates text_delta across chunk boundaries and reports stop_reason', async () => {
    const planText = JSON.stringify({ name: 'P', startDate: '2026-07-01', sessions: [] });
    const body = sse([
      { type: 'message_start', message: { id: 'x' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ...textDeltas(planText, 4),
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'IGNORED' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);
    const r = await readAnthropicSSE(chunked(body, 7));   // 7-byte chunks split lines mid-stream
    expect(r.stopReason).toBe('end_turn');
    expect(r.text).toBe(planText);                        // thinking_delta did not leak in
    expect(JSON.parse(r.text).name).toBe('P');
  });

  it('streams a long, valid plan that parses and passes the validator', async () => {
    // 16 weeks × 6 days ≈ 96 sessions — the size that would truncate at 16K non-streamed.
    const plan = generatePlanLocal({ sport: 'sprints', weeks: 16, daysPerWeek: 6, startDate: '2026-07-01' });
    const body = sse([
      { type: 'message_start', message: { id: 'x' } },
      ...textDeltas(JSON.stringify(plan), 32),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]);
    const r = await readAnthropicSSE(chunked(body, 50));
    const parsed = JSON.parse(r.text);
    expect(parsed.sessions.length).toBe(96);
    expect(loadPlan(parsed).ok).toBe(true);              // the streamed long plan is valid end-to-end
  });

  it('flags a truncated (max_tokens) stream so the caller can reject it', async () => {
    const body = sse([
      { type: 'message_start', message: { id: 'x' } },
      ...textDeltas('{"name":"half a pla', 6),           // deliberately cut off mid-JSON
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    ]);
    const r = await readAnthropicSSE(chunked(body, 9));
    expect(r.stopReason).toBe('max_tokens');
    expect(() => JSON.parse(r.text)).toThrow();          // truncated JSON is unparseable → generation failure
  });

  it('captures a pre-output refusal from message_start', async () => {
    const body = sse([
      { type: 'message_start', message: { stop_reason: 'refusal' } },
      { type: 'message_stop' },
    ]);
    const r = await readAnthropicSSE(chunked(body, 11));
    expect(r.stopReason).toBe('refusal');
    expect(r.text).toBe('');
  });

  it('surfaces a stream error event and ignores keep-alives/non-data lines', async () => {
    const body = ': ping\n\n' + sse([{ type: 'error', error: { message: 'overloaded' } }]) + 'data: \n\n';
    const r = await readAnthropicSSE(chunked(body, 5));
    expect(r.error).toBe('overloaded');
  });
});
