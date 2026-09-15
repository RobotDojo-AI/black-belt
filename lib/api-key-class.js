/**
 * lib/api-key-class.js — one Anthropic key per spend class.
 *
 * st_4312c9c0. The Console groups cost by API key natively. If every spend class
 * carries its own key, "where did the money go" becomes a dropdown instead of an
 * investigation — permanently, with no instrumentation to maintain.
 *
 * This session is the argument: reconstructing $1,239 took receipts, session
 * logs, file mtimes and screenshots, and ~$274 is still unattributed. Split
 * keys would have answered it in one click.
 *
 * The classes mirror the trigger taxonomy in config/tier-policy.json, because
 * that is the distinction that matters to the owner: work that fires with nobody
 * watching is a different KIND of risk from work he launched. Splitting on model
 * or on module would not separate those.
 *
 * FALLS BACK SAFELY. A class with no dedicated key resolves to the shared key,
 * so this can be adopted one key at a time — start with `autonomous`, which is
 * the only class that spends without being asked.
 *
 * REVOCATION IS THE POINT. Killing the autonomous key stops every background
 * job and leaves chat working. With one shared key that choice does not exist.
 */

// INTELLIGENCE_TIER: orchestration — selects which credential another tier's
// call will bill against. Makes no model call.
export const INTELLIGENCE_TIER = 'orchestration';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secret } from './config.js';

const CONFIG_PATH = join(import.meta.dirname, '..', 'config', 'api-keys.json');

export const CLASSES = Object.freeze(['autonomous', 'interactive', 'explicit', 'research', 'experimental']);

let _cfg = null;
function cfg() {
  if (_cfg) return _cfg;
  try {
    _cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : { classes: {} };
  } catch {
    _cfg = { classes: {} };
  }
  return _cfg;
}

/**
 * classFor — which spend class a call belongs to.
 *
 * Derived from the same two signals the spend guard already uses, so a call
 * cannot be interactive for the ceiling and autonomous for billing.
 *
 * @param {object} args
 * @param {boolean} [args.interactive] a human is waiting on this call
 * @param {string} [args.explicitClass] override, for a run the owner launched
 *   deliberately ('explicit' | 'research' | 'experimental')
 * @returns {string}
 */
export function classFor({ interactive = false, explicitClass = null } = {}) {
  if (explicitClass && CLASSES.includes(explicitClass)) return explicitClass;
  // ROBOTDOJO_SPEND_CLASS lets a CLI run label itself without touching code:
  //   ROBOTDOJO_SPEND_CLASS=research node scripts/profile-companies.js
  const envClass = process.env.ROBOTDOJO_SPEND_CLASS;
  if (envClass && CLASSES.includes(envClass)) return envClass;
  if (interactive) return 'interactive';
  // Default is autonomous, deliberately. An unlabelled call is one nobody
  // thought about, which is exactly the class that should land on the watched
  // key rather than hide inside a bigger one.
  return 'autonomous';
}

/** The keychain base name for a provider, e.g. anthropic -> ANTHROPIC_API_KEY. */
export function providerBase(provider) {
  return cfg().providers?.[provider] || `${String(provider).toUpperCase()}_API_KEY`;
}

/**
 * keyFor — the credential to bill a (provider, class) against.
 *
 * Resolution: env override → per-class keychain entry → shared provider key.
 * Never throws on a missing class credential; falling back is what makes
 * incremental adoption safe, one class and one vendor at a time.
 *
 * Names are derived by CONVENTION — {base}_{CLASS} — rather than enumerated, so
 * adding a provider needs no config edit. That is what lets the class taxonomy
 * survive a vendor switch instead of being rebuilt per vendor.
 *
 * @param {string} spendClass
 * @param {string} [provider]
 * @returns {{key: string|null, source: string, provider: string}}
 */
export function keyFor(spendClass, provider = 'anthropic') {
  const P = String(provider).toUpperCase();
  const C = String(spendClass).toUpperCase();

  const envName = `ROBOTDOJO_${P}_KEY_${C}`;
  if (process.env[envName]) return { key: process.env[envName], source: envName, provider };

  const base = providerBase(provider);
  for (const [name, label] of [
    [`${base}_${C}`, `robotdojo-${base}_${C}`],
    [base, `robotdojo-${base} (shared fallback)`],
  ]) {
    try {
      const v = secret(name);
      if (v) return { key: v, source: label, provider };
    } catch { /* try the next rung */ }
  }

  return { key: null, source: 'none', provider };
}

/** Expected and alarm thresholds for a class, for the report and the watchdog. */
export function budgetFor(spendClass) {
  const e = cfg().classes?.[spendClass];
  return e ? { expectMonthlyUsd: e.expect_monthly_usd, alarmIfOverUsd: e.alarm_if_over_usd, covers: e.covers } : null;
}

/** Providers this config knows how to route. */
export function providers() {
  return Object.keys(cfg().providers || { anthropic: 'ANTHROPIC_API_KEY' });
}

/** Which (provider, class) pairs have a dedicated credential — for the setup report. */
export function adoptionStatus(provider = 'anthropic') {
  return CLASSES.map((c) => {
    const { source } = keyFor(c, provider);
    return {
      provider,
      class: c,
      dedicated: source !== 'none' && !source.includes('shared fallback'),
      source,
    };
  });
}
