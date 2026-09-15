/**
 * tier-0/index.js — Aggregator for Tier 0 signals.
 *
 * WHY a separate aggregator: each signal is independent and trivial. The
 * aggregator's job is the "≥2 agree, no signal disagrees" rule that
 * short-circuits before paying for a Haiku call. This is the cost-discipline
 * pattern from the Compute Tier Protocol.
 *
 * Returns one of:
 *   - `{ ...decision, signals: [...], tier: 0 }` if ≥2 signals agree on the same
 *     (action, destination) AND no signal disagrees on (action, destination)
 *   - `{ noShortCircuit: true, signals: [...] }` otherwise
 *
 * The orchestrator escalates to Tier 1 (Haiku) when there's no short-circuit,
 * passing the collected signals as part of the prompt context.
 */

import { detectPathDirective } from './path-directive.js';
import { detectByFilename } from './filename.js';
import { detectContentHeader } from './content-header.js';
import { detectCodebaseRef } from './codebase-ref.js';
import { detectPackageJson } from './package-json.js';
import { detectPendingMigration } from './pending-migration.js';
import { detectDuplicateHash } from './duplicate-hash.js';
import { detectDbRedundancy } from './db-redundancy.js';

export async function runTier0(absPath, relPath, opts = {}) {
  const { registry, repoRoot } = opts;

  // Run all signals. Most are sync; codebase-ref shells out to grep. We don't
  // actually need parallelism here — the per-file budget is sub-second total.
  const signals = [
    detectPathDirective(absPath),
    detectByFilename(absPath, relPath, registry),
    detectContentHeader(absPath),
    detectPackageJson(absPath, { repoRoot }),
    detectPendingMigration(absPath, relPath, registry),
    detectDuplicateHash(absPath, { repoRoot }),
    detectDbRedundancy(absPath),
    // codebase-ref is advisory and intentionally last — its purpose is to
    // surface "no consumer" / "writer found" context for Tier 1, not to vote.
    detectCodebaseRef(absPath, { repoRoot }),
  ].filter(Boolean);

  // Tally votes by (action, destination). codebase-ref signals with action===null
  // are advisory (don't vote on a destination directly) but still count toward
  // the signals array passed up.
  const votes = new Map(); // key: action|destination → { count, signals[] }
  for (const sig of signals) {
    if (!sig.action) continue;
    const key = `${sig.action}|${sig.destination}`;
    if (!votes.has(key)) votes.set(key, { count: 0, action: sig.action, destination: sig.destination, signals: [] });
    const v = votes.get(key);
    v.count += 1;
    v.signals.push(sig);
  }

  // Disagreement detection: if >1 distinct (action, destination) pairs each
  // got at least 1 vote, signals disagree → no short-circuit, escalate.
  const distinct = [...votes.values()];
  if (distinct.length > 1) {
    return { noShortCircuit: true, signals, reason: 'tier-0 signals disagree on destination' };
  }
  if (distinct.length === 0) {
    return { noShortCircuit: true, signals, reason: 'no tier-0 directive signal' };
  }

  // Single (action, destination) cluster. Need ≥2 distinct signals voting for it.
  const top = distinct[0];
  if (top.count < 2) {
    return { noShortCircuit: true, signals, reason: `only 1 tier-0 signal (${top.signals[0]?.signal_name}); need ≥2 to short-circuit` };
  }

  // Confidence = max of contributing signals (capped at 1).
  const conf = Math.min(1, Math.max(...top.signals.map(s => s.confidence ?? 0.6)));

  return {
    tier: 0,
    action: top.action,
    destination: top.destination,
    confidence: conf,
    reason: `tier-0 short-circuit: ${top.signals.map(s => s.signal_name).join('+')} agree`,
    signals,
    what_it_is: '',
    intent: '',
    warnings: [],
  };
}
