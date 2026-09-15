// Shared warm-cache helpers — read/write JSON payloads stored under
// `{ payload, ts }` envelopes in localStorage. Extracted so both apps/chat/app.js
// (boot writer) and apps/chat/modules/chat.js (reloadLabelsAndConvs writer)
// can share the same envelope shape without an app.js↔chat.js import cycle.

const LEGACY_TOPIC_SLUGS = new Set(['tool-parent', 'tool-child', 'needs-routing']);

// Models/prefs only. Topics live in topic-store.js (`rd_topic_nav`).
export const WARM_CACHE_GEN = 5;

function sanitizeWarmPayload(key, payload) {
  if (key === 'rd_warm_labels' && payload && typeof payload === 'object') {
    return {
      ...payload,
      labels: Array.isArray(payload.labels)
        ? payload.labels.filter(l => !LEGACY_TOPIC_SLUGS.has(l?.slug || l?.context))
        : payload.labels,
      groups: Array.isArray(payload.groups)
        ? payload.groups.filter(g => !LEGACY_TOPIC_SLUGS.has(g?.slug))
        : payload.groups,
    };
  }
  return payload;
}

export function readWarmPayload(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (key === 'rd_warm_models' && parsed?.gen !== WARM_CACHE_GEN) return null;
    return sanitizeWarmPayload(key, parsed?.payload ?? null);
  } catch {
    return null;
  }
}

export function writeWarmPayload(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify({
      payload: sanitizeWarmPayload(key, payload),
      ts: Date.now(),
      gen: WARM_CACHE_GEN,
    }));
  } catch { /* */ }
}
