/**
 * lib/maintenance-routines.js — the always-on maintenance schedule (st_fd14cdd4 AC8).
 *
 * One declarative entry per routine. This file REPLACES the overnight batch
 * concept: there is no 9 PM LaunchAgent, no run-all orchestrator, and no
 * hardcoded NIGHTLY_TYPES seed list. Scheduling is FRESHNESS, not calendars —
 * a routine is enqueued (by the supervisor's probe, lib/passive-supervisor.js)
 * whenever its newest done/queued passive_jobs row is older than its freshness
 * window. The off-process maintenance worker drains the queue during idle /
 * server-quiet windows in bounded slices, so "daily" work runs at the first
 * quiet moment of the day instead of waiting for tonight.
 *
 * Schema per entry:
 *   jobType          passive_jobs.job_type — `maint_*` for upkeep routines,
 *                    `pipeline_*` for the entity-pipeline legs (AC8 disposition
 *                    table names; the AC criterion asserts these exact names).
 *   phase            scripts/maintenance-phases.js phase to run (`--phase X`),
 *                    or null for script-backed routines.
 *   script           repo-relative script for non-phase routines (run as a
 *                    bounded child by lib/passive-maintenance-handlers.js).
 *   freshnessMinutes enqueue when the newest done/queued row is older than this.
 *   priority         passive_jobs priority (higher drains first).
 *   maxSeconds       optional per-routine slice override; default is
 *                    MAINT_SLICE_SECONDS (lib/passive-maintenance-handlers.js).
 *   payload          extra payload fields merged into the enqueued job.
 *   targetId         freshness scope (default 'maintenance'); lets two routines
 *                    share a jobType without sharing a freshness clock
 *                    (participants_backfill per source).
 *
 * PURITY CONTRACT: imports nothing — no db, no config, no node modules — so
 * the contract check and unit tests can load it without side effects. All
 * tunables that need env overrides live where they are consumed (the handlers
 * module owns MAINT_SLICE_SECONDS); this file is the declarative WHAT.
 */

// Freshness shorthand. "Daily" routines run at the first idle window after
// their window lapses — not at a fixed hour.
const QUARTER_HOUR = 15;
const SIX_HOURS = 6 * 60;
const DAILY = 24 * 60;

export const ROUTINES = Object.freeze([
  // ── Hygiene + scoring ──────────────────────────────────────────────────────
  // Dedup/orphan hygiene is the backstop for sync-time people seeding (AC6) —
  // rolling ~6h keeps the union-find merge close behind create-or-link.
  { jobType: 'maint_clean', phase: 'CLEAN', freshnessMinutes: SIX_HOURS, priority: 90 },
  // RESCORE ignored --max-seconds before st_fd14cdd4 and quarantined on the
  // 300s passive-job timeout (live root cause). The phase now stops between
  // sub-steps when the slice budget elapses, AND gets a wider 900s budget:
  // computeAllScores is a single monolithic pass that cannot stop mid-flight,
  // so the slice must be wide enough to contain it on the live 7GB DB.
  { jobType: 'maint_rescore', phase: 'RESCORE', freshnessMinutes: DAILY, priority: 40, maxSeconds: 900 },

  // ── Entity pipeline (the "value faster" heart — AC5) ──────────────────────
  // pipeline_ingest also has a data-arrival trigger: any inbound data path that
  // lands new rows enqueues it debounced alongside memory/timeline replay. The
  // 15-min window here is the freshness FLOOR for quiet periods.
  { jobType: 'pipeline_ingest', phase: 'INGEST', freshnessMinutes: QUARTER_HOUR, priority: 60 },
  // ENTITIES follows pipeline_ingest completion (the handlers chain it); the
  // daily window is only the backstop if the chain trigger is ever missed.
  { jobType: 'pipeline_entities', phase: 'ENTITIES', freshnessMinutes: DAILY, priority: 55 },

  // ── Context + classification ───────────────────────────────────────────────
  { jobType: 'maint_topics', phase: 'TOPICS', freshnessMinutes: SIX_HOURS, priority: 50 },
  // st_abf246e4 — coding-agent session catch-up. The Stop hook is lossy
  // (upstream #29881); this rolling ~6h pull imports any session the push
  // missed. Not launch-critical (freshness suffices; a missed slice self-heals
  // next window), so it stays out of LAUNCH_CRITICAL_ROUTINE_JOB_TYPES.
  { jobType: 'maint_session_reconcile', phase: 'RECONCILE', freshnessMinutes: SIX_HOURS, priority: 45 },
  { jobType: 'maint_reclassify', phase: 'RECLASSIFY', freshnessMinutes: DAILY, priority: 22 },
  // Full-corpus chunk re-home: internals owned by st_2cd1af73; one bounded
  // activity-gated slice per freshness window — scheduling moved here only.
  { jobType: 'maint_reclassify_chunks', phase: 'RECLASSIFY_CHUNKS', freshnessMinutes: DAILY, priority: 20 },
  // Old installs may carry pre-cap email chunks that make local embedding look
  // days slower than a fresh launch. New chunks are capped at write time; this
  // bounded script repairs historical email input shape without a blocking
  // migration.
  { jobType: 'maint_email_chunk_compact', script: 'scripts/compact-email-chunk-inputs.mjs', freshnessMinutes: DAILY, priority: 21, maxSeconds: 240, payload: { args: ['--apply'] } },
  // Passive-queue retention. `passive_jobs` had NO retention path of any kind:
  // the session-log job history reached 147k rows / ~1.0 GB of payload at
  // +2,711/day with no ceiling, and that growth is what fed the maintenance
  // worker's CPU burn (migration 147 fixed the query cost; this bounds the
  // table). Two tiers in lib/passive-retention.js — compact the payload to '{}'
  // after 14d (keeps unique_key, so the dedup guard never lapses), delete the
  // row after 90d. Only `done` rows, only session-log job types: routine rows
  // are revived via requeueDone and must never be swept. Bounded slice, resumes
  // across runs.
  { jobType: 'maint_passive_retention', script: 'scripts/prune-passive-jobs.mjs', freshnessMinutes: DAILY, priority: 23, maxSeconds: 240, payload: { args: ['--apply'] } },
  // st_2d941f89 gap 1 — bounded/gated build of the ambient chunk_vec_general
  // shard (scripts/build-general-shard.js). Low priority: this is a first-turn
  // breadth nice-to-have, not on the critical recall path (scoped chat still
  // uses per-topic + HNSW retrieval) — it should never contend a launch-critical
  // routine for the daily maintenance slot.
  { jobType: 'maint_ambient_shard', phase: 'AMBIENT_SHARD', freshnessMinutes: DAILY, priority: 11, maxSeconds: 180 },
  { jobType: 'maint_style', phase: 'STYLE', freshnessMinutes: DAILY, priority: 26 },
  // BB-gated inside the phase (enrichmentDecision); existing 20-entity budget
  // preserved. Enqueued unconditionally — the phase no-ops cheaply in WB.
  { jobType: 'maint_enrich', phase: 'ENRICH', freshnessMinutes: DAILY, priority: 24 },
  // The brief is a daily artifact by nature; it now lands at the first idle
  // window of the day, not 21:00.
  { jobType: 'maint_brief', phase: 'BRIEF', freshnessMinutes: DAILY, priority: 38 },

  // ── Memory chain ───────────────────────────────────────────────────────────
  { jobType: 'maint_memory_ingest', phase: 'MEMORY_INGEST', freshnessMinutes: SIX_HOURS, priority: 34 },
  // Projection replay is the precision backstop: inline write hooks give fresh
  // recall; the data-arrival trigger makes newly integrated source data hit
  // contextual memory quickly, and this freshness window catches any missed
  // edge path.
  { jobType: 'maint_memory_recalc', phase: 'MEMORY_RECALC', freshnessMinutes: SIX_HOURS, priority: 33, maxSeconds: 900 },
  // Keeps the fail-loud Asana alarm (st_b9ec1b7c) — a fork surfaces within a
  // day, same contract as the overnight wiring it replaces.
  { jobType: 'maint_memory_verify', phase: 'MEMORY_VERIFY', freshnessMinutes: DAILY, priority: 32 },
  // The life timeline is a rebuildable projection over connected/imported
  // source tables. Data-arrival hooks keep it fresh; daily replay keeps it
  // exact when old history arrives or an importer missed its hook.
  { jobType: 'maint_timeline_recalc', phase: 'TIMELINE_RECALC', freshnessMinutes: DAILY, priority: 31, maxSeconds: 900 },

  // ── Audit + external monitors ──────────────────────────────────────────────
  // AUDIT absorbed REPORT (retired by name): it owns the day-over-day history
  // jsonl + anomaly alarm now that no run-all report exists.
  { jobType: 'maint_audit', phase: 'AUDIT', freshnessMinutes: DAILY, priority: 30 },
  // st_df0a8d71 AC-8 — nightly memory fact quiz: graph-generated questions
  // against the real no-topic chat path; data-layer quiz gates the chat-layer
  // quiz inside the phase. Wide slice: the chat quiz drives real model turns.
  { jobType: 'maint_monitor', phase: 'MONITOR', freshnessMinutes: DAILY, priority: 18 },
  { jobType: 'maint_dmarc', phase: 'DMARC', freshnessMinutes: DAILY, priority: 16 },
  { jobType: 'maint_tls_rpt', phase: 'TLS_RPT', freshnessMinutes: DAILY, priority: 14 },
  { jobType: 'maint_gsc', phase: 'GSC', freshnessMinutes: DAILY, priority: 12 },
  // Priority-ordered after maint_gsc so any GSC auto-heals ship before the
  // canonical URL list is re-announced (AC8 disposition row 19).
  { jobType: 'maint_indexnow', phase: 'INDEXNOW', freshnessMinutes: DAILY, priority: 10 },

  // ── Script-backed routines (no maintenance-phases.js phase) ───────────────
  // Replaces the overnight runner's update-models pre-step (disposition row
  // 21): config/models.json refreshes daily so model IDs never go stale.
  // Cheap (two HTTPS fetches, never fatal) — 120s slice is generous.
  { jobType: 'maint_models_refresh', script: 'scripts/update-models.js', freshnessMinutes: DAILY, priority: 85, maxSeconds: 120 },
  // Granola attendee residual (AC7): 287 live transcripts could not be covered
  // by the calendar join and need a provider re-read. Every local Granola
  // token was expired at build time; this routine retries daily so the backfill
  // SELF-UPGRADES the moment the Granola app mints fresh tokens — no operator
  // action. The script reports (never invents) the uncoverable residual.
  {
    jobType: 'participants_backfill',
    script: 'scripts/backfill-participants.js',
    freshnessMinutes: DAILY,
    priority: 25,
    targetId: 'granola',
    payload: { source: 'granola' },
  },
  // st_c619d929 — relationship discovery on an automatic cadence (AC8). The
  // kinship miner and the composite resolver had NO scheduled home; a new
  // person-to-person connection only surfaced on a manual run. Both are
  // idempotent, evidence-deduped, fixed-point sweeps, so ordering need not be
  // strict — the resolver runs at a LOWER priority so it drains AFTER the miner
  // within a quiet window, and a resolver one cycle behind a fresh mine
  // self-corrects on the next cadence. The existing supervisor freshness probe
  // picks both up for free.
  { jobType: 'maint_mine_relations', script: 'scripts/ingest/10-mine-relations.js', freshnessMinutes: DAILY, priority: 23, maxSeconds: 600 },
  { jobType: 'maint_resolve_relations', script: 'scripts/rebuild/relation-resolve-run.js', freshnessMinutes: DAILY, priority: 19, maxSeconds: 600 },
  // df_cbd30a5a AC-8 — reap archived-endpoint debris (entity_relationships edges
  // + chunk_entities + dead context pointers on archived people) that the
  // upsert-only re-derive never removes. The scheduled slice runs the WHOLE-GRAPH
  // reap unattended (archived-endpoint rows are always dead debris, and every
  // deleted row is backed up per batch); manual invocation stays dry-run-safe.
  // payload.args:['--execute'] → invoked as `… --execute --max-seconds 600`.
  { jobType: 'maint_reap_archived', script: 'scripts/ingest/reap-archived-endpoints.js', freshnessMinutes: DAILY, priority: 17, maxSeconds: 600, payload: { args: ['--execute'] } },
  // df_cbd30a5a AC-7 — over-merge (weld) suspect detector, REPORT-ONLY (no
  // payload.args → the script writes the candidate report and never splits; a
  // split is always owner-gated behind `--split <id> --execute`).
  { jobType: 'maint_detect_over_merges', script: 'scripts/ingest/detect-over-merges.js', freshnessMinutes: DAILY, priority: 13, maxSeconds: 300 },
  // Resolver hardening — detach role/generic emails (info@, investors@, no-reply@,
  // ESP/notification domains, machine-generated locals) wrongly attached to people
  // and archive any now-zero-signal ghost. The live pipeline refuses these at
  // attach time; this scheduled slice reaps any that slip in from historical data,
  // running unattended with a per-batch backup of every detached row. payload.args
  // → invoked as `… --execute --max-seconds 300`.
  { jobType: 'maint_detach_role_emails', script: 'scripts/ingest/detach-role-emails.js', freshnessMinutes: DAILY, priority: 15, maxSeconds: 300, payload: { args: ['--execute'] } },
]);

export const LAUNCH_CRITICAL_ROUTINE_JOB_TYPES = Object.freeze([
  'maint_clean',
  'maint_rescore',
  'pipeline_ingest',
  'pipeline_entities',
  'maint_topics',
  'maint_reclassify',
  'maint_reclassify_chunks',
  'maint_style',
  'maint_enrich',
  'maint_memory_ingest',
  'maint_memory_recalc',
  'maint_timeline_recalc',
]);

const BY_TYPE = new Map();
for (const routine of ROUTINES) {
  // jobType+targetId is the freshness identity; plain jobType lookups return
  // the first (and for all current types, only) routine of that type.
  if (!BY_TYPE.has(routine.jobType)) BY_TYPE.set(routine.jobType, routine);
}

/** Routine spec by jobType (first match). */
export function getRoutine(jobType) {
  return BY_TYPE.get(jobType) || null;
}

/** All declared jobTypes, deduped, in declaration order. */
export function routineJobTypes() {
  return [...new Set(ROUTINES.map((r) => r.jobType))];
}

/**
 * Validate the spec shape. Returns string[] of problems (empty = valid).
 * Used by tests + the pre-commit contract check so a malformed routine
 * cannot ship (a routine with no phase AND no script would quarantine on
 * "no handler" at drain time — catch it at commit time instead).
 */
export function validateRoutines() {
  const problems = [];
  const seen = new Set();
  for (const r of ROUTINES) {
    const tag = `routine ${r.jobType || '(missing jobType)'}`;
    if (!r.jobType) problems.push(`${tag}: missing jobType`);
    const identity = `${r.jobType}:${r.targetId || 'maintenance'}`;
    if (seen.has(identity)) problems.push(`${tag}: duplicate jobType+targetId`);
    seen.add(identity);
    if (!r.phase && !r.script) problems.push(`${tag}: needs phase or script`);
    if (r.phase && r.script) problems.push(`${tag}: phase and script are exclusive`);
    if (!Number.isFinite(r.freshnessMinutes) || r.freshnessMinutes <= 0) {
      problems.push(`${tag}: freshnessMinutes must be > 0`);
    }
    if (!Number.isFinite(r.priority)) problems.push(`${tag}: priority must be a number`);
    if (r.maxSeconds !== undefined && (!Number.isFinite(r.maxSeconds) || r.maxSeconds <= 0)) {
      problems.push(`${tag}: maxSeconds must be > 0 when set`);
    }
  }
  return problems;
}
