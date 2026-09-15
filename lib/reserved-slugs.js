// lib/reserved-slugs.js — names a user can't claim as their device handle.
//
// Why centralize: install-time prompt, runtime rename, setup-step validation,
// and the gateway's /api/register-device endpoint all need to agree on the
// same list. Forking the list anywhere guarantees a bug later.
//
// Category breakdown:
//   - URL-path collisions: anything already served at robotdojo.ai/<x>
//     (marketing pages, api, static, install). A user with slug `api` would
//     shadow every /api/... call at the edge.
//   - System words: dev/ops jargon that would confuse support ("is `admin`
//     your device name, or are you talking to an administrator?").
//   - Reserved for future expansion: tier/product names we'll likely use.
//
// NOT reserved: real hostnames people pick (dojo, mini, homelab). Kebab-case
// validation catches syntactically invalid names separately.

export const RESERVED_SLUGS = new Set([
  // URL-path collisions with the public site
  'api', 'auth', 'static', 'chat', 'ask', 'faq', 'login', 'logout', 'signup',
  'account', 'accounts', 'me', 'install', 'install.sh', 'uninstall',
  'uninstall.sh', 'onboarding', 'onboarding-share', 'setup', 'admin',
  'public-chat', 'network', 'pulse', 'files', 'billing', 'payments',
  'health', 'timeline', 'referrals', 'invite',
  'manifest.json', 'robots.txt', 'sitemap.xml', 'favicon.svg', 'favicon.ico',
  'icon-192.png', 'icon-512.png', '.well-known',

  // System / reserved future
  'root', 'system', 'support', 'help', 'status', 'health', 'ping',
  'white', 'black', 'sensei', 'dojo-team', 'robotdojo',

  // Dev-friendly aliases we might want
  'dev', 'staging', 'prod', 'test', 'local', 'localhost', 'null',
]);

// kebab-case: starts with letter/digit, 2–32 chars, letters/digits/hyphens.
// Enforces memorability + URL-safety + no leading/trailing hyphens.
export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Validate a proposed device handle. Returns null on success, a short
 * human-readable reason on failure.
 */
export function validateSlug(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'Name is required.';
  if (!SLUG_REGEX.test(s)) {
    return 'Use 2–32 lowercase letters, digits, and hyphens. No spaces or punctuation.';
  }
  if (RESERVED_SLUGS.has(s)) return `"${s}" is reserved. Pick another.`;
  if (/--/.test(s)) return 'No double hyphens.';
  return null;
}

/**
 * Suggest a slug from an arbitrary string (typically `hostname -s`).
 * Strips diacritics, collapses invalid chars to hyphens, trims hyphens,
 * caps at 32 chars. Returns '' if nothing usable remained.
 */
export function suggestSlugFromHostname(raw) {
  if (!raw) return '';
  const normalized = String(raw)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!SLUG_REGEX.test(normalized)) return '';
  if (RESERVED_SLUGS.has(normalized)) return '';
  return normalized;
}
