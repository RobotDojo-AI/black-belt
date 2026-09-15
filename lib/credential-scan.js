/**
 * lib/credential-scan.js — AC14: publication refuses on the owner's keys and
 * credentials, not only on his identity and contacts (st_dd0e19d8 Phase 4).
 *
 * WHAT WAS WRONG WITH THE OLD ANSWER. Before this module the only credential
 * detection in the publication path was gate-pii.sh's hand-written pattern list,
 * which catches nothing it does not name — and AC13 established it loaded ZERO
 * patterns inside the export, so it named nothing there either. AC14's sealed
 * text asks for two things: that the detection RUNS, and that "the list covers
 * every credential the product actually stores". A hand-written list can satisfy
 * the first and can never honestly claim the second, because the list and the
 * store drift the moment an integration is added.
 *
 * SO THE LIST IS DERIVED FROM THE STORE, NOT WRITTEN ALONGSIDE IT. Three
 * enumerations, unioned, each recorded separately so the coverage claim is
 * auditable rather than asserted:
 *
 *   1. the integration registry's `credentials.keychainKeys` — the product's own
 *      declaration of what it stores;
 *   2. every `robotdojo-<KEY>` service literal in the scanned tree — the keys
 *      older code names directly, which predate the registry;
 *   3. every `secret('<KEY>')` call site — the read path, which is the one place
 *      a key cannot be used without naming.
 *
 * A key the product can read is a key the product stores. Adding an integration
 * necessarily adds at least one of the three forms, so the enumeration follows
 * the product without maintenance. That is the difference between a list that
 * covers the store and a list that covered it once.
 *
 * WHAT IS MATCHED IS THE VALUE, NOT THE NAME. A tracked file naming
 * `robotdojo-ASANA_PAT` is documentation; a tracked file carrying that token's
 * VALUE is the leak. So each declared key is read from the OS keychain at scan
 * time and its value is searched for as a literal.
 *
 * THREE PROPERTIES THIS MODULE HOLDS, EACH FOR A STATED REASON:
 *
 *   - NO VALUE EVER LEAVES THIS PROCESS. The search is an in-memory string
 *     compare over file contents this process reads. Nothing is passed to `git
 *     grep`, to a shell, or to a temp file — argv is world-readable in the
 *     process table, and a secrets scanner that exposes the secrets it hunts is
 *     worse than no scanner. Findings name the KEY and the file:line; the value
 *     is never printed, never returned, and never logged.
 *
 *   - A SHORT VALUE IS NOT SCANNED, AND SAYS SO. A 6-character stored value
 *     matches ordinary source text everywhere, and a gate that blocks
 *     publication on noise gets routed around. Values below the configured
 *     minimum are reported as `too_short` — an explicit uncovered class for
 *     AC19, not a silent skip.
 *
 *   - AN UNREADABLE KEYCHAIN IS UNAVAILABILITY, NOT CLEANLINESS. On a machine
 *     with no stored credentials every key comes back absent and the scan finds
 *     nothing — correctly, and harmlessly, since there is nothing to leak there.
 *     The publication path passes `--require-credentials` so that state REFUSES
 *     rather than certifies; a fresh clone, which never passes it, keeps today's
 *     no-op. Same shape as gate-pii.sh's --require-patterns.
 *
 * NO OWNER DATA LIVES IN THIS FILE. Key names are product identifiers; values
 * are read at runtime from the OS keychain and held only in memory.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A Keychain service literal. The product's canonical service name is
 * `robotdojo-<KEY>` (lib/keychain.js), and KEY is SCREAMING_SNAKE by convention
 * across every call site. Three characters minimum so a stray `robotdojo-x`
 * fragment in prose cannot enter the enumeration.
 */
export const SERVICE_LITERAL_RE = /robotdojo-([A-Z][A-Z0-9_]{2,})/g;

/** A `secret('KEY')` / `secret("KEY")` read site — the product's own accessor. */
export const SECRET_CALL_RE = /\bsecret\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g;

/** Defaults live in config/defaults.json; this is the fallback if it is absent. */
export const DEFAULT_MIN_SECRET_LENGTH = 16;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The shortest stored value this scan will search for. Tunable — a deployment
 * with deliberately short tokens can lower it — so it lives in config, with an
 * env override for a one-off run, and never as a literal in a scanner.
 */
export function minSecretLength(configDir) {
  const env = Number(process.env.ROBOTDOJO_CREDENTIAL_MIN_LENGTH);
  if (Number.isInteger(env) && env > 0) return env;
  const defaults = readJson(join(configDir, 'defaults.json'));
  const v = defaults && defaults.credentialScan && Number(defaults.credentialScan.minSecretLength);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_MIN_SECRET_LENGTH;
}

/**
 * Enumeration 1 — the integration registry's declared keychain keys.
 *
 * Imported rather than parsed: the registry's purity contract (no lib/db.js, no
 * lib/config.js) means importing it opens no database and reads no secret, and a
 * regex over its source would miss a key expressed as anything but a literal.
 * Returns [] when the module cannot be loaded — an export tree missing it is a
 * recorded gap, not a throw inside a gate.
 */
export async function registryKeychainKeys(repoRoot) {
  try {
    const url = pathToFileURL(join(repoRoot, 'lib', 'integration-registry.js')).href;
    const mod = await import(url);
    const list = mod.INTEGRATIONS || mod.default || [];
    const keys = new Set();
    for (const d of Array.isArray(list) ? list : []) {
      const declared = d && d.credentials && d.credentials.keychainKeys;
      if (Array.isArray(declared)) for (const k of declared) if (k) keys.add(String(k));
    }
    return [...keys];
  } catch {
    return [];
  }
}

/**
 * Enumerations 2 and 3 — service literals and `secret()` call sites in the tree
 * being scanned. `files` is the same list the caller already reads for its other
 * arms, and `readText(file)` returns the file's text or null (binary, oversized,
 * or vanished); one traversal serves every arm.
 */
export function declaredKeysFromSources(readText, files) {
  const fromServices = new Set();
  const fromCalls = new Set();
  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    for (const m of text.matchAll(SERVICE_LITERAL_RE)) fromServices.add(m[1]);
    for (const m of text.matchAll(SECRET_CALL_RE)) fromCalls.add(m[1]);
  }
  return { fromServices: [...fromServices], fromCalls: [...fromCalls] };
}

/**
 * The union, with each enumeration preserved so a caller can state WHERE the
 * coverage comes from. AC14's honesty requirement is about the derivation, not
 * the total.
 */
export function unionKeys({ fromRegistry = [], fromServices = [], fromCalls = [] }) {
  return [...new Set([...fromRegistry, ...fromServices, ...fromCalls])].sort();
}

/**
 * Read each declared key's stored value and classify it. `readSecret(key)`
 * returns the value or a falsy value; it is injected so this module never shells
 * out and so a probe can drive it with a synthetic store.
 *
 * Returns `{ values, tooShort, absent }`. `values` is the only thing that
 * carries secret material, and it never leaves the caller's process.
 */
export function readStoredCredentials(readSecret, keys, { min = DEFAULT_MIN_SECRET_LENGTH } = {}) {
  const values = [];
  const tooShort = [];
  const absent = [];
  for (const key of keys) {
    let value = null;
    try {
      value = readSecret(key);
    } catch {
      value = null;
    }
    const v = value == null ? '' : String(value).trim();
    if (!v) {
      absent.push(key);
      continue;
    }
    if (v.length < min) {
      tooShort.push(key);
      continue;
    }
    values.push({ key, value: v });
  }
  return { values, tooShort, absent };
}

/**
 * Search the scanned files for each stored value.
 *
 * Two passes on purpose: `includes()` over the whole file text is a single
 * native scan and answers "is it here at all" for ~35 values across ~1,500 files
 * in well under a second; only a file that actually hits is split into lines to
 * locate it. Splitting every file for every value would be ~50x the work for a
 * result that is almost always empty.
 *
 * Findings carry the KEY and the location. The value is not in the return shape
 * at all — a caller cannot print it by accident.
 */
export function scanFilesForCredentials(readText, files, values) {
  const findings = [];
  if (values.length === 0) return findings;
  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    for (const { key, value } of values) {
      if (!text.includes(value)) continue;
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (line.includes(value)) findings.push({ key, file, line: i + 1 });
      });
    }
  }
  return findings;
}

/**
 * The whole arm, composed: enumerate, read, scan, and report what was covered.
 *
 * deps: { repoRoot, configDir, readText(file)->string|null, readSecret(key)->string|null }
 *
 * Returns `{ findings, keys, scanned, tooShort, absent, sources, min }`.
 * `scanned` is the number of credentials actually compared against the tree —
 * the number a `--require-credentials` caller asserts is non-zero. Reporting the
 * count is what makes "this ran" checkable instead of assumed; that distinction
 * is the entire reason AC13 exists.
 */
export async function credentialArm(deps, files) {
  const min = minSecretLength(deps.configDir);
  const fromRegistry = await registryKeychainKeys(deps.repoRoot);
  const { fromServices, fromCalls } = declaredKeysFromSources(deps.readText, files);
  const keys = unionKeys({ fromRegistry, fromServices, fromCalls });
  const { values, tooShort, absent } = readStoredCredentials(deps.readSecret, keys, { min });
  const findings = scanFilesForCredentials(deps.readText, files, values);
  return {
    findings,
    keys,
    scanned: values.length,
    tooShort,
    absent,
    sources: {
      registry: fromRegistry.length,
      service_literals: fromServices.length,
      secret_calls: fromCalls.length,
    },
    min,
  };
}
