const FEEDBACK_URL = process.env.ROBOTDOJO_FEEDBACK_URL || 'https://robotdojo.ai/api/feedback';

const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(rd_[A-Za-z0-9_-]{16,})\b/g,
  /\b([A-Za-z0-9_]*(?:api|auth|access|refresh|secret|token|key)[A-Za-z0-9_]*\s*[:=]\s*["']?)[^\s"',}]+/gi,
];

export function stripFounderMention(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/^@feedback\s*/i, '');
}

export function isFounderFeedbackMention(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return typeof last?.content === 'string' && /^@feedback\b/i.test(last.content.trimStart());
}

export function redactFeedbackText(value) {
  let text = String(value || '');
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]');
  text = text.replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[redacted phone]');
  text = text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted ssn]');
  text = text.replace(/\b(?:\d[ -]*?){13,19}\b/g, '[redacted number]');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (_, prefix) => prefix && /[:=]/.test(prefix) ? `${prefix}[redacted]` : '[redacted secret]');
  }
  return text.slice(0, 12000);
}

export async function submitFounderFeedback(messages, { conversationId, user } = {}) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const description = redactFeedbackText(stripFounderMention(last?.content || ''));
  const thread = messages.slice(-30).map((m) => ({
    role: m.role,
    content: redactFeedbackText(m.content),
  }));

  const body = {
    kind: 'feature_request',
    description: description || 'Feedback from chat',
    conversationId,
    source: 'chat @feedback',
    userId: user?.id || null,
    includeChatHistory: true,
    chatHistory: thread.map((m) => `${m.role}: ${m.content}`),
  };

  const res = await fetch(FEEDBACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.error || json?.message || `feedback_failed_${res.status}`);
  }
  return { ok: true };
}

export async function* streamFounderFeedbackMention(messages, opts = {}) {
  try {
    await submitFounderFeedback(messages, opts);
    yield {
      type: 'delta',
      text: 'Sent to the Robot Dojo task queue with PII and secrets scrubbed. The full local thread context was included after redaction.',
    };
  } catch (err) {
    yield {
      type: 'delta',
      text: `I could not send that yet: ${redactFeedbackText(err.message)}. Your message stayed local.`,
    };
  }
}
