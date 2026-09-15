/**
 * Robot Dojo — Public Chat Core
 *
 * Shared, UI-agnostic helpers for talking to /api/public-chat/stream.
 * Used by the full-page /ask experience. Keep DOM-free so it can be
 * reused from any surface.
 */

export const PUBLIC_CHAT_ENDPOINT = '/api/public-chat/stream';
const SESSION_KEY = 'rd_public_chat_session';

/** Quick-start prompts keyed to the FAQ context packs. */
export const QUICK_PROMPTS = [
  { label: 'Install',      context: 'install-guide',   prompt: 'Walk me through installing Robot Dojo step by step.' },
  { label: 'How it works', context: 'faq-how-it-works', prompt: 'How does Robot Dojo work? Walk me through the architecture.' },
  { label: 'Privacy',      context: 'faq-privacy',     prompt: 'How does Robot Dojo handle my data and privacy?' },
  { label: 'Tiers',        context: 'faq-pricing',     prompt: 'What is White Belt, what is Black Belt, and what happens if Black Belt expires?' },
];

/** Stable per-tab session id. Falls back to null if storage is blocked. */
export function getSessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * Stream a chat completion from /api/public-chat/stream.
 *
 * @param {Object} args
 * @param {Array<{role:string, content:string}>} args.messages - history including the new user turn
 * @param {string} args.context - FAQ context pack (e.g. "install-guide", "core")
 * @param {(delta:string) => void} args.onDelta - called with each streamed text chunk
 * @returns {Promise<{ok:boolean, error?:string, retryAfter?:number}>}
 */
export async function streamPublicChat({ messages, context, onDelta }) {
  const payload = {
    messages,
    context,
    sessionId: getSessionId(),
  };

  let res;
  try {
    res = await fetch(PUBLIC_CHAT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, error: 'Network error. Please try again.' };
  }

  if (!res.ok) {
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('retry-after') || '', 10);
      const retryAfter = Number.isFinite(retry) && retry > 0 && retry < 3600 ? retry : null;
      return {
        ok: false,
        retryAfter,
        error: retryAfter
          ? `Whoa, you\u2019re fast. Try again in ${retryAfter}s.`
          : "You've hit today's message limit. Try again tomorrow, or install Robot Dojo locally for local chat.",
      };
    }
    if (res.status >= 500) {
      return { ok: false, error: 'Miyagi is unavailable right now. Please try again shortly.' };
    }
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let got = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'delta' && data.text) {
          got = true;
          onDelta(data.text);
        } else if (data.type === 'error') {
          return { ok: false, error: data.message || 'Error.' };
        }
      } catch {
        /* malformed event, skip */
      }
    }
  }

  if (!got) {
    return { ok: false, error: 'No response. Please try again.' };
  }
  return { ok: true };
}
