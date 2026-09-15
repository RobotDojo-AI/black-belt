/**
 * Ollama local-model streaming.
 *
 * Moved from lib/chat.js (st_74f45a1a Phase 2). Same surface, same behavior —
 * the only change is the import path. lib/chat.js now imports from
 * lib/chat/ollama.js and the rest of the code is identical.
 *
 * WHY here vs lib/ollama-lifecycle.js: lifecycle is one-shot (probe / quit /
 * rm), streaming is per-request. Both live in lib but in separate files so
 * the route handlers can pull just the surface they need.
 */

const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';

export async function ollamaReachable() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Stream from a local Ollama server. Uses /api/chat with stream:true.
 * Yields { type: 'delta', text } events; throws on network error.
 */
export async function* streamOllama(modelName, system, messages) {
  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: system },
      ...messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
    ],
    stream: true,
  };
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`ollama server: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Ollama uses NDJSON, not SSE — one JSON object per line, no `data:` prefix.
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);
        const text = chunk.message?.content;
        if (text) yield { type: 'delta', text };
        if (chunk.done) return;
      } catch { /* malformed line — skip */ }
    }
  }
}
