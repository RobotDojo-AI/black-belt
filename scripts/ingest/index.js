/**
 * Entity Pipeline v2 Orchestrator
 *
 * Usage:
 *   node scripts/ingest/index.js                          # incremental run
 *   node scripts/ingest/index.js --reset                  # hard delete + full rebuild
 *   node scripts/ingest/index.js --force                  # force raw graph rebuild
 *   node scripts/ingest/index.js --skip-context           # skip Phase 7 (no LLM spend)
 *   node scripts/ingest/index.js --reset --skip-context   # reset + rebuild + check tiers only
 *
 * Phase sequence:
 *   0 (--reset only)  Hard delete all entity tables. Raw source data (emails, calendar,
 *                     iMessage, contacts, chunks) is never touched.
 *   1. Extract        Snapshot + gather entity candidates from all raw sources
 *   2. Resolve        Match candidates to existing people by email/phone components
 *   3. Timeline       Restore interactions/groups/topics from snapshot
 *   3b. Service-Vendor Pre-sort service-vendor people categorically (st_93fddaf0)
 *   4. Classify       LLM classification + family inference (config + iMessage signal)
 *   5. Score          Dual-track scoring, N2 assignment, dormancy detection (st_93fddaf0)
 *   6. Archive        Zero-signal cleanup, recompute company counts
 *   6b. Exact-Dedupe  Merge exact same human + same company rows with no phone conflict
 *   7. Context        Generate bio files (Haiku/Sonnet). Skip with --skip-context.
 *   8. Entity-link    Wire timeline events to entity participants
 *   8b. Places-Classify Foursquare/OSM place_subtype taxonomy backfill (st_93fddaf0)
 *   9. Entity-facts   Free-tier fact extraction (no model calls)
 *   9b. Companies-Norm Openprise 9-rule + brand-alias normalization (st_93fddaf0)
 *   9c. Exact-Dedupe  Re-run exact cleanup after company canonicalization
 *
 * (Co-occurrence step retired by st_87a0d072 — person_edges dropped.)
 */

import { phaseExtract } from './01-extract.js';
import { phaseResolve, mergeExactDuplicatePeoplePass } from './02-resolve.js';
import { phaseTimeline } from './03-timeline.js';
import { phaseServiceVendor } from './03b-service-vendor.js';
import { phaseClassify } from './04-classify.js';
import { phaseScore } from './05-score.js';
import { phaseArchive, archivePartialIngestNoise } from './06-archive.js';
import { phaseContext, refreshLinkedEntitySourceTimelineSections } from './07-context.js';
import { phaseEntityLink } from './08-entity-link.js';
import { phasePlacesClassify } from './08b-places-classify.js';
import { phaseCompaniesNormalize } from './09b-companies-normalize.js';
// (Co-occurrence step retired by st_87a0d072; the source script is deleted
// and the person_edges table is dropped by migration 070.)
import { bulkExtractFacts } from '../../lib/entity-facts.js';
import { MAINT_PARTIAL_PREFIX } from '../../lib/passive-maintenance-handlers.js';
import { hardDelete } from '../rebuild/phase-01-hard-delete.js';
import { snapshot }   from '../rebuild/phase-00-snapshot.js';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const t0 = Date.now();
const SKIP_CONTEXT = process.argv.includes('--skip-context') || process.env.SKIP_CONTEXT === '1';
const RESET        = process.argv.includes('--reset');
const FORCE_RAW =
  process.argv.includes('--force')
  || process.env.ENTITY_PIPELINE_FORCE === '1'
  || process.env.ROBOTDOJO_ENTITY_PIPELINE_FORCE === '1';
const REFRESH_CONTEXT =
  process.argv.includes('--refresh-context') || process.env.CONTEXT_REFRESH_ALL === '1';
const FULL_INGEST_FINGERPRINT_KEY = 'full_ingest_fingerprint_v2';
const RAW_GRAPH_FINGERPRINT_KEY = 'raw_graph_fingerprint_v1';
const RAW_SOURCE_TABLES = [
  { name: 'emails', max: ['received_at', 'synced_at'] },
  { name: 'email_participants', max: ['created_at'] },
  { name: 'calendar_events', max: ['start_time', 'synced_at'] },
  { name: 'google_contacts', max: ['synced_at'] },
  { name: 'imessages', max: ['date', 'updated_at', 'last_apple_ns'] },
  { name: 'chunks', max: ['created_at', 'event_time', 'id'] },
  { name: 'transcripts', max: ['meeting_date', 'imported_at'] },
  { name: 'health_notes', max: ['date', 'created_at'] },
];
const RAW_SOURCE_CONFIG_FILES = [
  'config/family.json',
  'config/service-vendor-keywords.json',
  'config/nicknames.json',
  'config/surnames-top-25K.json',
];
const RAW_GRAPH_DEPENDENCY_FILES = [
  'scripts/ingest/01-extract.js',
  'scripts/ingest/02-resolve.js',
  'scripts/ingest/03-timeline.js',
  'scripts/ingest/04-classify.js',
  'scripts/ingest/08-entity-link.js',
  'scripts/ingest/timeline-wire.js',
  'lib/entity-resolve.js',
  'lib/canonical-name.js',
];

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashPayload(payload) {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function columnSet(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((c) => c.name));
}

function sourceTableStamp(db, table, maxColumns = []) {
  if (!tableExists(db, table)) return { exists: false };
  const cols = columnSet(db, table);
  const selected = ['COUNT(*) AS row_count'];
  try {
    db.prepare(`SELECT MAX(rowid) AS max_rowid FROM ${quoteIdent(table)} LIMIT 1`).get();
    selected.push('MAX(rowid) AS max_rowid');
  } catch {
    // Virtual/WITHOUT ROWID tables are valid raw sources; they just omit rowid.
  }
  const maxAliases = [];
  for (const col of maxColumns) {
    if (!cols.has(col)) continue;
    const alias = `max_${col.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    selected.push(`MAX(${quoteIdent(col)}) AS ${quoteIdent(alias)}`);
    maxAliases.push([col, alias]);
  }
  const row = db.prepare(`SELECT ${selected.join(', ')} FROM ${quoteIdent(table)}`).get();
  const max = {};
  for (const [col, alias] of maxAliases) max[col] = row?.[alias] ?? null;
  return {
    exists: true,
    row_count: row?.row_count ?? 0,
    max_rowid: row?.max_rowid ?? null,
    max,
  };
}

function statStamp(path) {
  try {
    if (!existsSync(path)) return { path, exists: false };
    const st = statSync(path);
    return {
      path,
      exists: true,
      size: st.size,
      mtime_ms: Math.trunc(st.mtimeMs),
    };
  } catch (err) {
    return { path, exists: false, error: err.message };
  }
}

function addressBookStamp() {
  const root = pathResolve(homedir(), 'Library/Application Support/AddressBook');
  const files = [];
  const addDb = (dbPath) => {
    // -shm is SQLite reader/writer coordination state, not source data. Including
    // it makes read-only AddressBook scans look like user-data changes.
    for (const p of [dbPath, `${dbPath}-wal`]) files.push(statStamp(p));
  };
  addDb(pathResolve(root, 'AddressBook-v22.abcddb'));
  const sources = pathResolve(root, 'Sources');
  try {
    if (existsSync(sources)) {
      for (const source of readdirSync(sources).sort()) {
        addDb(pathResolve(sources, source, 'AddressBook-v22.abcddb'));
      }
    }
  } catch (err) {
    files.push({ path: sources, exists: false, error: err.message });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function fileStamp(relPath) {
  return statStamp(pathResolve(process.cwd(), relPath));
}

function ensurePipelineStateTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_pipeline_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function computeRawSourceFingerprint(db) {
  const payload = {
    version: 1,
    address_book: addressBookStamp(),
    tables: Object.fromEntries(RAW_SOURCE_TABLES.map((table) => [
      table.name,
      sourceTableStamp(db, table.name, table.max),
    ])),
    config_files: Object.fromEntries(RAW_SOURCE_CONFIG_FILES.map((relPath) => [relPath, fileStamp(relPath)])),
    graph_dependency_files: Object.fromEntries(RAW_GRAPH_DEPENDENCY_FILES.map((relPath) => [relPath, fileStamp(relPath)])),
  };
  return { hash: hashPayload(payload), payload };
}

function readStoredFingerprint(db, key) {
  ensurePipelineStateTable(db);
  const row = db.prepare('SELECT value FROM entity_pipeline_state WHERE key=?').get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return { hash: row.value };
  }
}

function writeStoredFingerprint(db, key, fingerprint) {
  ensurePipelineStateTable(db);
  const value = JSON.stringify(fingerprint);
  db.prepare(`
    INSERT INTO entity_pipeline_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value);
}

// st_27561b77 (expansion of st_f1a40461 closed scope) — bounded resumable
// pipeline. The caller passes `--max-seconds N` to bound a single
// slice; between phases the orchestrator checks the wall clock and, when
// expired, prints the pinned partial sentinel and exits 0 cleanly. Every
// phase uses INSERT OR IGNORE on its own keys, so the next slice resumes
// from whichever phase was about to start. The sentinel is the ONE shared
// constant MAINT_PARTIAL_PREFIX (lib/passive-maintenance-handlers.js) —
// matched by scripts/maintenance-phases.js and the maintenance worker;
// importing it here means the token can never drift on one side only.
const MAX_SECONDS = (() => {
  const i = process.argv.indexOf('--max-seconds');
  if (i < 0) return null;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
})();
const DEADLINE_MS = MAX_SECONDS ? t0 + MAX_SECONDS * 1000 : null;
function pastDeadline() {
  return DEADLINE_MS !== null && Date.now() >= DEADLINE_MS;
}
let _partialEmitted = false;
function exitPartial(nextPhase, reason) {
  if (_partialEmitted) return;
  _partialEmitted = true;
  console.log(`${MAINT_PARTIAL_PREFIX}INGEST reason=${reason} next_phase=${nextPhase}`);
}

async function runExactDuplicateCleanup(log) {
  const { default: db } = await import('../../lib/db.js');
  const { loadEmailsSenderIndex, loadContactsIndex } = await import('../../lib/canonical-name.js');
  const emailsSenderIndex = loadEmailsSenderIndex(db);
  const contactsIndex = await loadContactsIndex();
  return mergeExactDuplicatePeoplePass(db, log, { emailsSenderIndex, contactsIndex });
}

async function run() {
  log('=== Entity Pipeline v2 ===');
  if (MAX_SECONDS) log(`slice budget: ${MAX_SECONDS}s (deadline ${new Date(DEADLINE_MS).toISOString()})`);

  let skipSnapshot = false;
  if (RESET) {
    // Snapshot BEFORE deleting so Phase 3 can restore interactions into new person IDs.
    // Phase 1's internal snapshot() call is then skipped (skipSnapshot=true) to avoid
    // overwriting the pre-delete snap with zeros.
    log('=== Phase 0: Hard reset (--reset) ===');
    snapshot(log);
    hardDelete(log);
    skipSnapshot = true;
    log('=== Hard reset complete — rebuilding from raw data ===');
  }

  let rawFingerprint = null;
  let rawSourcesChanged = true;
  let fullIngestComplete = false;
  {
    const { default: db } = await import('../../lib/db.js');
    rawFingerprint = computeRawSourceFingerprint(db);
    const storedFull = readStoredFingerprint(db, FULL_INGEST_FINGERPRINT_KEY);
    const storedGraph = readStoredFingerprint(db, RAW_GRAPH_FINGERPRINT_KEY);
    const fullMatches = !RESET && !FORCE_RAW && storedFull?.hash === rawFingerprint.hash;
    const graphMatches = fullMatches || (!RESET && !FORCE_RAW && storedGraph?.hash === rawFingerprint.hash);
    rawSourcesChanged = !graphMatches;
    fullIngestComplete = fullMatches;
    let reason = 'changed';
    if (RESET) reason = 'reset';
    else if (FORCE_RAW) reason = 'forced';
    else if (fullMatches) reason = 'unchanged';
    else if (graphMatches) reason = 'raw_graph_checkpointed';
    else if (!storedFull?.hash && !storedGraph?.hash) reason = 'first_run';
    log(`Raw-source fingerprint: ${rawFingerprint.hash.slice(0, 12)} (${reason})`);
  }

  // Bounded-resumable: each `checkBudget(nextPhase)` call short-circuits the
  // orchestrator when the wall-clock budget has elapsed. INSERT OR IGNORE
  // semantics in every phase make resume safe — the next slice begins at
  // the SAME phase the previous slice was about to enter, and re-runs any
  // partial work without duplicate writes.
  async function checkBudget(nextPhase) {
    if (!pastDeadline()) return false;
    log(`=== slice budget exhausted before phase ${nextPhase} — exiting partial ===`);
    try {
      await archivePartialIngestNoise(log);
    } catch (err) {
      log(`Partial cleanup failed (non-fatal): ${err.message}`);
    }
    exitPartial(nextPhase, 'slice_budget_elapsed');
    return true;
  }

  let rawGraphFingerprintStored = !rawSourcesChanged;
  async function storeRawGraphFingerprintCheckpoint(reason) {
    if (!rawSourcesChanged || !rawFingerprint || rawGraphFingerprintStored) return;
    const { default: db } = await import('../../lib/db.js');
    writeStoredFingerprint(db, RAW_GRAPH_FINGERPRINT_KEY, rawFingerprint);
    rawGraphFingerprintStored = true;
    log(`Raw graph fingerprint stored (${reason}): ${rawFingerprint.hash.slice(0, 12)}`);
  }

  async function storeFullIngestFingerprintCheckpoint(reason) {
    if (fullIngestComplete || !rawFingerprint) return;
    const { default: db } = await import('../../lib/db.js');
    writeStoredFingerprint(db, FULL_INGEST_FINGERPRINT_KEY, rawFingerprint);
    fullIngestComplete = true;
    log(`Full ingest fingerprint stored (${reason}): ${rawFingerprint.hash.slice(0, 12)}`);
  }

  let resolved = { created: 0, linked: 0, discarded: 0, merged: 0 };

  if (await checkBudget('extract')) return { partial: true };
  if (rawSourcesChanged) {
    await phaseExtract(log, { skipSnapshot });
  } else {
    log('Phase 1 skipped: raw sources unchanged; keeping existing entity candidates');
  }

  // Clear stale WAL reader marks from any prior interrupted session before batch writes.
  // SQLITE_BUSY_SNAPSHOT hangs indefinitely when prior killed processes left SHM marks.
  {
    const { default: db } = await import('../../lib/db.js');
    db.pragma('wal_checkpoint(RESTART)');
    log('WAL checkpoint complete');
  }

  if (rawSourcesChanged) {
    if (await checkBudget('resolve')) return { partial: true };
    resolved = await phaseResolve(log);
    if (await checkBudget('timeline')) return { partial: true };
    await phaseTimeline(log, { skipRestore: RESET });
  } else {
    log('Phase 2 skipped: raw sources unchanged; keeping resolved identities');
    log('Phase 3 skipped: raw sources unchanged; keeping restored interactions');
  }
  // st_93fddaf0 Phase 5 — service-vendor pre-sort runs BEFORE Phase 4
  // (classify) so the deterministic discrimination happens before Haiku
  // burns tokens on rows that will be capped to Acquaintance anyway.
  if (await checkBudget('service_vendor')) return { partial: true };
  await phaseServiceVendor(log);
  if (rawSourcesChanged) {
    if (await checkBudget('classify')) return { partial: true };
    await phaseClassify(log);
    await storeRawGraphFingerprintCheckpoint('raw graph rebuilt');
  } else {
    log('Phase 4 skipped: raw sources unchanged; keeping classifications');
  }
  if (await checkBudget('score')) return { partial: true };
  const scored = await phaseScore(log);
  if (await checkBudget('archive')) return { partial: true };
  await phaseArchive(log, scored);
  if (await checkBudget('exact_duplicate_cleanup')) return { partial: true };
  await runExactDuplicateCleanup(log);

  if (SKIP_CONTEXT) {
    log('=== Context skipped (--skip-context) ===');
    const { default: db } = await import('../../lib/db.js');
    const tiers = db.prepare(
      "SELECT n1, n2, COUNT(*) as n FROM people WHERE archived=0 AND n2 IS NOT NULL GROUP BY n1, n2 ORDER BY n DESC"
    ).all();
    log('N2 distribution:');
    for (const r of tiers) log(`  ${r.n1 || '?'} / ${r.n2}: ${r.n}`);
    const familyRows = db.prepare(
      "SELECT display_name, relation_tag FROM people WHERE n2='Family' AND archived=0 ORDER BY relation_tag, display_name"
    ).all();
    log(`Family members tagged (${familyRows.length}):`);
    for (const r of familyRows) log(`  ${r.relation_tag}: ${r.display_name}`);
  } else {
    if (await checkBudget('context')) return { partial: true };
    const context = await phaseContext(log, { preserveExisting: !REFRESH_CONTEXT });
    log('Context files:', context.generated);
    if (!REFRESH_CONTEXT) log('Context preservation: existing context files left in place; use --refresh-context for a full rewrite');
  }

  // Phase 8b — st_93fddaf0 Phase 7: place ontology classification.
  // Runs BEFORE phaseEntityLink so any downstream surface that joins to
  // places gets the classified subtype. INTELLIGENCE_TIER=extraction.
  if (await checkBudget('places_classify')) return { partial: true };
  try {
    await phasePlacesClassify(log);
  } catch (err) {
    log('Phase 8b (places classify) failed (non-fatal):', err.message);
  }

  // E4 (st_f1a40461): Wire all ingested events into the timeline BEFORE Phase 8
  // entity-link runs. timeline-wire.js populates timeline_events; phaseEntityLink
  // and the needs_regen UPDATE both read timeline_events, so running timeline-wire
  // afterwards (the prior ordering) made entity-link a no-op against an empty table.
  // Non-fatal — timeline wiring failure must not abort the main pipeline.
  if (!fullIngestComplete && await checkBudget('timeline_wire')) return { partial: true };
  if (!fullIngestComplete) {
    const { execSync } = await import('child_process');
    try {
      execSync('node scripts/ingest/timeline-wire.js', {
        stdio: 'inherit',
        env: { ...process.env, ROBOTDOJO_ALLOW_PLAINTEXT: process.env.ROBOTDOJO_ALLOW_PLAINTEXT || '1' },
        cwd: process.cwd(),
      });
    } catch (e) {
      log('timeline-wire failed (non-fatal):', e.message);
    }
  } else {
    log('timeline-wire skipped: full ingest fingerprint unchanged; keeping timeline event wiring');
  }

  // Phase 8: Wire timeline events to entity participants
  if (!fullIngestComplete && await checkBudget('entity_link')) return { partial: true };
  if (!fullIngestComplete) {
    const { default: db } = await import('../../lib/db.js');
    try {
      const linked = await phaseEntityLink(db, log);
      // After Phase 8, refresh only entities that received newly inserted source
      // links, preserving existing synthesis/history and avoiding a regen backlog.
      // WHY after entity-link not before: entity-link is what creates the new
      // timeline_event_entities rows. Running before would miss entities that just
      // got their first event link in this pipeline run.
      const refreshed = refreshLinkedEntitySourceTimelineSections(db, {
        entityIdsByType: {
          person: linked.linkedPersonIds,
          company: linked.linkedCompanyIds,
          place: linked.linkedPlaceIds,
        },
        markFailures: true,
        log,
      });
      const personRefreshed = refreshed.person.updated + refreshed.person.unchanged;
      const companyRefreshed = refreshed.company.updated + refreshed.company.unchanged;
      const placeRefreshed = refreshed.place.updated + refreshed.place.unchanged;
      log(`Phase 8: source timelines refreshed for ${personRefreshed} newly linked people, ${companyRefreshed} newly linked companies, and ${placeRefreshed} newly linked places`);
      const markedFailures = refreshed.person.markedFailures + refreshed.company.markedFailures + refreshed.place.markedFailures;
      if (markedFailures) {
        log(`Phase 8: needs_regen = 1 set for ${markedFailures} source timeline refresh failures`);
      }
    } catch (err) {
      log('Phase 8 (entity link) failed (non-fatal):', err.message);
    }
  } else {
    log('Phase 8 skipped: full ingest fingerprint unchanged; keeping entity timeline links');
  }

  // After Phase 8, mark topics needs_regen=1 only when raw sources changed.
  // WHY: unchanged-source reruns must be a fixed point; dirtying every topic on
  // every run created needless downstream re-synthesis with no new material.
  {
    const { default: db } = await import('../../lib/db.js');
    try {
      if (!fullIngestComplete) {
        const dirty = db.prepare(`
          UPDATE user_topics
             SET needs_regen = 1,
                 updated_at = datetime('now')
           WHERE COALESCE(needs_regen, 0) != 1
        `).run();
        log(`Phase 8: user_topics needs_regen = 1 set for ${dirty.changes} topics`);
      } else {
        log('Phase 8: user_topics regen unchanged; full ingest fingerprint unchanged');
      }
    } catch (err) {
      log('Phase 8 (topic flag) failed (non-fatal):', err.message);
    }
  }

  // Phase 9: Extract entity facts (free tier — no model calls)
  if (await checkBudget('entity_facts')) return { partial: true };
  {
    const { default: db } = await import('../../lib/db.js');
    try {
      bulkExtractFacts(db, log);
    } catch (err) {
      log('Phase 9 (entity facts) failed (non-fatal):', err.message);
    }
  }

  // Phase 9b — st_93fddaf0 Phase 8: company name normalization.
  // Runs AFTER entity-facts so the normalized form is what surfaces in any
  // downstream context-doc generation. INTELLIGENCE_TIER=extraction.
  if (await checkBudget('companies_normalize')) return { partial: true };
  try {
    await phaseCompaniesNormalize(log);
  } catch (err) {
    log('Phase 9b (companies normalize) failed (non-fatal):', err.message);
  }
  {
    await runExactDuplicateCleanup(log);
  }

  // (Co-occurrence step retired by st_87a0d072 — person_edges dropped.)
  // (E4 st_f1a40461: timeline-wire moved to BEFORE Phase 8 entity-link above.)
  await storeFullIngestFingerprintCheckpoint('complete');

  log(`=== Done in ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
  log('People:', resolved.created, 'created,', resolved.linked, 'linked');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
