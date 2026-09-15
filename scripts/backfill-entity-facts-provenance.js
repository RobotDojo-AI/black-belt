#!/usr/bin/env node
/**
 * OWNER-RUN. Backfills entity_facts.source_class / confidence for legacy rows
 * (pre-dating the provenance columns added by
 * lib/entity-facts.js#ensureEntityFactsProvenanceColumns) — free tier rows
 * (structured-column extraction) → primary-source/1.0, haiku/sonnet rows →
 * llm-distilled/0.6 (design-unified-architecture.md §1.2). ~73k live rows as
 * of this pass.
 *
 * Defaults to dry-run — prints the plan, writes nothing. Pass --apply to
 * write. Idempotent (`WHERE source_class IS NULL`); safe to re-run — a
 * second run after --apply reports zero pending rows.
 *
 * Usage:
 *   node scripts/backfill-entity-facts-provenance.js            # dry-run (default)
 *   node scripts/backfill-entity-facts-provenance.js --dry-run  # explicit dry-run
 *   node scripts/backfill-entity-facts-provenance.js --apply    # writes
 *
 * INTELLIGENCE_TIER: extraction — deterministic, no LLM call.
 *
 * This file is intentionally a thin CLI shim (Thin Facade Pattern) — all
 * logic lives in lib/entity-facts.js#backfillEntityFactsProvenance, which is
 * what the test suite exercises against a temp DB. This script itself imports
 * the live db.js singleton and is NEVER executed by the build/test process —
 * only by the owner, on their own schedule.
 */
import db from '../lib/db.js';
import { backfillEntityFactsProvenance } from '../lib/entity-facts.js';

const APPLY = process.argv.includes('--apply');

function main() {
  const result = backfillEntityFactsProvenance(db, { apply: APPLY });

  console.log(`[backfill-entity-facts-provenance] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  if (!result.plan.length) {
    console.log('[backfill-entity-facts-provenance] nothing to do — no legacy rows pending');
    return;
  }
  for (const p of result.plan) {
    console.log(`  model_tier=${p.model_tier || '(null)'}: ${p.count} rows -> source_class=${p.source_class}, confidence=${p.confidence}`);
  }
  console.log(`[backfill-entity-facts-provenance] total pending: ${result.totalPending}, updated: ${result.updated}`);
  if (!APPLY) {
    console.log('[backfill-entity-facts-provenance] dry-run only — re-run with --apply to write.');
  }
}

main();
