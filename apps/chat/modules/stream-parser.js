/**
 * SSE stream parser — extracted from the inline reader loop in chat.js
 * (st_74f45a1a Phase 3).
 *
 * State machine:
 *   - Bytes (or strings) come in as chunks; we buffer until we hit a
 *     blank-line frame boundary (\n\n).
 *   - A frame is one or more lines:
 *       `: <comment>`   → heartbeat — update state.lastFrameMs, no event
 *       `data: <json>`  → JSON-parse the body, push as event
 *       `event: <name>` → tag the next data line (we ignore for now —
 *                          the server uses `type` field in JSON instead)
 *   - Returns an array of parsed event objects. Throws on malformed JSON
 *     with a message naming the offending text.
 *
 * Pure module — no DOM, no fetch. The state object is created with
 * `createStreamParserState()` and threaded across chunks by the caller
 * (so partial frames buffer correctly across reader.read() boundaries).
 */

const decoder = new TextDecoder();

export function createStreamParserState() {
  return {
    buffer: '',
    lastFrameMs: Date.now(),
  };
}

/**
 * Feed a chunk into the parser. Mutates state.buffer + state.lastFrameMs.
 *
 * @param {Uint8Array | string} chunk
 * @param {object} state - from createStreamParserState()
 * @returns {Array<object>} parsed events
 */
export function parseSSEChunk(chunk, state) {
  const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  state.buffer += text;

  const events = [];
  // Split on \n; we only commit a frame on encountering a blank line (frame
  // boundary). The trailing partial frame stays in the buffer.
  let idx;
  while ((idx = state.buffer.indexOf('\n\n')) !== -1) {
    const frame = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 2);

    const lines = frame.split('\n');
    let dataPayload = null;
    for (const line of lines) {
      if (line === '' || line === '\r') continue;
      if (line.startsWith(':')) {
        // Comment line — server heartbeat. Update lastFrameMs so watchdog
        // resets, but emit nothing to the consumer.
        state.lastFrameMs = Date.now();
        continue;
      }
      if (line.startsWith('data:')) {
        // SSE spec: data lines concat with \n; we only see single-line
        // data: frames in this app today, but handle multi-line safely.
        const part = line.slice(5).replace(/^ /, '');
        dataPayload = dataPayload === null ? part : dataPayload + '\n' + part;
      }
      // `event:`, `id:`, `retry:` are intentionally ignored — the server
      // encodes event type in the JSON `type` field.
    }
    if (dataPayload !== null) {
      let evt;
      try {
        evt = JSON.parse(dataPayload);
      } catch (err) {
        throw new Error(`stream-parser: failed to parse JSON in data: ${dataPayload.slice(0, 120)} (${err.message})`);
      }
      state.lastFrameMs = Date.now();
      events.push(evt);
    }
  }
  return events;
}
