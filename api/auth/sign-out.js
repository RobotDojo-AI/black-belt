/**
 * Vercel Edge function — POST /api/auth/sign-out (GET also accepted for convenience)
 *
 * Signs out the current user by:
 *   1. Reading rdj_session cookie from request
 *   2. If no cookie → 200 {"ok": true} (no-op)
 *   3. Parsing cookie: split on last '.', base64url decode payload, parse JSON, read sessionId
 *   4. DELETE FROM sessions WHERE session_id = $1
 *   5. Return 200 {"ok": true} with Set-Cookie that clears rdj_session (Max-Age=0)
 *
 * Environment vars: DATABASE_URL
 */

export const config = { runtime: 'edge' };

import { neonQuery } from '../../lib/neon/edge-auth.js';

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

const CLEAR_COOKIE = 'rdj_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.robotdojo.ai; Max-Age=0';

function readCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) !== name) continue;
    const raw = part.slice(eq + 1);
    try { return decodeURIComponent(raw); } catch { return raw; }
  }
  return null;
}

function parseSessionId(cookieValue) {
  if (typeof cookieValue !== 'string') return null;
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = cookieValue.slice(0, dot);
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const data = JSON.parse(json);
    return typeof data?.sessionId === 'string' ? data.sessionId : null;
  } catch {
    return null;
  }
}

export default async function handler(request) {
  try {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return jsonResponse({ error: 'method_not_allowed' }, 405);
    }

    const cookieValue = readCookie(request, 'rdj_session');
    if (!cookieValue) {
      return jsonResponse({ ok: true });
    }

    const sessionId = parseSessionId(cookieValue);
    if (!sessionId) {
      // Malformed cookie — clear it anyway
      return jsonResponse({ ok: true }, 200, { 'Set-Cookie': CLEAR_COOKIE });
    }

    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      try {
        await neonQuery(dbUrl,
          'DELETE FROM sessions WHERE session_id = $1',
          [sessionId],
        );
      } catch (err) {
        // Log but don't fail — always clear the cookie
        console.error('[sign-out] session delete error:', err?.message || err);
      }
    }

    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': CLEAR_COOKIE });
  } catch (err) {
    console.error('[sign-out] error:', err?.message || err);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}
