/**
 * WebSocket registry — one connection per user.
 *
 * Keyed by email (canonical identifier), slug, handle, and uuid.
 * The proxy looks up by handle/slug (URL alias). The control plane
 * looks up by email (payment webhooks). Internal routing uses uuid
 * (permanent, survives handle renames).
 *
 * A new connection from the same user replaces the old one — last-write-wins
 * keeps the registry consistent when an agent reconnects mid-flight.
 */
const bySlug   = new Map();
const byEmail  = new Map();
const byHandle = new Map();
const byUuid   = new Map();

export function register(conn) {
  const prev = byEmail.get(conn.email);
  if (prev && prev !== conn) {
    try { prev.socket.close(4000, 'superseded'); } catch {}
    bySlug.delete(prev.slug);
    if (prev.handle) byHandle.delete(prev.handle);
    if (prev.uuid) byUuid.delete(prev.uuid);
  }
  byEmail.set(conn.email, conn);
  bySlug.set(conn.slug, conn);
  if (conn.handle) byHandle.set(conn.handle, conn);
  if (conn.uuid) byUuid.set(conn.uuid, conn);
}

export function unregister(conn) {
  if (byEmail.get(conn.email) === conn) byEmail.delete(conn.email);
  if (bySlug.get(conn.slug) === conn) bySlug.delete(conn.slug);
  if (conn.handle && byHandle.get(conn.handle) === conn) byHandle.delete(conn.handle);
  if (conn.uuid && byUuid.get(conn.uuid) === conn) byUuid.delete(conn.uuid);
}

export function getBySlug(slug) { return bySlug.get(slug); }
export function getByHandle(handle) { return byHandle.get(handle); }
export function getByEmail(email) { return byEmail.get(email); }
export function getByUuid(uuid) { return byUuid.get(uuid); }
export function size() { return byEmail.size; }
