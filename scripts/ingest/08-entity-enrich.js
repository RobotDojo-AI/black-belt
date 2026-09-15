#!/usr/bin/env node
/**
 * scripts/ingest/08-entity-enrich.js — CLI wrapper for entity body enrichment.
 *
 * Black Belt gate: exits 1 with clear message when BELT !== 'black'.
 * WHY BB gate at CLI layer: enrichment calls Haiku per-chunk (cost) and writes
 * context files (side-effects). White Belt users must not trigger this.
 *
 * Flags:
 *   --entity-id <uuid>   Enrich a single entity
 *   --all                Enrich all entities with needs_regen = 1 (no cap)
 *   (no flags)           Enrich up to 20 entities with needs_regen = 1 (daily batch default)
 *
 * Cost estimate: ~$0.001 per entity (1-3 Haiku calls per entity at 80 tokens each).
 * 20 entities/night ≈ $0.02/night.
 *
 * Compute Tier Protocol: Tier 1 (Haiku) for per-chunk extraction.
 * See lib/entity-enrich.js for REACTS NULL pattern.
 */

import { enrichEntity, backfillTitlesFromFacts, selectEnrichmentCandidates } from '../../lib/entity-enrich.js';

// ── CLI arg parsing (must be before BB gate so --entity-id unknown-id errors correctly) ──
const args = process.argv.slice(2);
const entityIdFlag = (() => {
  const i = args.indexOf('--entity-id');
  return i >= 0 ? (args[i + 1] || null) : null;
})();
const allFlag = args.includes('--all');

// ── Imports (db needed before BB gate when --entity-id is provided) ───────────
const { default: db }         = await import('../../lib/db.js');

// ── Unknown entity-id check — runs before BB gate so non-existent IDs are caught ──
// WHY here: the BB gate exits 1 with a belt message, which would mask the real
// error when --entity-id refers to a UUID not in the DB. Validate first.
if (entityIdFlag) {
  const probe = db.prepare('SELECT id FROM people WHERE id = ?').get(entityIdFlag);
  if (!probe) {
    console.error(`[08-entity-enrich] Entity not found: ${entityIdFlag}`);
    process.exit(1);
  }
}

// ── BB gate — must be before any import that costs money ─────────────────────
// WHY process.env.BELT: LaunchAgent injects BELT=black via env.
// The gate here catches accidental runs in White Belt environments.
const belt = process.env.BELT || 'white';
if (belt !== 'black') {
  console.error(`[08-entity-enrich] Black Belt required for entity enrichment (current: ${belt}). Skipping.`);
  process.exit(1);
}

// anthropic-client no longer passed directly — llm-gateway handles it internally

// WHY 20 cap: a batch run must complete within its spawn timeout (180s default).
// At ~3s per entity (1-3 Haiku calls), 20 entities = ~60s max. --all bypasses cap.
const ENRICH_BATCH_CAP = 20;

const log  = (...a) => console.info(new Date().toISOString().slice(11, 19), ...a);
const warn = (...a) => console.warn(new Date().toISOString().slice(11, 19), 'WARN', ...a);

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  // Seed linkedin_title from entity_facts employer data (free tier — idempotent).
  // WHY on every run: new entity_facts rows may have arrived since last run.
  // The UPDATE only touches rows where linkedin_title is still empty, so cost is O(new rows).
  try {
    const seeded = backfillTitlesFromFacts(db);
    if (seeded > 0) log(`Seeded linkedin_title for ${seeded} people from entity_facts`);
  } catch (err) {
    warn(`backfillTitlesFromFacts failed (non-fatal): ${err.message}`);
  }

  if (entityIdFlag) {
    // Single entity mode — --entity-id <uuid>
    const person = db.prepare('SELECT id, display_name FROM people WHERE id = ?').get(entityIdFlag);
    if (!person) {
      console.error(`[08-entity-enrich] Entity not found or unknown: ${entityIdFlag}`);
      process.exit(1);
    }
    log(`Enriching single entity: ${person.display_name} (${person.id})`);
    try {
      const result = await enrichEntity(db, person, { belt });
      log(`Done: events=${result.events}, titleUpdated=${result.titleUpdated}`);
    } catch (err) {
      console.error(`[08-entity-enrich] Enrichment failed for ${person.id}: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Batch mode: highest-value-first candidate selection.
  //
  // st_b50005df Phase 4: the eligibility gate + tier-then-score priority sort now
  // live in ONE place — selectEnrichmentCandidates() in lib/entity-enrich.js —
  // reused by this daily batch, the always-on passive worker, and the
  // reconciler. The sort is unchanged (Family > Core > Partners > Customers >
  // Network, score DESC within a tier; Acquaintance + retired Extended excluded,
  // st_87a0d072 P8). Driving every path from the same selector means the highest-
  // value entities enrich first regardless of which driver fires.
  const candidates = selectEnrichmentCandidates(db, { limit: allFlag ? null : ENRICH_BATCH_CAP });
  log(`Entities to enrich: ${candidates.length}${allFlag ? ' (--all mode, no cap)' : ` (cap: ${ENRICH_BATCH_CAP})`}`);

  // WHY cost estimate before --all: explicit opt-in costs money, log estimate.
  if (allFlag && candidates.length > 0) {
    const estimatedCost = (candidates.length * 0.001).toFixed(3);
    log(`Estimated cost: ~$${estimatedCost} (${candidates.length} entities × ~$0.001/entity)`);
  }

  let enriched = 0;
  let failed = 0;

  for (const person of candidates) {
    try {
      const result = await enrichEntity(db, person, { belt });
      enriched++;
      log(`  ${person.display_name} (${person.n2}): events=${result.events}, titleUpdated=${result.titleUpdated}`);
    } catch (err) {
      // Non-fatal: log entity_id and continue. needs_regen stays 1 for retry.
      // WHY log entity_id: entity name may contain PII; ID is safe to log.
      warn(`  Enrichment failed for ${person.id}: ${err.message}`);
      failed++;
    }
  }

  log(`=== Entity enrichment done: ${enriched} enriched, ${failed} failed ===`);
}

run().catch(err => {
  console.error('[08-entity-enrich] Fatal:', err.message);
  process.exit(1);
});
