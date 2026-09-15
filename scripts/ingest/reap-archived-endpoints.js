#!/usr/bin/env node
/**
 * reap-archived-endpoints.js — the deterministic reaper for archived-endpoint
 * debris nothing reaps today (df_cbd30a5a AC-8, build FIRST).
 *
 * When a person is archived (merge loser, or an un-merge extraction), the
 * upsert-only re-derive path (lib/relationship-builder.js buildRelationships is
 * `ON CONFLICT DO UPDATE`) never DELETES the derived rows that still point at
 * the now-dead endpoint. Two orphan-derived-row classes accumulate:
 *
 *   Drain E — entity_relationships edges whose PERSON-typed endpoint is an
 *             archived person (~3,502 on the owner alone; the whole graph is
 *             larger). buildRelationships upserts new edges but never reaps the
 *             stale ones, so "make my data perfect" needs this run BEFORE it.
 *   Drain C — chunk_entities rows on archived people (orphaned attribution) and
 *             the dead `context_file_path` pointer archived people still carry.
 *
 * WHY a NEW reaper, not extend backfill-merge-loser-cleanup.js: that script
 * already nulls context_file_path/needs_regen and deletes entity_facts on
 * archived rows, but it touches NEITHER entity_relationships NOR chunk_entities.
 * The reaper owns exactly those two classes; the context-pointer null overlaps
 * loser-cleanup harmlessly (both converge to zero, idempotent).
 *
 * SAFE BY DEFAULT: `--dry-run` (the default) counts the debris and writes
 * NOTHING. `--execute` reaps. `--entity <id>` restricts Drain E to the given
 * person's own edges (the AC-6 owner-scoped make-perfect pass); in owner-scoped
 * mode Drain C is skipped entirely — an active entity has no archived-endpoint
 * chunk debris, and its live chunks must never be deleted. `--max-seconds N`
 * stops between batches on the time budget and exits 0-partial (bounded-
 * resumable); the residual-zero assert runs only on a completed pass.
 *
 * INTELLIGENCE_TIER: extraction
 *   Deterministic. No LLM. No synthesis. Reads structured rows, deletes orphan
 *   derived rows by exact id, nulls a dead pointer. (Does not call
 *   getAnthropicClient or reference MODELS; declares its tier per the
 *   Intelligence Tier Protocol for pipeline-write scripts.)
 *
 * Operational discipline (mirrors backfill-merge-loser-cleanup.js):
 *   - writes through lib/db.js (the encrypted pipeline connection), never raw.
 *   - wal_checkpoint(RESTART) before the first write clears stale reader marks.
 *   - id-keyset pagination (edges over the INTEGER PK; people over the TEXT id),
 *     NOT OFFSET.
 *   - transaction PER batch (default 2000) so the live embed daemon — sharing
 *     the single WAL writer — is never starved.
 *   - a pre-mutation JSONL backup of EVERY deleted row is appended per batch to
 *     ~/.robotdojo/reap-archived-backup-<ts>.jsonl so the large delete is
 *     reversible.
 *   - residual-zero assert on a completed pass; idempotent (a second run finds
 *     nothing and is a clean no-op that writes no backup).
 *
 * Usage:
 *   cd ~/robotdojo && node scripts/ingest/reap-archived-endpoints.js            # dry-run (whole graph)
 *   cd ~/robotdojo && node scripts/ingest/reap-archived-endpoints.js --execute  # reap whole graph
 *   cd ~/robotdojo && node scripts/ingest/reap-archived-endpoints.js --entity <id> --dry-run
 *
 * Exit codes: 0 success (incl. nothing-to-do / dry-run / bounded-partial), 1 on
 * a residual-non-zero completed pass or a SQLite/IO error (safe to re-run).
 */

export const INTELLIGENCE_TIER = 'extraction';

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_BATCH = 2000;

// An edge is dead debris when a PERSON-typed endpoint references an archived
// person. Only person-typed endpoints are checked — a company/place endpoint is
// never an archived PERSON. Written once, reused by the count + the drain so the
// residual-zero assert measures exactly the loop predicate.
const ARCHIVED_ENDPOINT_PREDICATE = `(
    (er.entity_type_a = 'person' AND EXISTS (SELECT 1 FROM people p WHERE p.id = er.entity_id_a AND p.archived = 1))
    OR
    (er.entity_type_b = 'person' AND EXISTS (SELECT 1 FROM people p WHERE p.id = er.entity_id_b AND p.archived = 1))
  )`;

// ── Backup path (allowlisted runtime dir; dry-run writes nothing) ────────────
// WHY ~/.robotdojo/backups/ not the root: `backups` is in the root-allowlist;
// a stray backup at the ~/.robotdojo/ root stop-the-lines check-structure.js on
// every scheduled run.
function backupDir() {
  return process.env.ROBOTDOJO_REAP_BACKUP_DIR || resolve(homedir(), '.robotdojo', 'backups');
}
export function reapBackupPathFor(ts = Date.now()) {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `reap-archived-backup-${ts}.jsonl`);
}

/**
 * Append the given `{ table, row }` records to the pre-mutation JSONL backup.
 * Memory-bounded: called per batch with only that batch's rows, never the whole
 * delete set. One JSON object per line.
 */
function makeBackupAppender(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return (records) => {
    if (!records || !records.length) return;
    appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  };
}

/**
 * Count the reap targets. Owner-scoped (`entityId`) counts ONLY Drain E edges on
 * that person's endpoints; whole-graph adds Drain C chunk + dead-pointer counts.
 * Pure reads — drives both the dry-run plan and the residual-zero assert.
 */
export function countReapTargets(db, { entityId = null } = {}) {
  const scoped = entityId ? ' AND (er.entity_id_a = @e OR er.entity_id_b = @e)' : '';
  const edgeSql = `SELECT COUNT(*) n FROM entity_relationships er WHERE ${ARCHIVED_ENDPOINT_PREDICATE}${scoped}`;
  const edges = entityId ? db.prepare(edgeSql).get({ e: entityId }).n : db.prepare(edgeSql).get().n;
  let chunks = 0;
  let deadPointers = 0;
  if (!entityId) {
    chunks = db.prepare(
      "SELECT COUNT(*) n FROM chunk_entities ce JOIN people p ON p.id = ce.entity_id WHERE ce.entity_type = 'person' AND p.archived = 1",
    ).get().n;
    deadPointers = db.prepare(
      'SELECT COUNT(*) n FROM people WHERE archived = 1 AND context_file_path IS NOT NULL',
    ).get().n;
  }
  return { edges, chunks, deadPointers };
}

/** Drain E: delete entity_relationships edges to archived person endpoints. */
function drainEdges(db, { entityId, batch, backup, deadline }) {
  const scoped = entityId ? ' AND (er.entity_id_a = @e OR er.entity_id_b = @e)' : '';
  const selectBatch = db.prepare(`
    SELECT er.id, er.entity_id_a, er.entity_id_b, er.entity_type_a, er.entity_type_b,
           er.relationship_type, er.weight, er.first_seen, er.last_seen, er.source,
           er.created_at, er.updated_at
    FROM entity_relationships er
    WHERE er.id > @lastId AND ${ARCHIVED_ENDPOINT_PREDICATE}${scoped}
    ORDER BY er.id
    LIMIT @limit
  `);
  const del = db.prepare('DELETE FROM entity_relationships WHERE id = ?');
  const delBatch = db.transaction((rows) => { for (const r of rows) del.run(r.id); });

  let lastId = 0;
  let deleted = 0;
  let budgetHit = false;
  while (true) {
    if (deadline && Date.now() >= deadline) { budgetHit = true; break; }
    const params = entityId ? { lastId, limit: batch, e: entityId } : { lastId, limit: batch };
    const rows = selectBatch.all(params);
    if (!rows.length) break;
    if (backup) backup(rows.map((r) => ({ table: 'entity_relationships', row: r })));
    delBatch(rows);
    deleted += rows.length;
    lastId = rows[rows.length - 1].id;
  }
  return { deleted, budgetHit };
}

/** Drain C: delete chunk_entities on archived people + null their dead pointer. */
function drainChunksAndPointers(db, { batch, backup, deadline }) {
  // Keyset over archived people.id (TEXT uuid — stable lexicographic order),
  // restricted to rows that still carry debris so the loop terminates exactly.
  const selectPeople = db.prepare(`
    SELECT id, context_file_path FROM people
    WHERE archived = 1 AND id > ?
      AND (
        context_file_path IS NOT NULL
        OR EXISTS (SELECT 1 FROM chunk_entities ce WHERE ce.entity_type = 'person' AND ce.entity_id = people.id)
      )
    ORDER BY id
    LIMIT ?
  `);
  const selectChunks = db.prepare("SELECT chunk_id, entity_id, entity_type, created_at FROM chunk_entities WHERE entity_type = 'person' AND entity_id = ?");
  const delChunks = db.prepare("DELETE FROM chunk_entities WHERE entity_type = 'person' AND entity_id = ?");
  const nullPtr = db.prepare("UPDATE people SET context_file_path = NULL, needs_regen = 0 WHERE id = ? AND archived = 1 AND context_file_path IS NOT NULL");
  const writeBatch = db.transaction((people) => {
    let chunksDel = 0;
    let ptrs = 0;
    for (const p of people) {
      chunksDel += delChunks.run(p.id).changes;
      ptrs += nullPtr.run(p.id).changes;
    }
    return { chunksDel, ptrs };
  });

  let lastId = '';
  let chunksDeleted = 0;
  let pointersNulled = 0;
  let budgetHit = false;
  while (true) {
    if (deadline && Date.now() >= deadline) { budgetHit = true; break; }
    const people = selectPeople.all(lastId, batch);
    if (!people.length) break;
    if (backup) {
      const records = [];
      for (const p of people) {
        for (const c of selectChunks.all(p.id)) records.push({ table: 'chunk_entities', row: c });
        if (p.context_file_path) records.push({ table: 'people_context_pointer', row: { id: p.id, context_file_path: p.context_file_path } });
      }
      backup(records);
    }
    const res = writeBatch(people);
    chunksDeleted += res.chunksDel;
    pointersNulled += res.ptrs;
    lastId = people[people.length - 1].id;
  }
  return { chunksDeleted, pointersNulled, budgetHit };
}

/**
 * The reaper. Dry-run (execute=false) counts only. On execute: checkpoint,
 * per-batch backup + delete, residual-zero assert on a completed pass.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{execute?:boolean, entityId?:string|null, batch?:number,
 *          maxSeconds?:number|null, backupPath?:string|null, log?:Function}} opts
 * @returns {object} report
 */
export function reapArchivedEndpoints(db, {
  execute = false,
  entityId = null,
  batch = DEFAULT_BATCH,
  maxSeconds = null,
  backupPath = null,
  log = () => {},
} = {}) {
  const before = countReapTargets(db, { entityId });
  const report = {
    execute, entityId, before,
    edgesDeleted: 0, chunksDeleted: 0, pointersNulled: 0,
    backupPath: null, completed: true, residual: null, residualZero: null,
  };
  if (!execute) return report;

  const hasWork = entityId
    ? before.edges > 0
    : (before.edges > 0 || before.chunks > 0 || before.deadPointers > 0);
  if (!hasWork) {
    report.after = before;
    report.residual = 0;
    report.residualZero = true;
    return report; // clean no-op — no checkpoint, no backup file
  }

  // Clear stale WAL reader marks before the write batch (Migration Protocol).
  try { db.pragma('wal_checkpoint(RESTART)'); } catch (err) { log(`  wal_checkpoint skipped: ${err.message}`); }

  const deadline = Number.isFinite(maxSeconds) && maxSeconds > 0 ? Date.now() + maxSeconds * 1000 : null;
  const path = backupPath || reapBackupPathFor();
  const backup = makeBackupAppender(path);
  report.backupPath = path;

  const e = drainEdges(db, { entityId, batch, backup, deadline });
  report.edgesDeleted = e.deleted;

  let cBudget = false;
  if (!entityId) {
    const c = drainChunksAndPointers(db, { batch, backup, deadline });
    report.chunksDeleted = c.chunksDeleted;
    report.pointersNulled = c.pointersNulled;
    cBudget = c.budgetHit;
  }

  report.completed = !e.budgetHit && !cBudget;
  const after = countReapTargets(db, { entityId });
  report.after = after;
  if (report.completed) {
    const residual = entityId ? after.edges : (after.edges + after.chunks + after.deadPointers);
    report.residual = residual;
    report.residualZero = residual === 0;
  }
  return report;
}

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const entIdx = argv.indexOf('--entity');
  const entityId = entIdx >= 0 ? argv[entIdx + 1] : null;
  const msIdx = argv.indexOf('--max-seconds');
  const maxSeconds = msIdx >= 0 ? parseInt(argv[msIdx + 1], 10) : null;
  const batchIdx = argv.indexOf('--batch');
  const batch = batchIdx >= 0 ? Math.max(1, parseInt(argv[batchIdx + 1], 10) || DEFAULT_BATCH) : DEFAULT_BATCH;

  const { default: db } = await import('../../lib/db.js');
  const before = countReapTargets(db, { entityId });
  const scope = entityId ? `owner-scoped ${entityId}` : 'whole-graph';
  console.log(
    `[reap-archived] ${scope} debris: edges=${before.edges}` +
    (entityId ? '' : `, chunks=${before.chunks}, deadPointers=${before.deadPointers}`),
  );

  if (!execute) {
    console.log('[reap-archived] --dry-run (default): no writes performed. Pass --execute to reap.');
    process.exit(0);
  }

  const report = reapArchivedEndpoints(db, { execute: true, entityId, batch, maxSeconds, log: (m) => console.log(m) });
  console.log(
    `[reap-archived] complete: edgesDeleted=${report.edgesDeleted}, chunksDeleted=${report.chunksDeleted}, ` +
    `pointersNulled=${report.pointersNulled}, completed=${report.completed}` +
    (report.backupPath ? `, backup=${report.backupPath}` : ''),
  );
  if (report.completed && report.residualZero === false) {
    console.error(`[reap-archived] WARNING: residual ${report.residual} after pass — re-run.`);
    process.exit(1);
  }
  if (!report.completed) {
    console.log('[reap-archived] --max-seconds budget reached — bounded-partial pass, safe to re-run to finish.');
  }
  process.exit(0);
}

// Run as CLI only (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => { console.error('[reap-archived] fatal:', err.message); process.exit(1); });
}
