/**
 * Small shared utilities. No side effects, no DB, no I/O.
 *
 * Kept narrow on purpose — helpers only graduate here when the same exact
 * pattern shows up in three or more call sites.
 */

/**
 * Parse a JSON string defensively. Returns `fallback` on any parse error
 * or when the input is not a non-empty string.
 *
 * Replaces the `try { x = JSON.parse(y); } catch { x = fallback; }` pattern
 * that was scattered across timeline, key-store, and ingest paths.
 */
export function safeJsonParse(s, fallback = null) {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * Defensive prepared-statement `.get()` — returns null on any error
 * (missing table, bad SQL, bad binding). Useful for schema-optional
 * reads where we'd rather degrade gracefully than crash.
 */
export function safeGet(stmt, ...args) {
  try { return stmt.get(...args); } catch { return null; }
}

/**
 * Defensive prepared-statement `.all()` — returns [] on any error.
 */
export function safeAll(stmt, ...args) {
  try { return stmt.all(...args); } catch { return []; }
}

/**
 * Validate + sanitize a redirect target. Returns the safe target string or
 * the fallback '/account' for any unsafe input.
 *
 * Rules:
 *  - Must be a non-empty string under 512 chars
 *  - Must not contain control characters (prevents header injection)
 *  - Relative paths must start with '/' (no protocol-relative or backslash tricks)
 *  - Absolute URLs are only allowed for *.robotdojo.ai subdomains (SNI targets)
 *  - Two-segment paths like /dojo/laptop/chat are explicitly allowed
 *
 * Shared between routes/auth.js and any middleware that issues redirects.
 */
export function safeRedirect(target) {
  if (!target || typeof target !== 'string') return '/account';
  // Reject control characters (CR/LF/NULL/etc) to prevent HTTP response
  // splitting and header injection. Also caps length as a defense in depth.
  if (target.length > 512) return '/account';
  if (/[\x00-\x1f\x7f]/.test(target)) return '/account';
  // Reject protocol-relative and backslash redirects.
  if (target.startsWith('//') || target.startsWith('/\\') || /^\/\/+/.test(target)) return '/account';
  // Same-origin relative paths (including two-segment /<servername>/<handle>/...) are safe.
  if (target.startsWith('/')) return target;
  // Allow our own subdomain URLs (SNI passthrough targets).
  if (/^https:\/\/[a-z0-9-]+\.robotdojo\.ai(\/|$)/.test(target)) return target;
  return '/account';
}
