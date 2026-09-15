/**
 * lib/viewer-topic-lens.js — loader for the owner's per-topic viewer "lens"
 * (st_e36f5f2b round 4, owner-out PII pass).
 *
 * The viewer (apps/viewer/app.js) is a browser IIFE that cannot read the
 * filesystem at runtime. Its per-topic fallback prose used to hard-code the
 * OWNER's biography (schools, home city, employers, network) directly in tracked
 * source. That biography now lives ONLY in the gitignored
 * config/viewer-topic-lens.user.json override; the tracked viewer ships GENERIC
 * fallback prose. The server (lib/server.js `serveViewerHtml`) reads this loader
 * and injects the owner lens as `window.RobotDojoTopicLens` — exactly the same
 * injection channel it already uses for `window.RobotDojoViewerPreload`. On a
 * fresh clone with no override the injection is an empty lens and the viewer
 * renders its generic tracked defaults.
 *
 * There is deliberately NO tracked base file: the "generic defaults" are the
 * prose literals inside apps/viewer/app.js, and the browser prefers a lens entry
 * over the generic default per topic at render time. This loader only supplies
 * the owner override (or an empty lens when it is absent).
 *
 * Mirrors the lib/asana-routing-config.js + config/asana-routing.user.json
 * convention: HOME-resolved override path, env hook for tests, graceful no-op
 * when the file is missing or malformed, cached per process.
 *
 * Deliberately db-free: nothing here reaches lib/db.js.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// HOME-resolved (not module-relative) so the override lives in the owner's own
// checkout, is read at runtime, and is never shipped or committed
// (config/.gitignore). The env hook lets tests point at a synthetic fixture
// without touching the real file (mirrors ROBOTDOJO_ASANA_ROUTING_USER_PATH).
function userOverridePath() {
  return process.env.ROBOTDOJO_VIEWER_TOPIC_LENS_USER_PATH
    || resolve(homedir(), 'robotdojo', 'config', 'viewer-topic-lens.user.json');
}

let _lens = null;

/**
 * Load the owner viewer-topic-lens override, or an empty lens when it is absent.
 * Returns `{ lenses, prewarmRoutes }`:
 *   - lenses: array of `{ match, currentRead?, deepBrief?, entityRead? }` where
 *     `match` is a case-insensitive regex string tested against the viewer's
 *     normalized topic key. The tracked viewer picks the field it needs and
 *     falls back to its own generic literal when no entry matches.
 *   - prewarmRoutes: owner-specific hot document routes to warm the viewer
 *     payload cache at boot (the product-safe routes stay in lib/server.js).
 *
 * Cached per process — the file is static config; a change means a new deploy,
 * and every consumer (the server, the QA render smoke) runs a fresh process.
 * A missing or malformed override degrades to the empty lens, never throws.
 */
export function loadViewerTopicLens() {
  if (_lens) return _lens;
  const empty = { lenses: [], prewarmRoutes: [] };
  const overridePath = userOverridePath();
  if (!existsSync(overridePath)) {
    _lens = empty;
    return _lens;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(overridePath, 'utf8'));
  } catch (err) {
    console.warn(`[viewer-topic-lens] failed to parse ${overridePath}: ${err.message} — using empty lens`);
    _lens = empty;
    return _lens;
  }
  _lens = {
    lenses: Array.isArray(parsed?.lenses) ? parsed.lenses : [],
    prewarmRoutes: Array.isArray(parsed?.prewarmRoutes) ? parsed.prewarmRoutes : [],
  };
  return _lens;
}

/** The injectable lens object the browser reads as `window.RobotDojoTopicLens`. */
export function viewerTopicLensForInjection() {
  return { lenses: loadViewerTopicLens().lenses };
}

/** Owner-specific hot document routes for the boot-time viewer payload prewarm. */
export function viewerPrewarmRoutes() {
  return loadViewerTopicLens().prewarmRoutes;
}

/** Test-only: force the override file to be re-read on the next call. */
export function _resetViewerTopicLensForTests() {
  _lens = null;
}
