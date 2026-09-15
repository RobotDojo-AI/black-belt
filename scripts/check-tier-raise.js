#!/usr/bin/env node
/**
 * scripts/check-tier-raise.js — no tier goes up without the owner saying so.
 *
 * st_4312c9c0 AC-10. Making escalation cheap must not make it automatic. This
 * gate compares the STAGED config/tier-policy.json against the committed one
 * and rejects the commit when it raises anything without a recorded approval.
 *
 * Three things count as a raise:
 *   1. A persona moving up tier_order (haiku → sonnet → opus).
 *   2. A call site's max_tier moving up.
 *   3. A call site entering the `substrate` category, or a brand-new site
 *      declared substrate. Substrate is the protected class — if it could grow
 *      freely, "hold this at a capable tier" would be self-service.
 *
 * Approvals live in ~/.robotdojo/tier-approvals.json, OUTSIDE the repo, keyed
 * to the sha256 of the staged policy file. Same reasoning as the root lock: a
 * commit that carries its own approval has approved itself. Editing the policy
 * changes the hash, so an approval cannot be reused for a later edit.
 *
 * Approval file shape:
 *   { "approvals": [ { "sha256": "...", "owner_quote": "...", "raises": [...] } ] }
 *
 * Exit 0 = no unapproved raise. Exit 1 = blocked, with each raise named.
 */

// INTELLIGENCE_TIER: extraction — deterministic diff of two JSON documents.
// Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(process.argv.includes('--repo')
  ? process.argv[process.argv.indexOf('--repo') + 1]
  : join(import.meta.dirname, '..'));

const POLICY_PATH = 'config/tier-policy.json';

function approvalPath() {
  return join(homedir(), '.robotdojo', 'tier-approvals.json');
}

/** Staged content of a repo-relative file, or null when it is not staged. */
function stagedContent(file) {
  const r = spawnSync('git', ['show', `:${file}`], { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

/** Committed (HEAD) content of a repo-relative file, or null when it is new. */
function headContent(file) {
  const r = spawnSync('git', ['show', `HEAD:${file}`], { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Compare two policies and return every raise, as human-readable strings.
 * `before` may be null — a brand-new policy file raises nothing by definition
 * except any substrate sites it declares.
 */
export function findRaises(before, after) {
  // Lanes, not model names (st_4312c9c0). tier_order is read as a fallback so a
  // policy written before the lane rename still ranks correctly rather than
  // silently ranking everything "unknown" — which would make this gate pass by
  // accident, the worst failure mode available to it.
  const order = after.lane_order || after.tier_order || ['fast', 'balanced', 'best'];
  const rank = (t) => {
    const i = order.indexOf(t);
    // An unknown tier is treated as the top rank. A typo must fail closed:
    // reading it as "unranked, therefore fine" is how an unapproved raise
    // slips through as a spelling mistake.
    return i === -1 ? order.length : i;
  };
  const raises = [];

  const beforePersonas = (before && before.personas) || {};
  for (const [name, tier] of Object.entries(after.personas || {})) {
    const prev = beforePersonas[name];
    if (prev === undefined) {
      // A new persona is not a raise on its own — there was nothing to raise
      // from. Its tier is reviewed the first time it changes.
      continue;
    }
    if (rank(tier) > rank(prev)) {
      raises.push(`persona ${name}: ${prev} → ${tier}`);
    }
  }

  // A provider switch changes what every lane costs, so it is a spend decision
  // and needs the same approval as raising one. Not caught by the per-site loop
  // below: every lane name stays identical while the money underneath moves.
  if (before && before.provider && after.provider && before.provider !== after.provider) {
    raises.push(`provider: ${before.provider} → ${after.provider}`);
  }

  const beforeSites = (before && before.app_call_sites) || {};
  for (const [path, spec] of Object.entries(after.app_call_sites || {})) {
    const prev = beforeSites[path];
    const tier = spec && (spec.max_lane ?? spec.max_tier);
    const category = spec && spec.category;

    if (!prev) {
      // New site. Declaring it substrate on arrival is the loophole this gate
      // exists to close, so that path needs approval; a new mechanical site
      // does not.
      if (category === 'substrate') {
        raises.push(`new site ${path} declared substrate`);
      }
      continue;
    }
    const prevTier = prev.max_lane ?? prev.max_tier;
    if (rank(tier) > rank(prevTier)) {
      raises.push(`site ${path}: ${prevTier} → ${tier}`);
    }
    if (prev.category !== 'substrate' && category === 'substrate') {
      raises.push(`site ${path}: ${prev.category} → substrate`);
    }
  }

  return raises;
}

function loadApprovedShas() {
  const p = approvalPath();
  if (!existsSync(p)) return new Set();
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    const list = Array.isArray(doc) ? doc : (doc.approvals || []);
    return new Set(list.map((a) => a && a.sha256).filter(Boolean));
  } catch (err) {
    process.stderr.write(`check-tier-raise: could not read ${p}: ${err.message}\n`);
    return new Set();
  }
}

function main() {
  const staged = stagedContent(POLICY_PATH);
  if (staged === null) {
    // Policy not staged — nothing to check. A code-side raise that leaves this
    // file untouched is check-tier-policy-match.js's job, not this one.
    process.stdout.write('check-tier-raise: policy not staged — nothing to check\n');
    return 0;
  }

  let after;
  try {
    after = JSON.parse(staged);
  } catch (err) {
    process.stderr.write(`check-tier-raise: staged policy is not valid JSON: ${err.message}\n`);
    return 1;
  }

  const headText = headContent(POLICY_PATH);
  let before = null;
  if (headText !== null) {
    try {
      before = JSON.parse(headText);
    } catch {
      // A corrupt committed policy cannot be diffed against. Treat as no prior
      // state rather than crashing; the substrate check still applies.
      before = null;
    }
  }

  const raises = findRaises(before, after);
  if (raises.length === 0) {
    process.stdout.write('check-tier-raise: no tier raised\n');
    return 0;
  }

  const hash = sha256(staged);
  if (loadApprovedShas().has(hash)) {
    process.stdout.write(`check-tier-raise: ${raises.length} raise(s) approved by the owner for ${hash.slice(0, 12)}\n`);
    for (const r of raises) process.stdout.write(`  - ${r}\n`);
    return 0;
  }

  process.stderr.write(`check-tier-raise: FAIL (${raises.length})\n`);
  for (const r of raises) process.stderr.write(`  - ${r}\n`);
  process.stderr.write(`\nThese raise cost. They need the owner's recorded approval in ${approvalPath()}\n`);
  process.stderr.write('for the staged policy hash:\n\n');
  process.stderr.write(`${JSON.stringify({ approvals: [{ sha256: hash, owner_quote: '<the owner\'s own words approving this raise>', raises }] }, null, 2)}\n`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
