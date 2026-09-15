#!/usr/bin/env node
/**
 * Maintenance phase runner — st_fd14cdd4 AC8 (formerly the overnight runner).
 *
 * One bounded phase per invocation. The overnight batch concept is DELETED:
 * no run-all orchestrator, no 9 PM LaunchAgent, no REPORT roll-up. Scheduling
 * lives in lib/maintenance-routines.js (freshness windows seeded by the
 * supervisor probe); execution lives in the off-process maintenance worker
 * (scripts/supervisor-maintenance-worker.mjs), which spawns this script as a
 * bounded-resumable child:
 *
 *   node scripts/maintenance-phases.js --phase CLEAN --max-seconds 240
 *
 * Contract per slice: run at most --max-seconds of wall clock, exit 0 even
 * when stopping early, and print the pinned MAINT_PARTIAL_PREFIX sentinel so
 * the worker re-enqueues a continuation slice. Phase writes are idempotent
 * (INSERT OR IGNORE / overwrite-by-key) so a partial pass is always safe.
 *
 * Phases (each independent): CLEAN, RESCORE, INGEST, ENTITIES, STYLE, ENRICH,
 * TOPICS, RECLASSIFY, RECLASSIFY_CHUNKS, BRIEF, MEMORY_INGEST, MEMORY_RECALC,
 * MEMORY_VERIFY, TIMELINE_RECALC, AUDIT, MONITOR, DMARC, TLS_RPT, GSC,
 * INDEXNOW.
 *
 * Retired by name (st_fd14cdd4): IMPORTS (exact duplicate of the
 * imports_snapshot passive job that runs every sync cycle), REPORT (formatted
 * a full-orchestrator run that no longer exists — its day-over-day history
 * jsonl + anomaly alarms moved into AUDIT), and the run-all path itself.
 * EMBED was already retired by st_b50005df — embedding is owned end-to-end by
 * the always-on chunk-embed daemon via lib/rag/embed.js.
 *
 * CLI:
 *   node scripts/maintenance-phases.js --phase CLEAN                   # one phase
 *   node scripts/maintenance-phases.js --phase CLEAN --max-seconds 240 # bounded slice
 *   node scripts/maintenance-phases.js --phase CLEAN --dry-run         # no writes
 */
// st_f6315f0b: these are the heaviest scheduled workers — CLEAN and RESCORE
// each touch large slices of the DB. The maintenance worker already yields to
// server activity; the idle gate inside the writer guard adds a second
// guardrail when a phase is invoked manually mid-session.
export const IDLE_GATED = true;

import { mkdirSync, existsSync, readFileSync, appendFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { withLaunchDbWriterGuard } from '../lib/db-writer-policy.js';
import { enrichmentDecision } from '../lib/entity-enrich-policy.js';
import { MAINT_PARTIAL_PREFIX, MAINT_WRITER_GUARD_NAME } from '../lib/passive-maintenance-handlers.js';
import { companyStandaloneGuardSql, personStandaloneGuardSql } from '../lib/entity-standalone.js';

export const INTELLIGENCE_TIER = 'orchestration';

let db;
let createNotificationTask;
let ownerEmails;
let computeAllScores;
let computePlaceScores;
let computeEntityRanks;
// st_b50005df: the embed-primitive bindings (embedBatch, EMBED_DIM,
// EMBED_MODEL, contentHash, embeddingSignature, vectorToBuffer) were removed
// with the old overnight embed phase. Embedding is owned by lib/rag/embed.js
// via the always-on chunk-embed-worker; maintenance no longer embeds, so it no
// longer needs them.
let getTimelineStats;
let computeReferralScores;
let scanForDocuments;
let getNetworkStats = () => ({});
let buildAddressTimeline = () => {};
let syncOuraLatest;
let syncEightSleepLatest;
let config;
let sendEmail;
let runDmarcParse;
let runTlsRptParse;
let runGscPoll;
let getBBStatus;

async function loadDeps() {
  const [
    dbModule,
    asanaModule,
    identityModule,
    scoringModule,
    timelineSchemaModule,
    referralModule,
    documentVaultModule,
    cohortModule,
    bbModule,
    ouraModule,
    eightSleepModule,
    configModule,
    emailModule,
    dmarcModule,
    tlsRptModule,
    gscModule,
  ] = await Promise.all([
    import('../lib/db.js'),
    import('../lib/asana.js'),
    import('../lib/identity.js'),
    import('../lib/scoring.js'),
    import('../lib/timeline-schema.js'),
    import('../lib/referral.js'),
    import('../lib/document-vault.js'),
    import('../lib/cohort/active.js'),
    import('../lib/bb/index.js'),
    import('../lib/oura-sync.js'),
    import('../lib/eight-sleep-sync.js'),
    import('../lib/config.js'),
    import('../lib/email.js'),
    import('./dmarc-parse.js'),
    import('./tls-rpt-parse.js'),
    import('./gsc-poll.js'),
  ]);

  db = dbModule.default;
  createNotificationTask = asanaModule.createNotificationTask;
  ownerEmails = identityModule.ownerEmails;
  computeAllScores = scoringModule.computeAllScores;
  computePlaceScores = scoringModule.computePlaceScores;
  computeEntityRanks = scoringModule.computeEntityRanks;
  getTimelineStats = timelineSchemaModule.getTimelineStats;
  computeReferralScores = referralModule.computeReferralScores;
  scanForDocuments = documentVaultModule.scanForDocuments;
  syncOuraLatest = ouraModule.syncOuraLatest;
  syncEightSleepLatest = eightSleepModule.syncEightSleepLatest;
  config = configModule.default;
  sendEmail = emailModule.sendEmail;
  runDmarcParse = dmarcModule.runDmarcParse;
  runTlsRptParse = tlsRptModule.runTlsRptParse;
  runGscPoll = gscModule.runGscPoll;
  getBBStatus = cohortModule.getBBStatus;

  // st_bc949e7c Phase 3.6: post-consolidation. BB code is loaded only after
  // the launch DB writer guard. WB mode -> fallback stubs.
  const bbActive = await cohortModule.isBBActive();
  getNetworkStats = bbActive ? bbModule.getNetworkStats : (() => ({}));
  buildAddressTimeline = bbActive && bbModule.buildAddressTimeline
    ? bbModule.buildAddressTimeline
    : (() => {});
}

const _scriptDir = dirname(fileURLToPath(import.meta.url));

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const phaseArg = (() => {
  const i = args.indexOf('--phase');
  return i >= 0 ? (args[i + 1] || '').toUpperCase() : null;
})();
const DRY_RUN = args.includes('--dry-run');
const MAINTENANCE_GOOGLE_ACCOUNT = process.env.ROBOTDOJO_MAINTENANCE_GOOGLE_ACCOUNT || undefined;

// st_27561b77 (expansion) — bounded slice wall-clock guard. When invoked with
// `--max-seconds N`, every phase polls SLICE_DEADLINE at safe boundaries
// (between sub-steps / between batches) and exits cleanly when it expires,
// printing the pinned partial sentinel so the maintenance worker re-enqueues
// a continuation slice. Without --max-seconds (a manual debugging run), the
// guard is disabled and the single phase runs to completion.
const SLICE_MAX_SECONDS = (() => {
  const i = args.indexOf('--max-seconds');
  if (i < 0) return null;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
})();
const SLICE_START_MS = Date.now();
const SLICE_DEADLINE_MS = SLICE_MAX_SECONDS ? SLICE_START_MS + SLICE_MAX_SECONDS * 1000 : null;
/** Returns true when the per-slice wall clock has elapsed. Always false
 *  when --max-seconds was not passed (manual mode). */
function sliceExpired() {
  return SLICE_DEADLINE_MS !== null && Date.now() >= SLICE_DEADLINE_MS;
}
/** Print the pinned partial sentinel the maintenance worker watches for.
 *  MAINT_PARTIAL_PREFIX is the ONE shared constant (exported by
 *  lib/passive-maintenance-handlers.js) — emit-site and match-site import it
 *  so the token can never drift on one side only. */
function emitPartial(phase, reason) {
  console.log(`${MAINT_PARTIAL_PREFIX}${phase} reason=${reason}`);
}


const DATE = new Date().toISOString().slice(0, 10);
// Day-over-day history for AUDIT's delta anomalies. The migrate script
// (scripts/migrate-overnight-to-routines.js) copies the legacy nightly
// history file here once so deltas survive the rename. ROBOTDOJO_STATE_DIR
// override (same convention as db-writer-policy) keeps tests and smoke runs
// off the live ~/.robotdojo tree.
const STATE_DIR = process.env.ROBOTDOJO_STATE_DIR || resolve(homedir(), '.robotdojo');
const MAINT_LOG_DIR = resolve(STATE_DIR, 'logs', 'maintenance');
const HISTORY_PATH = resolve(MAINT_LOG_DIR, 'maintenance-history.jsonl');

const ts = () => new Date().toISOString().slice(11, 19);
const log  = (m) => console.info(`[${ts()}] ${m}`);
const warn = (m) => console.warn(`[${ts()}] WARN ${m}`);
const err  = (m) => console.error(`[${ts()}] ERR  ${m}`);

// Per-phase result slot, keyed by lowercase phase name (runPhase derives the
// key from the phase name, so every PHASES entry MUST have a matching slot —
// the pre-st_fd14cdd4 BRIEF slot was misnamed `world_brief`, which made the
// BRIEF run throw on `results['brief'].ok`; latent only because nothing ever
// scheduled BRIEF).
const results = {
  clean:   { ok: false, duration_ms: 0, stats: {}, error: null },
  rescore: { ok: false, duration_ms: 0, stats: {}, error: null },
  ingest:  { ok: false, duration_ms: 0, stats: {}, error: null },
  style:   { ok: false, duration_ms: 0, stats: {}, error: null },
  entities: { ok: false, duration_ms: 0, stats: {}, error: null },
  enrich:  { ok: false, duration_ms: 0, stats: {}, error: null },
  topics:  { ok: false, duration_ms: 0, stats: {}, error: null },
  reclassify: { ok: false, duration_ms: 0, stats: {}, error: null },
  // st_abf246e4 — coding-agent session catch-up. Diffs local native jsonl +
  // transcript store against materialized thread_ids and imports the gap so a
  // missed Stop hook never drops a session. Bounded/resumable/idempotent.
  reconcile: { ok: false, duration_ms: 0, stats: {}, error: null },
  // st_2cd1af73 — full-corpus CHUNK reclassify (distinct from the conversation
  // RECLASSIFY above): drains the `personal` pile by re-homing embedded chunks
  // onto their best-matching T2 via cosine, one bounded activity-gated slice.
  reclassify_chunks: { ok: false, duration_ms: 0, stats: {}, error: null },
  // st_2d941f89 gap 1 — bounded/gated ambient-shard (chunk_vec_general) build,
  // same slice discipline as reclassify_chunks above.
  ambient_shard: { ok: false, duration_ms: 0, stats: {}, error: null },
  // st_2cd1af73 — daily brief synthesis (the chief-of-staff cheat sheet
  // injected as cached chat block 4). One Sonnet call over pre-gathered structure.
  brief: { ok: false, duration_ms: 0, stats: {}, error: null },
  // st_b9ec1b7c. Memory chain integrity is checked daily so a future fork
  // surfaces as an Asana alarm rather than going silent for weeks (the
  // exact regression this story remediated).
  memory_ingest: { ok: false, duration_ms: 0, stats: {}, error: null },
  memory_recalc: { ok: false, duration_ms: 0, stats: {}, error: null },
  memory_verify: { ok: false, duration_ms: 0, stats: {}, error: null },
  timeline_recalc: { ok: false, duration_ms: 0, stats: {}, error: null },
  audit:   { ok: false, duration_ms: 0, stats: {}, error: null },
  // st_df0a8d71 AC-8 — nightly graph-grounded memory fact quiz: data-layer
  // graph quiz first (sequencing gate), then the chat-layer quiz against the
  // real no-topic chat path. Any wrong answer fails the phase loudly (Asana
  // task via runPhase's failure path).
  monitor: { ok: false, duration_ms: 0, stats: {}, error: null },
  dmarc:   { ok: false, duration_ms: 0, stats: {}, error: null },
  tls_rpt: { ok: false, duration_ms: 0, stats: {}, error: null },
  gsc:     { ok: false, duration_ms: 0, stats: {}, error: null },
  indexnow:  { ok: false, duration_ms: 0, stats: {}, error: null },
};

const tableExists = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const count = (sqlTail, ...p) => {
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${sqlTail}`).get(...p)?.n ?? 0; }
  catch { return null; }
};

// ═══════════════════════════════════════════════════════════════════════════
// CLEAN
// ═══════════════════════════════════════════════════════════════════════════

async function phaseClean() {
  log('CLEAN: start');
  const stats = {};

  // 1. Orphan-archive: signal-less people (0 interactions, no contacts id) — but
  // a person STANDS ALONE (owner directive st_483361e2): a research marker
  // (uuid), facts, edges, or a phone identifier keep it regardless of
  // connections. Guard shared via lib/entity-standalone.js so this continuous
  // worker and scripts/clean-entities.js can never drift and re-archive a
  // real/promoted/edge-having person.
  if (tableExists('people') && tableExists('person_identifiers')) {
    const orphans = db.prepare(`
      SELECT p.id FROM people p
      WHERE COALESCE(p.archived, 0) = 0
        AND COALESCE(p.interaction_count, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM person_identifiers pi
          WHERE pi.person_id = p.id AND pi.source = 'contacts'
        )
        AND ${personStandaloneGuardSql('p')}
    `).all();
    if (!DRY_RUN && orphans.length > 0) {
      const upd = db.prepare('UPDATE people SET archived = 1 WHERE id = ?');
      db.transaction((rows) => { for (const r of rows) upd.run(r.id); })(orphans);
    }
    stats.people_orphans_archived = orphans.length;
  } else {
    stats.people_orphans_archived = 'skipped';
  }

  // 2. Dedup people on shared identifiers. Union-find collisions, merge into
  //    the row with the highest interaction_count (identifiers + interactions
  //    re-pointed, duplicate person row deleted).
  if (tableExists('person_identifiers') && tableExists('people')) {
    const collisions = db.prepare(`
      SELECT type, value, GROUP_CONCAT(person_id) AS ids
      FROM person_identifiers
      GROUP BY type, value
      HAVING COUNT(DISTINCT person_id) > 1
    `).all();

    let merges = 0;
    if (!DRY_RUN && collisions.length > 0) {
      const parent = new Map();
      const find = (id) => {
        while (parent.has(id) && parent.get(id) !== id) id = parent.get(id);
        return id;
      };
      const union = (ids) => {
        const roots = [...new Set(ids.map(find))];
        const keeper = roots[0];
        for (const r of roots) parent.set(r, keeper);
      };
      for (const c of collisions) union(c.ids.split(','));

      const groups = new Map();
      for (const id of parent.keys()) {
        const r = find(id);
        if (!groups.has(r)) groups.set(r, new Set());
        groups.get(r).add(id);
      }

      const getP         = db.prepare('SELECT id, interaction_count FROM people WHERE id = ?');
      const relinkIdent  = db.prepare('UPDATE OR IGNORE person_identifiers SET person_id = ? WHERE person_id = ?');
      const relinkInter  = tableExists('person_interactions')
        ? db.prepare('UPDATE OR IGNORE person_interactions SET person_id = ? WHERE person_id = ?') : null;
      const delLeftIdent = db.prepare('DELETE FROM person_identifiers WHERE person_id = ?');
      const delDup       = db.prepare('DELETE FROM people WHERE id = ?');

      db.transaction(() => {
        for (const members of groups.values()) {
          if (members.size <= 1) continue;
          const rows = [...members].map(id => getP.get(id)).filter(Boolean);
          if (rows.length <= 1) continue;
          rows.sort((a, b) => (b.interaction_count || 0) - (a.interaction_count || 0));
          const keeper = rows[0];
          for (let i = 1; i < rows.length; i++) {
            relinkIdent.run(keeper.id, rows[i].id);
            if (relinkInter) relinkInter.run(keeper.id, rows[i].id);
            delLeftIdent.run(rows[i].id);
            delDup.run(rows[i].id);
            merges++;
          }
        }
      })();
    }
    stats.people_merged = merges;
  } else {
    stats.people_merged = 'skipped';
  }

  // 3. Remove ONLY genuine no-signal company stubs. A company STANDS ALONE:
  // no people is NOT grounds for deletion (owner directive st_483361e2 —
  // "companies entity stands alone with people attached, i never made a people
  // rule"). Delete only when it also has no domain, no research marker (uuid),
  // no facts, and no edges. Guard shared via lib/company-standalone.js so this
  // (the continuous maintenance worker) and scripts/clean-entities.js can never
  // drift — the two-site drift is exactly what silently re-wiped every promoted
  // company.
  // WHY null-out first: archived people may still have company_id referencing these
  // companies. company_id is nullable — safe to clear before deletion.
  if (!DRY_RUN) {
    db.prepare(`UPDATE people SET company_id = NULL WHERE archived = 1 AND company_id IS NOT NULL`).run();
    const deleted = db.prepare(`
      DELETE FROM companies
      WHERE id NOT IN (
        SELECT DISTINCT company_id FROM people
        WHERE archived = 0 AND company_id IS NOT NULL
      )
      AND ${companyStandaloneGuardSql('companies')}
    `).run();
    // Cascade to company_domains — deleting a company without this strands an
    // orphan row that then blocks the domain UNIQUE for any real company that
    // legitimately owns it (the exact bug that broke the promote restore).
    db.prepare('DELETE FROM company_domains WHERE company_id NOT IN (SELECT id FROM companies)').run();
    stats.empty_companies_removed = deleted.changes;
  } else {
    stats.empty_companies_removed = 'dry-run';
  }

  // 4. Dedup chunks on (topic, source_type, source_id, chunk_index). The
  //    unique index rejects new dupes but legacy rows from retried ingests
  //    can still exist. Keep lowest id, drop the rest.
  if (tableExists('chunks')) {
    const dupes = db.prepare(`
      SELECT MIN(id) AS keep_id, GROUP_CONCAT(id) AS ids, COUNT(*) AS n
      FROM chunks
      GROUP BY topic, source_type, source_id, chunk_index
      HAVING n > 1
    `).all();
    let removed = 0;
    if (!DRY_RUN && dupes.length > 0) {
      const delCh = db.prepare('DELETE FROM chunks WHERE id = ?');
      db.transaction(() => {
        for (const row of dupes) {
          for (const id of row.ids.split(',').map(Number)) {
            if (id !== row.keep_id) { delCh.run(id); removed++; }
          }
        }
      })();
    }
    stats.chunks_deduped = removed;
  } else {
    stats.chunks_deduped = 'skipped';
  }

  // 5. Drop timeline_event_entities pointing at deleted people.
  if (tableExists('timeline_event_entities') && tableExists('people')) {
    let dropped = 0;
    if (!DRY_RUN) {
      dropped = db.prepare(`
        DELETE FROM timeline_event_entities
        WHERE entity_type = 'person' AND person_id NOT IN (SELECT id FROM people)
      `).run().changes;
    }
    stats.timeline_orphans_dropped = dropped;
  }

  // 6. Expire magic_links / sessions / rate buckets past TTL.
  const nowIso = new Date().toISOString();
  let expired = 0;
  if (tableExists('magic_links') && !DRY_RUN) {
    expired += db.prepare('DELETE FROM magic_links WHERE expires_at < ?').run(nowIso).changes;
  }
  if (tableExists('sessions') && !DRY_RUN) {
    expired += db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso).changes;
  }
  if (tableExists('magic_link_rate') && !DRY_RUN) {
    // Hourly buckets — anything older than 24h is cold.
    const cutoff = new Date(Date.now() - 86400_000).toISOString();
    expired += db.prepare('DELETE FROM magic_link_rate WHERE updated_at < ?').run(cutoff).changes;
  }
  stats.auth_rows_expired = expired;

  // 7. DB housekeeping — PASSIVE checkpoint, optimizer hints.
  //
  // st_27561b77 P6 — TRUNCATE blocks all writers for the entire checkpoint
  // window. On a 6.1 GB SQLCipher DB that can be many seconds of decrypt.
  // PASSIVE never blocks; it only checkpoints pages no reader holds. The
  // residual WAL is bounded by the F5 safety valve in the supervisor.
  try {
    const result = db.pragma('wal_checkpoint(PASSIVE)');
    stats.wal_checkpoint = 'ok';
    // Emit the pinned supervisor marker so AC4 grep also picks up
    // PASSIVE evidence when maint_clean fires.
    const row = Array.isArray(result) ? result[0] : result;
    if (row) {
      console.info(`wal_checkpoint(PASSIVE) result=${Number(row.busy ?? 0)} ${Number(row.log ?? 0)} ${Number(row.checkpointed ?? 0)}`);
    }
  } catch (e) { stats.wal_checkpoint = `failed: ${e.message}`; }
  try { db.pragma('optimize'); } catch { /* non-fatal */ }

  results.clean.stats = stats;
  log(`CLEAN: done — ${JSON.stringify(stats)}`);
}

// IMPORTS phase retired by name (st_fd14cdd4 AC8 disposition row 2): it was
// an exact duplicate of the imports_snapshot passive job that already runs
// every sync cycle (lib/passive-sync-orchestrator.js).

// ═══════════════════════════════════════════════════════════════════════════
// RESCORE
//
// st_fd14cdd4 AC8 (disposition row 3) — slice support. The live overnight
// machine quarantined nightly_rescore on timeout because this phase ignored
// --max-seconds: it ran every sub-step regardless and the passive-job timeout
// (slice + 60s) fired mid-flight. The phase now checks sliceExpired() between
// sub-steps and returns early; runPhase sees the expired clock and emits the
// partial sentinel, so the worker re-enqueues a continuation slice instead of
// burning an attempt. The first sub-steps (denormalized refresh +
// computeAllScores) are a single monolithic pass that cannot stop mid-flight —
// that is WHY the maint_rescore routine carries a wider maxSeconds (900s)
// in lib/maintenance-routines.js.
// ═══════════════════════════════════════════════════════════════════════════

async function phaseRescore() {
  log('RESCORE: start');
  const stats = {};
  if (!tableExists('people')) {
    stats.note = 'people table missing — skipped';
    results.rescore.stats = stats;
    return;
  }
  // Each sub-step below is idempotent, so stopping between steps and resuming
  // on the next slice re-runs at most one cheap step's worth of work.
  const slicePaused = (afterStep) => {
    if (!sliceExpired()) return false;
    stats.paused = `slice budget elapsed after ${afterStep}; continuation slice resumes`;
    results.rescore.stats = stats;
    log(`RESCORE: paused — ${stats.paused}`);
    return true;
  };

  // Refresh denormalized metrics before scoring so breaks are accurate.
  if (tableExists('person_interactions') && !DRY_RUN) {
    db.exec(`
      UPDATE people SET
        interaction_count = COALESCE((SELECT COUNT(*) FROM person_interactions WHERE person_id = people.id), 0),
        first_seen = COALESCE((SELECT MIN(date) FROM person_interactions WHERE person_id = people.id), people.first_seen),
        last_seen  = COALESCE((SELECT MAX(date) FROM person_interactions WHERE person_id = people.id), people.last_seen)
      WHERE COALESCE(archived, 0) = 0
    `);
  }

  // Dual-track scoring — writes score, tier, personal_tier, business_tier.
  try {
    const { tierCounts, breaks } = computeAllScores({ dryRun: DRY_RUN, verbose: false });
    stats.tier_counts = tierCounts;
    stats.breaks = {
      core: Number(breaks.core?.toFixed?.(1) ?? breaks.core),
      network: Number(breaks.network?.toFixed?.(1) ?? breaks.network),
      extended: Number(breaks.extended?.toFixed?.(1) ?? breaks.extended),
    };
  } catch (e) {
    stats.scoring = `failed: ${e.message}`;
    warn(`scoring failed: ${e.message}`);
  }

  if (slicePaused('computeAllScores')) return;

  // Places (if present).
  if (tableExists('places')) {
    try { if (!DRY_RUN) computePlaceScores(); stats.place_scores = 'ok'; }
    catch (e) { stats.place_scores = `failed: ${e.message}`; }
  }

  // Keep company people_count in sync.
  if (tableExists('companies') && !DRY_RUN) {
    db.exec(`
      UPDATE companies SET people_count = (
        SELECT COUNT(*) FROM people
        WHERE company_id = companies.id AND COALESCE(archived, 0) = 0
      )
    `);
  }

  // st_2d941f89 gap 2 — entity_rank per class (person/company/place), fed to
  // lib/db.js's VALUE_RANK_SQL_EXPR entity-rank-ordinal embed-priority term.
  // Placed AFTER people scores + company people_count sync above (and after
  // computePlaceScores' total_visits refresh) so ranking always reads THIS
  // pass's freshest prominence signals, never a stale prior-day snapshot.
  if (!DRY_RUN) {
    try { stats.entity_ranks = computeEntityRanks(db); }
    catch (e) { stats.entity_ranks = `failed: ${e.message}`; warn(`entity_rank scoring failed: ${e.message}`); }
  }

  if (slicePaused('place/company scores')) return;

  // Document vault + address timeline refresh.
  try { if (!DRY_RUN) scanForDocuments(); stats.document_vault = 'ok'; }
  catch (e) { stats.document_vault = `failed: ${e.message}`; }
  try { if (!DRY_RUN) buildAddressTimeline(); stats.address_timeline = 'ok'; }
  catch (e) { stats.address_timeline = `failed: ${e.message}`; }

  // Referral candidates — cheap; just a query + write.
  try {
    if (!DRY_RUN) stats.referral_candidates = computeReferralScores();
  } catch (e) {
    stats.referral_candidates = `failed: ${e.message}`;
  }

  if (slicePaused('document vault + referrals')) return;

  // Content depth scoring — populates people.content_depth so the dp bonus
  // in scoring.js has values to work with. Cap at 20 people per run.
  try {
    if (!DRY_RUN) {
      const depthScript = resolve(_scriptDir, 'score-content-depth.js');
      const depthResult = spawnSync(process.execPath, [depthScript, '--limit', '20'], {
        stdio: 'inherit', timeout: 120000, encoding: 'utf8',
      });
      stats.content_depth = depthResult.status === 0 ? 'ok' : `exited ${depthResult.status}`;
    } else {
      stats.content_depth = 'skipped (dry-run)';
    }
  } catch (e) {
    stats.content_depth = `failed: ${e.message}`;
    warn(`content depth scoring failed: ${e.message}`);
  }

  if (slicePaused('content depth')) return;

  // Oura Ring — latest 7 days of health metrics.
  try {
    if (!DRY_RUN) {
      const ouraResult = await syncOuraLatest();
      stats.oura = ouraResult;
    } else {
      stats.oura = 'skipped (dry-run)';
    }
  } catch (e) {
    stats.oura = `failed: ${e.message}`;
    warn(`oura sync failed: ${e.message}`);
  }

  try {
    if (!DRY_RUN) {
      stats.eightsleep = await syncEightSleepLatest();
    } else {
      stats.eightsleep = 'skipped (dry-run)';
    }
  } catch (e) {
    stats.eightsleep = `failed: ${e.message}`;
    warn(`eight sleep sync failed: ${e.message}`);
  }

  results.rescore.stats = stats;
  log(`RESCORE: done — tiers=${JSON.stringify(stats.tier_counts || {})}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// INGEST — full incremental entity pipeline (scripts/ingest/index.js, phases 1→9).
//
// st_f1a40461: the entity pipeline was manual-only and triggered by nothing, so
// freshly-synced raw rows (emails/imessage/google_contacts drained by sync.js)
// never folded into the graph. Running it here, inside this script's launch DB
// writer guard — continuously, via the pipeline_ingest routine's data-arrival
// trigger + 15-min freshness floor — means timeline_events / interaction_count /
// person_interactions are rebuilt from fresh raw data within minutes, and
// pipeline_entities (chained on completion) wires facts and relationships on top.
//
// WHY spawnSync (not import): index.js is a top-level orchestrator that opens its
// own lib/db.js connection and parses CLI args. Running it as a child process —
// the same pattern phaseStyle/phaseEnrich use — gives clean stdout/stderr
// isolation and a predictable exit code, and reuses this script's already-held
// writer guard (the child reaches the same external-db-writer lock as a
// guarded-child).
//
// WHY --skip-context: Phase 7 (context bios) calls Haiku/Sonnet and is the only
// paid phase. ENRICH already budgets the daily LLM spend (capped 20 entities/day);
// the structural phases 1→6,8,9 are free, so we run those passively and leave paid
// context synthesis to ENRICH. NO --reset: incremental fold, never a hard rebuild.
// ═══════════════════════════════════════════════════════════════════════════

async function phaseIngest() {
  log('INGEST: start');
  const stats = {};

  if (DRY_RUN) {
    stats.skipped_dry_run = true;
    results.ingest.stats = stats;
    log('INGEST: skipped (dry-run)');
    return;
  }

  try {
    const ingestScript = resolve(_scriptDir, 'ingest', 'index.js');
    // st_27561b77 (expansion) — bounded resumable INGEST. Pass the slice
    // budget through so the entity pipeline stops between phases when the
    // wall clock expires. Without --max-seconds nothing changes (the
    // existing 30-min spawnSync timeout still bounds the worst case).
    // Pipeline phases use INSERT OR IGNORE everywhere, so the next slice
    // resumes correctly from whichever phase the previous slice exited at.
    const ingestArgs = ['--skip-context'];
    // Reserve 30s of headroom inside the slice budget so child-process
    // cleanup, transcript-link, and stats reporting always finish.
    const remainingSeconds = SLICE_DEADLINE_MS
      ? Math.max(15, Math.floor((SLICE_DEADLINE_MS - Date.now()) / 1000) - 30)
      : null;
    if (remainingSeconds !== null) {
      ingestArgs.push('--max-seconds', String(remainingSeconds));
    }
    // Slice mode: smaller spawn timeout (slice + 60s safety). Manual mode
    // (no --max-seconds): preserve the original 30-min window so nothing
    // changes for a manual `node scripts/maintenance-phases.js` invocation.
    const spawnTimeoutMs = remainingSeconds !== null
      ? (remainingSeconds + 60) * 1000
      : 1_800_000;
    const r = spawnSync(process.execPath, [ingestScript, ...ingestArgs], {
      // Capture stdout so the partial sentinel from ingest/index.js can be
      // surfaced upward to the supervisor via this script's stdout.
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: spawnTimeoutMs,
      encoding: 'utf8',
    });
    const out = r.stdout || '';
    // Tee the child's stdout up to ours so the maintenance worker sees both
    // the child's partial-sentinel line (if any) and the rest of the pipeline
    // log.
    if (out) process.stdout.write(out);
    // Detect the partial sentinel emitted by scripts/ingest/index.js when
    // the pipeline exited its phase loop because the slice budget elapsed.
    // The worker watches our own stdout for the same shared token.
    const childPartial = out.includes(MAINT_PARTIAL_PREFIX);
    if (r.status === 0) {
      stats.pipeline = childPartial ? 'partial' : 'ok';
      log(`INGEST: ${childPartial ? 'partial slice — more pending' : 'done'}`);
    } else if (r.signal) {
      stats.pipeline = `killed: ${r.signal}`;
      warn(`INGEST: killed by ${r.signal} (likely timeout)`);
      // A signal-killed child often means our slice budget was tight and
      // the spawn timeout fired. Surface it as PARTIAL so the supervisor
      // re-enqueues rather than quarantining.
      emitPartial('INGEST', `child_signal_${r.signal}`);
    } else {
      stats.pipeline = `exited ${r.status}`;
      warn(`INGEST: pipeline exited ${r.status}`);
    }
  } catch (e) {
    stats.pipeline = `failed: ${e.message}`;
    warn(`INGEST: failed: ${e.message}`);
  }

  results.ingest.stats = stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTITIES — free structural graph pass before paid context enrichment.
//
// Links chunks to known people, refreshes deterministic entity facts, and
// rebuilds relationship edges. This is the automatic half of the entity
// pipeline; ENRICH below handles paid Black Belt synthesis for dirty entities.
// ═══════════════════════════════════════════════════════════════════════════

async function phaseEntities() {
  log('ENTITIES: start');
  const stats = {
    chunk_entities_inserted: 0,
    entity_facts: 0,
    relationships: {},
    skipped_dry_run: false,
  };

  if (DRY_RUN) {
    stats.skipped_dry_run = true;
    results.entities.stats = stats;
    log('ENTITIES: skipped (dry-run)');
    return;
  }

  try {
    const [
      { linkChunkEntities },
      { bulkExtractFacts },
      { buildRelationships },
    ] = await Promise.all([
      import('./ingest/link-chunk-entities.js'),
      import('../lib/entity-facts.js'),
      import('../lib/relationship-builder.js'),
    ]);

    stats.chunk_entities_inserted = linkChunkEntities();
    stats.entity_facts = bulkExtractFacts(db, log);
    stats.relationships = await buildRelationships(db, { log });
    log(`ENTITIES: done — ${JSON.stringify({
      chunk_entities_inserted: stats.chunk_entities_inserted,
      entity_facts: stats.entity_facts,
      relationships: stats.relationships?.inserted ?? 0,
    })}`);
  } catch (e) {
    stats.error = e.message;
    warn(`ENTITIES: failed: ${e.message}`);
  }

  results.entities.stats = stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// STYLE — communication style analysis (email/iMessage patterns)
// ═══════════════════════════════════════════════════════════════════════════

async function phaseStyle() {
  log('STYLE: start');
  const stats = {};
  if (!tableExists('people') || !tableExists('person_interactions')) {
    stats.note = 'required tables missing — skipped';
    results.style.stats = stats;
    return;
  }
  try {
    if (!DRY_RUN) {
      const styleScript = resolve(_scriptDir, 'analyze-communication-style.js');
      const r = spawnSync(process.execPath, [styleScript, '--limit', '20'], {
        stdio: 'inherit', timeout: 180000, encoding: 'utf8',
      });
      stats.style_analysis = r.status === 0 ? 'ok' : `exited ${r.status}`;
    } else {
      stats.style_analysis = 'skipped (dry-run)';
    }
  } catch (e) {
    stats.style_analysis = `failed: ${e.message}`;
    warn(`style analysis failed: ${e.message}`);
  }
  results.style.stats = stats;
  log(`STYLE: done — ${JSON.stringify(stats)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ENRICH — entity body enrichment: context files with real synthesis
//
// Runs after STYLE so that communication style data is fresh before enrichment.
// WHY capped at 20/night: each entity costs ~3 Haiku calls (~$0.001). 20/night
// = ~$0.02/night = ~$0.60/month. Cap ensures launchd timeout is never hit.
// WHY BELT=black gate: enrichment is a paid-tier feature (calls Haiku, writes
// context files). Non-Black-Belt environments skip silently without error.
// ═══════════════════════════════════════════════════════════════════════════

async function phaseEnrich() {
  log('ENRICH: start');
  const stats = { enriched: 0, failed: 0, skipped_no_belt: false };

  const belt = process.env.BELT || 'white';
  const bbStatus = await getBBStatus?.();
  const blackBeltActive = belt === 'black' || bbStatus?.active === true;
  // st_b50005df Phase 4 — the product default is ON under Black Belt. The ONLY
  // thing that pauses enrichment while BB is active is the explicit, local
  // owner-box opt-out (ROBOTDOJO_ENRICH_OWNER_BOX_DISABLED=1) — the dev-respend
  // guard, never the shipped default. enrichmentDecision encodes both gates so
  // there is one truth table for "should enrichment run".
  const decision = enrichmentDecision({ bbActive: blackBeltActive });
  if (!decision.enabled) {
    // WHY non-fatal skip: this runner serves WB, BB, and owner-box-paused
    // environments. Skipping silently keeps the phase clean either way.
    stats.skipped_no_belt = decision.reason === 'bb_inactive';
    stats.skipped_owner_box = decision.reason === 'owner_box_opt_out';
    const why = decision.reason === 'owner_box_opt_out'
      ? 'owner-box opt-out set (ROBOTDOJO_ENRICH_OWNER_BOX_DISABLED=1)'
      : `Black Belt required (${bbStatus?.reason || 'inactive'})`;
    log(`ENRICH: skipped — ${why}`);
    results.enrich.stats = stats;
    return;
  }

  try {
    const enrichScript = resolve(_scriptDir, 'ingest', '08-entity-enrich.js');
    // WHY spawnSync (not import): 08-entity-enrich.js does its own CLI arg parsing.
    // Running as child process gives clean stdout/stderr isolation and a predictable exit code.
    const r = spawnSync(process.execPath, [enrichScript], {
      stdio: 'inherit',
      timeout: 180_000, // 3 min max — 20 entities × ~9s worst case
      encoding: 'utf8',
      env: { ...process.env, BELT: 'black' },
    });
    if (r.status === 0) {
      stats.enriched = 'ok'; // actual count is in child stdout
      log('ENRICH: done');
    } else {
      stats.failed = `exited ${r.status}`;
      warn(`ENRICH: script exited ${r.status}`);
    }
  } catch (e) {
    stats.failed = e.message;
    warn(`ENRICH: failed: ${e.message}`);
  }

  results.enrich.stats = stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOPICS — regenerate context_md for stale or uninitialized topics.
// ═══════════════════════════════════════════════════════════════════════════

// TOPICS — regenerate context_md for stale or uninitialized topics.
// WHY: user_topics.needs_regen is set by ingest after each run. Overnight regen
// closes the loop so chat context stays current without manual --emit flags.
// WHY null-description topics get attempted: generateTopicContext returns null
// immediately when description is null — no LLM cost. Flag is cleared to avoid
// infinite retry; the topic will succeed once a description is added.
async function phaseTopics() {
  log('TOPICS: start');
  // distillOrGenerateTopicContext() delegates straight to the untouched
  // generateTopicContext() while the topic_distill flag is off (the default,
  // st_5184eb86 chunk 5) — zero behavior change to this phase until the owner
  // flips it. See lib/topic-distill.js for the exact cutover step.
  const { distillOrGenerateTopicContext } = await import('../lib/topic-distill.js');
  const { idleGateDecision } = await import('../lib/idle-gate.js');
  const topicsToRegen = db.prepare(`
    SELECT slug
    FROM user_topics
    WHERE COALESCE(needs_regen, 0) = 1
       OR (
        context_md IS NULL
        AND NULLIF(TRIM(COALESCE(description, '')), '') IS NOT NULL
       )
  `).all();
  // st_27561b77 AC5 — bounded slice + mid-loop idle re-check. The topics
  // phase is one of the enumerated idle-gated job types; one Sonnet
  // call per topic at ~3s each, so a 30-topic backlog spends ~90s without
  // yielding. The slice cap and pre-iteration idle check let the worker
  // pause cleanly at the next topic boundary when the user returns; the
  // remaining needs_regen=1 rows persist for the next maint_topics fire (the
  // INSERT OR IGNORE-style overwrite of context_md is idempotent).
  const SLICE_LIMIT = Number(process.env.ROBOTDOJO_MAINT_TOPICS_SLICE_LIMIT || 50);
  log(`TOPICS: ${topicsToRegen.length} topics queued (slice_limit=${SLICE_LIMIT})`);
  let done = 0;
  let skipped = 0;
  let processed = 0;
  let pauseReason = null;
  for (const { slug } of topicsToRegen) {
    if (processed >= SLICE_LIMIT) {
      pauseReason = `slice_limit_reached after ${processed}; ${topicsToRegen.length - processed} remaining for next fire`;
      break;
    }
    const decision = idleGateDecision('maintenance-TOPICS');
    if (!decision.ok) {
      pauseReason = `user_active idle=${decision.idle}s after ${processed} processed; ${topicsToRegen.length - processed} remaining`;
      break;
    }
    try {
      const result = await distillOrGenerateTopicContext(slug, db);
      if (result) {
        db.prepare('UPDATE user_topics SET needs_regen = 0 WHERE slug = ?').run(slug);
        done++;
      } else {
        // null = no description yet or no RAG material; clear flag to avoid infinite retry
        db.prepare('UPDATE user_topics SET needs_regen = 0 WHERE slug = ?').run(slug);
        skipped++;
      }
    } catch (e) {
      warn(`TOPICS: failed for ${slug}: ${e.message}`);
    }
    processed++;
  }
  log(`TOPICS: done — ${done} generated, ${skipped} skipped (no description)${pauseReason ? ` — paused: ${pauseReason}` : ''}`);
  results.topics.stats = { total: topicsToRegen.length, done, skipped, processed, paused: pauseReason };
}

// ═══════════════════════════════════════════════════════════════════════════
// RECLASSIFY — re-evaluate conversations against the live topic list (st_f0adee6f)
// ═══════════════════════════════════════════════════════════════════════════
//
// Compute tier ladder:
//   Tier 0  inferTopicFromContent (keyword) — free, runs first per conversation
//   Tier 1  Haiku classifyIntent — fires only when Tier 0 misses
//   Tier 0  generateTopicEmbedding — free, feeds future Round 2 cosine similarity
//
// Sits between TOPICS and EMBED so context_md is regenerated (TOPICS) before
// we use it as classifier signal, and reset embedded=0 from reclassify is
// picked up by the EMBED phase that follows.
//
// The WHERE clause excludes topic_set_method='user' — manual overrides are sacred.
async function phaseReclassify() {
  log('RECLASSIFY: start');
  const stats = { candidates: 0, classified: 0, topics_updated: 0 };
  const { classifyConversationTopic } = await import('../lib/conversations.js');
  const { generateTopicContext, generateTopicEmbedding } = await import('../lib/topic-context.js');

  const candidates = db.prepare(
    "SELECT id FROM conversations WHERE (topic_set_method IS NULL OR topic_set_method != 'user') AND (topic_slug IS NULL OR topic_set_method = 'keyword')"
  ).all();
  stats.candidates = candidates.length;

  if (DRY_RUN) {
    log(`RECLASSIFY: dry-run — ${candidates.length} candidates`);
    results.reclassify.stats = stats;
    return;
  }

  const affected = new Set();
  for (const { id } of candidates) {
    try {
      const ok = await classifyConversationTopic(db, id);
      if (ok) {
        stats.classified++;
        const row = db.prepare('SELECT topic_slug FROM conversations WHERE id = ?').get(id);
        if (row?.topic_slug) affected.add(row.topic_slug);
      }
    } catch (e) {
      warn(`RECLASSIFY: ${id} failed: ${e.message}`);
    }
  }

  for (const slug of affected) {
    try {
      await generateTopicContext(slug, db);
      await generateTopicEmbedding(slug, db);
      stats.topics_updated++;
    } catch (e) {
      warn(`RECLASSIFY: context regen failed for ${slug}: ${e.message}`);
    }
  }

  log(`RECLASSIFY: done — ${stats.classified}/${stats.candidates} classified, ${stats.topics_updated} topics regenerated`);
  results.reclassify.stats = stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// RECONCILE — catch-up capture of coding-agent sessions (st_abf246e4 WS1).
//
// The live Stop hook is lossy (upstream #29881). This phase is the PULL
// guarantee: diff local native jsonl + the transcript store against materialized
// thread_ids and import the gap via materializeSession (native-jsonl → two-sided
// when it survives, else a hidden one-sided fallback). Idempotent on thread_id,
// so a partial slice always resumes cleanly. Off the HTTP path — it runs inside
// this script's launch DB writer guard on the maintenance worker.
// ═══════════════════════════════════════════════════════════════════════════
async function phaseReconcile() {
  log('RECONCILE: start');
  const stats = {};

  if (DRY_RUN) {
    const { unreconciledSessionIds } = await import('../lib/claude-code-reconcile.js');
    stats.pending = unreconciledSessionIds(db).length;
    stats.skipped = 'dry-run';
    results.reconcile.stats = stats;
    log(`RECONCILE: dry-run — ${stats.pending} pending`);
    return;
  }

  const { reconcileSessions } = await import('../lib/claude-code-reconcile.js');
  // Reserve 15s of headroom inside the slice budget so the final materialize +
  // stats reporting always finish. Manual mode (no --max-seconds) runs unbounded.
  const maxSeconds = SLICE_DEADLINE_MS
    ? Math.max(10, Math.floor((SLICE_DEADLINE_MS - Date.now()) / 1000) - 15)
    : 0;
  const result = await reconcileSessions(db, { maxSeconds });
  stats.reconciled = result.materialized;
  stats.enriched = result.enriched;
  stats.hidden = result.hidden;
  stats.processed = result.processed;
  stats.remaining = result.remaining;
  stats.total = result.total;

  // A partial slice (budget elapsed with sessions still pending) emits the
  // shared sentinel so the worker re-enqueues a continuation slice.
  if (result.partial || result.remaining > 0) {
    emitPartial('RECONCILE', `remaining_${result.remaining}`);
  }
  results.reconcile.stats = stats;
  log(`RECONCILE: done — ${result.materialized} materialized, ${result.enriched} enriched, ${result.hidden} hidden, ${result.remaining} remaining`);
}

// ═══════════════════════════════════════════════════════════════════════════
// RECLASSIFY_CHUNKS — full-corpus chunk → T2 re-home, one bounded slice per
// freshness window (st_2cd1af73; scheduling moved to maint_reclassify_chunks
// by st_fd14cdd4 — internals unchanged).
// ═══════════════════════════════════════════════════════════════════════════
//
// DISTINCT from RECLASSIFY above. RECLASSIFY re-homes whole CONVERSATIONS via
// keyword→Haiku. THIS phase re-homes individual embedded CHUNKS via cosine
// similarity to each T2's description_embedding (scripts/ingest/05-reclassify-
// chunks.js) — the path that drains the ~99% `personal` pile once embeddings
// exist. It is the maintenance home for the one-time full-corpus pass: each
// fire runs one bounded slice, so the pile drains over successive idle windows
// instead of one unbounded multi-hour run on the interactive box.
//
// Compute tier: extraction. The phase always passes --no-regen, so the bounded
// path is cosine-only — NO Sonnet on this leg (the paid context regen is owned
// by the TOPICS phase). The script's INTELLIGENCE_TIER='extraction' holds.
//
// Gating: this is heavy full-corpus work, so it must yield to the user on BOTH
// signals the maintenance machine already trusts —
//   1. server-activity (getActivitySignal/activityPauseDecision, lib/request-
//      observer.js): the exact "user is in chat or the app right now" signal the
//      chunk-embed daemon yields to. A fresh in-flight / recent request pauses.
//   2. HID idle (idleGateDecision, lib/idle-gate.js): the broad "user is at the
//      machine" signal every other heavy phase (TOPICS) gates on.
// Either signal saying "user is here" skips the slice cleanly; the pile waits
// for the next fire. A bounded slice on a quiet box; nothing on an active one.
//
// WHY spawnSync (not import): 05-reclassify-chunks.js is a top-level script that
// opens its own lib/db.js connection, parses CLI args, and calls process.exit —
// the same reason phaseIngest/phaseStyle/phaseEnrich spawn their scripts. The
// child reaches the same external-db-writer lock under this script's held guard.
async function phaseReclassifyChunks() {
  log('RECLASSIFY_CHUNKS: start');
  const stats = { skipped: false, skip_reason: null, slice_seconds: 0, exit_code: null, partial: false };

  if (DRY_RUN) {
    stats.skipped = true;
    stats.skip_reason = 'dry-run';
    results.reclassify_chunks.stats = stats;
    log('RECLASSIFY_CHUNKS: skipped (dry-run)');
    return;
  }

  // Gate 1 — server activity. Pause the full-corpus pass the instant the user is
  // in chat or the app (a request in flight or one finished < ACTIVITY_PAUSE_MS ago).
  const { getActivitySignal, activityPauseDecision } = await import('../lib/request-observer.js');
  const activity = activityPauseDecision(getActivitySignal(db));
  if (activity.pause) {
    stats.skipped = true;
    stats.skip_reason = `server-active (${activity.reason})`;
    results.reclassify_chunks.stats = stats;
    log(`RECLASSIFY_CHUNKS: skipped — server active (${activity.reason})`);
    return;
  }

  // Gate 2 — HID idle. The broad "user is at the machine" signal the other heavy
  // phases gate on; reused here so the full-corpus pass never competes
  // with an actively-used laptop even between chat requests.
  const { idleGateDecision } = await import('../lib/idle-gate.js');
  const idle = idleGateDecision('maintenance-RECLASSIFY_CHUNKS');
  if (!idle.ok) {
    stats.skipped = true;
    stats.skip_reason = `user-active idle=${idle.idle}s`;
    results.reclassify_chunks.stats = stats;
    log(`RECLASSIFY_CHUNKS: skipped — user active (idle=${idle.idle}s)`);
    return;
  }

  // Bounded slice: one run is capped at SLICE_LIMIT seconds of wall clock
  // (the reclassifier stops at a source-topic boundary on committed state and
  // the next fire resumes). 300s default keeps a single pass well inside the
  // worker slice; tune via ROBOTDOJO_MAINT_RECLASSIFY_CHUNKS_SLICE_SECONDS.
  const SLICE_LIMIT = Number(process.env.ROBOTDOJO_MAINT_RECLASSIFY_CHUNKS_SLICE_SECONDS || 300);
  stats.slice_seconds = SLICE_LIMIT;

  try {
    const reclassifyScript = resolve(_scriptDir, 'ingest', '05-reclassify-chunks.js');
    const r = spawnSync(process.execPath, [
      reclassifyScript,
      '--no-regen',                       // cosine-only; keep Sonnet off the bounded path
      '--max-seconds', String(SLICE_LIMIT), // bound one slice
    ], {
      // Capture stdout so the partial sentinel from the reclassifier surfaces in
      // the phase stats; tee it up so an operator still sees the move log.
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: (SLICE_LIMIT + 60) * 1000,  // slice budget + 60s cleanup headroom
      encoding: 'utf8',
    });
    const out = r.stdout || '';
    if (out) process.stdout.write(out);
    stats.exit_code = r.status;
    stats.partial = out.includes('done (partial slice)');
    if (r.status === 0) {
      log(`RECLASSIFY_CHUNKS: ${stats.partial ? 'partial slice — more pending' : 'done'}`);
    } else if (r.signal) {
      stats.error = `killed: ${r.signal}`;
      warn(`RECLASSIFY_CHUNKS: killed by ${r.signal} (likely timeout)`);
    } else {
      stats.error = `exited ${r.status}`;
      warn(`RECLASSIFY_CHUNKS: script exited ${r.status}`);
    }
  } catch (e) {
    stats.error = e.message;
    warn(`RECLASSIFY_CHUNKS: failed: ${e.message}`);
  }

  results.reclassify_chunks.stats = stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// AMBIENT_SHARD — bounded/gated build of the ambient chunk_vec_general shard
// (st_2d941f89 gap 1; script scripts/build-general-shard.js).
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY this phase exists: chunk_vec_general is the vector table an unscoped
// ("general", no-topic) chat query reads (lib/rag-search.js). The populator
// script was correct in isolation but unscheduled — research confirmed zero
// references to it anywhere in the passive/maintenance loop, so the shard sat
// at a handful of foreground-mirrored rows (embedChunkNow's per-chat-fact
// write) against the full embedded corpus. This phase is the scheduling home:
// one bounded, gated slice per freshness window, same discipline as
// RECLASSIFY_CHUNKS immediately above.
//
// Compute tier: extraction. The script only relocates already-computed vectors
// (DELETE+INSERT copies from a chunk's per-topic vec table) — no LLM, no
// re-embedding, ever.
//
// Gating — identical two-signal contract as RECLASSIFY_CHUNKS, because this is
// also a full-corpus-scanning background writer that must never compete with
// an active session:
//   1. server-activity (getActivitySignal/activityPauseDecision): pause the
//      instant the user is in chat or the app right now.
//   2. HID idle (idleGateDecision): the broad "user is at the machine" signal.
// Either signal pauses the slice cleanly; the shard waits for the next fire.
// The spawned script ALSO self-gates mid-run via --max-seconds (checked
// between batches) plus its own chat-app-active check — defense in depth, the
// same shape scripts/ingest/05-reclassify-chunks.js already established.
//
// WHY spawnSync (not import): build-general-shard.js is a top-level script
// that opens its own lib/db.js connection and calls process.exit — same reason
// phaseReclassifyChunks/phaseIngest/phaseStyle spawn their scripts. The child
// reaches the same external-db-writer lock under this script's held guard.
async function phaseAmbientShard() {
  log('AMBIENT_SHARD: start');
  const stats = { skipped: false, skip_reason: null, slice_seconds: 0, exit_code: null, partial: false };

  if (DRY_RUN) {
    stats.skipped = true;
    stats.skip_reason = 'dry-run';
    results.ambient_shard.stats = stats;
    log('AMBIENT_SHARD: skipped (dry-run)');
    return;
  }

  // Gate 1 — server activity. Pause the full-corpus scan the instant the user is
  // in chat or the app (a request in flight or one finished < ACTIVITY_PAUSE_MS ago).
  const { getActivitySignal, activityPauseDecision } = await import('../lib/request-observer.js');
  const activity = activityPauseDecision(getActivitySignal(db));
  if (activity.pause) {
    stats.skipped = true;
    stats.skip_reason = `server-active (${activity.reason})`;
    results.ambient_shard.stats = stats;
    log(`AMBIENT_SHARD: skipped — server active (${activity.reason})`);
    return;
  }

  // Gate 2 — HID idle. Reused so the ambient-shard scan never competes with an
  // actively-used laptop even between chat requests.
  const { idleGateDecision } = await import('../lib/idle-gate.js');
  const idle = idleGateDecision('maintenance-AMBIENT_SHARD');
  if (!idle.ok) {
    stats.skipped = true;
    stats.skip_reason = `user-active idle=${idle.idle}s`;
    results.ambient_shard.stats = stats;
    log(`AMBIENT_SHARD: skipped — user active (idle=${idle.idle}s)`);
    return;
  }

  // Bounded slice: one run is capped at SLICE_LIMIT seconds of wall clock (the
  // populator stops at a write-batch boundary on committed state and the next
  // fire resumes — the idempotent diff-against-sample design means a partial
  // slice is always safe). Tune via ROBOTDOJO_MAINT_AMBIENT_SHARD_SLICE_SECONDS.
  const SLICE_LIMIT = Number(process.env.ROBOTDOJO_MAINT_AMBIENT_SHARD_SLICE_SECONDS || 180);
  stats.slice_seconds = SLICE_LIMIT;

  try {
    const shardScript = resolve(_scriptDir, 'build-general-shard.js');
    const r = spawnSync(process.execPath, [
      shardScript,
      '--max-seconds', String(SLICE_LIMIT), // bound one slice; script self-gates on chat-app-active too
    ], {
      // Capture stdout so the partial marker surfaces in the phase stats; tee it
      // up so an operator still sees the build log.
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: (SLICE_LIMIT + 60) * 1000, // slice budget + 60s cleanup headroom
      encoding: 'utf8',
    });
    const out = r.stdout || '';
    if (out) process.stdout.write(out);
    stats.exit_code = r.status;
    stats.partial = out.includes('done (partial slice)');
    if (r.status === 0) {
      log(`AMBIENT_SHARD: ${stats.partial ? 'partial slice — more pending' : 'done'}`);
    } else if (r.signal) {
      stats.error = `killed: ${r.signal}`;
      warn(`AMBIENT_SHARD: killed by ${r.signal} (likely timeout)`);
    } else {
      stats.error = `exited ${r.status}`;
      warn(`AMBIENT_SHARD: script exited ${r.status}`);
    }
  } catch (e) {
    stats.error = e.message;
    warn(`AMBIENT_SHARD: failed: ${e.message}`);
  }

  results.ambient_shard.stats = stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// BRIEF — synthesize the daily chief-of-staff cheat sheet (st_2cd1af73).
//
// Writes ONE canonical markdown (user/contexts/brief.md) the chat path
// injects as cached block 4. Tier-0 gather (chat activity, calendar last/next
// 48h, core roster, topic index) + ONE Tier-2 Sonnet synthesis. Runs in ALL
// belts: the inputs (calendar, conversations, topics) are White Belt data — the
// brief is not a Black Belt entity feature. Placed AFTER RESCORE so people tiers
// (the core roster source) are fresh.
//
// WHY spawnSync (not import): synthesize-brief.js opens its own lib/db.js
// connection and has a CLI entry — the same isolation pattern phaseIngest/
// phaseStyle use. The child reaches the same writer guard under this script's
// held lock. The synthesis is one Sonnet call (~$0.01), no slice budgeting
// needed. Daily cadence comes from the maint_brief routine; it now runs at
// the first idle window of the day, not 21:00.
// ═══════════════════════════════════════════════════════════════════════════

async function phaseBrief() {
  log('BRIEF: start');
  const stats = {};

  if (DRY_RUN) {
    stats.skipped = 'dry-run';
    results.brief.stats = stats;
    log('BRIEF: skipped (dry-run)');
    return;
  }

  try {
    const briefScript = resolve(_scriptDir, 'synthesize-brief.js');
    const r = spawnSync(process.execPath, [briefScript], {
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 180_000, // one Sonnet call (longer client timeout) + bounded SQL gather + retries
      encoding: 'utf8',
      // WHY override ANTHROPIC_TIMEOUT_MS: the shared Anthropic client caps every
      // request at 15s for CHAT speed (lib/llm/anthropic.js). The world brief is a
      // BATCH synthesis, not a chat turn — a larger Sonnet completion
      // legitimately runs past 15s, so the chat ceiling would abort it every
      // run. Lift it to 90s for this child only; chat keeps its 15s ceiling.
      env: { ...process.env, ANTHROPIC_TIMEOUT_MS: process.env.ANTHROPIC_TIMEOUT_MS || '90000' },
    });
    const out = r.stdout || '';
    if (out) process.stdout.write(out);
    if (r.status === 0) {
      stats.synthesis = 'ok';
      log('BRIEF: done');
    } else if (r.signal) {
      stats.synthesis = `killed: ${r.signal}`;
      warn(`BRIEF: killed by ${r.signal}`);
    } else {
      stats.synthesis = `exited ${r.status}`;
      warn(`BRIEF: script exited ${r.status}`);
    }
  } catch (e) {
    stats.synthesis = `failed: ${e.message}`;
    warn(`BRIEF: failed: ${e.message}`);
  }

  results.brief.stats = stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// EMBED — REMOVED (st_b50005df)
//
// The overnight EMBED phase (BATCH_SIZE 100) was a SECOND, divergent
// embed implementation. It is gone. The single embed implementation is now
// lib/rag/embed.js (small bounded batch, length-sorted, idle-aware, DELETE+
// INSERT vec writes), drained by the always-on chunk-embed-worker via
// passive_jobs. Embedding does not ride the maintenance path at all; nothing
// here should re-introduce an embed phase. See lib/chunk-worker.js +
// lib/rag/embed.js for the one true path.
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY_INGEST — fold flat auto-memory notes into the curated chain.
//
// st_b9ec1b7c. The harness writes flat .md notes (with `name` + nested
// `metadata.type`) into user/memory/auto/. The chain is the authoritative
// store; flat notes are a write-cheap inbox. This phase scans the inbox and
// appends every new note (by `name`) into the chain via the locked append
// path. The maint_memory_ingest routine carries a tighter freshness window
// than maint_memory_verify, so a freshly-ingested note is normally in scope
// of the same day's verify pass.
//
// Idempotency contract: a flat note whose `name` already exists as a curated
// chain entry is skipped. This means the phase is a no-op on a converged
// chain; only newly-written flat notes are appended. The check is by `name`
// because content can legitimately differ between the flat note (the most
// recent statement) and the chain entry (the historical record of the same
// fact); the chain entry is what counts for "do we have this memory".
//
// MEMORY.md (the projection at the top of user/memory/auto/) is excluded —
// it is a generated index, not a memory entry.
// ═══════════════════════════════════════════════════════════════════════════

async function phaseMemoryIngest() {
  log('MEMORY_INGEST: start');
  const stats = { scanned: 0, appended: 0, skipped: 0, failed: 0 };
  const autoDir = resolve(_scriptDir, '..', 'user', 'memory', 'auto');
  try {
    const [memMod, ingestMod] = await Promise.all([
      import('../lib/memory.js'),
      import('../lib/memory-ingest.js'),
    ]);
    const r = await ingestMod.runMemoryIngest({
      autoDir,
      appendMemory: memMod.appendMemory,
      getLogIndex: memMod.getLogIndex,
      warn: (m) => warn(`MEMORY_INGEST: ${m}`),
    });
    stats.scanned = r.scanned;
    stats.appended = r.appended;
    stats.skipped = r.skipped;
    stats.failed = r.failed;
    if (r.names.length) stats.appended_names = r.names;
    log(`MEMORY_INGEST: done — scanned=${r.scanned} appended=${r.appended} skipped=${r.skipped} failed=${r.failed}`);
  } catch (e) {
    stats.error = e.message;
    results.memory_ingest.stats = stats;
    throw e;
  }
  results.memory_ingest.stats = stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY_RECALC — replay rebuildable memory projections from immutable events.
//
// Inline write hooks keep chat/workbench memory fresh at the moment a turn or
// close happens. This phase is the precision backstop: if older history is
// imported, a source row is repaired, or an edge path missed its immediate hook,
// every active workbench synthesis and topic context projection is rebuilt from
// the full source set.
// ═══════════════════════════════════════════════════════════════════════════

async function phaseMemoryRecalc() {
  log('MEMORY_RECALC: start');
  const stats = { scope: 'all', workbenches: 0, source_set_hashes: [], chat_backfill: null };
  if (DRY_RUN) {
    stats.skipped = 'dry-run';
    results.memory_recalc.stats = stats;
    log('MEMORY_RECALC: skipped (dry-run)');
    return;
  }
  try {
    const { backfillChatMemoryEvents } = await import('../lib/chat-memory-backfill.js');
    stats.chat_backfill = backfillChatMemoryEvents(db);
    const { recalcMemory } = await import('../lib/memory-recalc.js');
    const r = await recalcMemory(db, { all: true });
    stats.workbenches = r.count;
    stats.generated_tiers = r.generated_tiers;
    stats.source_set_hashes = r.source_set_hashes;
    log(`MEMORY_RECALC: done — chat_backfill_inserted=${stats.chat_backfill.inserted} workbenches=${r.count} hashes=${r.source_set_hashes.length}`);
  } catch (e) {
    stats.error = e.message;
    results.memory_recalc.stats = stats;
    throw e;
  }
  results.memory_recalc.stats = stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY_VERIFY — fail loud on chain fork/break.
//
// st_b9ec1b7c. The chain went silently forked for weeks because nothing
// checked it. memory-verify.js exits non-zero on fork/break; this phase
// surfaces that exit code as a phase failure, which the runner's
// failure handler (runPhase below) turns into an Asana task. The verify
// runs against the canonical user/memory/log path; we spawn the script
// rather than import it so stdout shows the same FAIL diagnostic an
// operator would see at the CLI.
// ═══════════════════════════════════════════════════════════════════════════

async function phaseMemoryVerify() {
  log('MEMORY_VERIFY: start');
  const stats = {};
  try {
    const { runMemoryVerifyPhase } = await import('../lib/memory-verify-phase.js');
    const r = runMemoryVerifyPhase();
    stats.exit_code = r.exitCode;
    stats.summary = r.summary;
    if (!r.ok) {
      const detail = r.stdout || r.stderr || `exit ${r.exitCode}`;
      stats.error = detail.slice(0, 500);
      warn(`MEMORY_VERIFY: FAIL — ${detail}`);
      // Throwing makes runPhase mark this phase failed and fire the
      // createNotificationTask Asana alarm. The throw text becomes the
      // task title; keep it short.
      const head = (r.stderr || r.stdout).split('\n')[0] || `exit ${r.exitCode}`;
      throw new Error(`memory-verify failed: ${head}`);
    }
    log(`MEMORY_VERIFY: ${r.summary}`);
  } catch (e) {
    // Propagate so runPhase records the failure and triggers the alarm.
    results.memory_verify.stats = stats;
    throw e;
  }
  results.memory_verify.stats = stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// TIMELINE_RECALC — replay the whole-life timeline projection.
//
// Source tables remain truth. timeline_events is the fast read model for
// "what happened when." Sync/import hooks write it immediately; this replay
// makes retroactive data and missed hooks converge without operator action.
// ═══════════════════════════════════════════════════════════════════════════

async function phaseTimelineRecalc() {
  log('TIMELINE_RECALC: start');
  const stats = { source_rows: 0, timeline_changed: 0, coverage_ok: false };
  if (DRY_RUN) {
    stats.skipped = 'dry-run';
    results.timeline_recalc.stats = stats;
    log('TIMELINE_RECALC: skipped (dry-run)');
    return;
  }
  try {
    const { recalcLifeTimeline, timelineCoverage } = await import('../lib/timeline-recalc.js');
    const r = recalcLifeTimeline(db);
    const coverage = timelineCoverage(db);
    stats.source_rows = r.source_rows;
    stats.timeline_changed = r.timeline_changed;
    stats.coverage_ok = coverage.ok;
    stats.sources = coverage.sources.map((row) => ({
      source: row.source,
      ready: row.ready,
      source_rows: row.source_rows,
      timeline_rows: row.timeline_rows,
      missing: row.missing,
    }));
    log(`TIMELINE_RECALC: done — source_rows=${r.source_rows} changed=${r.timeline_changed} coverage=${coverage.ok ? 'ok' : 'missing'}`);
    if (!coverage.ok) throw new Error('timeline coverage has missing source rows');
  } catch (e) {
    stats.error = e.message;
    results.timeline_recalc.stats = stats;
    throw e;
  }
  results.timeline_recalc.stats = stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT
//
// st_fd14cdd4 (disposition rows 14 + 20) — AUDIT absorbed the retired REPORT
// phase's two surviving values: the day-over-day history jsonl (the source of
// the delta anomalies below) and the anomaly ALARM. REPORT only formatted a
// full-orchestrator run that no longer exists; its markdown file is gone —
// the passive_jobs ledger and /api/server-health are the status surfaces now,
// and anomalies route to the Asana task queue (a report file nobody reads is
// not an alarm).
// ═══════════════════════════════════════════════════════════════════════════

function phaseAudit() {
  log('AUDIT: start');
  const stats = { table_counts: {}, anomalies: [] };

  const TRACKED = [
    'users', 'sessions', 'magic_links',
    'people', 'companies', 'person_identifiers', 'person_interactions',
    // person_edges retired by st_87a0d072 Phase 6.
    'person_groups', 'places',
    'chunks', 'conversations', 'messages', 'token_usage',
    'timeline_events', 'timeline_event_entities',
    'accounts', 'health_notes',
  ];
  for (const t of TRACKED) if (tableExists(t)) stats.table_counts[t] = count(t);

  // Empty-but-expected tables.
  const EXPECT_NONEMPTY = ['people', 'person_identifiers', 'person_interactions'];
  for (const t of EXPECT_NONEMPTY) {
    if (stats.table_counts[t] === 0) stats.anomalies.push(`${t} is empty (expected data)`);
  }

  // Chunk / embedding health.
  if (tableExists('chunks')) {
    const nullEmbed = count('chunks WHERE embedded IS NULL');
    if (nullEmbed > 0) stats.anomalies.push(`${nullEmbed} chunks with NULL embedded state`);
    const pendingEmbed = count('chunks WHERE embedded = 0 AND skip_embed = 0');
    stats.pending_embeddings = pendingEmbed;
    if (pendingEmbed > 10_000) stats.anomalies.push(`${pendingEmbed} chunks unembedded — EMBED backlog`);
  }

  // Orphan-edges audit retired with person_edges by st_87a0d072 Phase 6.

  // Timeline + network snapshots (best-effort; these never throw on empty).
  try { stats.timeline = getTimelineStats(); }
  catch (e) { stats.timeline = `failed: ${e.message}`; }
  try { stats.network = getNetworkStats(); }
  catch (e) { stats.network = `failed: ${e.message}`; }

  // Day-over-day deltas from history.
  if (existsSync(HISTORY_PATH)) {
    try {
      const lines = readFileSync(HISTORY_PATH, 'utf-8').trim().split('\n').filter(Boolean);
      const prev = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
      if (prev?.table_counts) {
        for (const [t, n] of Object.entries(stats.table_counts)) {
          const before = prev.table_counts[t];
          if (typeof before !== 'number' || before === 0) continue;
          const delta = n - before;
          const pct = Math.abs(delta) / before;
          if (pct >= 0.5 && Math.abs(delta) >= 100) {
            stats.anomalies.push(
              `${t}: ${delta >= 0 ? '+' : ''}${delta} rows vs yesterday (${(pct * 100).toFixed(0)}%)`,
            );
          }
        }
      }
    } catch (e) {
      warn(`audit history parse: ${e.message}`);
    }
  }

  // Append today's record for tomorrow's delta comparison (absorbed from the
  // retired REPORT phase). One record per calendar day: a same-day re-run
  // (partial-resume slice, manual fire) must not stack records, or tomorrow's
  // delta would compare against this afternoon instead of yesterday.
  if (!DRY_RUN) {
    try {
      let lastDate = null;
      if (existsSync(HISTORY_PATH)) {
        const lines = readFileSync(HISTORY_PATH, 'utf-8').trim().split('\n').filter(Boolean);
        if (lines.length) lastDate = JSON.parse(lines[lines.length - 1])?.date ?? null;
      }
      if (lastDate !== DATE) {
        mkdirSync(dirname(HISTORY_PATH), { recursive: true });
        appendFileSync(HISTORY_PATH, JSON.stringify({
          date: DATE,
          table_counts: stats.table_counts,
          pending_embeddings: stats.pending_embeddings ?? null,
          anomalies: stats.anomalies.length,
        }) + '\n');
      }
    } catch (e) {
      warn(`audit history append failed: ${e.message}`);
    }
  }

  // Anomaly alarm (absorbed from REPORT): anomalies must reach the operator's
  // task queue, not a log file. Fire-and-forget, same pattern as runPhase's
  // failure alarm — an Asana outage must not fail the audit itself.
  if (stats.anomalies.length > 0 && !DRY_RUN) {
    createNotificationTask(
      `[Robot Dojo] maintenance/AUDIT: ${stats.anomalies.length} anomal${stats.anomalies.length === 1 ? 'y' : 'ies'}`,
      `Day-over-day audit anomalies at ${new Date().toISOString()}:\n\n` +
      stats.anomalies.map((a) => `- ${a}`).join('\n'),
    );
  }

  results.audit.stats = stats;
  log(`AUDIT: done — ${Object.keys(stats.table_counts).length} tables, ${stats.anomalies.length} anomalies`);
}

// ═══════════════════════════════════════════════════════════════════════════
// MONITOR — query gateway error buffer, email if actionable
// ═══════════════════════════════════════════════════════════════════════════

async function phaseMonitor() {
  log('MONITOR: start');
  const stats = { errors_found: 0, email_sent: false };

  const gatewayUrl = config.gatewayUrl || 'https://relay.robotdojo.ai';
  const secret     = config.gatewayInternalSecret;
  if (!secret) { warn('MONITOR: GATEWAY_INTERNAL_SECRET not configured — skipped'); results.monitor.stats = stats; return; }

  const since = Date.now() - 24 * 60 * 60 * 1000; // last 24 hours
  let data;
  try {
    const res = await fetch(`${gatewayUrl}/internal/errors?since=${since}`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    warn(`MONITOR: gateway query failed: ${e.message}`);
    results.monitor.stats = stats;
    return;
  }

  stats.errors_found = data.count ?? 0;
  if (stats.errors_found === 0) {
    log('MONITOR: no errors — done');
    results.monitor.stats = stats;
    return;
  }

  // Group by [status, normalised message].
  const normalise = (msg) => String(msg || '')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<uuid>')
    .replace(/\b\d{6,}\b/g, '<id>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <token>')
    .slice(0, 120);

  const groups = new Map();
  for (const e of data.errors) {
    const key = `${e.status ?? '?'}|${normalise(e.message)}`;
    if (!groups.has(key)) groups.set(key, { status: e.status, pattern: normalise(e.message), count: 0, example: e.requestId });
    groups.get(key).count++;
  }
  const top = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  const rows = top.map(g =>
    `<tr><td>${g.status ?? '—'}</td><td style="font-family:monospace;font-size:12px">${g.pattern}</td><td>${g.count}</td><td style="font-family:monospace;font-size:11px;color:#666">${g.example ?? '—'}</td></tr>`
  ).join('');

  const html = `<p>Robot Dojo caught <strong>${stats.errors_found} errors</strong> in the last 24 hours.</p>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">
<thead><tr style="background:#f0f0f0"><th>Status</th><th>Pattern</th><th>Count</th><th>Example Request ID</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p style="color:#888;font-size:12px">Source: relay.robotdojo.ai/internal/errors — Robot Dojo maintenance</p>`;

  if (!DRY_RUN) {
    try {
      await sendEmail({
        to: ownerEmails()[0],
        subject: `Robot Dojo — ${stats.errors_found} errors in the last 24h`,
        html,
      });
      stats.email_sent = true;
      log(`MONITOR: emailed ${stats.errors_found} errors (${top.length} patterns)`);
    } catch (e) {
      warn(`MONITOR: email failed: ${e.message}`);
    }
  } else {
    log(`MONITOR: dry-run — would email ${stats.errors_found} errors`);
  }

  results.monitor.stats = stats;
}

// REPORT phase retired by name (st_fd14cdd4 AC8 disposition row 20): it
// formatted a single full-orchestrator run that no longer exists. Its
// day-over-day history jsonl + anomaly alarms live in AUDIT above; run status
// lives in the passive_jobs ledger and /api/server-health.

// ═══════════════════════════════════════════════════════════════════════════
// DMARC — parse new aggregate reports from Gmail, append to log
// ═══════════════════════════════════════════════════════════════════════════

async function phaseDmarc() {
  log('DMARC: start');
  const { processed, failed, authFails } = await runDmarcParse({ dryRun: DRY_RUN, account: MAINTENANCE_GOOGLE_ACCOUNT });
  results.dmarc.stats = { processed, failed, authFails };
  log(`DMARC: done — processed: ${processed}, failed: ${failed}, authFails: ${authFails}`);

  // WHY a task (not an email): st_ea15ae66 scope expansion routes infra
  // alerts to the Asana task queue, never the inbox. The owner's inbox stays
  // clean for healable classes; novel/judgment-required issues get one task each.
  if (authFails > 0 && !DRY_RUN) {
    const title = `DMARC: ${authFails} auth failure(s) detected`;
    const notes = `DMARC aggregate reports found ${authFails} auth failure(s) across ${processed} report(s).\nCheck ~/.robotdojo/logs/dmarc.log for details.`;
    const gid = await createNotificationTask(title, notes);
    results.dmarc.stats.task_created = !!gid;
    log(`DMARC: Asana task created — ${authFails} auth failures${gid ? ` (${gid})` : ' (failed)'}`);
  } else if (authFails > 0 && DRY_RUN) {
    log(`DMARC: dry-run — would create Asana task for ${authFails} auth failures`);
  }
}

// TLS-RPT — parse new TLS reporting reports from Gmail
async function phaseTlsRpt() {
  log('TLS_RPT: start');
  const { processed, failed, certFails } = await runTlsRptParse({ dryRun: DRY_RUN, account: MAINTENANCE_GOOGLE_ACCOUNT });
  results.tls_rpt.stats = { processed, failed, certFails };
  log(`TLS_RPT: done — processed: ${processed}, failed: ${failed}, certFails: ${certFails}`);

  // WHY a task (not an email): st_ea15ae66 scope expansion — cert failures
  // need DNS-level human judgment, not an inbox notification. Route through
  // the same Asana task queue as every other heal-impossible class.
  if (certFails > 0 && !DRY_RUN) {
    const title = `TLS-RPT: ${certFails} certificate failure(s) detected`;
    const notes = `TLS reporting found ${certFails} certificate failure(s) across ${processed} report(s).\nCheck ~/.robotdojo/logs/tls-rpt.log for details.`;
    const gid = await createNotificationTask(title, notes);
    results.tls_rpt.stats.task_created = !!gid;
    log(`TLS_RPT: Asana task created — ${certFails} cert failures${gid ? ` (${gid})` : ' (failed)'}`);
  } else if (certFails > 0 && DRY_RUN) {
    log(`TLS_RPT: dry-run — would create Asana task for ${certFails} cert failures`);
  }
}

// GSC — poll Google Search Console for indexing + structured data issues,
// and check the GSC_ALERT_INBOX for unread alert emails. After polling, run
// dispatchHeal to auto-heal known issue classes (noindex, dead URL in
// sitemap, canonical mismatch) and create Asana tasks only for the residue.
async function phaseGsc() {
  log('GSC: start');
  const { properties, inspected, issues, findings, threadIds } =
    await runGscPoll({ dryRun: DRY_RUN, account: MAINTENANCE_GOOGLE_ACCOUNT });
  results.gsc.stats = { properties, inspected, issues };
  log(`GSC: done — properties: ${properties}, inspected: ${inspected}, issues: ${issues}`);

  // WHY dispatchHeal (not direct createNotificationTask): st_ea15ae66 scope
  // expansion. Three deterministic issue classes (noindex, sitemap-remove,
  // canonical) auto-heal; manual-action and thin-content are judgment-required
  // and route to tasks. The 7-day heal-pending log suppresses duplicate tasks
  // during GSC's 2-4 day index lag.
  const issueFindings = (findings || []).filter(f => f?.is_issue);
  if (issueFindings.length > 0 || (threadIds && threadIds.length > 0)) {
    // Import is lazy so the module is not loaded if the phase never runs
    // (cleaner stack traces on unrelated phase failures).
    const { dispatchHeal } = await import('../lib/gsc-heal.js');
    let token = null;
    if (!DRY_RUN) {
      try {
        const { getValidAccessToken, listConnectedGoogleAccounts } = await import('../lib/google-oauth.js');
        const account = MAINTENANCE_GOOGLE_ACCOUNT || listConnectedGoogleAccounts()[0];
        token = account ? await getValidAccessToken(account) : null;
      } catch (e) {
        warn(`GSC: dispatchHeal token fetch failed: ${e.message}`);
      }
    }
    const allowGitPush = !DRY_RUN && process.env.ROBOTDOJO_GSC_HEAL_GIT_PUSH === '1';
    const dispatchResult = await dispatchHeal({
      findings: issueFindings,
      token,
      threadIds: threadIds || [],
      dryRun: DRY_RUN,
      gitPush: allowGitPush,
    });
    results.gsc.stats.healed = dispatchResult.healed.length;
    results.gsc.stats.task_created = dispatchResult.task_created.length;
    results.gsc.stats.suppressed = dispatchResult.suppressed.length;
    log(`GSC: dispatchHeal — healed: ${dispatchResult.healed.length}, tasked: ${dispatchResult.task_created.length}, suppressed: ${dispatchResult.suppressed.length}`);
  }
}

// INDEXNOW — push sitemap URL list to api.indexnow.org so Bing/Yandex/Copilot
// re-crawl as soon as a deploy lands. Google does NOT participate in IndexNow
// (its general-content signal remains sitemap+lastmod). Priority-ordered after
// maint_gsc so any GSC canonical/noindex auto-heals already shipped before we
// re-announce the canonical URL list. Non-fatal on failure — IndexNow
// rejections (422 for host mismatch, 400 for malformed key) are reported, not
// cascaded.
async function phaseIndexNow() {
  log('INDEXNOW: start');
  const script = resolve(_scriptDir, 'submit-indexnow.js');
  const result = spawnSync(process.execPath, [script, '--host', 'robotdojo.ai', ...(DRY_RUN ? ['--dry-run'] : [])], {
    stdio: 'inherit', encoding: 'utf8', timeout: 60_000,
  });
  results.indexnow.stats = { exit_code: result.status };
  if (result.status !== 0) {
    warn(`INDEXNOW: exited ${result.status}`);
    results.indexnow.error = `exit ${result.status}`;
    return;
  }
  log('INDEXNOW: done');
}

// phaseSynthesize + phaseDocSynthesis removed under st_5285c160 (canonical-doc-hybrid).
// Pre-removal: phaseSynthesize spawned memory-synthesize.js (mining feedback memory
// into agents/agents.md); phaseDocSynthesis spawned old doc-synthesis scripts
// to write generated sections into canonical surfaces. Both removed
// because canonical-doc governance collapsed to hand-curated commits — no autonomous
// writer fires against any canonical surface from cron.

// ═══════════════════════════════════════════════════════════════════════════
// Phase registry + runner. One phase per invocation; failure exits non-zero
// so the maintenance worker's retry/quarantine discipline applies.
// ═══════════════════════════════════════════════════════════════════════════

const PHASES = {
  CLEAN:   phaseClean,
  RESCORE: phaseRescore,
  INGEST:  phaseIngest,
  ENTITIES: phaseEntities,
  STYLE:   phaseStyle,
  ENRICH:  phaseEnrich,
  TOPICS:  phaseTopics,
  RECLASSIFY: phaseReclassify,
  RECONCILE: phaseReconcile,
  RECLASSIFY_CHUNKS: phaseReclassifyChunks,
  AMBIENT_SHARD: phaseAmbientShard,
  BRIEF: phaseBrief,
  MEMORY_INGEST: phaseMemoryIngest,
  MEMORY_RECALC: phaseMemoryRecalc,
  MEMORY_VERIFY: phaseMemoryVerify,
  TIMELINE_RECALC: phaseTimelineRecalc,
  AUDIT:   phaseAudit,
  MONITOR: phaseMonitor,
  DMARC:   phaseDmarc,
  TLS_RPT: phaseTlsRpt,
  GSC:     phaseGsc,
  INDEXNOW: phaseIndexNow,
};

async function runPhase(name, fn) {
  const key = name.toLowerCase();
  const t0 = Date.now();
  try {
    await fn();
    results[key].ok = true;
    // st_27561b77 (expansion) — slice-mode partial detection. After the
    // phase returns, if the wall clock has expired the phase did NOT
    // complete all its pending work and the maintenance worker needs to
    // schedule a continuation slice. Phases are idempotent so the next
    // slice resumes cleanly without external checkpoint state.
    if (sliceExpired() && SLICE_DEADLINE_MS !== null) {
      emitPartial(name, 'slice_budget_elapsed');
    }
    // Phase-internal partial signal: if a phase wrote stats.pipeline ===
    // 'partial' (currently INGEST does this when the child ingest run hit
    // its own internal --max-seconds guard), surface the same sentinel.
    if (results[key]?.stats?.pipeline === 'partial') {
      emitPartial(name, 'phase_reported_partial');
    }
  } catch (e) {
    results[key].ok = false;
    results[key].error = e.message;
    err(`${name} FAILED: ${e.message}`);
    if (e.stack) err(e.stack.split('\n').slice(1, 4).join(' | '));
    // Fire-and-forget Asana task — no await so the process can exit on its
    // own clock (the HTTP call resolves before the event loop drains).
    // WHY: every phase failure must surface in the operator's task queue, not
    // just a log file that nobody reads unless something is already wrong.
    createNotificationTask(
      `[Robot Dojo] maintenance/${name}: ${e.message.slice(0, 80)}`,
      `Phase: ${name}\nError: ${e.message}\nTime: ${new Date().toISOString()}\n\n${e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : ''}`
    ); // fire-and-forget — no await
  } finally {
    results[key].duration_ms = Date.now() - t0;
  }
}

async function main() {
  const start = Date.now();
  log(`=== Robot Dojo Maintenance ${DATE} ===`);
  if (DRY_RUN) log('DRY RUN — writes suppressed where possible');
  // The run-all orchestrator path is DELETED (st_fd14cdd4 AC8): every phase
  // is scheduled individually by lib/maintenance-routines.js freshness
  // windows, so an invocation without --phase has nothing meaningful to run.
  // The update-models pre-step moved to the maint_models_refresh routine.
  if (!phaseArg) {
    err(`--phase required. Valid: ${Object.keys(PHASES).join(', ')}`);
    err('The run-all overnight path was retired by st_fd14cdd4 — phases are scheduled by lib/maintenance-routines.js.');
    return { exitCode: 2 };
  }
  if (!PHASES[phaseArg]) {
    err(`Unknown phase: ${phaseArg}. Valid: ${Object.keys(PHASES).join(', ')}`);
    return { exitCode: 2 };
  }
  await runPhase(phaseArg, PHASES[phaseArg]);

  const key = phaseArg.toLowerCase();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`=== ${phaseArg} done in ${elapsed}s — ${results[key].ok ? 'ok' : 'FAILED'} ===`);
  // Non-zero on phase failure so the passive-job handler records a real
  // attempt (retry → quarantine discipline). A PARTIAL slice still exits 0 —
  // the sentinel, not the exit code, signals residual work.
  return { exitCode: results[key].ok ? 0 : 1 };
}

withLaunchDbWriterGuard(MAINT_WRITER_GUARD_NAME, async () => {
  await loadDeps();
  return main();
}, { dryRun: DRY_RUN })
  .then((result) => {
    process.exit(result?.exitCode ?? 0);
  })
  .catch((e) => {
    err(`Fatal: ${e.message}`);
    if (e.stack) err(e.stack);
    process.exit(1);
  });
