#!/usr/bin/env node
/**
 * One-time backfill: clean stale derived state off archived merge-loser rows.
 *
 * st_2cd1af73 Phase 3. ROOT-CAUSE companion to the mergeInto fix in
 * scripts/ingest/02-resolve.js. Historically, when resolution merged two people
 * it archived the loser but left the loser's `context_file_path` pointer and its
 * `entity_facts` rows intact. The winner already inherited the loser's
 * chunk_entities, so the loser's context document + facts are dead duplicates
 * that:
 *   (a) inflate the "enriched entities" count (~18k phantom rows — the headline
 *       "34k enriched" decomposed to ~15.8k active + ~18k stale losers),
 *   (b) leave fact rows joined to an archived, invisible person,
 *   (c) leave a context_file_path on a row that should resolve to nothing.
 *
 * From now on mergeInto cleans this at merge time. This script applies the same
 * cleanup ONCE to the rows that were merged BEFORE that fix shipped. After it
 * runs, the archived set carries no context pointers and no facts; the active
 * set is the true enriched population.
 *
 * Cleanup per archived loser (identical to mergeInto's new block):
 *   - context_file_path → NULL
 *   - needs_regen       → 0  (an archived row must never be picked up by the
 *                             regen scanner, which walks needs_regen=1)
 *   - entity_facts rows (entity_type='person', entity_id=loser) → DELETE
 *
 * Target set = archived people that still carry stale state:
 *   archived = 1 AND (context_file_path IS NOT NULL OR needs_regen = 1
 *                     OR has any person entity_facts row)
 *
 * WHY through lib/db.js: the owner authorized deleting stale pipeline data, and
 * the rule is that data writes go through the pipeline's own DB path — the same
 * encrypted connection the pipeline uses — never a one-off raw-SQLite write.
 *
 * INTELLIGENCE_TIER: extraction
 *   Deterministic. No LLM. No synthesis. Reads structured columns, nulls a
 *   pointer / flag, deletes fact rows by exact id. (This script does not call
 *   getAnthropicClient or reference MODELS, but declares its tier per the
 *   Intelligence Tier Protocol for pipeline-write scripts.)
 *
 * Operational discipline (build-conventions Migration Protocol):
 *   - Short transactions in batches (default 2,000 ids) so the live embed
 *     daemon — which is draining concurrently — is never starved of the single
 *     WAL writer. We yield the writer between every batch.
 *   - wal_checkpoint(RESTART) before the first batch clears stale reader marks
 *     left by any prior killed process (prevents SQLITE_BUSY_SNAPSHOT).
 *   - id-keyset pagination over the people rowid, NOT OFFSET (OFFSET re-scans
 *     each batch → O(n²)).
 *   - Idempotent: a second run finds an empty target set and exits 0.
 *
 * Usage:
 *   # preview only — counts the target set, writes nothing:
 *   cd ~/robotdojo && ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/ingest/backfill-merge-loser-cleanup.js --dry-run
 *
 *   # execute the cleanup:
 *   cd ~/robotdojo && ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/ingest/backfill-merge-loser-cleanup.js
 *
 * Flags:
 *   --dry-run        count the target set and print the plan; make no writes.
 *   --batch <n>      ids per transaction (default 2000).
 *   --verbose|-v     per-batch progress.
 *
 * Exit codes: 0 success (incl. nothing-to-do), 1 SQLite/IO error (safe to re-run).
 */

export const INTELLIGENCE_TIER = 'extraction';

import db from '../../lib/db.js';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose') || argv.includes('-v');
const batchIdx = argv.indexOf('--batch');
const BATCH = batchIdx >= 0 ? Math.max(1, parseInt(argv[batchIdx + 1], 10) || 2000) : 2000;

function vlog(...a) { if (VERBOSE) console.log(...a); }

/**
 * Count the cleanup target set + the component counts, for both the dry-run
 * plan and the post-run verification. Pure reads.
 */
function targetCounts() {
  const stalePtr = db.prepare(
    'SELECT COUNT(*) n FROM people WHERE archived = 1 AND context_file_path IS NOT NULL',
  ).get().n;
  const staleRegen = db.prepare(
    'SELECT COUNT(*) n FROM people WHERE archived = 1 AND needs_regen = 1',
  ).get().n;
  const staleFactRows = db.prepare(`
    SELECT COUNT(*) n FROM entity_facts ef
    JOIN people p ON p.id = ef.entity_id
    WHERE ef.entity_type = 'person' AND p.archived = 1
  `).get().n;
  // Rows needing ANY cleanup — drives the batch loop.
  const targetRows = db.prepare(`
    SELECT COUNT(*) n FROM people p
    WHERE p.archived = 1
      AND (
        p.context_file_path IS NOT NULL
        OR p.needs_regen = 1
        OR EXISTS (
          SELECT 1 FROM entity_facts ef
          WHERE ef.entity_type = 'person' AND ef.entity_id = p.id
        )
      )
  `).get().n;
  return { targetRows, stalePtr, staleRegen, staleFactRows };
}

function main() {
  const before = targetCounts();
  console.info(
    `[merge-loser-cleanup] target archived rows needing cleanup: ${before.targetRows} ` +
    `(context_file_path=${before.stalePtr}, needs_regen=${before.staleRegen}, fact_rows=${before.staleFactRows})`,
  );

  if (DRY_RUN) {
    console.info('[merge-loser-cleanup] --dry-run: no writes performed.');
    process.exit(0);
  }

  if (before.targetRows === 0) {
    console.info('[merge-loser-cleanup] nothing to do — archived set already clean.');
    process.exit(0);
  }

  // Clear stale WAL reader marks before the first write (Migration Protocol).
  try {
    db.pragma('wal_checkpoint(RESTART)');
  } catch (err) {
    console.warn('[merge-loser-cleanup] wal_checkpoint failed (continuing):', err.message);
  }

  // id-keyset pagination over the target rows. We re-select the next batch of
  // ids each loop (id > lastId) rather than OFFSET so each batch is an O(1)
  // index seek. The predicate matches targetCounts so the loop terminates
  // exactly when no dirty archived row remains above lastId.
  const selectBatch = db.prepare(`
    SELECT id FROM people p
    WHERE p.archived = 1
      AND p.id > ?
      AND (
        p.context_file_path IS NOT NULL
        OR p.needs_regen = 1
        OR EXISTS (
          SELECT 1 FROM entity_facts ef
          WHERE ef.entity_type = 'person' AND ef.entity_id = p.id
        )
      )
    ORDER BY p.id
    LIMIT ?
  `);
  const clearPerson = db.prepare(
    'UPDATE people SET context_file_path = NULL, needs_regen = 0 WHERE id = ?',
  );
  const deleteFacts = db.prepare(
    "DELETE FROM entity_facts WHERE entity_type = 'person' AND entity_id = ?",
  );

  // WHY transaction PER batch (not one mega-transaction): the embed daemon is
  // live and shares the single WAL writer. A 30k-row transaction would hold the
  // writer for its full duration and starve the daemon. Batching to ~2k ids per
  // commit yields the writer ~hundreds of times so embedding keeps progressing.
  const writeBatch = db.transaction((ids) => {
    let factRowsDeleted = 0;
    for (const id of ids) {
      clearPerson.run(id);
      factRowsDeleted += deleteFacts.run(id).changes;
    }
    return factRowsDeleted;
  });

  const started = Date.now();
  let lastId = '';            // people.id is a TEXT uuid — string keyset.
  let peopleCleaned = 0;
  let factsDeleted = 0;
  let batches = 0;

  // people.id is a UUID string; ORDER BY id is a stable lexicographic order, so
  // id > lastId (string compare) is a correct keyset cursor over that order.
  while (true) {
    const rows = selectBatch.all(lastId, BATCH);
    if (!rows.length) break;
    const ids = rows.map((r) => r.id);
    factsDeleted += writeBatch(ids);
    peopleCleaned += ids.length;
    lastId = ids[ids.length - 1];
    batches++;
    vlog(`[merge-loser-cleanup] batch ${batches}: ${peopleCleaned} people cleaned so far`);
  }

  const after = targetCounts();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.info(
    `[merge-loser-cleanup] complete: ${peopleCleaned} archived people cleaned, ` +
    `${factsDeleted} fact rows deleted, ${batches} batches, ${elapsed}s`,
  );
  console.info(
    `[merge-loser-cleanup] residual target rows: ${after.targetRows} ` +
    `(context_file_path=${after.stalePtr}, needs_regen=${after.staleRegen}, fact_rows=${after.staleFactRows})`,
  );

  // The residual MUST be zero — the loop predicate is the target predicate.
  if (after.targetRows !== 0) {
    console.error(`[merge-loser-cleanup] WARNING: ${after.targetRows} rows still dirty after pass — re-run.`);
    process.exit(1);
  }
  process.exit(0);
}

try {
  main();
} catch (err) {
  console.error('[merge-loser-cleanup] fatal:', err.message);
  process.exit(1);
}
