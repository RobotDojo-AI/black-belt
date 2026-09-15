/**
 * Admin routes — restricted to users with is_admin=1.
 *
 * All endpoints here require the session cookie + is_admin flag. Non-admin
 * users get a plain 403; no information leak about which endpoints exist.
 *
 * Mounted at /api/admin/* by lib/server.js (see routes/_mount-admin.md).
 */

import { Hono } from 'hono';
import db from '../lib/db.js';
import { requireAdmin } from '../lib/middleware-auth.js';
import { issuePerpetualKey } from '../lib/key-issuance.js';
import { logAudit } from '../lib/account-prefs.js';
import { setBeltOverride, getBeltOverride } from '../lib/admin-queries.js';
import { runDataPlaneProof } from '../lib/data-plane-proof.js';

const admin = new Hono();

// Every admin route requires the admin flag.
admin.use('*', requireAdmin());

const VALID_BELTS = new Set(['white', 'black']);
const PERPETUAL_BELTS = new Set(['black']);

/**
 * GET /api/admin/belt-override
 * Returns the current session's belt override (or null).
 */
admin.get('/belt-override', (c) => {
  const session = c.get('session');
  const row = getBeltOverride(db,session.id);
  return c.json({ belt_override: row?.belt_override || null });
});

/**
 * POST /api/admin/belt-override
 *   body: { belt: 'white' | 'black' | null }
 * Sets the current session's belt override. A null value clears the
 * override and returns the user to their real belt (from subscription).
 */
admin.post('/belt-override', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const belt = body?.belt === null || body?.belt === '' ? null : body?.belt;
  if (belt !== null && !VALID_BELTS.has(belt)) {
    return c.json({ error: `belt must be one of: ${[...VALID_BELTS].join(', ')} or null` }, 400);
  }

  const session = c.get('session');
  setBeltOverride(db, belt, session.id);
  return c.json({ ok: true, belt_override: belt });
});

/**
 * GET /api/admin/whoami
 * Returns the current admin user's identity + override state. Useful
 * for debugging admin session plumbing.
 */
admin.get('/whoami', (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({
      id: null,
      email: null,
      slug: null,
      handle: null,
      display_name: null,
      is_admin: true,
      subscription_status: null,
      belt_override: null,
    });
  }
  const session = c.get('session');
  // Bearer-auth requests have no session; belt-override is session-scoped, so
  // it's absent for those. Optional chain so the handler doesn't 500 — the
  // unhandled throw was log-spamming on every Playwright chat page load.
  const row = session ? getBeltOverride(db, session.id) : null;
  return c.json({
    id: user.id,
    email: user.email,
    slug: user.user_slug,
    handle: user.user_handle || null,
    display_name: user.display_name || null,
    is_admin: !!user.is_admin,
    subscription_status: user.subscription_status,
    belt_override: row?.belt_override || null,
  });
});

/**
 * GET /api/admin/status
 * Lightweight "are you admin?" probe. Unlike /whoami, this endpoint is
 * NOT gated by requireAdmin — it returns { is_admin: false } for any
 * authenticated non-admin, so the UI can decide whether to render the
 * admin card without a 403 error in the console.
 *
 * Exposed as a separate sub-app mount (see routes/_mount-admin.md) since
 * the `.use('*', requireAdmin())` above would otherwise block it.
 */

/**
 * POST /api/admin/issue-perpetual-key
 *   body: { email, name?, belt: 'black' }
 *
 * Mints an unbilled encryption key for an arbitrary email. Creates the
 * user row if missing, marks subscriptions.perpetual=1, and returns the
 * raw key so the admin can hand it off to the recipient. The raw key is
 * never stored — only the SHA-256 hash lives in users.encryption_key_hash.
 *
 * Admin-gated by the `.use('*', requireAdmin())` above.
 */
admin.post('/issue-perpetual-key', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const name  = typeof body?.name  === 'string' ? body.name.trim() : null;
  const belt  = body?.belt;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  if (!PERPETUAL_BELTS.has(belt)) {
    return c.json({ error: `belt must be one of: ${[...PERPETUAL_BELTS].join(', ')}` }, 400);
  }

  try {
    const result = await issuePerpetualKey(email, { name, belt });
    const issuedAt = new Date().toISOString();
    const adminUser = c.get('user');
    logAudit(adminUser?.id ?? null, 'issue_perpetual_key', {
      target_email: email,
      target_user_id: result.userId,
      belt,
      delivered: result.delivered,
      name,
    });
    return c.json({
      api_key: result.apiKey,
      belt,
      email,
      issued_at: issuedAt,
      delivered: result.delivered,
    });
  } catch (err) {
    console.error('[admin] issue-perpetual-key failed:', err.message);
    return c.json({ error: 'issuance_failed', message: err.message }, 500);
  }
});

/**
 * POST /api/admin/data-plane-proof
 *   body: { cleanup?: boolean } // defaults to true; pass false only for debugging
 *
 * Runs a fixed, synthetic data-plane proof inside the server process. The
 * route does not accept SQL or private source text; all written rows are
 * namespaced QA rows and the response is redacted boundary evidence.
 */
admin.post('/data-plane-proof', async (c) => {
  let body = {};
  try {
    const text = await c.req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  try {
    const result = await runDataPlaneProof({ cleanup: body?.cleanup !== false });
    return c.json(result, result.ok ? 200 : 500);
  } catch (err) {
    console.error('[admin] data-plane-proof failed:', err.message);
    return c.json({ ok: false, error: 'data_plane_proof_failed', message: err.message }, 500);
  }
});

// Relay registration (register-relay / relay-status / set-subdomain) was removed
// with the interim per-user Cloudflare Tunnel (st_63b59bda AC-7). The blind-relay
// architecture provisions each subdomain's routing DNS from the relay side during
// cert issuance (gateway/routes/cert-provision.js), so there is no app-driven
// tunnel to register or rename here anymore.

export default admin;

/**
 * Status probe — deliberately outside the requireAdmin gate.
 * Mount with: `app.get('/api/admin/status', adminStatus)` in index.js.
 */
export async function adminStatus(c) {
  // Tolerate anonymous + non-admin users quietly. The UI uses this to
  // decide whether to show the admin block at all.
  const user = c.get('user');
  const session = c.get('session');
  if (!user) return c.json({ is_admin: false, belt_override: null });
  let belt_override = null;
  if (session) {
    const row = getBeltOverride(db,session.id);
    belt_override = row?.belt_override || null;
  }
  return c.json({ is_admin: !!user.is_admin, belt_override });
}
