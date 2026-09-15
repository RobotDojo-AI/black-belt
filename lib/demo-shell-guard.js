/**
 * demo-shell-guard.js — the single document-boundary chokepoint that keeps the
 * public marketing port (belt === 'demo', 0.0.0.0:4336) from ever serving the
 * private authenticated app shell.
 *
 * WHY this exists: the demo port shares ONE Hono `app` instance with the
 * black-belt app port (4338) and the internal proxy (4339) — see index.js
 * `beltFetch(belt)` which calls setBelt(belt) then app.fetch on the same app.
 * Any unguarded static mount (/apps/*, /chat/*, the serveSpaHtml deep links)
 * would happily serve the authed shell HTML to an unauthenticated demo visitor,
 * who then sees a dead, topic-less, data-less app. This guard redirects every
 * demo-belt request for an authenticated route to the connect page (/connect)
 * BEFORE any app HTML is emitted (fail-closed, deny-by-default).
 *
 * SHARED-BELT SAFETY INVARIANT (load-bearing): the belt is a module-level
 * mutable in lib/server.js (`let _defaultBelt`), set per fetch by setBelt(belt)
 * on the one shared app. This is safe ONLY because the belt injector captures
 * the belt synchronously into the request (`c.set('belt', _defaultBelt)`)
 * before the first await, so no interleaving connection can swap the global
 * mid-request. Therefore this guard MUST read the request-scoped value
 * `c.get('belt')` and NEVER the module global `_defaultBelt`. Reading the
 * global would race under concurrent demo+black traffic and could redirect a
 * black-belt request (breaking the real app) or serve the shell to a demo
 * visitor (the bug this guard closes). The guard runs after the belt injector,
 * so `c.get('belt')` is always populated when it fires.
 *
 * DENY-BY-DEFAULT: the guard serves a demo request only if its path is on the
 * explicit public allowlist below; everything else redirects to /connect.
 */
import { safeRedirect } from './utils.js';

// Single-path public routes — EXACT match only. A prefix here would over-allow:
// in particular '/' as a prefix would allow every path on the site (every path
// starts with '/'), defeating the guard entirely. Each entry is a bare
// marketing/redirect route that serves exactly one document.
const PUBLIC_EXACT = new Set([
  '/',                            // landing page
  '/connect',                     // connect CTA — the redirect target itself
  '/faq',                         // public demo chat
  '/ask',                         // → /faq
  '/architecture',                // → /
  '/architecture.html',           // → /
  '/install-success',             // install handoff page
  '/auth-google-guidance',        // OAuth guidance page
  '/licensing',                   // marketing
  '/privacy',                     // marketing
  '/terms',                       // marketing
  '/robots.txt',                  // crawler policy
  '/sitemap.xml',                 // crawler sitemap
  '/google6102e1268ece5472.html', // GSC verification
  '/llms.txt',                    // AI-bot discovery
  '/llms-full.txt',               // AI-bot discovery
  '/og-image.png',                // OpenGraph image
  '/install.sh',                  // installer script
  '/uninstall.sh',                // uninstaller script
  '/sw.js',                       // service worker
]);

// Asset trees and the connect mount — PREFIX match because each fronts a
// directory of many files (or, for /api/, a whole route tree with its own
// dedicated gate).
const PUBLIC_PREFIXES = [
  '/apps/connect/', // connect SPA mount — the destination of /connect; MUST allow or /connect loops
  '/faq/',          // faq app assets
  '/static/',       // shared marketing + connect assets, fonts, app-registry.js
  '/api/',          // ALL /api/* — already gated by the demo-404 + DEMO_BLOCKED_PREFIXES
                    //   in server.js; let it pass THIS guard and hit that existing gate.
];

/**
 * isPublicDemoPath(path) → boolean. Pure, no deps, no DB.
 * Returns true if `path` is on the public allowlist (exact OR prefix match).
 * Extracted as a named function so the allowlist — the load-bearing
 * loop-avoidance surface — is directly unit-testable without booting the server.
 */
export function isPublicDemoPath(path) {
  return PUBLIC_EXACT.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * demoShellGuard — Hono middleware. The single `app.use('*', demoShellGuard)`
 * chokepoint, registered before every static mount and serveSpaHtml handler.
 *
 * First line is the entire blast-radius defense: on any non-demo belt (black
 * on 4338/4339) it returns immediately, so the real app is never touched. On
 * demo, a public-allowlisted path passes through; anything else redirects to
 * the connect page with a 302 (the convention for an unauthenticated GET of a
 * protected page). The redirect target is the constant '/connect', passed
 * through safeRedirect purely as a same-origin assertion (belt-and-suspenders;
 * the value is not user-supplied).
 */
export function demoShellGuard(c, next) {
  if (c.get('belt') !== 'demo') return next();        // real app untouched (black belt)
  if (isPublicDemoPath(c.req.path)) return next();    // public surface passes
  return c.redirect(safeRedirect('/connect'), 302);   // authed shell → connect
}
