#!/usr/bin/env node
/**
 * Catch-up embed drain for the large personal backlog.
 *
 * Run after a verified live DB backup. This is a resumable maintenance tool:
 * it pauses the resident chunk-embed-daemon with a token-owned hold, drains the
 * selected topic through the same embedChunks primitive, and releases the hold
 * on exit. It never mutates chunks.topic; reclassification owns topic movement.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { existsSync, mkdirSync, openSync, closeSync, unlinkSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.env.ROBOTDOJO_HOME || resolve(homedir(), 'robotdojo');

const { default: db, openEmbeddingsDb } = await import(resolve(ROOT, 'lib/db.js'));
const { beginEmbedPauseHold, refreshEmbedPauseHold, releaseEmbedPauseHold } = await import(resolve(ROOT, 'lib/embed-pause-hold.js'));
const {
  readEmbedProofFreezeRequest,
  writeEmbedProofFreezeStatus,
  clearEmbedProofFreezeStatus,
} = await import(resolve(ROOT, 'lib/embed-proof-freeze.js'));
const { embedChunks } = await import(resolve(ROOT, 'lib/rag/embed.js'));
const { setEmbedProfile } = await import(resolve(ROOT, 'lib/rag/local-embed.js'));
const { LanePool } = await import(resolve(ROOT, 'lib/rag/lane-pool.js'));
const { computeWorkOrder } = await import(resolve(ROOT, 'lib/rag/work-order.js'));
const {
  activityPauseDecision,
  getActivitySignal,
  chatAppActiveDecision,
} = await import(resolve(ROOT, 'lib/request-observer.js'));

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = '1'] = arg.split('=');
  return [key, value];
}));

const requestedTopic = args.get('--topic') || 'personal';
const workOrderMode = args.has('--work-order')
  || requestedTopic === 'work-order'
  || requestedTopic === '*';
let activeTopic = workOrderMode ? null : requestedTopic;
const maxBatches = Number(args.get('--max-batches') || 0);
const maxChunks = Number(args.get('--max-chunks') || 0);
const lanes = Math.min(3, Math.max(1, Number(process.env.ROBOTDOJO_EMBED_LANES || args.get('--lanes') || 2)));
const nightBatch = Math.max(1, Number(process.env.ROBOTDOJO_NIGHT_BATCH || args.get('--night-batch') || 16));
const workOrderPassMaxBatches = Math.max(1, Number(
  process.env.ROBOTDOJO_DRAIN_WORK_ORDER_PASS_MAX_BATCHES
    || args.get('--work-order-pass-max-batches')
    || 16,
));
const activityWatchMs = Math.max(100, Number(process.env.ROBOTDOJO_DRAIN_ACTIVITY_WATCH_MS || args.get('--activity-watch-ms') || 500));
const foregroundQuietMs = Math.max(0, Number(
  process.env.ROBOTDOJO_DRAIN_FOREGROUND_QUIET_MS
    || args.get('--foreground-quiet-ms')
    || 15 * 60_000,
));
const foregroundPauseSleepMs = Math.max(1000, Number(
  process.env.ROBOTDOJO_DRAIN_FOREGROUND_PAUSE_SLEEP_MS
    || args.get('--foreground-pause-sleep-ms')
    || 30_000,
));
const resourceWatchMs = Math.max(1000, Number(process.env.ROBOTDOJO_DRAIN_RESOURCE_WATCH_MS || args.get('--resource-watch-ms') || 5000));
const minFreeGb = Math.max(0, Number(process.env.ROBOTDOJO_DRAIN_MIN_FREE_GB || args.get('--min-free-gb') || 6));
const holdTtlMs = Math.max(60_000, Number(args.get('--hold-ttl-ms') || 72 * 60 * 60_000));
const holdRefreshMs = Math.max(30_000, Number(process.env.ROBOTDOJO_DRAIN_HOLD_REFRESH_MS || args.get('--hold-refresh-ms') || Math.min(15 * 60_000, Math.floor(holdTtlMs / 3))));
const lockPath = args.get('--lock') || resolve(homedir(), '.robotdojo', 'runtime', 'drain-personal-embeddings.lock');
const stateDir = resolve(homedir(), '.robotdojo');
const longInputChars = Math.max(1, Number(process.env.ROBOTDOJO_EMBED_LONG_INPUT_CHARS || 2000));
const valueRankEntityFloor = 1_000_000_000_000;
const progressLogMinCompleted = Math.max(1, Number(process.env.ROBOTDOJO_DRAIN_PROGRESS_MIN_COMPLETED || args.get('--progress-min-completed') || 512));
const progressLogMinMs = Math.max(1000, Number(process.env.ROBOTDOJO_DRAIN_PROGRESS_MIN_MS || args.get('--progress-min-ms') || 15_000));

mkdirSync(dirname(lockPath), { recursive: true });
let lockFd = null;
try {
  lockFd = openSync(lockPath, 'wx');
} catch {
  console.error(`[drain-personal] lock already held: ${lockPath}`);
  process.exit(1);
}

let hold = null;
let holdRefreshTimer = null;
let holdLostReason = null;
let parkedFreezeId = null;
let lanePool = null;
let lanePoolResetNeeded = false;
let embeddingsDb = null;
let checkpointPromise = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyError(err) {
  return err?.code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(err?.message || String(err || ''));
}

function isTransientLaneError(err) {
  const msg = typeof err === 'string' ? err : (err?.message || String(err || ''));
  return /lane \d+: lane not ready|lane \d+ exited|lane \d+ slice timeout|lane \d+ send failed/i.test(msg);
}

async function busyRetry(label, fn, {
  retries = 8,
  backoffMs = [250, 500, 1000, 2000, 5000, 10000, 15000, 30000],
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err) || attempt >= retries) throw err;
      const waitMs = backoffMs[Math.min(attempt, backoffMs.length - 1)] || 30000;
      console.warn(`[drain-personal] SQLITE_BUSY during ${label}; retry ${attempt + 1}/${retries} after ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

function drainTopicLabel() {
  return workOrderMode ? 'work-order' : activeTopic;
}

function holdMetadata(extra = {}) {
  return {
    topic: drainTopicLabel(),
    active_topic: activeTopic || null,
    mode: workOrderMode ? 'work-order' : 'topic',
    pid: process.pid,
    ...extra,
  };
}

function pendingCount(topicName = activeTopic) {
  if (!topicName) return pendingBacklogCount();
  return db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE topic = ? AND embedded = 0 AND skip_embed = 0')
    .get(topicName).n;
}

function embeddedCount(topicName = activeTopic) {
  if (!topicName) {
    return db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 1').get().n;
  }
  return db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE topic = ? AND embedded = 1')
    .get(topicName).n;
}

function pendingBacklogCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0 AND skip_embed = 0').get().n;
}

async function safePendingCount(label = 'pending count', topicName = workOrderMode ? null : activeTopic) {
  return busyRetry(label, () => pendingCount(topicName));
}

async function safeEmbeddedCount(label = 'embedded count', topicName = workOrderMode ? null : activeTopic) {
  return busyRetry(label, () => embeddedCount(topicName));
}

async function markMigratedIfDrained() {
  if (workOrderMode) return false;
  if (await safePendingCount('pre-migration pending count') !== 0) return false;
  await busyRetry('topic migration marker', () => {
    db.prepare('INSERT OR IGNORE INTO topic_vec_migrations (topic) VALUES (?)').run(activeTopic);
  });
  return true;
}

async function nextWorkOrderTopic() {
  return busyRetry('work-order topic selection', () => {
    const order = computeWorkOrder(db, {
      now: Date.now(),
      longInputChars,
      valueRankFloor: valueRankEntityFloor,
    });
    return order.find((entry) => Number(entry.pending || 0) > 0) || null;
  });
}

function foregroundPauseDecision() {
  const signal = getActivitySignal(db);
  const activity = activityPauseDecision(signal, { pauseMs: 0 });
  const appActive = chatAppActiveDecision(signal);
  return {
    pause: Boolean(appActive || activity.pause),
    reason: appActive ? 'chat-app-active' : (activity.reason || 'foreground-quiet'),
    quiet_ms: foregroundQuietMs,
  };
}

function chatBusy() {
  return foregroundPauseDecision().pause;
}

async function waitForForegroundQuiet(label = 'resume') {
  while (true) {
    const decision = foregroundPauseDecision();
    if (!decision.pause) return;
    console.log(`[drain-personal] foreground active (${decision.reason}) — pausing ${foregroundPauseSleepMs}ms before ${label}`);
    await sleep(foregroundPauseSleepMs);
  }
}

async function checkpoint() {
  if (checkpointPromise) return checkpointPromise;
  checkpointPromise = (async () => {
    try { await busyRetry('embeddings checkpoint', () => embeddingsDb?.pragma('wal_checkpoint(PASSIVE)'), { retries: 2 }); } catch {}
    try { await busyRetry('app db checkpoint', () => db.pragma('wal_checkpoint(PASSIVE)'), { retries: 2 }); } catch {}
  })().finally(() => {
    checkpointPromise = null;
  });
  return checkpointPromise;
}

function gb(bytes) {
  return bytes / (1024 ** 3);
}

function diskFreeDecision() {
  if (!minFreeGb) return { ok: true, reason: null };
  try {
    const stat = statfsSync(stateDir);
    const freeBytes = Number(stat.bavail || 0) * Number(stat.bsize || 0);
    const freeGb = gb(freeBytes);
    if (freeGb < minFreeGb) {
      return {
        ok: false,
        reason: 'disk-free',
        message: `[drain-personal] disk floor reached — free=${freeGb.toFixed(1)}GB min=${minFreeGb.toFixed(1)}GB; stopping drain before OS pressure`,
      };
    }
    return { ok: true, reason: null, freeGb };
  } catch (err) {
    return {
      ok: false,
      reason: 'disk-free-check-failed',
      message: `[drain-personal] disk free check failed: ${err?.message || err}; stopping rather than draining blind`,
    };
  }
}

function laneRssDecision() {
  if (!lanePool || typeof lanePool.rssGate !== 'function') return { ok: true, reason: null };
  const decision = lanePool.rssGate('drain-personal-embeddings');
  if (decision.ok) return decision;
  return {
    ...decision,
    message: `${decision.message} — stopping catch-up drain before memory pressure`,
  };
}

function holdDecision() {
  if (!holdLostReason) return { ok: true, reason: null };
  return {
    ok: false,
    reason: 'embed-pause-hold-lost',
    message: `[drain-personal] pause hold lost (${holdLostReason}) — stopping drain so another embedder cannot compete silently`,
  };
}

function proofFreezeDecision() {
  const freeze = readEmbedProofFreezeRequest();
  if (!freeze.active) return { ok: true, reason: null, freeze };
  return {
    ok: false,
    reason: 'proof-freeze',
    freeze,
    message: `[drain-personal] exact proof freeze requested (${freeze.reason}) — parking drain`,
  };
}

function resourceDecision() {
  const holdState = holdDecision();
  if (!holdState.ok) return holdState;
  const freeze = proofFreezeDecision();
  if (!freeze.ok) return freeze;
  const disk = diskFreeDecision();
  if (!disk.ok) return disk;
  const rss = laneRssDecision();
  if (!rss.ok) return rss;
  return { ok: true, reason: null };
}

function refreshDrainHold(label = 'periodic') {
  if (!hold || holdLostReason) return false;
  const refreshed = refreshEmbedPauseHold(hold, {
    ttlMs: holdTtlMs,
    metadata: holdMetadata({ refreshed_by: label }),
  });
  if (!refreshed.ok) {
    holdLostReason = refreshed.reason || 'refresh-failed';
    console.warn(`[drain-personal] pause hold refresh failed: ${holdLostReason}`);
    return false;
  }
  hold = refreshed;
  return true;
}

async function startLanePool(label = 'startup') {
  if (lanes <= 1 || lanePool) return;
  await waitForForegroundQuiet(`lane startup${label ? ` (${label})` : ''}`);
  lanePool = new LanePool({
    laneCount: lanes,
    sliceTimeoutMs: 600_000,
    env: {
      ROBOTDOJO_LANE_INTRA_THREADS: '2',
      ROBOTDOJO_EMBED_ORT_INTRA_THREADS: '2',
      ROBOTDOJO_MMAP_SIZE: '0',
    },
  });
  console.log(`[drain-personal] waiting for ${lanes} embedding lane(s) to load${label ? ` (${label})` : ''}`);
  await lanePool.waitUntilReady({ timeoutMs: 300_000 });
  console.log(`[drain-personal] ${lanes} embedding lane(s) ready${label ? ` (${label})` : ''}`);
}

async function resetLanePool(label = 'reset') {
  if (lanes <= 1) return;
  try { lanePool?.destroy?.(); } catch {}
  lanePool = null;
  lanePoolResetNeeded = false;
  await startLanePool(label);
}

async function parkForProofFreeze(initialFreeze = null) {
  let freeze = initialFreeze?.active ? initialFreeze : readEmbedProofFreezeRequest();
  if (!freeze.active) {
    if (parkedFreezeId) clearEmbedProofFreezeStatus({ id: parkedFreezeId });
    parkedFreezeId = null;
    return false;
  }

  if (parkedFreezeId !== freeze.id) {
    console.log(`[drain-personal] exact proof freeze active — parking drain id=${freeze.id || 'unknown'} reason=${freeze.reason}`);
    parkedFreezeId = freeze.id || null;
  }

  while (freeze.active) {
    refreshDrainHold('proof-freeze');
    const pending = await safePendingCount('proof-freeze pending count');
    const embedded = await safeEmbeddedCount('proof-freeze embedded count');
    writeEmbedProofFreezeStatus(freeze, {
      topic: drainTopicLabel(),
      pending,
      embedded,
      metadata: {
        hold_reason: hold?.hold?.reason || hold?.reason || null,
        active_topic: activeTopic || null,
        mode: workOrderMode ? 'work-order' : 'topic',
      },
    });
    await sleep(1000);
    freeze = readEmbedProofFreezeRequest();
  }

  if (parkedFreezeId) clearEmbedProofFreezeStatus({ id: parkedFreezeId });
  parkedFreezeId = null;
  console.log('[drain-personal] exact proof freeze released — resuming drain');
  return true;
}

async function embedPass(topicName, passMaxBatches, {
  pass = null,
  passStartPending = null,
} = {}) {
  const passAc = new AbortController();
  let activityAbortLogged = false;
  let drainAbortReason = null;
  const passStartedAt = Date.now();
  let passEmbedded = 0;
  let passReused = 0;
  let passCompleted = 0;
  let lastProgressLogAt = 0;
  let lastProgressCompleted = 0;
  function logPassProgress(payload = {}, { force = false } = {}) {
    passEmbedded += Number(payload.embedded || 0);
    passReused += Number(payload.reused || 0);
    passCompleted += Number(payload.completed || 0);
    const now = Date.now();
    const completedDelta = passCompleted - lastProgressCompleted;
    if (!force && completedDelta < progressLogMinCompleted && now - lastProgressLogAt < progressLogMinMs) return;
    const elapsedMs = Math.max(1, now - passStartedAt);
    const rate = Math.round(passCompleted / (elapsedMs / 3_600_000));
    const pendingEstimate = Number.isFinite(Number(passStartPending))
      ? Math.max(0, Number(passStartPending) - passCompleted)
      : null;
    console.log(`[drain-personal] progress pass=${pass ?? 'unknown'} topic=${topicName} completed=${passCompleted} embedded=${passEmbedded} reused=${passReused} pending_estimate=${pendingEstimate ?? 'unknown'} rate_per_hour=${rate} elapsed_ms=${elapsedMs}`);
    lastProgressLogAt = now;
    lastProgressCompleted = passCompleted;
  }
  function abortPass(reason, message) {
    if (passAc.signal.aborted) return;
    drainAbortReason = reason;
    if (message) console.warn(message);
    if (reason === 'proof-freeze') {
      lanePoolResetNeeded = true;
      try { lanePool?.cancelInFlight?.(); } catch {}
      setTimeout(() => {
        try { if (lanePoolResetNeeded) lanePool?.destroy?.(); } catch {}
      }, 1000).unref?.();
    }
    passAc.abort();
  }
  const activityWatch = setInterval(() => {
    try {
      if (passAc.signal.aborted || !chatBusy()) return;
      const busyLanes = lanePool?.lanes?.filter?.((lane) => lane && lane.busy).length || 0;
      abortPass('activity', null);
      if (!activityAbortLogged) {
        console.log(`[drain-personal] chat active mid-pass — aborting embed slice${busyLanes ? ` and freeing ${busyLanes} busy lane(s)` : ''}`);
        activityAbortLogged = true;
      }
    } catch {
      /* a transient activity-signal read failure just means we re-check next tick */
    }
  }, activityWatchMs);
  activityWatch.unref?.();
  const resourceWatch = setInterval(() => {
    try {
      if (passAc.signal.aborted) return;
      const decision = resourceDecision();
      if (!decision.ok) abortPass(decision.reason, decision.message);
    } catch (err) {
      abortPass('resource-check-failed', `[drain-personal] resource check failed: ${err?.message || err}; stopping rather than draining blind`);
    }
  }, resourceWatchMs);
  resourceWatch.unref?.();
  try {
    const result = await embedChunks(topicName, passAc.signal, {
      embeddingsDb,
      lanePool,
      maxBatches: passMaxBatches,
      nightShortBatchSize: nightBatch,
      shortFirst: true,
      idleGateWorkerName: 'drain-personal-embeddings',
      activityCheck: chatBusy,
      onBatchCommitted: checkpoint,
      onBacklogCompleted: logPassProgress,
    });
    if (drainAbortReason && result && typeof result === 'object') {
      result.drainAbortReason = drainAbortReason;
    }
    return result;
  } finally {
    clearInterval(activityWatch);
    clearInterval(resourceWatch);
  }
}

function cleanup() {
  if (holdRefreshTimer) {
    clearInterval(holdRefreshTimer);
    holdRefreshTimer = null;
  }
  try { lanePool?.destroy?.(); } catch {}
  try { embeddingsDb?.close?.(); } catch {}
  if (parkedFreezeId) {
    try { clearEmbedProofFreezeStatus({ id: parkedFreezeId }); } catch {}
    parkedFreezeId = null;
  }
  if (hold) {
    try { releaseEmbedPauseHold(hold); } catch {}
    hold = null;
  }
  if (lockFd !== null) {
    try { closeSync(lockFd); } catch {}
    lockFd = null;
  }
  try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch {}
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[drain-personal] ${signal} — cleaning up`);
    cleanup();
    process.exit(0);
  });
}

try {
  db.pragma('busy_timeout = 30000');
  embeddingsDb = openEmbeddingsDb();
  if (!embeddingsDb) throw new Error('embeddings.db unavailable');
  embeddingsDb.pragma('busy_timeout = 30000');

  hold = beginEmbedPauseHold({
    reason: 'drain_personal_embeddings_sole_writer',
    ttlMs: holdTtlMs,
    metadata: holdMetadata(),
  });
  if (!hold.ok) {
    throw new Error(`pause hold unavailable: ${hold.reason}${hold.current_reason ? ` (${hold.current_reason})` : ''}`);
  }
  holdRefreshTimer = setInterval(() => refreshDrainHold('interval'), holdRefreshMs);
  holdRefreshTimer.unref?.();
  setEmbedProfile('night');

  await waitForForegroundQuiet('startup');
  await startLanePool('startup');

  const before = await safePendingCount('startup pending count');
  const started = Date.now();
  const startupResource = resourceDecision();
  if (!startupResource.ok) throw new Error(startupResource.message || startupResource.reason);
  console.log(`[drain-personal] start topic=${drainTopicLabel()} pending=${before} lanes=${lanes} nightBatch=${nightBatch} workOrderPassMaxBatches=${workOrderPassMaxBatches} activityWatchMs=${activityWatchMs} foregroundQuietMs=${foregroundQuietMs} resourceWatchMs=${resourceWatchMs} minFreeGb=${minFreeGb} holdRefreshMs=${holdRefreshMs} maxBatches=${maxBatches || 'unbounded'} maxChunks=${maxChunks || 'unbounded'}`);

  let embeddedTotal = 0;
  let completedTotal = 0;
  let reusedTotal = 0;
  let batchesTotal = 0;
  let pass = 0;
  let lastPending = before;
  while ((await safePendingCount('loop pending count')) > 0) {
    if (holdLostReason) break;
    if (await parkForProofFreeze()) continue;
    if (maxChunks > 0 && embeddedTotal >= maxChunks) break;
    await waitForForegroundQuiet('next pass');
    let topicForPass = activeTopic;
    if (workOrderMode) {
      const next = await nextWorkOrderTopic();
      if (!next) {
        const pendingNow = await safePendingCount('work-order empty pending count', null);
        if (pendingNow > 0) {
          throw new Error(`work-order selector returned no embeddable topic while backlog has ${pendingNow} pending chunks; repair blank-topic or empty-content pending rows before drain can finish`);
        }
        break;
      }
      topicForPass = next.topic;
      activeTopic = topicForPass;
      refreshDrainHold('topic-select');
      console.log(`[drain-personal] work-order selected topic=${topicForPass} pending=${next.pending} priority=${next.priority} short=${next.shortPending} long=${next.longPending} emailShare=${Number(next.emailShare || 0).toFixed(3)}`);
    }

    const remainingChunkBudget = maxChunks > 0 ? Math.max(1, maxChunks - embeddedTotal) : 0;
    const batchBudgetFromChunks = remainingChunkBudget > 0
      ? Math.max(1, Math.ceil(remainingChunkBudget / nightBatch))
      : 0;
    const passMaxBatches = maxBatches > 0
      ? maxBatches
      : (batchBudgetFromChunks || (workOrderMode ? workOrderPassMaxBatches : 200));

    pass++;
    let result;
    try {
      result = await embedPass(topicForPass, passMaxBatches, {
        pass,
        passStartPending: lastPending,
      });
    } catch (err) {
      const freeze = readEmbedProofFreezeRequest();
      if (freeze.active || lanePoolResetNeeded) {
        console.warn(`[drain-personal] proof-freeze interrupted embed pass=${pass}; rebuilding lanes before parking (${err?.message || err})`);
        await resetLanePool('proof-freeze');
        await parkForProofFreeze(freeze);
        continue;
      }
      if (!isBusyError(err)) throw err;
      const pendingNow = await safePendingCount('busy-after pending count');
      const completed = Math.max(0, lastPending - pendingNow);
      completedTotal += completed;
      embeddedTotal += completed;
      lastPending = pendingNow;
      console.warn(`[drain-personal] SQLITE_BUSY during embed pass=${pass}; committed=${completed} pending=${pendingNow} — sleeping 30s then resuming`);
      await checkpoint();
      await sleep(30000);
      continue;
    }
    embeddedTotal += Number(result.embedded) || 0;
    reusedTotal += Number(result.reused) || 0;
    batchesTotal += Number(result.batches) || 0;
    const pendingNow = await safePendingCount('post-pass pending count');
    completedTotal = before - pendingNow;
    lastPending = pendingNow;
    const elapsedMs = Date.now() - started;
    const rate = completedTotal > 0 ? Math.round(completedTotal / (elapsedMs / 3_600_000)) : 0;
    console.log(`[drain-personal] pass=${pass} topic=${topicForPass} embedded=${embeddedTotal} completed=${completedTotal} reused=${reusedTotal} pending=${pendingNow} rate_per_hour=${rate} aborted=${result.aborted ? result.abortReason : 'no'}`);
    await checkpoint();

    if (result.drainAbortReason === 'proof-freeze') {
      await resetLanePool('proof-freeze');
      await parkForProofFreeze(readEmbedProofFreezeRequest());
      continue;
    }
    if (result.drainAbortReason && result.drainAbortReason !== 'activity') {
      console.warn(`[drain-personal] stopped by resource guard (${result.drainAbortReason}); rerun after freeing resources or lowering drain intensity`);
      break;
    }
    if (result.aborted && result.abortReason === 'rss-ceiling') {
      console.warn('[drain-personal] stopped by in-process RSS ceiling; rerun resumes from remaining backlog');
      break;
    }
    if (result.error) {
      if (isTransientLaneError(result.error)) {
        console.warn(`[drain-personal] transient lane error during pass=${pass}: ${result.error} — waiting for lanes then retrying`);
        await lanePool?.waitUntilReady?.({ timeoutMs: 300_000 });
        await sleep(10000);
        continue;
      }
      throw new Error(`embed pass failed: ${result.error}`);
    }
    if (result.aborted && result.abortReason === 'activity') {
      await waitForForegroundQuiet('activity abort recovery');
    }
    if (maxBatches > 0 || (maxChunks > 0 && embeddedTotal >= maxChunks)) break;
    if (!result.embedded && !result.reused && !result.aborted) break;
  }

  if (holdLostReason) {
    throw new Error(`pause hold lost: ${holdLostReason}`);
  }

  const after = await safePendingCount('final pending count');
  const migrated = await markMigratedIfDrained();
  console.log(JSON.stringify({
    ok: true,
    topic: drainTopicLabel(),
    active_topic: activeTopic || null,
    mode: workOrderMode ? 'work-order' : 'topic',
    before,
    after,
    embedded: embeddedTotal,
    completed: before - after,
    reused: reusedTotal,
    batches: batchesTotal,
    migrated,
    elapsed_ms: Date.now() - started,
  }, null, 2));
} catch (err) {
  console.error(`[drain-personal] fatal: ${err?.message || err}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
