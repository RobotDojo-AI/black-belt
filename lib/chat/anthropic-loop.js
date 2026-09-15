/**
 * Provider-driven chat + tool-use loop.
 *
 * Async generator. Yields:
 *   { type: 'delta', text }
 *   { type: 'tool_start', name, args }
 *   { type: 'tool_done', name, result }
 *
 * st_74f45a1a R2 amendment — extracted from lib/chat.js (Phase 2) and now
 * routed through the lib/llm provider abstraction (Phase 1B). The loop
 * speaks the unified `provider.streamChat(...)` contract; AC 10 grep gate
 * enforces no direct Anthropic SDK imports outside lib/llm/.
 *
 * Injection surface (everything is a Function, no globals):
 *   - provider: lib/llm provider with streamChat({...}) generator
 *   - executeTool(name, args, toolCtx): runs a single tool
 *   - onPhase(name): server lifecycle hook ('streaming', 'calling_tools')
 *   - onMetric.firstToken(): observability hook at first delta
 *   - onMetric.completion({usage, response_model}): once per turn at done
 *
 * Tool rounds: up to MAX_TOOL_ROUNDS. The loop accumulates assistant +
 * tool_result messages into workingMessages and re-enters until the model
 * stops requesting tools or the budget is exhausted.
 *
 * cache hint: passed through to the provider on every iteration. The
 * provider translates it per-vendor (Anthropic → cache_control markers;
 * OpenAI/Google → no-op or cachedContent).
 */

const MAX_TOOL_ROUNDS = 5;

function stripInternalFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (k.startsWith('_')) continue;
    out[k] = obj[k];
  }
  return out;
}

/**
 * Run the streaming + tool-use loop.
 *
 * @param {object} args
 * @param {Array} args.messages - chat history (working copy)
 * @param {string | Array} args.system - assembled system prompt (string or cacheable blocks)
 * @param {Array} args.tools - tool schemas (may be empty)
 * @param {string} args.model - resolved tier ('fast'/'balanced'/'best') or concrete id
 * @param {number} args.maxTokens - max tokens for the stream
 * @param {object} args.provider - lib/llm provider with .streamChat()
 * @param {Function} args.executeTool - (name, args, toolCtx) => Promise<result>
 * @param {object} args.toolCtx - passed verbatim to executeTool
 * @param {Function} [args.onPhase] - phase event callback
 * @param {{firstToken: Function, completion: Function}} [args.onMetric] - observability
 * @param {number} [args.streamTimeoutMs] - timeout per stream call (0 = none)
 * @param {number} [args.firstDeltaTimeoutMs] - timeout until first text delta (0 = none)
 * @param {string|null} [args.cache] - prompt-cache hint ('system'|'system+tools'|null)
 */
export async function* streamAnthropicToolLoop(args) {
  const {
    messages,
    system,
    tools = [],
    model,
    maxTokens = 4096,
    provider,
    executeTool,
    toolCtx = {},
    onPhase = null,
    onMetric = null,
    streamTimeoutMs = 0,
    firstDeltaTimeoutMs = 0,
    cache = null,
  } = args;

  if (!provider || typeof provider.streamChat !== 'function') {
    throw new Error('streamAnthropicToolLoop: provider with .streamChat() required');
  }

  const emitPhase = (name, payload) => {
    if (typeof onPhase === 'function') {
      try { onPhase(name, payload); } catch { /* observability never breaks chat */ }
    }
  };
  const metricFirstToken = () => {
    if (onMetric && typeof onMetric.firstToken === 'function') {
      try { onMetric.firstToken(); } catch { /* observability never breaks chat */ }
    }
  };
  const metricCompletion = (info) => {
    if (onMetric && typeof onMetric.completion === 'function') {
      try { onMetric.completion(info); } catch { /* observability never breaks chat */ }
    }
  };

  // Working copy — tool rounds append to this without mutating the caller's array.
  const workingMessages = messages.map(m => ({ role: m.role, content: m.content }));

  let toolRounds = 0;
  let lastUsage = null;
  let responseModel = null;
  let streamingPhaseEmitted = false;
  let toolsPhaseEmitted = false;

  while (toolRounds <= MAX_TOOL_ROUNDS) {
    const callArgs = {
      messages: workingMessages,
      system,
      model,
      max_tokens: maxTokens,
      cache,
    };
    if (tools.length > 0 && toolRounds < MAX_TOOL_ROUNDS) {
      callArgs.tools = tools;
    }

    // Per-stream timeout via AbortController. The provider honors signal.
    // The first-delta timeout is also enforced by a hard iterator race below:
    // some SDK streams can ignore abort until their internal read settles, and
    // the route still must be able to fail over without waiting for that read.
    const needsAbortController = streamTimeoutMs > 0 || firstDeltaTimeoutMs > 0;
    const ac = needsAbortController ? new AbortController() : null;
    const timeout = ac && streamTimeoutMs > 0
      ? setTimeout(() => { try { ac.abort(); } catch {} }, streamTimeoutMs)
      : null;
    if (ac) callArgs.signal = ac.signal;
    // First-delta SLA starts AFTER the HTTP stream is open. Racing it from
    // streamChat() construction included uploading the cached prefix, so every
    // provider died at exactly 6000ms and fallback never got a real token.
    const CONNECT_BUDGET_MS = 20_000;
    let seenConnect = false;
    let firstDeltaDeadline = 0;
    const connectDeadline = firstDeltaTimeoutMs > 0 && tools.length === 0
      ? Date.now() + Math.max(firstDeltaTimeoutMs, CONNECT_BUDGET_MS)
      : 0;

    let finalContent = [];
    let stopReason = null;
    // Pending tool_use blocks for this round, captured from provider events
    // so we can replay them as assistant content in the working message list.
    const toolUseBlocks = [];

    try {
      const iterator = provider.streamChat(callArgs)[Symbol.asyncIterator]();
      while (true) {
        let result;
        const activeDeadline = !streamingPhaseEmitted && firstDeltaTimeoutMs > 0 && tools.length === 0
          ? (seenConnect ? firstDeltaDeadline : connectDeadline)
          : 0;
        if (activeDeadline > 0) {
          const remaining = Math.max(0, activeDeadline - Date.now());
          let firstDeltaTimer = null;
          const timeoutRace = new Promise((resolve) => {
            firstDeltaTimer = setTimeout(() => resolve({ timeout: true }), remaining);
          });
          const nextRace = iterator.next()
            .then((value) => ({ value }))
            .catch((error) => ({ error }));
          let raced = await Promise.race([nextRace, timeoutRace]);
          if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
          if (raced?.timeout) {
            // After a long main-thread stall, Node fires expired timers before
            // poll I/O. Bytes already on the socket would lose that race and
            // look like a dead provider. Give the poll phase one turn.
            raced = await Promise.race([
              nextRace,
              new Promise((resolve) => setImmediate(() => resolve({ timeout: true }))),
            ]);
          }
          if (raced?.timeout) {
            try { ac?.abort(new Error('first_delta_timeout')); } catch { try { ac?.abort(); } catch {} }
            try { iterator.return?.(); } catch {}
            const timeoutError = new Error(`first_delta_timeout after ${firstDeltaTimeoutMs}ms`);
            timeoutError.code = 'first_delta_timeout';
            throw timeoutError;
          }
          if (raced?.error) throw raced.error;
          result = raced.value;
        } else {
          result = await iterator.next();
        }
        if (result.done) break;
        const event = result.value;
        if (event?.type === 'connected') {
          if (!seenConnect) {
            seenConnect = true;
            firstDeltaDeadline = Date.now() + firstDeltaTimeoutMs;
          }
          continue;
        }
        if (event.type === 'delta') {
          if (!streamingPhaseEmitted) {
            emitPhase('streaming');
            streamingPhaseEmitted = true;
            metricFirstToken();
          }
          yield { type: 'delta', text: event.text };
        } else if (event.type === 'tool_start') {
          toolUseBlocks.push({
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.args || {},
          });
          if (!toolsPhaseEmitted) {
            // Emit count + label after the push so the indicator shows
            // "Calling 1 tools…" with the actual tool name (Phase 1D).
            emitPhase('calling_tools', {
              count: toolUseBlocks.length,
              label: `Calling ${event.name}…`,
            });
            toolsPhaseEmitted = true;
          }
        } else if (event.type === 'complete') {
          finalContent = event.content || finalContent;
          if (event.usage) lastUsage = event.usage;
          if (event.model) responseModel = event.model;
          if (event.stop_reason) stopReason = event.stop_reason;
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    // Reconcile: if the provider's complete event omitted content blocks
    // (some providers do), we synthesize a content array from the deltas
    // we observed. Today only Anthropic populates content here.
    if ((!finalContent || finalContent.length === 0) && toolUseBlocks.length > 0) {
      finalContent = toolUseBlocks;
    }

    const toolCalls = (finalContent || []).filter(b => b.type === 'tool_use');
    if (toolCalls.length === 0 || stopReason !== 'tool_use') {
      break;
    }

    // Push the assistant message (full content array) and execute each tool.
    workingMessages.push({ role: 'assistant', content: finalContent });

    const toolResults = [];
    for (const call of toolCalls) {
      yield { type: 'tool_start', name: call.name, args: call.input };

      let result = await executeTool(call.name, call.input, toolCtx);

      // Two-phase tool resolution: an intermediate envelope (e.g.
      // request_credential) followed by the real result after the UI
      // resolves. Yield the envelope, then await the resolution.
      if (result && typeof result._onResolved === 'function') {
        yield { type: 'tool_done', name: call.name, result };
        const resolve = result._onResolved;
        result = await resolve();
      } else {
        yield { type: 'tool_done', name: call.name, result };
      }

      const publicResult = stripInternalFields(result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: JSON.stringify(publicResult),
      });
    }

    workingMessages.push({ role: 'user', content: toolResults });
    toolRounds++;
  }

  // One completion event per turn — caller wires this into observability.
  metricCompletion({ usage: lastUsage, response_model: responseModel, provider_name: provider.name || null });
}
