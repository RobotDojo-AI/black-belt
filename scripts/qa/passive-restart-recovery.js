#!/usr/bin/env node
/**
 * QA: passive job restart recovery.
 *
 * Uses child Node processes against a temporary SQLite DB:
 * 1. child A enqueues + leases a job, then exits without completing it
 * 2. child B starts fresh, recovers the expired lease, and completes the job
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const phase = process.argv.find((arg) => arg.startsWith('--phase='))?.split('=')[1] || null;

async function runPhaseStart() {
  const { default: db } = await import('../../lib/db.js');
  const { acquireNextPassiveJob, enqueuePassiveJob } = await import('../../lib/passive-jobs.js');
  db.prepare('DELETE FROM passive_jobs').run();
  enqueuePassiveJob({
    jobType: 'embedding_topic',
    uniqueKey: 'qa:restart-real',
    targetType: 'topic',
    targetId: 'restart-real',
    timeoutMs: 10_000,
  });
  const job = acquireNextPassiveJob({ worker: 'qa-child-a', jobTypes: ['embedding_topic'], leaseMs: 1 });
  process.stdout.write(JSON.stringify({ phase: 'start', job_id: job.id, status: job.status, lease_owner: job.lease_owner }) + '\n');
}

async function runPhaseRecover() {
  const { default: db } = await import('../../lib/db.js');
  const { acquireNextPassiveJob, completePassiveJob, getPassiveJobSummary } = await import('../../lib/passive-jobs.js');
  const recovered = acquireNextPassiveJob({ worker: 'qa-child-b', jobTypes: ['embedding_topic'], leaseMs: 10_000 });
  if (!recovered) throw new Error('no job recovered after restart');
  completePassiveJob(db, recovered.id, { recovered: true, previous_attempts: recovered.attempts - 1 });
  process.stdout.write(JSON.stringify({
    phase: 'recover',
    job_id: recovered.id,
    attempts: recovered.attempts,
    lease_owner: recovered.lease_owner,
    summary: getPassiveJobSummary({ jobTypes: ['embedding_topic'] }),
  }) + '\n');
}

if (phase === 'start') {
  await runPhaseStart();
  process.exit(0);
}

if (phase === 'recover') {
  await runPhaseRecover();
  process.exit(0);
}

const tempDir = mkdtempSync(join(tmpdir(), 'robotdojo-passive-restart-'));
const dbPath = join(tempDir, 'qa.db');
const env = {
  ...process.env,
  ROBOTDOJO_DB: dbPath,
  ROBOTDOJO_ALLOW_PLAINTEXT: '1',
  ROBOTDOJO_LOCAL_DB_KEY: 'b'.repeat(64),
  SESSION_SECRET: process.env.SESSION_SECRET || 'passive-restart-recovery-secret-32',
  NODE_ENV: 'test',
};

function runChild(childPhase) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--phase=${childPhase}`], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.status !== 0) {
    throw new Error(`${childPhase} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return JSON.parse(String(result.stdout || '').trim().split('\n').pop());
}

try {
  const started = runChild('start');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const recovered = runChild('recover');
  const queue = recovered.summary.queues.find((row) => row.job_type === 'embedding_topic');
  const ok = started.job_id === recovered.job_id
    && recovered.attempts >= 2
    && queue?.done === 1
    && queue?.depth === 0;
  process.stdout.write(JSON.stringify({ ok, database: dbPath, started, recovered }, null, 2) + '\n');
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
} finally {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
}
