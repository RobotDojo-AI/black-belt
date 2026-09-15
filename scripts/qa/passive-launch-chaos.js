#!/usr/bin/env node
/**
 * QA: passive data-plane launch chaos.
 *
 * Default mode uses a temporary SQLCipher database under user/databases so the
 * check exercises the encrypted binding without touching live user data.
 *
 * Flags:
 *   --live-db          use the current Robot Dojo DB/keychain instead
 *   --strict-launchd  fail if product LaunchAgents are missing/drifted/unloaded
 *   --max-ms N        foreground route budget, default 500ms
 *   --depth N         synthetic passive queue depth, default 800
 *   --keep-db         keep the temporary SQLCipher DB for inspection
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..', '..');
const args = process.argv.slice(2);

// st_b50005df Phase 6 (AC-4b) — the integration self-heal proofs pin the live
// 6.3GB encrypted DB at `~/.robotdojo/robotdojo.db`, NEVER the stale ~240MB
// empty leftover under user/databases (pre-2026-04-18; silently passes any
// check pointed at it). Keep the `.robotdojo/robotdojo.db` tail intact so the
// AC-4b live-path grep matches and the stale-path guard stays clean (this file
// must not contain the stale-path literal anywhere, including comments).
const LIVE_DB_PATH = resolve(homedir(), '.robotdojo/robotdojo.db');

function hasFlag(name) {
  return args.includes(name);
}

function argValue(name, fallback = null) {
  const direct = args.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const phase = argValue('--phase');
const maxMs = Number(argValue('--max-ms', '500'));
const depth = Number(argValue('--depth', '800'));
const liveDb = hasFlag('--live-db');
const strictLaunchd = hasFlag('--strict-launchd');
const keepDb = hasFlag('--keep-db');
const tempRoots = [];
const qaPrefix = 'qa:launch-chaos:';

if (hasFlag('--via-launchctl') && process.env.ROBOTDOJO_QA_LAUNCHCTL_CHILD !== '1') {
  const childArgs = args.filter((arg) => arg !== '--via-launchctl');
  const result = spawnSync('launchctl', ['asuser', String(process.getuid()), process.execPath, __filename, ...childArgs], {
    cwd: repoRoot,
    env: { ...process.env, ROBOTDOJO_QA_LAUNCHCTL_CHILD: '1' },
    stdio: 'inherit',
    timeout: 120_000,
  });
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

function configureEnvironment() {
  process.env.NODE_ENV ||= 'test';
  process.env.SESSION_SECRET ||= 'passive-launch-chaos-session-secret-32';
  process.env.ROBOTDOJO_SERVER_HEALTH_CACHE_MS = '0';
  process.env.ROBOTDOJO_SLOW_REQUEST_MS = String(maxMs);
  process.env.ROBOTDOJO_PASSIVE_JOB_BACKOFF_BASE_MS ||= '10';
  process.env.ROBOTDOJO_PASSIVE_JOB_BACKOFF_MAX_MS ||= '100';

  // st_b50005df Phase 6 (AC-4b) — `--live-db` explicitly pins the live
  // encrypted DB. An explicit ROBOTDOJO_DB override still wins (so a caller can
  // point at a controlled fixture), but with no override `--live-db` resolves
  // to the live path rather than depending on ambient env to be preset.
  if (liveDb) {
    if (!process.env.ROBOTDOJO_DB) process.env.ROBOTDOJO_DB = LIVE_DB_PATH;
    return null;
  }
  if (process.env.ROBOTDOJO_DB) return null;

  const dbRoot = resolve(repoRoot, 'user', 'databases');
  mkdirSync(dbRoot, { recursive: true });
  const tempRoot = mkdtempSync(join(dbRoot, 'passive-launch-chaos-'));
  tempRoots.push(tempRoot);
  process.env.ROBOTDOJO_DB = join(tempRoot, 'qa.db');
  process.env.ROBOTDOJO_LOCAL_DB_KEY ||= 'd'.repeat(64);
  return tempRoot;
}

configureEnvironment();

// df_974525f2 — db.js routes its [db] init banners through console.error
// (stderr) so machine-parsed stdout stays clean; suppress the noisy ones here
// by patching console.error (was console.info before the banner move).
const originalError = console.error;
console.error = (...entry) => {
  const line = entry.map(String).join(' ');
  if (line.startsWith('[db] migration applied:') || line.startsWith('[db] workbenches registered:')) return;
  originalError(...entry);
};

if (phase === 'hold-lock') {
  const { default: db } = await import('../../lib/db.js');
  db.pragma('busy_timeout = 100');
  db.exec('BEGIN IMMEDIATE');
  process.stdout.write('LOCK_HELD\n');
  await new Promise((resolve) => setTimeout(resolve, Number(argValue('--hold-ms', '1500'))));
  try { db.exec('COMMIT'); } catch {}
  process.exit(0);
}

const { Hono } = await import('hono');
const { default: db } = await import('../../lib/db.js');
const { buildServer } = await import('../../lib/server.js');
const { default: accountsRoutes } = await import('../../routes/accounts.js');
const { default: setupRoutes } = await import('../../routes/setup.js');
const { default: sessionLogRoutes } = await import('../../routes/session-log.js');
const jobs = await import('../../lib/passive-jobs.js');

db.pragma('busy_timeout = 100');

function cipherVersion() {
  try {
    const direct = db.pragma('cipher_version', { simple: true });
    if (direct) return String(direct);
  } catch {}
  try {
    const row = db.prepare('PRAGMA cipher_version').get();
    return Object.values(row || {})[0] ? String(Object.values(row)[0]) : null;
  } catch {
    return null;
  }
}

function encryptedFileHeader() {
  const dbPath = process.env.ROBOTDOJO_DB;
  if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath)) return false;
  try {
    const header = readFileSync(dbPath, { encoding: null, flag: 'r' }).subarray(0, 16);
    return !header.equals(Buffer.from('SQLite format 3\0', 'utf8'));
  } catch {
    return false;
  }
}

function cleanQaRows() {
  db.prepare('DELETE FROM passive_jobs WHERE unique_key LIKE ?').run(`${qaPrefix}%`);
}

async function waitForLockHolder() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--phase=hold-lock', '--hold-ms=5000'], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`lock holder did not become ready: ${stderr || stdout || 'timeout'}`));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!settled && stdout.includes('LOCK_HELD')) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`lock holder exited ${code}: ${stderr || stdout}`));
      }
    });
  });
}

function waitForChild(child) {
  return new Promise((resolve) => child.on('exit', () => resolve()));
}

function requestObserverSlowLogs(warnLogs) {
  return warnLogs.filter((entry) => String(entry[0] || '').includes('[request-observer] slow'));
}

function isLockError(err) {
  return err?.code === 'SQLITE_BUSY'
    || err?.code === 'SQLITE_LOCKED'
    || /database is locked|database locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(err?.message || err));
}

function queueFor(summary, jobType) {
  return summary.queues.find((row) => row.job_type === jobType) || null;
}

function hasObservability(summary) {
  const drop = queueFor(summary, 'drop_folder_import');
  const chunk = queueFor(summary, 'chunk_source_scan');
  const embed = queueFor(summary, 'embedding_topic');
  const oauth = queueFor(summary, 'oauth_sync');
  const requiredFields = ['depth', 'queued', 'running', 'paused', 'done', 'quarantined', 'retry_count', 'last_success_at', 'last_failure_at', 'last_error', 'next_retry_at', 'active_job'];
  if (![drop, chunk, embed, oauth].every(Boolean)) return false;
  if (![drop, chunk, embed, oauth].every((row) => requiredFields.every((field) => Object.hasOwn(row, field)))) return false;
  return drop.depth >= 1
    && drop.done >= 1
    && drop.quarantined >= 1
    && Boolean(drop.last_success_at)
    && Boolean(drop.last_failure_at)
    && Boolean(drop.last_error)
    && chunk.paused >= 1
    && Boolean(chunk.next_retry_at)
    && embed.done >= 1
    && Boolean(embed.last_success_at)
    && oauth.retry_count >= 1
    && Boolean(oauth.last_failure_at)
    && Boolean(oauth.last_error)
    && Boolean(oauth.next_retry_at);
}

async function probe(name, fn) {
  const started = Date.now();
  const detail = await fn();
  const ms = Date.now() - started;
  return { name, ms, ok: ms <= maxMs && detail.ok !== false, detail };
}

async function runForegroundProbes({ healthApp, foregroundApp }) {
  const probes = [];
  probes.push(await probe('/api/server-health', async () => {
    const res = await healthApp.request('/api/server-health');
    const body = await res.json();
    return { status: res.status, ok: [200, 503].includes(res.status), passive_ok: body.passive_jobs?.ok === true };
  }));
  probes.push(await probe('/api/accounts/integration-cards', async () => {
    const res = await foregroundApp.request('/api/accounts/integration-cards?refresh=1');
    const body = await res.json();
    return { status: res.status, ok: res.status === 200 && body.passive_jobs?.ok === true };
  }));
  probes.push(await probe('/api/accounts/imports', async () => {
    const res = await foregroundApp.request('/api/accounts/imports');
    const body = await res.json();
    return { status: res.status, ok: res.status === 200 && body.passive_jobs?.ok === true };
  }));
  probes.push(await probe('/chat', async () => {
    const res = await foregroundApp.request('/chat');
    const body = await res.text();
    return { status: res.status, ok: res.status === 200 && /chat|dojo|message/i.test(body) };
  }));
  probes.push(await probe('/api/session-log/turn', async () => {
    const res = await foregroundApp.request('/api/session-log/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'qa-launch-chaos',
        threadId: 'passive-launch-chaos',
        role: 'user',
        content: 'foreground launch chaos probe',
      }),
    });
    const body = await res.json();
    return { status: res.status, ok: res.status === 202 && body.ok === true && body.queued === true };
  }));
  return probes;
}

function buildForegroundApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'qa-user', email: 'qa@example.com', is_admin: true });
    c.set('belt', 'black');
    await next();
  });
  app.get('/chat', (c) => c.html(readFileSync(resolve(repoRoot, 'apps/chat/index.html'), 'utf8')));
  app.get('/account', (c) => c.html(readFileSync(resolve(repoRoot, 'apps/account/index.html'), 'utf8')));
  app.get('/account/:tab', (c) => c.html(readFileSync(resolve(repoRoot, 'apps/account/index.html'), 'utf8')));
  app.route('/', accountsRoutes);
  app.route('/', sessionLogRoutes);
  app.route('/api/setup', setupRoutes);
  return app;
}

function checkLaunchAgents() {
  const result = spawnSync(process.execPath, ['scripts/check-live-launch-agents.js', '--print-loaded'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
  });
  const ok = result.status === 0;
  return {
    ok,
    strict: strictLaunchd,
    status: result.status,
    stdout: String(result.stdout || '').trim().split('\n').slice(-20),
    stderr: String(result.stderr || '').trim().split('\n').filter(Boolean).slice(-20),
  };
}

async function main() {
  cleanQaRows();

  const warnLogs = [];
  const originalWarn = console.warn;
  console.warn = (...entry) => {
    warnLogs.push(entry);
    originalWarn(...entry);
  };

  const healthApp = await buildServer();
  const foregroundApp = buildForegroundApp();
  const launchAgents = checkLaunchAgents();

  const cipher = cipherVersion();
  const encryptedHeader = encryptedFileHeader();
  const encryptedOk = Boolean(cipher) || encryptedHeader;

  const requiredPaths = new Set([
    'drop_folder_import',
    'session_log_turn',
    'llm_export_import',
    'oauth_sync',
    'granola_sync',
    'local_sync',
    'chunk_source_scan',
    'embedding_topic',
    'integration_health_refresh',
    'asana_sync',
    'notion_sync',
    'oura_sync',
    'eight_sleep_sync',
    'health_import',
    'imports_snapshot',
    'maintenance',
  ]);
  const inventoryIds = new Set(jobs.PASSIVE_DATA_PLANE_PATHS.map((row) => row.id));
  const inventoryMissing = [...requiredPaths].filter((id) => !inventoryIds.has(id));

  for (let i = 0; i < depth; i += 1) {
    jobs.enqueuePassiveJob({
      jobType: 'drop_folder_import',
      uniqueKey: `${qaPrefix}load:${i}`,
      targetType: 'file',
      targetId: `/tmp/passive-launch-chaos-${i}.json`,
      metadata: { story: 'st_4101b740' },
    });
  }

  const backgroundDrain = jobs.drainPassiveJobs({
    worker: 'qa-launch-drain',
    jobTypes: ['drop_folder_import'],
    limit: Math.min(120, depth),
    handlers: {
      drop_folder_import: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { processed: true };
      },
    },
    pressureCheck: () => ({ ok: true }),
  });

  jobs.enqueuePassiveJob({ jobType: 'drop_folder_import', uniqueKey: `${qaPrefix}bad`, targetType: 'file', targetId: 'bad.json' });
  jobs.enqueuePassiveJob({ jobType: 'drop_folder_import', uniqueKey: `${qaPrefix}good`, targetType: 'file', targetId: 'good.json' });
  jobs.enqueuePassiveJob({ jobType: 'drop_folder_import', uniqueKey: `${qaPrefix}good`, targetType: 'file', targetId: 'good.json' });
  const bad = jobs.acquireNextPassiveJob({ worker: 'qa-launch-drop', jobTypes: ['drop_folder_import'] });
  const poison = new Error('malformed launch-chaos import');
  poison.quarantine = true;
  jobs.failPassiveJob(db, bad.id, poison);
  const good = jobs.acquireNextPassiveJob({ worker: 'qa-launch-drop', jobTypes: ['drop_folder_import'] });
  jobs.completePassiveJob(db, good.id, { imported: true });

  jobs.enqueuePassiveJob({ jobType: 'embedding_topic', uniqueKey: `${qaPrefix}restart`, targetType: 'topic', targetId: 'restart', timeoutMs: 10_000 });
  const oldLease = jobs.acquireNextPassiveJob({ worker: 'qa-launch-old', jobTypes: ['embedding_topic'], leaseMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const recovered = jobs.acquireNextPassiveJob({ worker: 'qa-launch-new', jobTypes: ['embedding_topic'], leaseMs: 10_000 });
  jobs.completePassiveJob(db, recovered.id, { recovered_from: oldLease.lease_owner });

  // ── st_b50005df Phase 2 — kill launch-critical jobs mid-run, prove none stick ──
  // The launch promise is "impossible to permanently break". This block kills an
  // embedding_topic and a chunk_source_scan mid-run (lease abandoned, and a hard
  // quarantine), then proves both are reclaimable WITHOUT manual intervention:
  // the lease-expiry reclaim costs no real-failure attempt, and the reconciler
  // un-quarantines any launch-critical job whose backlog still lives in truth.
  const reconciler = await import('../../lib/passive-reconciler.js');
  const seedChunk = (topic, sourceId) => db.prepare(`
    INSERT INTO chunks (topic, source_type, source_id, chunk_index, content, embedded, skip_embed, content_rank)
    VALUES (?, 'email', ?, 0, ?, 0, 0, 3)
  `).run(topic, sourceId, `launch-chaos backlog ${sourceId}`);

  // (1) KILL mid-run via abandoned lease — the -9 / idle-abort class. The job
  // must reclaim with attempts unchanged (no march to quarantine).
  seedChunk('qa-chaos-kill', `${qaPrefix}kill-chunk`);
  jobs.enqueuePassiveJob({ queue: 'qa-launch-chaos-p2', jobType: 'embedding_topic', uniqueKey: `${qaPrefix}kill`, targetType: 'topic', targetId: 'qa-chaos-kill', payload: { topic: 'qa-chaos-kill' } });
  const killed = jobs.acquireNextPassiveJob({ queue: 'qa-launch-chaos-p2', worker: 'qa-killed', jobTypes: ['embedding_topic'], leaseMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 8));
  const reclaimedKill = jobs.acquireNextPassiveJob({ queue: 'qa-launch-chaos-p2', worker: 'qa-reclaim', jobTypes: ['embedding_topic'], leaseMs: 30_000 });
  const killedJobReclaimed = reclaimedKill && reclaimedKill.id === killed.id && reclaimedKill.attempts === 0;
  jobs.completePassiveJob(db, reclaimedKill.id, { qa: 'killed-reclaimed' });

  // (2) HARD QUARANTINE a launch-critical embedding_topic, backlog still in
  // truth → reconciler re-animates it. No permanent dead-end exists.
  seedChunk('qa-chaos-quar', `${qaPrefix}quar-chunk`);
  jobs.enqueuePassiveJob({ queue: 'qa-launch-chaos-p2', jobType: 'embedding_topic', uniqueKey: `${qaPrefix}quar`, targetType: 'topic', targetId: 'qa-chaos-quar', payload: { topic: 'qa-chaos-quar' } });
  const quarJob = jobs.acquireNextPassiveJob({ queue: 'qa-launch-chaos-p2', worker: 'qa-quar', jobTypes: ['embedding_topic'] });
  jobs.quarantinePassiveJob(db, quarJob.id, 'launch-chaos forced quarantine');
  const quarBefore = jobs.getPassiveJob(db, quarJob.id).status === 'quarantined';
  const quarRevived = reconciler.unquarantineEmbedChunkJobs(db);
  const quarantinedJobRecovered = quarBefore
    && quarRevived.revived.includes(quarJob.id)
    && jobs.getPassiveJob(db, quarJob.id).status === 'queued';

  // (3) The launch invariant: after the chaos, NO launch-critical embed/chunk
  // job is left permanently stuck (quarantined with backlog still in truth, or
  // a running job with an expired lease that never recovers).
  const stuckLaunchCritical = db.prepare(`
    SELECT COUNT(*) AS n FROM passive_jobs
     WHERE job_type IN ('embedding_topic', 'chunk_source_scan')
       AND status = 'quarantined'
  `).get().n;
  const noPermanentlyStuck = killedJobReclaimed && quarantinedJobRecovered && stuckLaunchCritical === 0;

  // Clean up Phase-2 chaos scratch so the launch-chaos summary + the real queue
  // are untouched.
  db.prepare("DELETE FROM chunks WHERE source_id LIKE ?").run(`${qaPrefix}%`);
  db.prepare("DELETE FROM passive_jobs WHERE queue = 'qa-launch-chaos-p2'").run();
  db.prepare("DELETE FROM passive_jobs WHERE job_type='embedding_topic' AND target_id LIKE 'qa-chaos-%'").run();

  jobs.enqueuePassiveJob({ jobType: 'chunk_source_scan', uniqueKey: `${qaPrefix}pressure`, targetType: 'system', targetId: 'chunks' });
  const pressure = await jobs.drainPassiveJobs({
    worker: 'qa-launch-pressure',
    jobTypes: ['chunk_source_scan'],
    handlers: { chunk_source_scan: () => ({ should_not_run: true }) },
    pressureCheck: () => ({ ok: false, reason: 'cpu-pressure', delayMs: 10_000 }),
  });

  jobs.enqueuePassiveJob({ jobType: 'oauth_sync', uniqueKey: `${qaPrefix}busy`, targetType: 'integration', targetId: 'gmail:launch-chaos@example.com' });
  const busyJob = jobs.acquireNextPassiveJob({ worker: 'qa-launch-busy', jobTypes: ['oauth_sync'] });
  const lockChild = await waitForLockHolder();
  let busyError = null;
  let lockHealth = null;
  let probes = [];
  try {
    const started = Date.now();
    const lockRes = await healthApp.request('/api/server-health');
    lockHealth = { status: lockRes.status, ms: Date.now() - started };
    probes = await runForegroundProbes({ healthApp, foregroundApp });
    jobs.completePassiveJob(db, busyJob.id, { should_retry: false });
  } catch (err) {
    busyError = err;
  }
  await waitForChild(lockChild);
  await backgroundDrain;
  const lockBackoff = busyError ? jobs.failPassiveJob(db, busyJob.id, busyError) : null;

  const duplicateCount = db.prepare('SELECT COUNT(*) AS n FROM passive_jobs WHERE unique_key = ?').get(`${qaPrefix}good`).n;
  const summary = jobs.getPassiveJobSummary({
    jobTypes: ['drop_folder_import', 'embedding_topic', 'chunk_source_scan', 'oauth_sync', 'session_log_turn'],
  });
  const slowLogs = requestObserverSlowLogs(warnLogs);

  const checks = {
    encrypted_sqlcipher: encryptedOk,
    passive_inventory_complete: inventoryMissing.length === 0,
    launch_agents: launchAgents.ok || !strictLaunchd,
    foreground_probes_fast_under_lock: probes.length === 5 && probes.every((row) => row.ok),
    no_foreground_slow_logs: slowLogs.length === 0,
    quarantine_good_continues: summary.queues.some((row) => row.job_type === 'drop_folder_import' && row.quarantined >= 1 && row.done >= 1),
    duplicate_jobs_collapsed: duplicateCount === 1,
    // st_b50005df Phase 2 — a benign lease reclaim no longer increments the
    // real-failure counter, so the recovered job's attempts stays 0 (was >=2
    // pre-fix, when every claim bumped attempts). The recovery itself is proven
    // by reclaiming the SAME job id; the no_permanently_stuck_launch_critical
    // check below proves the launch invariant end-to-end.
    restart_recovered: recovered?.id === oldLease?.id && recovered?.attempts === 0 && recovered?.reclaims >= 1,
    no_permanently_stuck_launch_critical: noPermanentlyStuck,
    cpu_pressure_paused: pressure[0]?.skipped === true && pressure[0]?.job?.status === 'paused',
    db_lock_backed_off: isLockError(busyError) && lockBackoff?.status === 'queued' && lockBackoff?.retry_count >= 1,
    server_health_fast_under_lock: lockHealth && lockHealth.ms <= maxMs && [200, 503].includes(lockHealth.status),
    observability_fields_truthful: hasObservability(summary),
  };

  const ok = Object.values(checks).every(Boolean);
  const payload = {
    ok,
    mode: liveDb ? 'live-db' : 'temp-sqlcipher',
    database: process.env.ROBOTDOJO_DB || LIVE_DB_PATH,
    max_ms: maxMs,
    depth,
    cipher_version: cipher,
    encrypted_header: encryptedHeader,
    checks,
    launch_agents: launchAgents,
    probes,
    lock_health: lockHealth,
    lock_error: busyError ? String(busyError.message || busyError.code || busyError).slice(0, 180) : null,
    slow_logs: slowLogs.map((entry) => entry.map(String)),
    passive_jobs: summary,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  return ok ? 0 : 1;
}

main()
  .then((code) => {
    try { cleanQaRows(); } catch {}
    if (!keepDb && !liveDb) {
      for (const root of tempRoots) {
        if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
      }
    }
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
    try { cleanQaRows(); } catch {}
    if (!keepDb && !liveDb) {
      for (const root of tempRoots) {
        if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
      }
    }
    process.exit(1);
  });
