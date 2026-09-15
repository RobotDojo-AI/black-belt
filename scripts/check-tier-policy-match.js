#!/usr/bin/env node
/**
 * scripts/check-tier-policy-match.js — the declared lane is the real lane.
 *
 * st_4312c9c0. check-tier-raise.js watches the policy file. This one watches the
 * code, and catches the opposite move: raising a real call site to a more
 * expensive model while leaving config/tier-policy.json alone, so the
 * declaration stays honest-looking and the bill goes up anyway.
 *
 * TWO DESIGN CHOICES, both learned from the first version being brittle:
 *
 * 1. DISCOVERY, NOT REGISTRATION. The gate scans lib/, scripts/, and routes/ for
 *    model references and fails on any file that is not classified in the
 *    policy. The first version only checked sites the policy already listed,
 *    which meant a new call site — exactly the thing worth catching — was
 *    invisible to it. A gate you have to remember to update is not a gate.
 *
 * 2. LANES, NOT MODEL NAMES. The policy declares 'fast' | 'balanced' | 'best'.
 *    Those resolve to concrete models through config/models.json per provider,
 *    so switching the application from Anthropic to Google or bumping a model
 *    generation is a config change — not an edit to this gate, the policy, or
 *    any call site. Model strings appear here only in the reverse map that
 *    turns a MODELS.* symbol back into the lane it belongs to.
 *
 * The check is a CEILING, not equality. A file declared 'balanced' may use the
 * fast lane freely — several sites legitimately escalate on hard input, or pick
 * per entity. What it may not do is exceed its declared lane.
 *
 * Comments are stripped before matching: a commented-out reference is not spend,
 * and failing on one trains people to delete the comment rather than fix the call.
 *
 * Exit 0 = code matches the declared ceilings and everything is classified.
 * Exit 1 = a site exceeds its lane, or an undeclared site exists.
 */

// INTELLIGENCE_TIER: extraction — deterministic source scan against a JSON
// declaration. Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const REPO_ROOT = resolve(process.argv.includes('--repo')
  ? process.argv[process.argv.indexOf('--repo') + 1]
  : join(import.meta.dirname, '..'));

const POLICY_PATH = join(REPO_ROOT, 'config/tier-policy.json');
const SCAN_ROOTS = ['lib', 'scripts', 'routes'];

// MODELS.* symbol → lane. The ONLY place model vocabulary appears; everything
// downstream reasons in lanes. `frontier` is an alias for the top lane.
const SYMBOL_TO_LANE = {
  haiku: 'fast',
  haiku_v4: 'fast',
  sonnet: 'balanced',
  opus: 'best',
  frontier: 'best',
};

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
}

/** Lanes a source file actually reaches for, comments excluded. */
export function lanesReferenced(source) {
  const stripped = stripComments(source);
  const found = new Set();
  for (const m of stripped.matchAll(/MODELS\.(haiku|haiku_v4|sonnet|opus|frontier)\b/g)) {
    found.add(SYMBOL_TO_LANE[m[1]]);
  }
  for (const m of stripped.matchAll(/modelFor\(\s*['"](fast|balanced|best)['"]/g)) {
    found.add(m[1]);
  }
  return found;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(abs);
    else if (name.endsWith('.js') || name.endsWith('.mjs')) yield abs;
  }
}

/** Every file that reaches for a model constant, repo-relative. */
export function discoverCallSites(repoRoot = REPO_ROOT) {
  const found = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(join(repoRoot, root))) {
      const lanes = lanesReferenced(readFileSync(abs, 'utf8'));
      if (lanes.size) found.push({ path: relative(repoRoot, abs), lanes });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function main() {
  if (!existsSync(POLICY_PATH)) {
    process.stderr.write('check-tier-policy-match: config/tier-policy.json missing\n');
    return 1;
  }

  let policy;
  try {
    policy = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
  } catch (err) {
    process.stderr.write(`check-tier-policy-match: policy is not valid JSON: ${err.message}\n`);
    return 1;
  }

  const order = policy.lane_order || ['fast', 'balanced', 'best'];
  const rank = (lane) => {
    const i = order.indexOf(lane);
    // An unknown lane ranks top: a typo must fail closed, not read as "fine".
    return i === -1 ? order.length : i;
  };

  const sites = policy.app_call_sites || {};
  const infra = policy.infrastructure || {};
  const errors = [];
  const discovered = discoverCallSites();

  for (const { path, lanes } of discovered) {
    if (infra[path]) continue; // classified as naming constants without choosing a tier
    const spec = sites[path];
    if (!spec) {
      errors.push(`${path}: reaches for a model but is not classified in tier-policy.json (add it under app_call_sites with a max_lane, or under infrastructure if it makes no call of its own)`);
      continue;
    }
    const ceiling = spec.max_lane;
    if (!ceiling) {
      errors.push(`${path}: no max_lane declared`);
      continue;
    }
    for (const lane of lanes) {
      if (rank(lane) > rank(ceiling)) {
        errors.push(`${path}: uses the ${lane} lane but is declared max_lane ${ceiling}`);
      }
    }
  }

  // A declared site that no longer exists is stale policy — not a raise, but it
  // must not pass silently or the policy rots into fiction.
  const discoveredPaths = new Set(discovered.map((d) => d.path));
  for (const path of Object.keys(sites)) {
    if (!discoveredPaths.has(path)) {
      errors.push(`${path}: declared in policy but no longer reaches for a model (remove the entry)`);
    }
  }

  if (errors.length) {
    process.stderr.write(`check-tier-policy-match: FAIL (${errors.length})\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write('\nEither lower the call site, or raise its declaration in\n');
    process.stderr.write('config/tier-policy.json — which check-tier-raise.js will then ask you to approve.\n');
    return 1;
  }

  const provider = policy.provider || 'anthropic';
  process.stdout.write(`check-tier-policy-match: ok — ${discovered.length} call site(s) discovered, all classified and within their declared lane (provider: ${provider})\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
