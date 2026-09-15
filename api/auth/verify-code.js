/**
 * Vercel Edge function — POST /api/auth/verify-code
 *
 * Verifies a 6-digit magic code and issues a session cookie.
 *
 * Flow:
 *   1. Validate email + code present → 400 if missing
 *   2. Hash email with HMAC-SHA256(email, SESSION_SECRET)
 *   3. DELETE FROM magic_links WHERE token = $1 AND hashed_email = $2
 *      AND used_at IS NULL AND expires_at > NOW() RETURNING id
 *   4. If 0 rows → 400 invalid_or_expired_code
 *   5. UPSERT user: INSERT ... ON CONFLICT (hashed_email) DO UPDATE SET last_seen_at = NOW()
 *      RETURNING user_id, plan_tier, user_slug
 *   6. Generate sessionId (crypto.randomUUID)
 *   7. INSERT INTO sessions (session_id, user_id, slug, belt, expires_at)
 *      slug = user_id.slice(0,8) — temporary placeholder for single-user system
 *   8. Build and sign rdj_session cookie
 *   9. Return 200 {"ok": true} with Set-Cookie header
 *
 * Environment vars: SESSION_SECRET, DATABASE_URL
 */

export const config = { runtime: 'edge' };

import { hashEmail, neonQuery, buildCookie, cookieHeader } from '../../lib/neon/edge-auth.js';

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function isValidEmail(str) {
  return typeof str === 'string' && str.includes('@') && str.length > 3 && str.length < 320;
}

function isValidCode(str) {
  return typeof str === 'string' && /^\d{6}$/.test(str.trim());
}

const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30; // 30 days

export default async function handler(request) {
  try {
    if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

    let body;
    try { body = await request.json(); }
    catch { return jsonResponse({ error: 'invalid_json' }, 400); }

    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    const code  = typeof body?.code  === 'string' ? body.code.trim()  : '';

    if (!isValidEmail(email) || !code) {
      return jsonResponse({ error: 'email_and_code_required' }, 400);
    }

    const secret = process.env.SESSION_SECRET;
    const dbUrl  = process.env.DATABASE_URL;
    if (!secret || !dbUrl) return jsonResponse({ error: 'server_misconfigured' }, 500);

    const hashed = await hashEmail(email, secret);

    // Consume the magic link — atomic DELETE so replay is impossible
    const deleteResult = await neonQuery(dbUrl,
      `DELETE FROM magic_links
       WHERE token = $1 AND hashed_email = $2 AND used_at IS NULL AND expires_at > NOW()
       RETURNING id, hashed_email`,
      [code, hashed],
    );

    if (!deleteResult?.rows?.length) {
      return jsonResponse({ error: 'invalid_or_expired_code' }, 400);
    }

    // Upsert user — create on first login, update last_seen on subsequent
    const upsertResult = await neonQuery(dbUrl,
      `INSERT INTO users (hashed_email, plan_tier)
       VALUES ($1, 'white')
       ON CONFLICT (hashed_email) DO UPDATE SET last_seen_at = NOW()
       RETURNING user_id, plan_tier, user_slug`,
      [hashed],
    );

    const user = upsertResult?.rows?.[0];
    if (!user?.user_id) return jsonResponse({ error: 'user_upsert_failed' }, 500);

    const { user_id, plan_tier, user_slug } = user;

    // Session — 30-day rolling window
    const sessionId = globalThis.crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000);
    // Use real slug from users table; fallback to user_id prefix for new/unknown users
    const slug = user_slug || user_id.slice(0, 8);
    const belt = plan_tier || 'white';

    await neonQuery(dbUrl,
      `INSERT INTO sessions (session_id, user_id, slug, belt, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, user_id, slug, belt, expiresAt.toISOString()],
    );

    // Build signed cookie
    const cookieValue = await buildCookie(
      { sessionId, userId: user_id, slug, belt, expiresAt: expiresAt.toISOString() },
      secret,
    );

    return jsonResponse(
      { ok: true },
      200,
      { 'Set-Cookie': cookieHeader(cookieValue, SESSION_DURATION_SECONDS) },
    );
  } catch (err) {
    console.error('[verify-code] error:', err?.message || err);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}
