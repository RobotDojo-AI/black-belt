/**
 * Module loader — thin compatibility shim.
 *
 * st_bc949e7c (2026-05-15) Pass B Phase 3 — belt consolidation.
 *
 * Pre-consolidation, this module pulled an encrypted tarball, decrypted bytes
 * in memory, and dynamic-imported the resulting JS via a data: URL. That
 * plumbing is gone. BB code lives directly under `lib/bb/`, `lib/chat-tools/black/`,
 * and is statically imported. The runtime gate is `isBBActive()` from
 * `lib/cohort/active.js`, checked at the call sites (routes/scripts).
 *
 * This shim preserves the historical `getBBModule()/loadModules()` API so
 * legacy callers that haven't been migrated to direct imports still work.
 * New code should NEVER use this surface — import from `lib/bb/index.js`
 * directly and gate on `isBBActive()`.
 *
 * Why a shim instead of a clean delete: routes/scripts that haven't been
 * touched in this story (e.g. scripts/rebuild/*) still call `getBBModule()`
 * and would break on a hard removal. The shim is bounded — it has 0 LOC of
 * decryption, 0 network calls, 0 disk writes. Each migrated caller drops
 * its `getBBModule()` line; once the last call site is gone, the shim
 * follows.
 */
import { isBBActive } from './cohort/active.js';
import * as bb from './bb/index.js';
import { TOOLS as _TOOLS } from './chat-tools/registry.js';

let _cachedActive = null; // null = unknown, true/false = last known

/**
 * Refreshes the cached active state. Preserves the historical API contract
 * that callers can `await loadModules()` before reading the loaded belt.
 * Always returns synchronously-readable state.
 */
export async function loadModules() {
  _cachedActive = await isBBActive();
  return {
    belt: _cachedActive ? 'black' : 'white',
    modules: _cachedActive ? ['bb'] : [],
  };
}

/**
 * Drops cached state. Reverts to White Belt on next call.
 */
export function unloadModules() {
  _cachedActive = false;
}

export function getLoadedBelt() {
  // Returns the last-known belt without doing an async cohort check. Callers
  // that need a fresh check should `await loadModules()` first.
  return _cachedActive === true ? 'black' : 'white';
}

/**
 * Flatten loaded BB tools into the legacy array shape. Reads the chat-tools
 * registry — see lib/chat-tools/index.js for the canonical tool table.
 *
 * Returns [] in White Belt mode. Returns the BB tool array in Black mode.
 * Schema matches the pre-consolidation `getLoadedTools()` contract:
 *   [{ schema, execute, belt }]
 */
export function getLoadedTools() {
  if (!_cachedActive) return [];
  // The TOOLS object is populated by defineTool() at chat-tools/index.js
  // load time. registry.js has no imports of its own — safe to import
  // statically without circular-dep risk.
  const out = [];
  for (const [name, tool] of Object.entries(_TOOLS)) {
    if (!tool || tool.belt !== 'black') continue;
    out.push({ schema: tool.schema, execute: tool.execute, belt: 'black', name });
  }
  return out;
}

/**
 * Return the BB module namespace (post-consolidation = the static lib/bb/
 * import). Returns null in White Belt mode.
 *
 * Legacy contract: callers do `getBBModule()?.getPeople(...)` and fall back
 * on null. That contract is preserved verbatim — null on no key, the full
 * lib/bb namespace on active key.
 */
export function getBBModule() {
  if (!_cachedActive) return null;
  return bb;
}

/**
 * Called from the tunnel agent on key_revoked / key_issued. Post-consolidation
 * this is a state-cache invalidation — the module is always physically present.
 */
export async function markRevoked() {
  _cachedActive = false;
}
