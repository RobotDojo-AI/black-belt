#!/usr/bin/env node
/**
 * Synthetic passive data-plane self-heal QA.
 *
 * Runs against a temporary plaintext SQLite DB by default so it can be used
 * without touching a user's live Robot Dojo data. It demonstrates:
 * - bad work quarantines
 * - later good work completes
 * - duplicate jobs collapse
 * - provider/DB failures back off
 * - CPU pressure pauses work
 * - stale leases recover after a simulated restart
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// st_b50005df Phase 6 (AC-4b) — `--live-db` pins the live 6.3GB encrypted DB at
// `~/.robotdojo/robotdojo.db`, NEVER the stale ~240MB empty leftover under
// user/databases (which silently passes any check pointed at it). Keep the
// `.robotdojo/robotdojo.db` tail intact so the AC-4b live-path grep matches and
// the stale-path guard stays clean (this file must not contain the stale-path
// literal anywhere, including comments).
const LIVE_DB_PATH = resolve(homedir(), '.robotdojo/robotdojo.db');
const LIVE_DB = process.argv.includes('--live-db');

const tempDir = mkdtempSync(join(tmpdir(), 'robotdojo-passive-qa-'));
// An explicit ROBOTDOJO_DB override always wins; `--live-db` pins the live DB
// when no override is set; otherwise the safe temp DB is used so the default
// run never touches live user data.
if (!process.env.ROBOTDOJO_DB) {
  process.env.ROBOTDOJO_DB = LIVE_DB ? LIVE_DB_PATH : join(tempDir, 'qa.db');
}
process.env.ROBOTDOJO_ALLOW_PLAINTEXT = '1';
process.env.ROBOTDOJO_LOCAL_DB_KEY ||= 'a'.repeat(64);
process.env.SESSION_SECRET ||= 'passive-data-plane-self-heal-secret-32';
process.env.ROBOTDOJO_PASSIVE_JOB_BACKOFF_BASE_MS ||= '10';
process.env.ROBOTDOJO_PASSIVE_JOB_BACKOFF_MAX_MS ||= '100';
process.env.NODE_ENV ||= 'test';

const { default: db } = await import('../../lib/db.js');
const {
  acquireNextPassiveJob,
  completePassiveJob,
  drainPassiveJobs,
  enqueuePassiveJob,
  failPassiveJob,
  getPassiveJob,
  getPassiveJobSummary,
  quarantinePassiveJob,
} = await import('../../lib/passive-jobs.js');
const {
  reconcileEmbedTopics,
  unquarantineEmbedChunkJobs,
} = await import('../../lib/passive-reconciler.js');

// st_b50005df Phase 2 — insert a deterministic un-embedded chunk so the
// reconciler has real backlog (in the chunks source of truth) to re-derive and
// to justify un-quarantining an embedding job. Cleaned up before exit.
function seedEmbedBacklog(topic) {
  db.prepare(`
    INSERT INTO chunks (topic, source_type, source_id, chunk_index, content, embedded, skip_embed, content_rank)
    VALUES (?, 'email', ?, 0, ?, 0, 0, 3)
  `).run(topic, `qa-selfheal:${topic}`, `qa self-heal backlog for ${topic}`);
}

function clearEmbedBacklog() {
  db.prepare("DELETE FROM chunks WHERE source_id LIKE 'qa-selfheal:%'").run();
}

async function main() {
  db.prepare('DELETE FROM passive_jobs').run();

  enqueuePassiveJob({ jobType: 'drop_folder_import', uniqueKey: 'qa:bad-file', targetType: 'file', targetId: 'bad.json' });
  enqueuePassiveJob({ jobType: 'drop_folder_import', uniqueKey: 'qa:good-file', targetType: 'file', targetId: 'good.json' });
  enqueuePassiveJob({ jobType: 'drop_folder_import', uniqueKey: 'qa:good-file', targetType: 'file', targetId: 'good.json' });

  const bad = acquireNextPassiveJob({ worker: 'qa-drop', jobTypes: ['drop_folder_import'] });
  const poison = new Error('malformed input file');
  poison.quarantine = true;
  failPassiveJob(db, bad.id, poison);

  await drainPassiveJobs({
    worker: 'qa-drop',
    jobTypes: ['drop_folder_import'],
    limit: 10,
    handlers: { drop_folder_import: () => ({ processed: true }) },
    pressureCheck: () => ({ ok: true }),
  });

  enqueuePassiveJob({ jobType: 'embedding_topic', uniqueKey: 'qa:provider', targetType: 'topic', targetId: 'work' });
  const provider = acquireNextPassiveJob({ worker: 'qa-embed', jobTypes: ['embedding_topic'] });
  failPassiveJob(db, provider.id, new Error('embedding provider unavailable'));

  enqueuePassiveJob({ jobType: 'oauth_sync', uniqueKey: 'qa:db-busy', targetType: 'integration', targetId: 'gmail:qa@example.com', maxAttempts: 1 });
  const busy = acquireNextPassiveJob({ worker: 'qa-sync', jobTypes: ['oauth_sync'] });
  const locked = new Error('database is locked');
  locked.code = 'SQLITE_BUSY';
  failPassiveJob(db, busy.id, locked);

  enqueuePassiveJob({ jobType: 'chunk_source_scan', uniqueKey: 'qa:pressure', targetType: 'system', targetId: 'chunks' });
  await drainPassiveJobs({
    worker: 'qa-chunk',
    jobTypes: ['chunk_source_scan'],
    handlers: { chunk_source_scan: () => ({ should_not_run: true }) },
    // st_b50005df — long pause delay so the paused-state assertion is robust to
    // the recoverClaimableJobs sweeps run by the Phase-2 self-heal acquires
    // below. (recoverClaimableJobs is queue-agnostic and recovers any paused
    // row whose run_after has elapsed; a 10ms delay made the assertion flaky.)
    pressureCheck: () => ({ ok: false, reason: 'cpu-pressure', delayMs: 60_000 }),
  });

  enqueuePassiveJob({ jobType: 'integration_health_refresh', uniqueKey: 'qa:restart', targetType: 'integration', targetId: 'granola' });
  const restart = acquireNextPassiveJob({ worker: 'old-worker', jobTypes: ['integration_health_refresh'], leaseMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const recovered = acquireNextPassiveJob({ worker: 'new-worker', jobTypes: ['integration_health_refresh'], leaseMs: 1000 });
  completePassiveJob(db, recovered.id, { recovered_from: restart.lease_owner });

  // ── st_b50005df Phase 2 — embed/chunk-scan self-heal, no manual intervention ──
  // Run in an ISOLATED queue so these forced stalls/failures never collide with
  // the original `default`-queue assertions above (which inspect drop-folder /
  // oauth / chunk-scan-pressure / integration jobs). Every enqueue + acquire
  // below is scoped to P2_QUEUE; the queue is purged before the final summary.
  const P2_QUEUE = 'p2-embed-selfheal';
  clearEmbedBacklog();
  db.prepare('DELETE FROM passive_jobs WHERE queue = ?').run(P2_QUEUE);

  // (A) FORCED STALL of an embedding_topic job. Claim with a 1ms lease and let
  // it expire — the live churn class. The benign lease-expiry reclaim must
  // re-queue it WITHOUT consuming a real-failure attempt, so it never marches
  // to quarantine.
  seedEmbedBacklog('qa-embed-stall');
  enqueuePassiveJob({
    queue: P2_QUEUE,
    jobType: 'embedding_topic', uniqueKey: 'p2:embedding-topic:qa-embed-stall',
    targetType: 'topic', targetId: 'qa-embed-stall', payload: { topic: 'qa-embed-stall' },
  });
  const stalled = acquireNextPassiveJob({ queue: P2_QUEUE, worker: 'stall-old', jobTypes: ['embedding_topic'], leaseMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 6));
  const reclaimed = acquireNextPassiveJob({ queue: P2_QUEUE, worker: 'stall-new', jobTypes: ['embedding_topic'], leaseMs: 60_000 });
  const embedStallHealed = reclaimed
    && reclaimed.id === stalled.id
    && reclaimed.attempts === 0   // benign reclaim cost no real-failure attempt
    && reclaimed.reclaims >= 1;   // bookkeeping advanced
  completePassiveJob(db, reclaimed.id, { qa: 'embed-stall-healed' });

  // (B) FORCED FAILURE → quarantine of an embedding_topic job, then automatic
  // un-quarantine by the reconciler because the backlog still exists in truth.
  // No human touches it — the reconciler re-derives and re-animates.
  const failingEnqueued = enqueuePassiveJob({
    queue: P2_QUEUE,
    jobType: 'embedding_topic', uniqueKey: 'p2:embedding-topic:qa-embed-fail',
    targetType: 'topic', targetId: 'qa-embed-fail', payload: { topic: 'qa-embed-fail' },
    maxAttempts: 1,
  });
  let failing = acquireNextPassiveJob({ queue: P2_QUEUE, worker: 'fail-w', jobTypes: ['embedding_topic'] });
  if (!failing || failing.id !== failingEnqueued.id) failing = getPassiveJob(db, failingEnqueued.id);
  failPassiveJob(db, failing.id, new Error('forced embed failure'), { delayMs: 0 });
  const quarantinedAfterFail = getPassiveJob(db, failing.id).status === 'quarantined';
  // Backlog still exists → reconciler revives. The un-quarantine scan is
  // queue-agnostic by design, so it picks up the isolated-queue job too.
  seedEmbedBacklog('qa-embed-fail');
  const revived = unquarantineEmbedChunkJobs(db);
  const embedFailHealed = quarantinedAfterFail
    && revived.revived.includes(failing.id)
    && getPassiveJob(db, failing.id).status === 'queued';
  completePassiveJob(db, failing.id, { qa: 'embed-fail-healed' });

  // (C) FORCED STALL of a chunk_source_scan job — the same benign-reclaim
  // discipline applies to the chunker, not just embedding.
  enqueuePassiveJob({
    queue: P2_QUEUE,
    jobType: 'chunk_source_scan', uniqueKey: 'p2:chunk-source-scan',
    targetType: 'system', targetId: 'chunks',
  });
  const scanStalled = acquireNextPassiveJob({ queue: P2_QUEUE, worker: 'scan-old', jobTypes: ['chunk_source_scan'], leaseMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 6));
  const scanReclaimed = acquireNextPassiveJob({ queue: P2_QUEUE, worker: 'scan-new', jobTypes: ['chunk_source_scan'], leaseMs: 60_000 });
  const chunkScanHealed = scanReclaimed
    && scanReclaimed.id === scanStalled.id
    && scanReclaimed.attempts === 0
    && scanReclaimed.reclaims >= 1;
  completePassiveJob(db, scanReclaimed.id, { qa: 'chunk-scan-stall-healed' });

  // (D) FORCED QUARANTINE of a chunk_source_scan with backlog still in truth →
  // reconciler re-animates it. The un-quarantine probe reads un-chunked source
  // rows (an email with no chunk), so we seed one.
  db.prepare(`
    INSERT INTO emails (id, subject, sender, sender_email, body_text, is_newsletter, list_unsubscribe, received_at)
    VALUES ('qa-selfheal-email', 'qa', 'A', 'a@example.com', 'body', 0, NULL, '2026-06-01T00:00:00Z')
  `).run();
  enqueuePassiveJob({
    queue: P2_QUEUE,
    jobType: 'chunk_source_scan', uniqueKey: 'p2:chunk-source-scan-q',
    targetType: 'system', targetId: 'chunks',
  });
  const scanJob = acquireNextPassiveJob({ queue: P2_QUEUE, worker: 'scan-q', jobTypes: ['chunk_source_scan'] });
  quarantinePassiveJob(db, scanJob.id, 'forced scan quarantine');
  const scanQuarantined = getPassiveJob(db, scanJob.id).status === 'quarantined';
  const scanRevived = unquarantineEmbedChunkJobs(db);
  const chunkScanFailHealed = scanQuarantined
    && scanRevived.revived.includes(scanJob.id)
    && getPassiveJob(db, scanJob.id).status === 'queued';

  // (E) The reconciler re-derives missing embed jobs from a WIPED queue
  // (default queue — that is where the production reconciler enqueues).
  seedEmbedBacklog('qa-rederive');
  db.prepare("DELETE FROM passive_jobs WHERE unique_key='embedding-topic:qa-rederive'").run();
  reconcileEmbedTopics(db);
  const rederived = db.prepare(
    "SELECT status FROM passive_jobs WHERE unique_key='embedding-topic:qa-rederive'",
  ).get();
  const embedRederived = !!rederived && rederived.status === 'queued';

  // Clean up all Phase-2 scratch so no test residue survives and the
  // original-queue summary below is untouched:
  //  - the isolated P2 queue rows;
  //  - every default-queue embedding_topic job the step-E reconcile enqueued
  //    for a qa-* topic (reconcileEmbedTopics enqueues to the default queue for
  //    EVERY un-embedded topic, including the qa backlog chunks);
  //  - the backlog chunks and scratch email.
  clearEmbedBacklog();
  db.prepare('DELETE FROM passive_jobs WHERE queue = ?').run(P2_QUEUE);
  db.prepare("DELETE FROM passive_jobs WHERE job_type='embedding_topic' AND target_id LIKE 'qa-%'").run();
  db.prepare("DELETE FROM emails WHERE id='qa-selfheal-email'").run();

  const summary = getPassiveJobSummary();
  const flat = Object.fromEntries(summary.queues.map((row) => [row.job_type, row]));
  const embedSelfHeal = {
    embed_stall_healed: embedStallHealed,
    embed_fail_unquarantined: embedFailHealed,
    chunk_scan_stall_healed: chunkScanHealed,
    chunk_scan_fail_unquarantined: chunkScanFailHealed,
    embed_rederived_from_truth: embedRederived,
  };

  const ok = (
    flat.drop_folder_import?.quarantined === 1 &&
    flat.drop_folder_import?.done === 1 &&
    flat.oauth_sync?.retry_count === 1 &&
    flat.chunk_source_scan?.paused === 1 &&
    flat.integration_health_refresh?.done === 1 &&
    // st_b50005df Phase 2 — embed + chunk-scan self-heal, no manual touch.
    Object.values(embedSelfHeal).every(Boolean)
  );

  const payload = {
    ok,
    database: process.env.ROBOTDOJO_DB,
    duplicate_jobs_collapsed: db.prepare("SELECT COUNT(*) AS n FROM passive_jobs WHERE unique_key='qa:good-file'").get().n === 1,
    embed_chunk_self_heal: embedSelfHeal,
    summary,
  };

  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  return ok ? 0 : 1;
}

main()
  .then((code) => {
    if (!process.env.ROBOTDOJO_DB || process.env.ROBOTDOJO_DB.startsWith(tempDir)) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
    process.exit(code);
  })
  .catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    process.exit(1);
  });
