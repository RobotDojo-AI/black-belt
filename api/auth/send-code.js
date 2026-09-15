/**
 * Vercel Edge function — POST /api/auth/send-code
 *
 * Sends a 6-digit login code to a registered user's email.
 * Silently succeeds for unknown emails (owner gate — only seeded users can log in).
 *
 * Flow:
 *   1. Validate email present → 400 if missing
 *   2. Hash email with HMAC-SHA256(email, SESSION_SECRET)
 *   3. Check Neon users table: SELECT user_id WHERE hashed_email = $1
 *   4. If no matching user → return 200 {"ok": true} silently (no email sent)
 *   5. Generate 6-digit code
 *   6. INSERT INTO magic_links (token, hashed_email, expires_at)
 *   7. Send email via Resend API
 *   8. Return 200 {"ok": true}
 *
 * Environment vars: SESSION_SECRET, DATABASE_URL, RESEND_API_KEY
 */

export const config = { runtime: 'edge' };

import { hashEmail, generateCode, neonQuery } from '../../lib/neon/edge-auth.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isValidEmail(str) {
  return typeof str === 'string' && str.includes('@') && str.length > 3 && str.length < 320;
}

export default async function handler(request) {
  try {
    if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

    let body;
    try { body = await request.json(); }
    catch { return jsonResponse({ error: 'invalid_json' }, 400); }

    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    if (!isValidEmail(email)) return jsonResponse({ error: 'email_required' }, 400);

    const secret = process.env.SESSION_SECRET;
    const dbUrl = process.env.DATABASE_URL;
    const resendKey = process.env.RESEND_API_KEY;

    if (!secret || !dbUrl) return jsonResponse({ error: 'server_misconfigured' }, 500);

    // Hash email for lookup
    const hashed = await hashEmail(email, secret);

    // Check if user exists (owner gate — only seeded users get codes)
    const userResult = await neonQuery(dbUrl,
      'SELECT user_id FROM users WHERE hashed_email = $1 LIMIT 1',
      [hashed],
    );

    if (!userResult?.rows?.length) {
      // Silent success — don't reveal whether email is registered
      return jsonResponse({ ok: true });
    }

    // Generate 6-digit code and insert magic link (15-minute TTL)
    const code = generateCode();
    await neonQuery(dbUrl,
      `INSERT INTO magic_links (token, hashed_email, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
      [code, hashed],
    );

    // Send email via Resend
    if (!resendKey) return jsonResponse({ error: 'server_misconfigured' }, 500);

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Robot Dojo <noreply@robotdojo.ai>',
        to: [email],
        subject: 'Your login code',
        html: `<p>Your Robot Dojo login code is: <strong>${code}</strong></p><p>Expires in 15 minutes.</p>`,
      }),
    });

    if (!emailRes.ok) {
      const detail = await emailRes.text().catch(() => '');
      console.error('[send-code] Resend error:', emailRes.status, detail.slice(0, 200));
      return jsonResponse({ error: 'email_send_failed' }, 502);
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('[send-code] error:', err?.message || err);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}
