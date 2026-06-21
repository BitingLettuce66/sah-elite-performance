/* sse.js — parse Anthropic's streaming (SSE) response into the final text.

   Long plans (up to the 16-week × 6-day cap ≈ 96 sessions of structured JSON) can
   exceed a non-streaming response's safe output ceiling and get truncated mid-JSON.
   Streaming the Claude call avoids that and the HTTP timeout that comes with a big
   max_tokens. This module is pure (consumes an async iterable of string chunks), so
   the long-plan path is unit-tested offline with mocked SSE — no network.

   We accumulate only `text_delta` content (the structured JSON is delivered as text;
   thinking deltas are ignored) and capture the final `stop_reason` so the caller can
   tell a clean finish from a refusal or a `max_tokens` truncation. */

// Apply one SSE line to the running accumulator.
function applyLine(line, acc) {
  const t = line.trim();
  if (!t.startsWith('data:')) return;
  const payload = t.slice(5).trim();
  if (!payload || payload === '[DONE]') return;
  let ev;
  try { ev = JSON.parse(payload); } catch { return; }   // ignore keep-alives / partial noise
  if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
    acc.text += ev.delta.text;
  } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) {
    acc.stopReason = ev.delta.stop_reason;
  } else if (ev.type === 'message_start' && ev.message && ev.message.stop_reason) {
    acc.stopReason = ev.message.stop_reason;             // pre-output refusal arrives here
  } else if (ev.type === 'error') {
    acc.error = (ev.error && ev.error.message) || 'stream error';
  }
}

/* readAnthropicSSE(chunks) -> { text, stopReason, error }
   chunks: an async iterable yielding string fragments of the SSE body (split at
   arbitrary byte boundaries — we buffer across chunks and split on newlines). */
export async function readAnthropicSSE(chunks) {
  const acc = { text: '', stopReason: null, error: null };
  let buf = '';
  for await (const chunk of chunks) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      applyLine(buf.slice(0, nl), acc);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) applyLine(buf, acc);   // flush a final line with no trailing newline
  return acc;
}

/* Adapt a Web ReadableStream (Deno/Node fetch body) into the async-iterable of
   decoded strings readAnthropicSSE expects. */
export async function* decodeStream(readable) {
  const reader = readable.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield dec.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
