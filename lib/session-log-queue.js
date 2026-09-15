const DEFAULT_MAX_DEPTH = 500;
const DEFAULT_JOB_TIMEOUT_MS = 10_000;

import crypto from 'node:crypto';
import db from './db.js';
import { readSupervisorSessionLogSummary } from './supervisor-status.js';
import { logTurn, logBookmark } from './session-log.js';
import { materializeSession } from './conversations.js';
import {
  drainPassiveJobs,
  enqueuePassiveJob,
  passiveJobUniqueKey,
} from './passive-jobs.js';
import { enqueuePipelinesOnDataArrival } from './data-arrival-pipelines.js';

function positiveInt(name, fallback) {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const maxDepth = positiveInt('ROBOTDOJO_SESSION_LOG_QUEUE_MAX', DEFAULT_MAX_DEPTH);
const jobTimeoutMs = positiveInt('ROBOTDOJO_SESSION_LOG_JOB_TIMEOUT_MS', DEFAULT_JOB_TIMEOUT_MS);
const sessionStopTimeoutMs = positiveInt(
  'ROBOTDOJO_SESSION_STOP_JOB_TIMEOUT_MS',
  Math.max(jobTimeoutMs, 30_000),
);
const durableDrainLimit = positiveInt('ROBOTDOJO_SESSION_LOG_DURABLE_DRAIN_LIMIT', 25);
const dbBusyTimeoutMs = positiveInt('ROBOTDOJO_SESSION_LOG_DB_BUSY_TIMEOUT_MS', 25);
const enqueueMaxAttempts = positiveInt('ROBOTDOJO_SESSION_LOG_ENQUEUE_MAX_ATTEMPTS', 60);
const durableRetryMs = positiveInt('ROBOTDOJO_SESSION_LOG_DURABLE_RETRY_MS', 250);
const queue = [];

let draining = false;
let durableDraining = false;
let durableRetryTimer = null;
let sequence = 0;
const stats = {
  accepted: 0,
  completed: 0,
  failed: 0,
  dropped: 0,
  last_error: null,
  last_completed_at: null,
};

// st_2cd1af73 AC-1 — exported so the off-process maintenance worker can compute
// the durable session-log summary on its own connection (keeping the aggregate
// scan off the server thread). The worker writes the result to supervisor_status
// and getSessionLogQueueStatus() reads it from there instead of scanning inline.
export const SESSION_LOG_JOB_TYPES = ['session_log_turn', 'session_log_bookmark', 'session_log_batch'];

function hashPayload(kind, payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ kind, payload }))
    .digest('hex')
    .slice(0, 24);
}

function timeout(ms, label) {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`${label || 'session-log job'} timed out`)), ms);
    t.unref?.();
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function normalizeError(err) {
  return err?.message || err?.code || String(err || 'session-log job failed');
}

function isBusyError(err) {
  const message = normalizeError(err);
  return err?.code === 'SQLITE_BUSY'
    || err?.code === 'SQLITE_LOCKED'
    || /SQLITE_(BUSY|LOCKED)|database is locked|database locked/i.test(message);
}

function retryDelayMs(attempts) {
  return Math.min(1000, 50 * (2 ** Math.min(5, Math.max(0, Number(attempts || 1) - 1))));
}

function withShortDbBusyTimeout(fn) {
  let prevTimeout;
  try {
    try { prevTimeout = db.pragma('busy_timeout', { simple: true }); } catch { prevTimeout = undefined; }
    try { db.pragma(`busy_timeout = ${dbBusyTimeoutMs}`); } catch {}
    return fn();
  } finally {
    if (prevTimeout !== undefined) {
      try { db.pragma(`busy_timeout = ${prevTimeout}`); } catch {}
    }
  }
}

async function withShortDbBusyTimeoutAsync(fn) {
  let prevTimeout;
  try {
    try { prevTimeout = db.pragma('busy_timeout', { simple: true }); } catch { prevTimeout = undefined; }
    try { db.pragma(`busy_timeout = ${dbBusyTimeoutMs}`); } catch {}
    return await fn();
  } finally {
    if (prevTimeout !== undefined) {
      try { db.pragma(`busy_timeout = ${prevTimeout}`); } catch {}
    }
  }
}

async function drain() {
  while (queue.length > 0) {
    const job = queue.shift();
    try {
      await Promise.race([
        job.run(),
        timeout(job.timeoutMs || jobTimeoutMs, job.label),
      ]);
      stats.completed += 1;
      stats.last_completed_at = new Date().toISOString();
      stats.last_error = null;
    } catch (err) {
      const message = normalizeError(err);
      if (job.retryOnBusy && isBusyError(err) && job.attempts < job.maxAttempts) {
        job.attempts += 1;
        stats.last_error = message;
        queue.push(job);
        await sleep(retryDelayMs(job.attempts));
      } else {
        stats.failed += 1;
        stats.last_error = message;
        console.warn('[session-log] queued job failed:', stats.last_error);
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  draining = false;
  if (queue.length > 0) scheduleDrain();
}

function scheduleDrain() {
  if (draining) return;
  draining = true;
  setImmediate(() => {
    drain().catch((err) => {
      draining = false;
      stats.failed += 1;
      stats.last_error = err?.message || String(err || 'session-log drain failed');
      console.warn('[session-log] queue drain failed:', stats.last_error);
      if (queue.length > 0) scheduleDrain();
    });
  });
}

export function enqueueSessionLogJob({
  label = 'session-log',
  run,
  timeoutMs = jobTimeoutMs,
  retryOnBusy = false,
  maxAttempts = 8,
} = {}) {
  if (typeof run !== 'function') {
    throw new Error('enqueueSessionLogJob: run function required');
  }
  if (queue.length >= maxDepth) {
    stats.dropped += 1;
    return { ok: false, error: 'queue_full', depth: queue.length, max_depth: maxDepth };
  }
  const id = `slq_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
  queue.push({ id, label, run, timeoutMs, retryOnBusy, maxAttempts, attempts: 0 });
  stats.accepted += 1;
  scheduleDrain();
  return { ok: true, id, depth: queue.length, max_depth: maxDepth };
}

export function enqueueSessionLogTurn(body) {
  return enqueueDurableSessionLogJob('session_log_turn', {
    threadId: body.threadId,
    role: body.role,
    content: body.content,
    source: body.source || 'unknown',
    toolName: body.toolName || null,
    summary: body.summary || null,
    author: body.author || 'hook',
  }, {
    label: `turn:${body.threadId}`,
    targetId: body.threadId,
    timeoutMs: sessionLogTurnTimeoutMs(body),
  });
}

export function sessionLogTurnTimeoutMs(body = {}) {
  // st_abf246e4 — subagent-stop triggers the same materialize as session-stop,
  // so it earns the same wider timeout.
  return body.role === 'system' && (body.content === 'session-stop' || body.content === 'subagent-stop')
    ? sessionStopTimeoutMs
    : jobTimeoutMs;
}

export function enqueueSessionLogBookmark(body) {
  return enqueueDurableSessionLogJob('session_log_bookmark', {
    threadId: body.threadId,
    summary: body.summary,
    decisions: body.decisions || [],
    nextSteps: body.nextSteps || [],
    openQuestions: body.openQuestions || [],
    source: body.source || 'unknown',
    author: body.author || 'hook',
  }, {
    label: `bookmark:${body.threadId}`,
    targetId: body.threadId,
    timeoutMs: jobTimeoutMs,
  });
}

export function enqueueSessionLogBatch({ entries, source = 'unknown' }) {
  return enqueueDurableSessionLogJob('session_log_batch', {
    source,
    entries,
  }, {
    label: `batch:${entries.length}`,
    targetId: `batch:${hashPayload('session_log_batch', entries)}`,
    timeoutMs: Math.max(jobTimeoutMs, entries.length * 1_000),
  });
}

function enqueueDurableSessionLogJob(jobType, payload, { label, targetId, timeoutMs } = {}) {
  // Do not touch SQLite on the HTTP request path. The session-log hook is
  // background telemetry; if the WAL writer is busy, auth/chat must win. We
  // bound only the in-memory queue here and let the queue persist to passive_jobs
  // on a short-timeout retry loop after the 202 response has already left.
  if (queue.length >= maxDepth) {
    stats.dropped += 1;
    return { ok: false, error: 'queue_full', depth: queue.length, max_depth: maxDepth };
  }

  const payloadHash = hashPayload(jobType, payload);
  const jobSpec = {
    database: db,
    jobType,
    uniqueKey: passiveJobUniqueKey({
      jobType,
      targetType: 'session',
      targetId,
      payload: { payloadHash },
    }),
    targetType: 'session',
    targetId,
    payload,
    priority: 80,
    maxAttempts: 8,
    timeoutMs,
    metadata: { label, payload_hash: payloadHash },
  };
  const writeDurableJob = () => withShortDbBusyTimeout(() => enqueuePassiveJob(jobSpec));
  const queued = enqueueSessionLogJob({
    label: `durable:${label}`,
    timeoutMs,
    retryOnBusy: true,
    maxAttempts: enqueueMaxAttempts,
    run: () => {
      const job = writeDurableJob();
      scheduleDurableDrain();
      return job;
    },
  });
  return {
    ...queued,
    durable: false,
    delayed: true,
    error: queued.ok ? 'durable_enqueue_deferred' : queued.error,
  };
}

function getQueuedDepth() {
  try {
    const row = withShortDbBusyTimeout(() => db.prepare(`
      SELECT COUNT(*) AS n
        FROM passive_jobs
       WHERE job_type IN ('session_log_turn', 'session_log_bookmark', 'session_log_batch')
         AND status IN ('queued', 'running', 'paused')
    `).get());
    return Number(row?.n || 0) + queue.length;
  } catch {
    return queue.length;
  }
}

async function handleSessionLogJob(job) {
  if (job.job_type === 'session_log_turn') {
    await logTurn(job.payload);
    // st_abf246e4 — 'subagent-stop' (SubagentStop hook) materializes exactly
    // like 'session-stop' (Stop hook); origin is decided by isSidechain at parse.
    const isStopMarker = job.payload.role === 'system'
      && (job.payload.content === 'session-stop' || job.payload.content === 'subagent-stop');
    if (isStopMarker) {
      try {
        await materializeSession(db, job.payload.threadId);
      } catch (e) {
        console.warn('[session-log] materialize error:', e.message);
      }
    }
    return { threadId: job.payload.threadId, role: job.payload.role };
  }

  if (job.job_type === 'session_log_bookmark') {
    await logBookmark(job.payload);
    return { threadId: job.payload.threadId };
  }

  if (job.job_type === 'session_log_batch') {
    for (const entry of job.payload.entries || []) {
      if (entry.kind === 'turn') {
        await logTurn({
          threadId: entry.threadId,
          role: entry.role,
          content: entry.content,
          source: entry.source || job.payload.source || 'unknown',
          toolName: entry.toolName || null,
          summary: entry.summary || null,
          author: entry.author || 'hook',
        });
      } else if (entry.kind === 'bookmark') {
        await logBookmark({
          threadId: entry.threadId,
          summary: entry.summary,
          decisions: entry.decisions || [],
          nextSteps: entry.nextSteps || [],
          openQuestions: entry.openQuestions || [],
          source: entry.source || job.payload.source || 'unknown',
          author: entry.author || 'hook',
        });
      }
    }
    return { entries: job.payload.entries?.length || 0 };
  }

  const err = new Error(`unknown session-log job type: ${job.job_type}`);
  err.quarantine = true;
  throw err;
}

async function drainDurable() {
  if (durableDraining) return;
  durableDraining = true;
  let retryAfterDrain = false;
  try {
    const results = await withShortDbBusyTimeoutAsync(() => drainPassiveJobs({
      database: db,
      worker: 'session-log',
      jobTypes: SESSION_LOG_JOB_TYPES,
      limit: durableDrainLimit,
      handlers: {
        session_log_turn: handleSessionLogJob,
        session_log_bookmark: handleSessionLogJob,
        session_log_batch: handleSessionLogJob,
      },
      pressureCheck: () => ({ ok: true, worker: 'session-log' }),
    }));
    for (const result of results) {
      if (result.ok) {
        stats.completed += 1;
        stats.last_completed_at = new Date().toISOString();
        stats.last_error = null;
      } else if (!result.skipped) {
        stats.failed += 1;
        stats.last_error = result.error || result.job?.last_error || 'session-log durable job failed';
      }
    }
    if (results.some((r) => r?.ok)) {
      try {
        enqueuePipelinesOnDataArrival(db, { source: 'session-log-data-arrival' });
      } catch (err) {
        console.warn('[session-log] data-arrival pipeline enqueue failed:', err?.message || String(err));
      }
    }
    if (results.length >= durableDrainLimit && getQueuedDepth() > 0) retryAfterDrain = true;
  } catch (err) {
    stats.last_error = err?.message || String(err || 'session-log durable drain failed');
    if (!isBusyError(err)) stats.failed += 1;
    console.warn('[session-log] durable queue drain failed:', stats.last_error);
    retryAfterDrain = isBusyError(err) || getQueuedDepth() > 0;
  } finally {
    durableDraining = false;
    if (retryAfterDrain) scheduleDurableDrain({ delayMs: durableRetryMs });
  }
}

function scheduleDurableDrain({ delayMs = 0 } = {}) {
  if (durableDraining || durableRetryTimer) return;
  const run = () => {
    durableRetryTimer = null;
    drainDurable().catch((err) => {
      durableDraining = false;
      stats.failed += 1;
      stats.last_error = err?.message || String(err || 'session-log durable drain failed');
      console.warn('[session-log] durable queue drain failed:', stats.last_error);
    });
  };
  if (delayMs > 0) {
    durableRetryTimer = setTimeout(run, delayMs);
    durableRetryTimer.unref?.();
  } else {
    setImmediate(run);
  }
}

export function drainSessionLogJobsForTest() {
  return drainDurable();
}

export function getSessionLogQueueStatus() {
  // st_2cd1af73 AC-1 (round 2) — prefer the durable summary the off-process
  // maintenance worker publishes to supervisor_status (one small-row read, no
  // aggregate scan on the server thread). If the worker has not published yet,
  // surface a warming marker instead of scanning passive_jobs inline; transcript
  // status can lag, but chat/login cannot stall for a dashboard.
  let durable = readSupervisorSessionLogSummary(db);
  if (!durable) {
    durable = {
      ok: false,
      warming: true,
      reason: 'worker-summary-warming',
      totals: { depth: null },
      queues: [],
    };
  }
  const durableDepth = Number.isFinite(Number(durable?.totals?.depth))
    ? Number(durable.totals.depth)
    : 0;
  return {
    ...stats,
    depth: queue.length + durableDepth,
    max_depth: maxDepth,
    draining: draining || durableDraining,
    durable,
  };
}

export function _resetSessionLogQueueForTest() {
  queue.length = 0;
  draining = false;
  if (durableRetryTimer) clearTimeout(durableRetryTimer);
  durableRetryTimer = null;
  sequence = 0;
  Object.assign(stats, {
    accepted: 0,
    completed: 0,
    failed: 0,
    dropped: 0,
    last_error: null,
    last_completed_at: null,
  });
  durableDraining = false;
}
