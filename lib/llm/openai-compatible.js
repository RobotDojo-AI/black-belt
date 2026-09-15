/**
 * Minimal OpenAI-compatible chat-completions transport.
 *
 * Used by OpenAI and xAI so provider availability does not depend on optional
 * SDK packages. Provider modules own auth/model mapping; this helper owns
 * request shape, SSE parsing, and usage normalization.
 */

export function flattenSystem(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((block) => block?.text || '').filter(Boolean).join('\n');
  }
  return String(system || '');
}

export function translateMessages(messages, system) {
  const out = [];
  const systemText = flattenSystem(system);
  if (systemText) out.push({ role: 'system', content: systemText });

  for (const message of messages || []) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (typeof message.content === 'string') {
      out.push({ role, content: message.content });
      continue;
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((block) => block?.type === 'text' || block?.type === 'tool_result')
        .map((block) => block.text || block.content || '')
        .filter(Boolean)
        .join('\n');
      out.push({ role, content: text });
      continue;
    }
    out.push({ role, content: '' });
  }

  return out;
}

// Models that reject `max_tokens` and require `max_completion_tokens`: the
// o-series (o1/o3/o4…) and GPT-5 and later. Matching only /^o\d/ silently 400s
// every gpt-5* call with "Unsupported parameter: 'max_tokens'", which is why the
// best lane could not move off o3-mini. xAI's `grok-*` ids share this transport
// and still take `max_tokens`, so they must not match here.
export function usesMaxCompletionTokens(model) {
  const id = String(model || '');
  if (/^o\d/i.test(id)) return true;
  const gpt = /^gpt-(\d+)/i.exec(id);
  return Boolean(gpt) && Number(gpt[1]) >= 5;
}

export function buildChatBody({ model, messages, system, maxTokens, stream, includeStreamUsage = false }) {
  const body = {
    model,
    messages: translateMessages(messages, system),
  };
  if (stream) body.stream = true;
  if (stream && includeStreamUsage) body.stream_options = { include_usage: true };

  const tokenKey = usesMaxCompletionTokens(model) ? 'max_completion_tokens' : 'max_tokens';
  body[tokenKey] = tokenKey === 'max_completion_tokens'
    ? Math.max(maxTokens || 4096, 1024)
    : (maxTokens || 4096);
  return body;
}

export function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens || null,
  };
}

export function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => part?.text || '').join('');
  return '';
}

export async function parseErrorResponse(res) {
  let data = null;
  try { data = await res.json(); } catch {
    try { data = { message: await res.text() }; } catch { data = null; }
  }
  const detail = data?.error || data;
  const message = detail?.message || `HTTP ${res.status}`;
  const err = new Error(message);
  err.status = res.status;
  err.detail = detail;
  return err;
}

export async function* readSseJson(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  const findBoundary = () => {
    const match = /\r?\n\r?\n/.exec(buffer);
    return match ? { index: match.index, length: match[0].length } : null;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = findBoundary();
    while (boundary) {
      const eventText = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      for (const line of eventText.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice('data:'.length).trim();
        if (!payload || payload === '[DONE]') return;
        yield JSON.parse(payload);
      }
      boundary = findBoundary();
    }
  }

  const trailing = buffer.trim();
  if (trailing) {
    for (const line of trailing.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (!payload || payload === '[DONE]') return;
      yield JSON.parse(payload);
    }
  }
}

export async function postChatCompletion({
  fetchImpl,
  baseUrl,
  apiKey,
  model,
  messages,
  system,
  maxTokens,
  signal,
  stream = false,
  includeStreamUsage = false,
}) {
  if (!fetchImpl) throw new Error('provider_not_configured: fetch unavailable');
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildChatBody({
      model,
      messages,
      system,
      maxTokens,
      stream,
      includeStreamUsage,
    })),
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return res;
}
