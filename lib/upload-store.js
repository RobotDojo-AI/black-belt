/**
 * Ephemeral in-memory store for uploaded binary files (images).
 * Entries expire after TTL_MS so the process doesn't leak memory on long runs.
 */
const TTL_MS = 30 * 60 * 1000; // 30 min
const store = new Map();

export function putFile({ id, name, mimeType, base64 }) {
  store.set(id, { name, mimeType, base64, expiresAt: Date.now() + TTL_MS });
}

export function getFile(id) {
  const f = store.get(id);
  if (!f) return null;
  if (f.expiresAt < Date.now()) { store.delete(id); return null; }
  return f;
}
