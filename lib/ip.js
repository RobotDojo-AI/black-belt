/**
 * Trusted client-IP extraction.
 *
 * Threat: attacker controls `X-Forwarded-For` when the app is reached
 * directly (bypassing the intended proxy). Spoofing lets them bypass
 * rate limits or lock legitimate users out of magic-link throttles by
 * impersonating their IP.
 *
 * Trust model:
 *   1. Behind Vercel — `x-vercel-forwarded-for` is set server-side AFTER
 *      the edge auth step, so the client cannot forge it. Prefer it.
 *   2. Behind a known proxy (ALB, Cloudflare, self-hosted nginx) — opt
 *      in via env var `TRUSTED_PROXY=true`. Only then do we read XFF.
 *   3. Otherwise — ignore XFF entirely. Fall back to the single
 *      non-forgeable header `x-real-ip` (if a local proxy sets it), or
 *      the string `'direct'` so at least one rate-limit bucket groups
 *      all untrusted callers together rather than partitioning on a
 *      value the attacker controls.
 */

const TRUSTED_PROXY = process.env.TRUSTED_PROXY === 'true';

function firstHop(header) {
  if (!header) return null;
  const first = String(header).split(',')[0].trim();
  return first || null;
}

export function ipFromHonoContext(c) {
  const vfwd = firstHop(c.req.header('x-vercel-forwarded-for'));
  if (vfwd) return vfwd;
  if (TRUSTED_PROXY) {
    const xff = firstHop(c.req.header('x-forwarded-for'));
    if (xff) return xff;
  }
  return c.req.header('x-real-ip') || 'direct';
}

export function ipFromFetchRequest(request) {
  const vfwd = firstHop(request.headers.get('x-vercel-forwarded-for'));
  if (vfwd) return vfwd;
  if (TRUSTED_PROXY) {
    const xff = firstHop(request.headers.get('x-forwarded-for'));
    if (xff) return xff;
  }
  return request.headers.get('x-real-ip') || 'direct';
}
