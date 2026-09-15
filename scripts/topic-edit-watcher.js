#!/usr/bin/env node
/**
 * scripts/topic-edit-watcher.js — st_8c7b7a6b
 *
 * Stage 4 of the topic lifecycle: when the user edits a topic in the
 * left-nav UI, recategorize affected chunks AFTER a 5-min quiet period
 * (debounce) so a burst of edits processes as one settled state, not as
 * five mid-flight re-runs.
 *
 * Runs under launchd (~/Library/LaunchAgents/com.robotdojo.topic-edit-watcher.plist)
 * on a 60-second cadence. The 5-minute debounce is enforced inside the
 * SELECT, NOT in this script, so a restart of the daemon does not reset
 * any in-flight timer:
 *
 *   SELECT slug FROM user_topics
 *   WHERE needs_regen = 1
 *     AND updated_at < datetime('now', '-5 minutes')
 *
 * Debounce rule: "if the user is making many topic changes back to
 * back, wait until they're done before doing the expensive work." The
 * updated_at timestamp pushes forward on every edit; the 5-min filter
 * only matches rows that have been quiet that long.
 *
 * What we do for each stale topic:
 *   1. Regenerate description_embedding (Tier 0 — local Snowflake)
 *   2. Run scripts/ingest/05-reclassify-chunks.js scoped to this T2's
 *      parent T1 (just that branch of the tree, not the whole corpus).
 *      The reclassifier already handles the iterative pass logic.
 *   3. If chunks moved, regenerate context_md (Tier 2 — Sonnet synthesis,
 *      ~3s + ~$0.005 per topic). Otherwise skip the Sonnet call.
 *   4. UPDATE user_topics SET needs_regen=0.
 *
 * RENAME and DELETE are NOT handled here — those are mechanical and run
 * inline in the route handlers (no semantic work needed). See
 * lib/topic-lifecycle.js for those helpers.
 *
 * INTELLIGENCE_TIER: orchestration (calls extraction + synthesis tiers).
 *
 * Run modes:
 *   node scripts/topic-edit-watcher.js                # process stale topics
 *   node scripts/topic-edit-watcher.js --dry-run      # log candidates only
 *   node scripts/topic-edit-watcher.js --force-all    # ignore debounce; useful after bulk import
 */

export const INTELLIGENCE_TIER = 'orchestration';

// st_f6315f0b: when work is pending, this worker spawns a reclassifier
// child + calls Sonnet for context regen — both CPU-meaningful. The
// existing pending-work pre-check (needs_regen=1) already keeps idle cycles
// cheap, but when work IS present we still want the user away.
export const IDLE_GATED = true;

import { spawn } from 'node:child_process';
import { withLaunchDbWriterGuard } from '../lib/db-writer-policy.js';
import { idleGateDecision } from '../lib/idle-gate.js';
import { CHAT_YIELD_POLL_MS, chatAppActiveDecision, getActivitySignal } from '../lib/request-observer.js';

let db;
let generateTopicContext;
let generateTopicEmbedding;
let readEmbedPauseHold;
let topicContextDepsLoaded = false;

const isDryRun = process.argv.includes('--dry-run');
const forceAll = process.argv.includes('--force-all');

// st_27561b77 AC5 — bounded slice + mid-loop yield. The needs_regen=1 set can
// grow to thousands of rows; processing all of them in one launchd fire would
// run ~3s of Sonnet per topic without re-checking idle. The drain processes
// up to TOPIC_SLICE_LIMIT topics per fire, re-checking idle BEFORE each topic
// so a returned-user pauses at the next item boundary. Remaining needs_regen=1
// rows stay flagged for the next idle window — the work is idempotent.
const TOPIC_SLICE_LIMIT = Number(process.env.ROBOTDOJO_TOPIC_WATCHER_SLICE_LIMIT || 1);
const RECLASSIFY_MAX_SECONDS = Number(process.env.ROBOTDOJO_TOPIC_WATCHER_RECLASSIFY_MAX_SECONDS || 120);

function chatAppIsActive() {
  if (!db) return false;
  try {
    return chatAppActiveDecision(getActivitySignal(db));
  } catch {
    return false;
  }
}

function skipForChat(stage, slug = '') {
  if (!chatAppIsActive()) return false;
  const target = slug ? ` (${slug})` : '';
  console.log(`[topic-watcher] chat-app active before ${stage}${target} — leaving needs_regen=1`);
  return true;
}

function skipForMaintenanceHold(stage, slug = '') {
  if (!readEmbedPauseHold) return false;
  const hold = readEmbedPauseHold({ maxCacheMs: 0 });
  if (!hold?.active) return false;
  const target = slug ? ` (${slug})` : '';
  console.log(`[topic-watcher] ${hold.reason} active before ${stage}${target} — leaving needs_regen=1`);
  return true;
}

async function loadMaintenanceHoldDeps() {
  if (readEmbedPauseHold) return;
  const hold = await import('../lib/embed-pause-hold.js');
  readEmbedPauseHold = hold.readEmbedPauseHold;
}

async function loadDbOnly() {
  const dbModule = await import('../lib/db.js');
  db = dbModule.default;
  db.pragma('busy_timeout = 30000');
}

async function loadTopicContextDeps() {
  if (topicContextDepsLoaded) return;
  const topicContext = await import('../lib/topic-context.js');
  generateTopicContext = topicContext.generateTopicContext;
  generateTopicEmbedding = topicContext.generateTopicEmbedding;
  topicContextDepsLoaded = true;
}

async function runReclassifier(slug, t1Parent) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      new URL('./ingest/05-reclassify-chunks.js', import.meta.url).pathname,
      '--no-regen', // we handle Sonnet regen ourselves below
      '--max-seconds',
      String(RECLASSIFY_MAX_SECONDS),
    ], {
      env: {
        ...process.env,
        RECLASSIFY_SCOPE_T1: t1Parent || '',
        RECLASSIFY_SCOPE_T2: slug,
      },
      stdio: 'inherit',
    });

    let killedForChat = false;
    let forceKillTimer = null;
    const poll = setInterval(() => {
      if (!chatAppIsActive()) return;
      killedForChat = true;
      console.log(`[topic-watcher] chat-app opened during reclassifier (${slug}) — stopping child and leaving needs_regen=1`);
      try { child.kill('SIGTERM'); } catch {}
      clearInterval(poll);
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 5000);
      forceKillTimer.unref?.();
    }, CHAT_YIELD_POLL_MS);
    poll.unref?.();

    child.on('error', (err) => {
      clearInterval(poll);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ status: null, signal: null, error: err, killedForChat });
    });
    child.on('exit', (status, signal) => {
      clearInterval(poll);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ status, signal, killedForChat });
    });
  });
}

async function processTopic(slug) {
  console.log(`[topic-watcher] processing ${slug}`);

  // 1. Refresh description_embedding so the reclassifier has a fresh anchor.
  if (skipForMaintenanceHold('embedding refresh', slug)) return { moved: 0, regenerated: false, paused: true };
  if (skipForChat('embedding refresh', slug)) return { moved: 0, regenerated: false, paused: true };
  await loadTopicContextDeps();
  try {
    await generateTopicEmbedding(slug, db);
  } catch (e) {
    console.warn(`  embedding refresh failed: ${e.message}`);
  }

  // 2. Find the topic's T1 parent — scoped reclassify only walks that branch.
  const topic = db.prepare('SELECT parent_slug FROM user_topics WHERE slug = ?').get(slug);
  if (!topic) {
    console.warn(`  topic ${slug} not found — skipping`);
    return { moved: 0, regenerated: false };
  }
  const t1Parent = topic.parent_slug; // may be NULL if slug IS a T1

  // 3. Count chunks before for delta detection.
  const beforeRow = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE topic = ? AND embedded = 1').get(slug);
  const beforeN = beforeRow?.n || 0;

  // 4. Invoke reclassifier scoped to this slug's branch.
  //    We pass via env so the reclassifier targets just the parent's chunks.
  //    (The reclassifier already supports a SCOPE env in its design — added
  //    below.)
  if (!isDryRun) {
    if (skipForMaintenanceHold('reclassifier', slug)) return { moved: 0, regenerated: false, paused: true };
    if (skipForChat('reclassifier', slug)) return { moved: 0, regenerated: false, paused: true };
    const result = await runReclassifier(slug, t1Parent);
    if (result.killedForChat) return { moved: 0, regenerated: false, paused: true };
    if (result.error) {
      console.warn(`  reclassifier error=${result.error.message}`);
    } else if (result.status !== 0) {
      console.warn(`  reclassifier exit=${result.status}${result.signal ? ` signal=${result.signal}` : ''}`);
    }
  }

  // 5. Count after — did anything actually move?
  const afterRow = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE topic = ? AND embedded = 1').get(slug);
  const afterN = afterRow?.n || 0;
  const moved = Math.abs(afterN - beforeN);

  // 6. If chunks moved, regen context_md (Sonnet — slowest leg).
  let regenerated = false;
  if (moved > 0 && !isDryRun) {
    if (skipForMaintenanceHold('context regen', slug)) return { moved, regenerated: false, paused: true };
    if (skipForChat('context regen', slug)) return { moved, regenerated: false, paused: true };
    try {
      await generateTopicContext(slug, db);
      regenerated = true;
      console.log(`  context_md regenerated (delta ${moved} chunks)`);
    } catch (e) {
      console.warn(`  context regen failed: ${e.message}`);
    }
  } else {
    console.log(`  no chunks moved — skipping Sonnet regen`);
  }

  // 7. Clear needs_regen.
  if (!isDryRun) {
    if (skipForMaintenanceHold('needs_regen clear', slug)) return { moved, regenerated, paused: true };
    if (skipForChat('needs_regen clear', slug)) return { moved, regenerated, paused: true };
    db.prepare('UPDATE user_topics SET needs_regen = 0 WHERE slug = ?').run(slug);
  }

  return { moved, regenerated, paused: false };
}

async function main() {
  await loadMaintenanceHoldDeps();
  await loadDbOnly();
  if (skipForMaintenanceHold('candidate scan')) return { exitCode: 0, skipped: true, reason: 'maintenance-hold-active' };
  if (skipForChat('candidate scan')) return { exitCode: 0, skipped: true, reason: 'chat-app-active' };

  // Candidate rows: edits that have been quiet for ≥5 minutes (or any
  // pending row when --force-all is passed).
  const query = forceAll
    ? "SELECT slug, label, updated_at FROM user_topics WHERE needs_regen = 1 ORDER BY updated_at ASC"
    : "SELECT slug, label, updated_at FROM user_topics WHERE needs_regen = 1 AND updated_at < datetime('now', '-5 minutes') ORDER BY updated_at ASC";

  const candidates = db.prepare(query).all();
  if (candidates.length === 0) {
    if (process.env.VERBOSE) console.log('[topic-watcher] no debounced edits ready');
    return { exitCode: 0 };
  }

  console.log(`[topic-watcher] ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} ready (slice_limit=${TOPIC_SLICE_LIMIT})`);
  // st_27561b77 AC5 — bounded slice with mid-loop idle re-check. The pre-fire
  // idle gate keeps the launchd-fired invocation off the user's machine when
  // they're at the keyboard, but a single fire that started idle can still
  // run for 90+ seconds across 30 topics; if the user returns mid-batch we
  // must yield BEFORE the next Sonnet call. The decision runs at the start
  // of each iteration; idempotent needs_regen=1 means we just exit and the
  // next launchd fire (or supervisor tick) picks up where we left off.
  let processed = 0;
  for (const row of candidates) {
    if (processed >= TOPIC_SLICE_LIMIT) {
      console.log(`[topic-watcher] slice limit ${TOPIC_SLICE_LIMIT} reached — ${candidates.length - processed} remaining for next fire`);
      break;
    }
    const decision = idleGateDecision('topic-edit-watcher');
    if (!decision.ok) {
      console.log(`[topic-watcher] user-active mid-batch — pausing after ${processed} processed, ${candidates.length - processed} remaining (idle=${decision.idle}s threshold=${decision.threshold}s)`);
      break;
    }
    try {
      const r = await processTopic(row.slug);
      if (r?.paused) {
        console.log(`[topic-watcher] paused after ${processed} processed — ${candidates.length - processed} remaining for next idle window`);
        break;
      }
      console.log(`  done ${row.slug}: moved=${r.moved} regen=${r.regenerated}`);
    } catch (e) {
      console.error(`  ${row.slug} fatal:`, e.message);
    }
    processed++;
  }
  console.log(`[topic-watcher] done processed=${processed}`);
  return { exitCode: 0 };
}

async function run() {
  return withLaunchDbWriterGuard('topic-edit-watcher', main, { dryRun: isDryRun });
}

run().then((result) => {
  process.exit(result?.exitCode ?? 0);
}).catch(err => {
  console.error('[topic-watcher] fatal:', err.message);
  process.exit(1);
});
