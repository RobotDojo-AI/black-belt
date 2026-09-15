#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// scripts/chunk-embed-daemon.mjs — st_2cd1af73 Phase 1
//
// Compute tier: orchestration. This daemon coordinates the deterministic embed
// primitive (lib/rag/embed.js → local ONNX model); it makes NO LLM call against
// structured data. It loads the embedding model ONCE and lives, draining the
// embed backlog value-first while yielding the single WAL writer to chat.
//
// WHY a long-lived daemon and not the 120s-fire chunk-embed-worker (research
// st_b50005df / st_2cd1af73): the worker reloaded the ~2GB ONNX model every fire
// and re-entered a lease/claim layer that livelocked (reclaims=20, 0.5% drained).
// the throwaway scripts/overnight-drain.mjs (now deleted, superseded by this
// daemon) proved the direct embedChunks() path drains; this productionizes that
// path: model loaded once, no lease, truth-driven loop over
// `chunks WHERE embedded=0 AND skip_embed=0` so recall can PAUSE but never
// terminates. The legacy worker keeps its chunk-source-scanner role; its embed
// path is gated off (EMBED_OWNER) so two embedders never race the WAL writer.
//
// WHY activity + foreground-idle gated: launch stability means background
// embedding may never compete with login, connect, topic edits, or chat. The
// server-activity signal catches product requests; HID idle catches the broader
// "a human is using the Mac" state before a product request exists.
// ─────────────────────────────────────────────────────────────────────────────

export const INTELLIGENCE_TIER = 'orchestration';

// IDLE_GATED is read by check-idle-gated.js (pre-commit) + the registry check.
// true: this long-lived daemon stays resident, but its drain loop waits until
// foreground activity is quiet (server signal + HID idle) before embedding.
export const IDLE_GATED = true;

import { homedir, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const HOME = process.env.HOME || homedir();
const ROOT = process.env.ROBOTDOJO_HOME || resolve(HOME, 'robotdojo');
// Launch-safe foreground gate. The daemon keeps a broad HID-aware gate for
// startup/no-work safety, but selected topic work uses the narrower product
// activity gate so a large import drains under normal Mac use while still yielding
// to live requests and recent chat turns.
const FOREGROUND_IDLE_SECONDS = (() => {
  const raw = Number(process.env.ROBOTDOJO_DAEMON_FOREGROUND_IDLE_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15 * 60;
})();
const STARTUP_GRACE_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_DAEMON_STARTUP_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 90_000;
})();
const FIRST_VECTOR_BOOTSTRAP_ENABLED = process.env.ROBOTDOJO_FIRST_VECTOR_BOOTSTRAP !== '0';
const FIRST_VECTOR_BOOTSTRAP_MAX_CHUNKS = (() => {
  const raw = Number(process.env.ROBOTDOJO_FIRST_VECTOR_BOOTSTRAP_MAX_CHUNKS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 512;
})();
const FIRST_VECTOR_BOOTSTRAP_MAX_TOPICS = (() => {
  const raw = Number(process.env.ROBOTDOJO_FIRST_VECTOR_BOOTSTRAP_MAX_TOPICS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 32;
})();
const FIRST_VECTOR_BOOTSTRAP_MAX_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_FIRST_VECTOR_BOOTSTRAP_MAX_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60 * 60_000;
})();
const FIRST_VECTOR_BOOTSTRAP_BATCHES_PER_TOPIC = (() => {
  const raw = Number(process.env.ROBOTDOJO_FIRST_VECTOR_BOOTSTRAP_BATCHES_PER_TOPIC);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
})();

// Absolute imports — ESM does not resolve relative reliably when launchd starts
// this from an arbitrary CWD; the plist also sets WorkingDirectory but we do not
// depend on it.
const { default: db, openEmbeddingsDb } = await import(resolve(ROOT, 'lib/db.js'));
const { embedChunks } = await import(resolve(ROOT, 'lib/rag/embed.js'));
const { maybeRefreshGlobalIndex } = await import(resolve(ROOT, 'lib/ann/usearch-adapter.js'));
// df_969e7d39 AC-4 — only embedPriorityForTopic is still needed here (the live
// unranked-row fallback passed to computeWorkOrder). The pure scorers
// (valueScoreFromCounts / embedPriorityFromScore) now live in lib/rag/work-order.js,
// which computeWorkOrder applies for the fully-ranked path — no longer imported here.
const { embedPriorityForTopic } = await import(resolve(ROOT, 'lib/chunk-worker.js'));
const { getIdleSeconds, rssCeilingDecision } = await import(resolve(ROOT, 'lib/idle-gate.js'));
const { localEmbeddingModelStatus, setEmbedProfile, getEmbedProfile } = await import(resolve(ROOT, 'lib/rag/local-embed.js'));
const { LanePool } = await import(resolve(ROOT, 'lib/rag/lane-pool.js'));
const {
  getActivitySignal,
  ACTIVITY_PAUSE_MS,
  ACTIVITY_STALE_TTL_MS,
  chatAppActiveDecision,
} = await import(resolve(ROOT, 'lib/request-observer.js'));
const { readEmbedPauseHold } = await import(resolve(ROOT, 'lib/embed-pause-hold.js'));
const { readEmbedProofFreezeRequest } = await import(resolve(ROOT, 'lib/embed-proof-freeze.js'));
// df_969e7d39 AC-4 — the single source of truth for the value-first work order.
// db.js-free so the off-thread child (scripts/chunk-embed-work-order.mjs) can run
// the IDENTICAL derive without importing lib/db.js (which runs migrate() + opens a
// writer at import). daemonWorkOrder() below is a thin wrapper over computeWorkOrder.
const { computeWorkOrder } = await import(resolve(ROOT, 'lib/rag/work-order.js'));
const { SLA_TIERS } = await import(resolve(ROOT, 'lib/rag/embed-sla.js'));

const WORKER_NAME = 'chunk-embed-daemon';

// WHY a 2s busy_timeout on THIS connection (the server keeps 30000): the daemon
// is a separate process. We want it to YIELD to chat, not block. A short timeout
// means a contended write surfaces as SQLITE_BUSY quickly; the loop then backs
// off and re-checks activity rather than holding the writer. db.js sets 30000 at
// open; we override it here for the daemon process only.
db.pragma('busy_timeout = 2000');
db.pragma('extended_result_codes = 1');

// st_1cfe9061 — embeddings.db connection; sole writer for this daemon.
const embeddingsDb = openEmbeddingsDb();

// st_1cfe9061 — HNSW rebuild trigger. Fires once when every distinct embedded
// topic has a row in topic_vec_migrations. Guard: set after first spawn so the
// rebuild isn't triggered repeatedly.
let hnswRebuildTriggered = false;

function markTopicMigrated(topic) {
  if (!embeddingsDb) return;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO topic_vec_migrations (topic) VALUES (?)`
    ).run(topic);
  } catch (err) {
    console.log(`[${WORKER_NAME}] [warn] markTopicMigrated "${topic}": ${err?.message}`);
  }
}

function checkAndTriggerHnswRebuild() {
  if (hnswRebuildTriggered) return;
  if (!embeddingsDb) return;
  try {
    const embedded = db.prepare('SELECT COUNT(DISTINCT topic) as n FROM chunks WHERE embedded=1').get().n;
    const migrated = db.prepare('SELECT COUNT(*) as n FROM topic_vec_migrations').get().n;
    if (embedded > 0 && migrated >= embedded) {
      hnswRebuildTriggered = true;
      const refresh = maybeRefreshGlobalIndex(db);
      console.log(`[${WORKER_NAME}] all ${migrated} topic(s) migrated to embeddings.db — ANN refresh ${refresh.spawned ? 'spawned' : 'skipped'} (${refresh.reason})`);
    }
  } catch (err) {
    console.log(`[${WORKER_NAME}] [warn] checkAndTriggerHnswRebuild: ${err?.message}`);
  }
}

// How long to sleep when the activity signal says "pause", before re-polling.
// Short enough that the daemon resumes within ~ACTIVITY_PAUSE_MS of the user
// going quiet; long enough not to spin the CPU while paused.
const PAUSE_POLL_MS = Number(process.env.ROBOTDOJO_DAEMON_PAUSE_POLL_MS) || 500;

// How long to sleep when the backlog is fully drained, before re-deriving truth.
// Truth-driven: new chunks arrive from the chunk-source scanner, so we re-check
// rather than exit.
const IDLE_DRAIN_POLL_MS = Number(process.env.ROBOTDOJO_DAEMON_IDLE_POLL_MS) || 5_000;

// One topic-slice = this many internal embed batches before the daemon re-checks
// the activity signal + RSS. Small so the yield-to-chat latency is bounded: at
// batch size 8 a slice is ~16 chunks, embedded in well under ACTIVITY_PAUSE_MS,
// so a request that lands mid-slice is honored on the very next slice boundary.
const SLICE_BATCHES = Number(process.env.ROBOTDOJO_DAEMON_SLICE_BATCHES) || 2;

// st_2cd1af73 AC-3 — work-order cache TTL. The work order (daemonWorkOrder) runs
// a GROUP BY plus a per-topic value score over the WHOLE pending backlog; on the
// 333k-row backlog that was MEASURED at ~15s per derivation (8.5s GROUP BY with a
// LENGTH(content) scan + 6.3s of per-topic correlated-subquery value scoring). The
// original loop re-derived it EVERY outer pass — so the daemon spent ~15s deriving
// for every ~2s of actual embedding, and the work-order recompute, not the embed,
// dominated the wall clock (the exact "work-order recompute cost" the brief named
// as a suspect). Topic VALUE ordering does not change meaningfully within a minute
// (priorities are structural, the backlog drains slowly relative to a minute), so
// we derive once and REUSE the order for this TTL, re-deriving only after it
// expires or the order empties. Cooldown/demotion still apply live (checked at use,
// not just at derive). This turns the per-pass tax into a once-per-TTL tax and lets
// the short bulk drain at the model's real rate. Env-tunable.
//
// WHY 10 min (not 1): the derive was MEASURED at ~55s under live load on the 333k
// backlog (the correlated-subquery value score is the cost). At a 60s TTL the
// daemon would spend ~48% of every minute re-deriving — the recompute would STILL
// dominate. Topic VALUE order is structural: a topic's high-signal/entity-density
// share barely moves as chunks drain, and cross-topic priority is stable over
// minutes. So a long TTL is correct — the order stays good while the short bulk
// drains, and live cooldown/demotion + the empty-order force-refresh keep it from
// going stale in the ways that matter. 30 min amortizes the ~50s derive to <3% in
// the worst case and effectively to nil once the backlog shrinks; live cooldown +
// the empty-order force-refresh prevent a stale order from ever stranding the
// daemon on a drained or demoted topic. (Verified live at the 10-min default: the
// short bulk sustained ~32 chunks/min back-to-back; 30 min only removes more of the
// periodic derive stall.)
const WORK_ORDER_TTL_MS = Number(process.env.ROBOTDOJO_DAEMON_WORK_ORDER_TTL_MS) || 1_800_000;

// st_2cd1af73 AC-1 (residual, daemon end): how often the mid-slice activity
// watcher polls the server-activity signal to abort an in-flight (CPU-bound,
// uninterruptible-per-inference) embed slice the moment chat goes active. 250ms
// is frequent enough to react inside a single long inference's sub-batch boundary
// without meaningfully loading the CPU itself (one cheap row read per tick).
// Tunable for a slower/faster box.
const ACTIVITY_WATCH_MS = Number(process.env.ROBOTDOJO_DAEMON_ACTIVITY_WATCH_MS) || 250;

// st_fd14cdd4 AC9 — DB-contention-as-activity. When the server's activity-row
// flush is starved (the row goes stale) the daemon's normal pause gate reads
// "stale → don't pause" and grinds through a live chat turn. SQLITE_BUSY is the
// independent, can't-be-starved signal that the server wants the writer NOW. After
// this many consecutive busy events the daemon treats it as activity the heartbeat
// failed to report: it backs off a real pause window and drops to the polite day
// profile (tears the night lanes down). One streak (not the first busy) so a single
// transient lock does not collapse the night fan-out; a sustained storm does.
const CONTENTION_YIELD_STREAK = Number(process.env.ROBOTDOJO_DAEMON_CONTENTION_STREAK) || 3;
// How long to pause when contention says the server wants the DB. Mirrors the chat
// pause window so the daemon stays out of the way across a chat turn's sub-requests.
const CONTENTION_BACKOFF_MS = Number(process.env.ROBOTDOJO_DAEMON_CONTENTION_BACKOFF_MS) || EMBED_CHAT_PAUSE_MS_FALLBACK();
function EMBED_CHAT_PAUSE_MS_FALLBACK() {
  const v = Number(process.env.ROBOTDOJO_DAEMON_CHAT_PAUSE_MS);
  return Number.isFinite(v) && v > 0 ? v : 1500;
}
// Consecutive SQLITE_BUSY count, reset to 0 on any successful embed. Module-level
// so the catch handler and the success path share it across passes.
let contentionStreak = 0;
// Set by main() so the contention handler can tear the live night lane pool down
// (free its CPU at once) when the server is contending. A no-op until main wires it.
let dropLanePoolForContention = () => false;

// AC-1: cross-loop progress watchdog. lastKnownPending is seeded with a cheap
// backlog COUNT before the first expensive work-order derive, refreshed from each
// work order, then decremented by committed-row notifications while a slice runs.
// -1 means unknown, never "empty". lastProgressAt is reset on committed backlog
// progress and while the foreground pause gate is intentionally holding the
// daemon; the watchdog fires only when work is pending, the daemon is runnable,
// and no progress is made for WATCHDOG_MAX_IDLE_MS.
let lastKnownPending = -1;
let lastProgressAt = Date.now();
const WATCHDOG_MAX_IDLE_MS = 10 * 60 * 1000;

// AC-2: hysteresis after contention-triggered pool teardown. Prevents the lane pool
// from rebuilding immediately after a contention drop — the rebuild cooldown ensures
// chat has had time to clear before inference resumes at full fan-out.
let lastContentionDropAt = 0;
const POOL_REBUILD_COOLDOWN_MS = 90_000;

// df_969e7d39 AC-4 (iteration-4) — the worker's emit cadence (was the main-thread
// timer interval). The heartbeat now fires on an independent worker thread every
// HEARTBEAT_MS, well inside the 35s liveness bound, immune to main-thread blocks.
const HEARTBEAT_MS = 20_000;
// df_969e7d39 AC-4 (iteration-4) — the liveness region the main thread publishes and
// the worker reads. Five int32 slots, one per payload field; only integers cross
// Atomics, so the profile is published as an enum int (0=day, 1=night). The main
// thread writes with Atomics.store (sub-microsecond, lock-free, non-blocking) at the
// cheap points where the values change; the worker reads with Atomics.load on its own
// clock. SharedArrayBuffer is the only handoff whose write does not reintroduce a
// main-thread dependency (a pipe or file write needs the blocked thread schedulable).
//   [0] pending  [1] profile-int  [2] lanesReady  [3] lanesTotal  [4] contentionStreak
const HEARTBEAT_SAB = new SharedArrayBuffer(5 * 4);
const heartbeatState = new Int32Array(HEARTBEAT_SAB);
// Worker ref, stored module-scope for teardown. A worker thread dies automatically
// when the host process exits (watchdog exit, crash, jetsam SIGKILL), so the explicit
// terminate in onSignal is belt-and-suspenders for the graceful path only.
let heartbeatWorker = null;

// df_969e7d39 AC-4 — off-thread work-order derive. The derive is a multi-second
// GROUP BY scan; running it on the main thread blocked the heartbeat/watchdog timers
// (the QA-FAIL root cause). We spawn it as a short-lived child (scripts/
// chunk-embed-work-order.mjs) and await its JSON result, so the main event loop stays
// free. WORK_ORDER_DERIVE_TIMEOUT_MS bounds the wait above the worst measured 94.7s
// derive; on timeout the child is killed and the cached order is kept. deriveInFlight
// is a single-flight Promise guard so two passes never spawn two children.
const WORK_ORDER_DERIVE_TIMEOUT_MS = 180_000;
let deriveInFlight = null;

// Per-slice watchdog. A single topic can hold pathologically long chunks (e.g. a
// 32k-char meeting transcript ≈ 8k tokens) whose CPU embedding takes minutes per
// batch — one such topic would otherwise starve the whole backlog, including the
// high-volume email corpus AC-3 must drain. When a slice exceeds this budget the
// daemon aborts it (embedChunks honors the signal between batches and inside
// embedBatch), re-checks activity, and rotates to the next topic; the slow topic
// is retried on the next pass, making partial progress each time instead of
// blocking. Tunable via ROBOTDOJO_DAEMON_SLICE_TIMEOUT_MS.
const SLICE_TIMEOUT_MS = Number(process.env.ROBOTDOJO_DAEMON_SLICE_TIMEOUT_MS) || 20_000;

// st_2cd1af73 AC-3 — per-topic time budget + cooldown (the wedge-proof queue).
//
// WHY the watchdog alone was not enough (Phase-1 finding): a single ONNX CPU
// inference is UNINTERRUPTIBLE. embedLocalBatch only checks the abort signal
// BETWEEN its internal sub-batches, so a watchdog firing sliceAc.abort() mid-
// inference does nothing until that inference returns — by which time a long-input
// batch has run for minutes and ballooned RSS toward the jetsam kill. Rotating
// away on the next pass (the old behavior) re-selects the same slow topic at the
// HEAD every spawn (value-first put coaching first), so the daemon spent its whole
// life re-fighting the slowest topic and never reached the 335k email bulk.
//
// FIX (the Tesla move): measure each topic's embed time. When a topic's committed
// batch exceeds TOPIC_TIME_BUDGET_MS, FINISH that batch (the work is already done
// and written), then DEMOTE the topic — drop it into an in-memory cooldown set so
// the work order skips it for TOPIC_COOLDOWN_MS. Value-first ordering still applies
// to every healthy topic; a slow topic simply cannot head-block the queue. After
// the cooldown the topic is retried, making steady partial progress instead of
// wedging. The cooldown lives only in this process; a fresh respawn re-evaluates
// every topic, which is correct (a respawn means RSS reset / new conditions).
function readDaemonConfig() {
  try {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, 'config', 'defaults.json'), 'utf8'));
    return cfg?.embed && typeof cfg.embed === 'object' ? cfg.embed : {};
  } catch {
    return {};
  }
}
function numFromEnvOrCfg(envName, cfgVal, fallback) {
  const env = Number(process.env[envName]);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  if (Number.isFinite(Number(cfgVal)) && Number(cfgVal) > 0) return Math.floor(Number(cfgVal));
  return fallback;
}
const DAEMON_CFG = readDaemonConfig();
const TOPIC_TIME_BUDGET_MS = numFromEnvOrCfg('ROBOTDOJO_DAEMON_TOPIC_BUDGET_MS', DAEMON_CFG.topicTimeBudgetMs, 120_000);
const TOPIC_COOLDOWN_MS = numFromEnvOrCfg('ROBOTDOJO_DAEMON_TOPIC_COOLDOWN_MS', DAEMON_CFG.topicCooldownMs, 600_000);

// st_2cd1af73 AC-1 (residual): the char threshold above which a chunk is a LONG
// input. Mirrors lib/rag/embed.js LONG_INPUT_CHAR_THRESHOLD (same config/env). A
// long chunk is a ~1000-token CPU inference (~11s) that cannot be interrupted
// mid-call; the daemon treats long-dominated topics specially.
const LONG_INPUT_CHARS = numFromEnvOrCfg('ROBOTDOJO_EMBED_LONG_INPUT_CHARS', DAEMON_CFG.longInputCharThreshold, 2000);

// st_fd14cdd4 — the chunks.value_rank floor that marks a chunk ENTITY-LINKED. The
// value_rank composite (lib/db.js VALUE_RANK_ENTITY_TERM) adds exactly 1e12 for an
// entity-linked chunk and that term DOMINATES all others (recency max 6e10, length
// source-signal max 3e11, recency max 6e10, length max ~1e6 — see the db.js WHY
// block), so `value_rank >= 1e12` is an exact, cheap
// integer test for entity-linkedness on the column the work-order scan already
// reads. This replaces the per-chunk EXISTS(chunk_entities) correlated subquery
// that made daemonWorkOrder a ~55s shared-connection scan (the 30-65s chat-TTFT
// spike root cause): the derive now folds value into its single GROUP BY pass and
// finishes in ~1.4s. MUST equal lib/db.js VALUE_RANK_ENTITY_TERM; it is a stable,
// documented composite constant, so it is mirrored here with this contract note
// rather than threaded through a new export. A row with value_rank=0 is NOT YET
// RANKED (a fresh insert before backfill, or a test fixture) — such a topic falls
// back to the live embedPriorityForTopic so its ordering is unaffected.
const VALUE_RANK_ENTITY_FLOOR = 1_000_000_000_000;

// A topic-slice whose pending chunks are at least this fraction LONG inputs is
// "long-dominated": one of its inferences will block the CPU for many seconds.
// Such a slice runs ONLY when the server has been quiet for LONG_INPUT_QUIET_MS —
// wide enough that a chat turn is very unlikely to land mid-inference. Short
// (email-bulk) slices keep the normal 1.5s activity gate and yield instantly.
const LONG_INPUT_DOMINATED_THRESHOLD = (() => {
  const raw = Number(process.env.ROBOTDOJO_DAEMON_LONG_DOMINATED_FRACTION);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.25; // 25% long → gated
})();

// WHY a wide gate for long work (analogous to the maintenance worker's TRUNCATE
// quiet gate): a long inference, once started, holds the CPU ~11s uninterruptibly
// and starves the server event loop, blowing chat first-token to 10–40s if a turn
// lands during it. The activity watcher can only abort at the next sub-batch
// boundary — too coarse for an 11s+ inference. So the real defense is to NEVER
// START a long inference within a chat session: require the server to have been
// quiet for this long first. 30s comfortably exceeds the inter-turn gap of an
// active session, so giant chunks embed only when the user is genuinely away;
// short chunks keep draining throughout. Env-overridable.
const LONG_INPUT_QUIET_MS = Number(process.env.ROBOTDOJO_DAEMON_LONG_QUIET_MS) || 30_000;

// A short-rich pass may include this many high-priority long-only topics after
// the short topics. The long-only tail rotates across passes: this prevents
// high-value long-form workbench/domain material from starving behind hundreds of
// thousands of short email chunks OR behind one larger long-only topic, while the
// existing long-input quiet gate + one-batch cap still protect foreground chat.
const LONG_ONLY_TOPICS_PER_SHORT_PASS = (() => {
  const raw = Number(process.env.ROBOTDOJO_DAEMON_LONG_ONLY_PER_SHORT_PASS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 1;
})();

// st_2cd1af73 NIGHT MODE — the wide-quiet throughput profile.
//
// WHY: the day profile is deliberately throttled for chat safety (intraOp=2 =
// half the P-cores, short batch 8, Background QoS) so the daemon can never starve
// a chat turn's first token. But when NO human has been in chat for a wide window,
// that throttle is leaving throughput on the table for no benefit — there is no
// turn to protect. Night mode opens the work intensity up (intraOp→4 = full
// P-cores via a session re-init, short batch→16) so the 333k email bulk drains
// roughly twice as fast overnight, then drops back to the polite day profile
// WITHIN the existing activity reflex (~2s) the instant any chat request lands.
//
// HARD INVARIANTS night mode does NOT touch:
//   - the RSS ceiling (rssCeilingDecision) is checked every pass in BOTH profiles
//     and exits cleanly on breach — the absolute jetsam contract (the 95GB scar).
//   - the long-input batch stays at LONG_INPUT_BATCH_SIZE in both profiles (only
//     the SHORT tier widens) — a long batch's activation memory is the balloon.
//   - the YIELD behavior is identical: waitForQuiet, embedPauseDecision, the
//     sub-batch activityCheck, and the mid-slice activityWatch abort are unchanged.
//     Night mode changes ONLY work intensity, never when/how the daemon yields.
//
// The trigger is CHAT quiet (lastChatRequestAt via getActivitySignal), the same
// chat-only signal the long-input wide-quiet gate uses — so entering night mode
// naturally unlocks the long tail too (longInputQuietEnough keys off the same
// signal at a NARROWER 30s window, so once chat has been quiet for the wider night
// window the long gate is necessarily open as well).
//
// Env-tunable: ROBOTDOJO_NIGHT_BATCH (default 16) is the night short-tier batch;
// ROBOTDOJO_NIGHT_INTRAOP (default 4, read in local-embed.js) is the night intra-op thread count.
const NIGHT_SHORT_BATCH = Number(process.env.ROBOTDOJO_NIGHT_BATCH) || 16;

// st_db4b3118 PARALLEL INFERENCE LANES — how many child-process inference lanes
// fan out one fetched batch. Day always uses 1. Night now auto-sizes by hardware
// by default: a normal large import should finish promptly without the operator
// knowing an env var exists. Operators can still pin ROBOTDOJO_EMBED_LANES=N, or
// set ROBOTDOJO_EMBED_AUTO_LANES=0 to return to the old single-lane conservative
// mode. The hard caps, sum-RSS gate, contention drop, and foreground drop-to-day
// remain the safety rails.
//
// HARD INVARIANTS the lane fan-out does NOT touch:
//   - sum-RSS ceiling: the pool's sum-RSS gate (parent + every lane pid) is checked
//     every pass and exits cleanly on breach — the absolute jetsam contract.
//   - the chat-yield reflex: pause/abort stops DISPATCHING new batches and lets the
//     in-flight lane batches finish (≤ a few seconds); the lane pool drops to 1 lane
//     within the day reflex (~2s) of any chat request.
//   - each lane inherits MMAP_SIZE=0 and the ORT memory bounds (arena/mem-pattern
//     OFF) from the parent env, so a lane's RSS stays near the model working set.
const LANE_NIGHT_MAX = 3;
const AUTO_LANES_ENABLED = process.env.ROBOTDOJO_EMBED_AUTO_LANES !== '0';
const AUTO_MAX_LANES = (() => {
  const raw = Number(process.env.ROBOTDOJO_EMBED_AUTO_MAX_LANES);
  return Number.isFinite(raw) && raw > 0 ? Math.min(LANE_NIGHT_MAX, Math.floor(raw)) : LANE_NIGHT_MAX;
})();

export function autoLaneCountForTotalMemory(totalMemoryBytes = totalmem()) {
  const gb = Number(totalMemoryBytes) / (1024 ** 3);
  if (!Number.isFinite(gb) || gb < 12) return 1;
  if (gb < 24) return 2;
  return 3;
}

function nightLaneCount() {
  const raw = Number(process.env.ROBOTDOJO_EMBED_LANES);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(LANE_NIGHT_MAX, Math.floor(raw));
  if (!AUTO_LANES_ENABLED) return 1;
  return Math.min(LANE_NIGHT_MAX, AUTO_MAX_LANES, autoLaneCountForTotalMemory());
}
// Lanes for a profile: night opens the fan-out; day is always a single in-process
// stream (lane count 1 → no pool).
function laneCountForProfile(profile) {
  return profile === 'night' ? nightLaneCount() : 1;
}

// st_db4b3118 — per-lane intra-op thread budget. Each lane is ONE of N parallel
// processes, so it pins a small thread count; the parallelism is ACROSS lanes. With
// 2-3 lanes × this many threads the box's idle cores (10 total, ~8 idle) fill
// without oversubscription. Env-tunable per box.
const LANE_INTRA_THREADS = Number(process.env.ROBOTDOJO_LANE_INTRA_THREADS) || 2;

/**
 * Reconcile the live lane pool to the active profile. Night → ensure a pool of
 * nightLaneCount() lanes exists; day → tear the pool down (return to the single
 * in-process model). Idempotent: a pool already at the right width is left alone.
 * Returns the pool to use (or null for day / lane count 1).
 *
 * The chat-collapse guarantee lives here: when chat lands and the profile flips to
 * day, this destroys the pool, so the NEXT batch embeds in-process (single lane).
 * In-flight lane batches finish on their own (≤ a few seconds) before destroy()
 * sends SIGTERM — the abort path stops DISPATCHING; it does not interrupt a
 * committed lane inference mid-flight.
 *
 * @param {'day'|'night'} profile
 * @param {LanePool|null} current
 * @returns {LanePool|null}
 */
function reconcileLanePool(profile, current) {
  const want = laneCountForProfile(profile);
  if (want < 2) {
    // Day / single lane: no pool. Tear down any night pool.
    if (current) {
      log(`lane pool → 0 (day profile; tearing down ${current.laneCount} lanes)`);
      try { current.destroy(); } catch { /* ignore */ }
    }
    return null;
  }
  if (current && current.laneCount === want && !current.destroyed) return current;
  // AC-2: if the pool was just torn down for contention, wait for the rebuild cooldown
  // before re-spawning lanes — gives chat time to clear before inference resumes.
  if (!current && lastContentionDropAt && Date.now() - lastContentionDropAt < POOL_REBUILD_COOLDOWN_MS) {
    const remainingMs = POOL_REBUILD_COOLDOWN_MS - (Date.now() - lastContentionDropAt);
    log(`lane-pool-cooldown — ${Math.ceil(remainingMs / 1000)}s remaining after contention teardown; skipping rebuild`);
    return null;
  }
  // Width changed (or first night entry): rebuild at the wanted width.
  if (current) { try { current.destroy(); } catch { /* ignore */ } }
  log(`lane pool → ${want} lanes (night profile; each lane loads the model once)`);
  return new LanePool({
    laneCount: want,
    sliceTimeoutMs: Math.max(SLICE_TIMEOUT_MS, TOPIC_TIME_BUDGET_MS * 2),
    env: {
      // Each lane is a single bounded inference stream. Pin its intra-op threads;
      // the ORT memory bounds + MMAP_SIZE=0 are inherited from the parent env.
      ROBOTDOJO_LANE_INTRA_THREADS: String(LANE_INTRA_THREADS),
      ROBOTDOJO_EMBED_ORT_INTRA_THREADS: String(LANE_INTRA_THREADS),
    },
  });
}

// st_db4b3118 (brief item, folded in) — make tonight's ops QoS lift PERMANENT in
// the daemon's profile flip. Tonight the throughput lift (taskpolicy -B to clear
// the Background QoS clamp + renice 0 to drop the launchd Nice=10) was applied by
// hand to the running pid. Bake it into the flip so a respawn re-applies it:
//   - night entry: taskpolicy -B (utility/unrestricted QoS) + renice 0 on own pid,
//     so the wide-quiet drain runs at normal priority on the idle cores.
//   - day entry:   taskpolicy -b (Background QoS) + renice 10, returning to the
//     polite clamp the instant a human might be in chat — the daemon must never
//     outrank a chat turn's work.
// Guarded try/catch (a missing taskpolicy/renice or an EPERM must never crash the
// daemon — the QoS lift is an optimization, not a correctness requirement) and a
// logged flip so the transition is visible. Operates on the daemon's OWN pid only.
function applyQosForProfile(profile) {
  const pid = String(process.pid);
  const taskpolicyFlag = profile === 'night' ? '-B' : '-b';
  const nice = profile === 'night' ? '0' : '10';
  const results = [];
  try {
    const tp = spawnSync('taskpolicy', [taskpolicyFlag, '-p', pid], { stdio: 'ignore' });
    results.push(`taskpolicy ${taskpolicyFlag}${tp.error ? `(err:${tp.error.code})` : `(${tp.status})`}`);
  } catch (err) {
    results.push(`taskpolicy ${taskpolicyFlag}(throw:${err?.code || 'E'})`);
  }
  try {
    // renice the daemon's own pid. -n sets an absolute priority on macOS renice.
    const rn = spawnSync('renice', ['-n', nice, '-p', pid], { stdio: 'ignore' });
    results.push(`renice ${nice}${rn.error ? `(err:${rn.error.code})` : `(${rn.status})`}`);
  } catch (err) {
    results.push(`renice ${nice}(throw:${err?.code || 'E'})`);
  }
  return results.join(', ');
}

const NIGHT_PROFILE_QUIET_MS = Number(process.env.ROBOTDOJO_DAEMON_NIGHT_QUIET_MS) || 30 * 60_000;

/**
 * Pick the embed work-intensity profile from the user-visible activity signal.
 * Night is true quiet time only: no app-open ping, no in-flight request, and no
 * recent submitted chat turn.
 *
 * @param {{inFlight:number, lastChatRequestAt:number, lastChatAppActiveAt:number, updatedAt:number}} signal
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.quietMs]
 * @param {number} [opts.staleTtlMs]
 * @returns {{profile:'day'|'night', reason:string}}
 */
export function nightProfileDecision(signal, {
  now = Date.now(),
  quietMs = NIGHT_PROFILE_QUIET_MS,
  staleTtlMs = ACTIVITY_STALE_TTL_MS,
} = {}) {
  const updatedAt = Number(signal?.updatedAt) || 0;
  if (updatedAt === 0 || (now - updatedAt) > staleTtlMs) return { profile: 'night', reason: 'stale/quiet' };
  if (chatAppActiveDecision(signal, { now, staleTtlMs })) return { profile: 'day', reason: 'chat-app-open' };
  if ((Number(signal?.inFlight) || 0) > 0) return { profile: 'day', reason: 'in-flight' };
  const lastChat = Number(signal?.lastChatRequestAt) || 0;
  if (lastChat > 0 && (now - lastChat) < quietMs) return { profile: 'day', reason: 'recent-chat' };
  return { profile: 'night', reason: 'quiet' };
}

/**
 * Reconcile the live ONNX session profile. setEmbedProfile is idempotent: called
 * every pass but only triggers a session re-init when the intra-op thread count
 * changes.
 *
 * @returns {{profile:'day'|'night', changed:boolean, reason:string}}
 */
function reconcileEmbedProfile() {
  const signal = getActivitySignal(db);
  const foreground = daemonPauseDecision(signal);
  if (foreground.pause) {
    const current = getEmbedProfile();
    if (current === 'day') return { profile: current, changed: false, reason: foreground.reason };
    const res = setEmbedProfile('day');
    const qos = applyQosForProfile(res.profile);
    return { profile: res.profile, changed: true, reason: foreground.reason, reloaded: res.reloaded, intraOp: res.intraOpNumThreads, qos };
  }
  const decision = nightProfileDecision(signal);
  const want = decision.profile;
  const current = getEmbedProfile();
  if (current === want) return { profile: current, changed: false, reason: decision.reason };
  const res = setEmbedProfile(want);
  const qos = applyQosForProfile(res.profile);
  return { profile: res.profile, changed: true, reason: decision.reason, reloaded: res.reloaded, intraOp: res.intraOpNumThreads, qos };
}

async function ensureLanePoolReady(pool) {
  if (!pool || pool.destroyed) return pool;
  if (pool.lanes?.every((l) => l && l.ready)) return pool;
  try {
    await pool.waitUntilReady({ timeoutMs: 300_000 });
    return pool;
  } catch (err) {
    log(`lane pool not ready — ${err?.message || err}; tearing down and continuing single-lane this pass`);
    try { pool.destroy(); } catch { /* ignore */ }
    return null;
  }
}

/**
 * st_fd14cdd4 AC9 — force the polite DAY profile because the server is contending
 * for the DB (a signal the stale activity row failed to surface). Flips the ONNX
 * profile to day (intraOp drops to the chat-safe count) and tears the night lane
 * pool down at once via the main()-wired hook, freeing the lanes' CPU immediately.
 * The lane pool is rebuilt by the top-of-pass reconcile only after chat genuinely
 * quiets, so a contention storm cannot re-spawn lanes mid-chat.
 * Returns true if a night pool was actually torn down (for the log line).
 * @param {string} reason
 * @returns {boolean}
 */
function reconcileEmbedProfileToDay(reason) {
  try { setEmbedProfile('day'); applyQosForProfile('day'); } catch { /* QoS/profile best-effort */ }
  return dropLanePoolForContention(reason);
}

/**
 * st_fd14cdd4 AC9 — pure contention drop: free a live night lane pool's CPU at once
 * because the server is contending for the DB. SIGKILLs every busy lane
 * (cancelInFlight — durable, the rows stay embedded=0) then destroys the pool, so
 * the lanes stop competing with chat for CPU and the writer immediately. Returns
 * `{ dropped, killed }`: dropped is true iff a live pool was torn down (so the
 * caller can null its binding and log). Pulled out of the main() closure so it is
 * unit-testable with a fake pool WITHOUT spawning real lanes — the exact behavior
 * (busy-lane kill + destroy, not a no-op) the contention path turns on.
 *
 * @param {{cancelInFlight?:Function, destroy?:Function}|null} pool the live lane pool
 * @returns {{dropped:boolean, killed:number}}
 */
export function laneContentionDrop(pool) {
  if (!pool) return { dropped: false, killed: 0 };
  let killed = 0;
  try { killed = Number(pool.cancelInFlight?.()) || 0; } catch { killed = 0; }
  try { pool.destroy?.(); } catch { /* ignore */ }
  return { dropped: true, killed };
}

// topic → epoch-ms when its cooldown expires. A topic in here is skipped by the
// work order until now() passes its value. Exported for the demotion test.
const topicCooldownUntil = new Map();

/**
 * Mark a topic demoted: it is skipped by the work order until `now + cooldownMs`.
 * @param {string} topic
 * @param {number} [now] epoch ms (test hook)
 * @param {number} [cooldownMs]
 */
export function demoteTopic(topic, now = Date.now(), cooldownMs = TOPIC_COOLDOWN_MS) {
  topicCooldownUntil.set(topic, now + cooldownMs);
}

/**
 * Is this topic currently in cooldown (demoted)? Expired entries are cleaned up.
 * @param {string} topic
 * @param {number} [now] epoch ms (test hook)
 * @returns {boolean}
 */
export function topicInCooldown(topic, now = Date.now()) {
  const until = topicCooldownUntil.get(topic);
  if (until === undefined) return false;
  if (now >= until) { topicCooldownUntil.delete(topic); return false; }
  return true;
}

/** Test helper: clear all cooldown state. */
export function _resetCooldownForTest() { topicCooldownUntil.clear(); }

const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} [${WORKER_NAME}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rssMb = () => Math.round(process.memoryUsage().rss / 1048576);

const ac = new AbortController();
let shuttingDown = false;
// st_db4b3118 — set by main() to tear down the lane pool on shutdown so no orphan
// lane child outlives the daemon. A no-op until main() wires it (and harmless if a
// signal arrives before then).
let teardownLanePool = () => {};
function onSignal(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} received — aborting in-flight embed and closing DB (rss=${Math.round(process.memoryUsage().rss / 1048576)}MB)`);
  try { ac.abort(); } catch { /* already aborted */ }
  try { teardownLanePool(); } catch { /* lanes may already be gone */ }
  // df_969e7d39 AC-4 (iteration-4) — terminate the heartbeat worker on the graceful
  // path. Belt-and-suspenders: a worker thread is destroyed automatically when the host
  // process exits, so no orphan can survive a KeepAlive respawn on any exit path.
  try { heartbeatWorker?.terminate(); heartbeatWorker = null; } catch { /* worker may already be gone */ }
  try { db.close(); } catch { /* may already be closed */ }
  setTimeout(() => process.exit(0), 1500);
}
// st_2cd1af73 AC-3 — never die silently again. The Phase-1 wedge was invisible
// because the only killer that hit (jetsam SIGKILL) leaves no trace AND no [embed]
// line had printed. SIGKILL is uncatchable by definition, so the defense is twofold:
// (1) RSS is logged on every work-order derive and every slice (above) so the run-up
// to a memory kill is visible in the log before the OS acts; (2) every CATCHABLE
// exit path — the catchable signals, an uncaught throw, an unhandled rejection, and
// the final process 'exit' — logs a plain line here. After this change a silent
// disappearance in the log can ONLY be an external SIGKILL, and the preceding RSS
// trail will show why.
if (isEntrypoint()) {
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGHUP', () => onSignal('SIGHUP'));
  process.on('uncaughtException', (err) => {
    log(`FATAL uncaughtException: ${err?.stack || err?.message || err} (rss=${Math.round(process.memoryUsage().rss / 1048576)}MB)`);
    try { db.close(); } catch { /* ignore */ }
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log(`FATAL unhandledRejection: ${reason?.stack || reason?.message || reason} (rss=${Math.round(process.memoryUsage().rss / 1048576)}MB)`);
    try { db.close(); } catch { /* ignore */ }
    process.exit(1);
  });
  process.on('exit', (code) => {
    // Synchronous-only context. One last line so every clean exit is accounted for.
    log(`process exit code=${code} (rss=${Math.round(process.memoryUsage().rss / 1048576)}MB)`);
  });
}

async function waitForLaunchStartupGrace() {
  if (STARTUP_GRACE_MS > 0) {
    log(`startup grace ${STARTUP_GRACE_MS}ms — server gets launch CPU first`);
    await sleep(STARTUP_GRACE_MS);
  }
}

async function waitForLaunchForegroundQuiet() {
  if (FOREGROUND_IDLE_SECONDS <= 0) return;

  let foregroundPauseLogged = false;
  let foregroundPauseTicks = 0;
  while (!ac.signal.aborted) {
    const idle = getIdleSeconds();
    if (idle >= FOREGROUND_IDLE_SECONDS) {
      if (foregroundPauseLogged) {
        log(`startup foreground idle reached — idle=${idle}s threshold=${FOREGROUND_IDLE_SECONDS}s`);
      }
      return;
    }
    if (!foregroundPauseLogged || foregroundPauseTicks % 12 === 0) {
      log(`startup foreground-pause — user-active idle=${idle}s<threshold=${FOREGROUND_IDLE_SECONDS}s`);
      foregroundPauseLogged = true;
    }
    foregroundPauseTicks += 1;
    await sleep(5_000);
  }
}

/**
 * Truth-driven, value-first work order over the pending topics.
 *
 * Returns the list of topics with un-embedded embeddable chunks, ordered so the
 * highest-value topics embed FIRST and low-signal bulk (email-dominated topics)
 * embeds LAST. Value is `embedPriorityForTopic` (high content_rank + entity
 * density → higher priority). The email-share term is a tiebreaker that pushes a
 * topic whose pending chunks are mostly email toward the end even when its base
 * value score ties another topic — the value-first contract the AC asserts.
 *
 * Exported (and importable without launching the daemon) so the value-order test
 * exercises the exact ordering the daemon uses, against a fixture DB.
 *
 * A topic currently in cooldown (demoted because its embed time blew the per-topic
 * budget) is excluded so it can never head-block the queue; it reappears once its
 * cooldown expires. The `now` hook keeps the demotion test deterministic.
 *
 * @param {object} database better-sqlite3 connection
 * @param {number} [now] epoch ms (test hook for cooldown evaluation)
 * @returns {Array<{topic:string, pending:number, priority:number, emailShare:number}>}
 */
export function daemonWorkOrder(database, now = Date.now()) {
  // df_969e7d39 AC-4 — thin wrapper over computeWorkOrder (the db.js-free single
  // source of truth for the ordering, so the daemon and the off-thread child can
  // never drift). Behavior is byte-for-byte identical to the prior inline derive.
  return computeWorkOrder(database, {
    now,
    longInputChars: LONG_INPUT_CHARS,
    valueRankFloor: VALUE_RANK_ENTITY_FLOOR,
    // Pass the daemon's live, in-process callbacks so its contract is preserved:
    //   - cooldownPredicate = topicInCooldown — the in-process demotion set.
    //   - unrankedScorer = embedPriorityForTopic — the live correlated-subquery
    //     score used ONLY for a topic with value_rank=0 pending chunks (fresh/
    //     un-backfilled rows + the test fixtures; production has zero unranked). A
    //     fully-ranked topic derives value from the scan's own counts (no extra
    //     query). st_fd14cdd4 (preserved): high_n (content_rank<=1) = high-signal
    //     share; entity_n (value_rank >= the entity floor) = entity-linked share —
    //     both free from the GROUP BY; removed the ~55s correlated scan.
    cooldownPredicate: topicInCooldown,
    unrankedScorer: embedPriorityForTopic,
  });
}

export function selectEmbeddingPassOrder(order, {
  longOnlyTopicsPerShortPass = LONG_ONLY_TOPICS_PER_SHORT_PASS,
  longOnlyStart = 0,
} = {}) {
  const normalized = Array.isArray(order) ? order : [];
  const hasShort = (t) => (t.shortPending || 0) > 0;
  const shortRich = normalized.filter(hasShort);
  const longOnly = normalized.filter((t) => !hasShort(t));
  if (!shortRich.length) return longOnly;
  const longBudget = Math.max(0, Number(longOnlyTopicsPerShortPass) || 0);
  const start = longOnly.length
    ? ((Math.floor(Number(longOnlyStart) || 0) % longOnly.length) + longOnly.length) % longOnly.length
    : 0;
  const rotatedLongOnly = start > 0
    ? [...longOnly.slice(start), ...longOnly.slice(0, start)]
    : longOnly;
  return longBudget > 0
    ? [...shortRich, ...rotatedLongOnly.slice(0, longBudget)]
    : shortRich;
}

/**
 * df_969e7d39 AC-4 — derive the work order in a short-lived CHILD PROCESS so the
 * heavy GROUP-BY scan never blocks the daemon's main thread (the heartbeat/watchdog
 * timers stay live throughout). Mirrors the lane spawn convention (process.execPath
 * + absolute script path) but is a PIPED child whose JSON result the parent awaits,
 * not a fire-and-forget detached spawn.
 *
 * Single-flight: a `deriveInFlight` Promise guard means two passes can never spawn
 * two children — a second caller awaits the first's result. On child error, non-zero
 * exit, unparseable stdout, OR timeout: the child is killed if still alive, a
 * `work-order-derive-failed` line is logged, and null is returned so the caller keeps
 * the existing cached order (retry on the next TTL). Never wedges on the child.
 *
 * @returns {Promise<Array|null>} the parsed work order, or null on any failure.
 */
async function deriveWorkOrderOffThread() {
  if (deriveInFlight) return deriveInFlight;
  deriveInFlight = new Promise((resolvePromise) => {
    const scriptPath = resolve(ROOT, 'scripts/chunk-embed-work-order.mjs');
    let child;
    try {
      // Piped stdout (the parent needs the JSON); inherit the env so the child opens
      // the SAME live DB (ROBOTDOJO_DB / ROBOTDOJO_CONFIG / ROBOTDOJO_LOCAL_DB_KEY).
      child = spawn(process.execPath, [scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      log(`work-order-derive-failed — spawn error: ${err?.message || err}; keeping cached order`);
      resolvePromise(null);
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };

    const timer = setTimeout(() => {
      log(`work-order-derive-failed — timed out after ${WORK_ORDER_DERIVE_TIMEOUT_MS}ms; keeping cached order`);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish(null);
    }, WORK_ORDER_DERIVE_TIMEOUT_MS);
    timer.unref();

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      log(`work-order-derive-failed — child error: ${err?.message || err}; keeping cached order`);
      finish(null);
    });
    child.on('close', (code) => {
      if (settled) return; // timeout already fired
      if (code !== 0) {
        log(`work-order-derive-failed — child exit ${code}: ${(stderr.trim() || 'no stderr').slice(0, 200)}; keeping cached order`);
        finish(null);
        return;
      }
      // Parse the LAST non-empty stdout line (the contract: stdout carries only JSON,
      // but be defensive about any trailing newline / stray line).
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last) {
        log('work-order-derive-failed — empty stdout; keeping cached order');
        finish(null);
        return;
      }
      try {
        const order = JSON.parse(last);
        if (!Array.isArray(order)) {
          log('work-order-derive-failed — stdout is not a JSON array; keeping cached order');
          finish(null);
          return;
        }
        finish(order);
      } catch (err) {
        log(`work-order-derive-failed — unparseable stdout: ${err?.message || err}; keeping cached order`);
        finish(null);
      }
    });
  }).finally(() => { deriveInFlight = null; });
  return deriveInFlight;
}

/**
 * df_969e7d39 AC-4 (iteration-4) — publish the five liveness fields into the shared
 * region. Each Atomics.store is a handful of integer memory writes — sub-microsecond,
 * lock-free, NON-BLOCKING — so the main thread can publish the instant before it enters
 * an 8s synchronous block, and the worker reads the result while the main thread is
 * mid-block. The profile is mapped to an enum int (0=day, 1=night) because only integers
 * cross Atomics. Called at the cheap points where the values change (see the four call
 * sites in main()); liveness comes from the worker's own clock, freshness from these.
 */
function publishHeartbeatState(lanePool) {
  Atomics.store(heartbeatState, 0, lastKnownPending | 0);
  Atomics.store(heartbeatState, 1, getEmbedProfile() === 'night' ? 1 : 0);
  Atomics.store(heartbeatState, 2, lanePool?.lanes?.filter((l) => l.ready).length ?? 0);
  Atomics.store(heartbeatState, 3, lanePool?.lanes?.length ?? 0);
  Atomics.store(heartbeatState, 4, contentionStreak | 0);
}

export function nextKnownPendingAfterCommit(currentPending, completedRows) {
  const current = Number(currentPending);
  const completed = Number(completedRows);
  if (!Number.isFinite(completed) || completed <= 0) {
    return Number.isFinite(current) ? Math.floor(current) : -1;
  }
  if (!Number.isFinite(current) || current < 0) return -1;
  return Math.max(0, Math.floor(current) - Math.floor(completed));
}

function noteBacklogCompleted(payload, lanePool) {
  const completed = Number(payload?.completed ?? payload);
  if (!Number.isFinite(completed) || completed <= 0) return;
  lastKnownPending = nextKnownPendingAfterCommit(lastKnownPending, completed);
  lastProgressAt = Date.now();
  contentionStreak = 0;
  publishHeartbeatState(lanePool);
}

export function pendingBacklogCount(database) {
  try {
    return Number(database.prepare(`
      SELECT COUNT(*) AS n
      FROM chunks
      WHERE embedded = 0 AND skip_embed = 0
    `).get()?.n || 0);
  } catch {
    return -1;
  }
}

/**
 * df_969e7d39 AC-4 (iteration-4) — start the independent heartbeat emitter on a worker
 * thread. The worker reads the shared region with Atomics.load on its OWN setInterval
 * clock (HEARTBEAT_MS) and logs the daemon:heartbeat line. It runs on a separate OS
 * thread the kernel schedules independently, so it fires on schedule through every
 * main-thread block (wal_checkpoint TRUNCATE, in-process ONNX inference, derive) that
 * parked the prior main-thread timer. unref() so the worker never keeps the process
 * alive — the main loop owns process lifetime, exactly as the old heartbeatInterval did.
 */
function startHeartbeatWorker(lanePool) {
  publishHeartbeatState(lanePool);
  heartbeatWorker = new Worker(resolve(ROOT, 'scripts/chunk-embed-heartbeat-worker.mjs'), {
    workerData: { sab: HEARTBEAT_SAB, cadenceMs: HEARTBEAT_MS },
  });
  heartbeatWorker.unref();
}

/**
 * Pure decision: has CHAT been quiet long enough to safely START a long
 * (multi-second, uninterruptible) inference? True only when the last CHAT request
 * finished at least quietMs ago (or none ever this session).
 *
 * st_2cd1af73 AC-3 — this reads `lastChatRequestAt`, NOT `lastRequestAt`. The
 * dominant overnight wedge was that background traffic (health probes, login-probe,
 * sync, integration-monitor, the supervisor's own localhost calls, maintenance
 * children) stamps lastRequestAt continuously, so the gap since lastRequestAt
 * never reached the 30s quiet window and the 333k long-dominated bulk deferred
 * FOREVER while only tiny topics drained. The real requirement is "no human is in
 * chat", which is exactly lastChatRequestAt. Note: in_flight is NOT consulted here
 * — in_flight counts ALL requests (a 0.1s health probe bumps it) and would
 * re-introduce the same false-busy the chat scope is removing; the slice-boundary
 * embedPauseDecision still honors in_flight for the instant WAL yield. Pulled out
 * so it is unit-testable in isolation, mirroring activityPauseDecision.
 *
 * st_fd14cdd4 AC9 — an OPEN chat app ALSO blocks a long-input start, even before
 * any turn is submitted. WHY this is the load-bearing addition: a long ONNX
 * inference (~11s+, and on this corpus a long batch measured 7–30s) is
 * UNINTERRUPTIBLE — once started it holds the CPU and grows a large vec0 write
 * transaction that a chat turn's RAG read then contends with. The lane SIGKILL on
 * app-active frees CPU within a watch tick, but a turn that lands while a long
 * inference is ALREADY in flight still eats the tail of that uninterruptible call
 * plus its committed write — the residual turn-1 spike measured at 12–33s. The real
 * defense (the same logic as the chat-submit wide-quiet gate) is to NEVER START a
 * long inference while a human has chat open: if the app is open, defer the long
 * tail to a wider idle window. Short batches keep draining throughout (they are
 * instantly yieldable), so this costs only the small long tail, not throughput.
 *
 * @param {{lastChatRequestAt:number, lastChatAppActiveAt:number, updatedAt:number}} signal
 * @param {object} [opts]
 * @param {number} [opts.now] epoch ms
 * @param {number} [opts.quietMs]
 * @param {number} [opts.staleTtlMs] a dead-server stale row reads as quiet
 * @returns {boolean}
 */
export function longInputQuietDecision(signal, {
  now = Date.now(),
  quietMs = LONG_INPUT_QUIET_MS,
  staleTtlMs = ACTIVITY_STALE_TTL_MS,
} = {}) {
  const updatedAt = Number(signal?.updatedAt) || 0;
  if (chatAppActiveDecision(signal, { now })) return false;
  // A dead/stale server (row older than the TTL) is treated as quiet — never let
  // a stopped server permanently block long-input embedding.
  if (updatedAt === 0 || (now - updatedAt) > staleTtlMs) return true;
  const lastChat = Number(signal?.lastChatRequestAt) || 0;
  if (lastChat === 0) return true; // no chat request ever seen this session
  return (now - lastChat) >= quietMs;
}

/** Live wrapper: reads the current server-activity signal + the wide chat-quiet gate. */
function longInputQuietEnough() {
  return longInputQuietDecision(getActivitySignal(db));
}

/**
 * Age in ms since the last CHAT request (for the decision trace). Infinity when
 * no chat has been seen or the server row is stale/dead — i.e. fully quiet.
 * @param {number} [now] epoch ms
 * @returns {number}
 */
function chatQuietAgeMs(now = Date.now()) {
  const sig = getActivitySignal(db);
  const updatedAt = Number(sig?.updatedAt) || 0;
  if (updatedAt === 0 || (now - updatedAt) > ACTIVITY_STALE_TTL_MS) return Infinity;
  const lastChat = Number(sig?.lastChatRequestAt) || 0;
  if (lastChat === 0) return Infinity;
  return now - lastChat;
}

// st_2cd1af73 AC-3 — the embedder's CHAT-scoped pause window. Distinct from the
// generic ACTIVITY_PAUSE_MS the supervisor/maintenance use: those must yield to ALL
// traffic (any DB query benefits from them releasing the WAL writer). The
// EMBEDDER's recency pause, though, must key off CHAT — because the whole point of
// this story is that constant overnight background traffic (health, login-probe,
// sync, supervisor's own localhost calls, maintenance children) was pinning the
// daemon paused at the 60s generic window and crawling the backlog to a halt. A
// generous chat window (default 60s, env-tunable) rides out a chat turn's
// sub-request gaps (prefetch → stream → events); background traffic does not move
// it. Defaults to the generic ACTIVITY_PAUSE_MS so a deploy that only set the
// generic knob still gets a sane chat window.
const EMBED_CHAT_PAUSE_MS = Number(process.env.ROBOTDOJO_DAEMON_CHAT_PAUSE_MS) || ACTIVITY_PAUSE_MS;
const EMBED_REQUEST_PAUSE_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_DAEMON_REQUEST_PAUSE_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5_000;
})();

/**
 * The embedder's pause decision (st_2cd1af73 AC-3 + st_fd14cdd4 AC9). Independent
 * reasons to pause, mirroring the shared activityPauseDecision but recency-scoped
 * to CHAT:
 *
 *   - chat APP is OPEN (st_fd14cdd4 AC9) → pause: the chat app pinged /api/chat/active
 *     within the active window, so a human has chat open RIGHT NOW. Pause (and, at
 *     the call sites, drop the in-flight chunk) so the writer is free BEFORE the
 *     user finishes typing. This fires on app LOAD — earlier and broader than the
 *     per-turn signals below, which is the whole point: the prior yield waited for a
 *     submitted turn, by which time the embedder was already mid-write-batch and the
 *     turn's RAG reads contended. Checked FIRST so the log reason is the app signal.
 *   - in_flight > 0 (FRESH row) → pause: a request is literally mid-flight, so
 *     release the single WAL writer NOW regardless of whether it is chat or a
 *     background probe. This is the instant yield that protects a live query.
 *   - last ANY request < requestPauseMs ago → pause briefly: login/retrieval/topic
 *     edits are foreground product paths too, and must not race a vector write right
 *     after their request completes. This window must stay short; background probes
 *     and stoplight checks hit generic request recency too, and a long default would
 *     recreate the silent no-progress wedge the daemon exists to remove.
 *   - last CHAT request < pauseMs ago → pause: a chat turn just happened; stay
 *     paused across its sub-request gaps so the daemon never grabs the writer
 *     mid-turn. Background-only recency does NOT trigger this — that conflation
 *     is the exact wedge this story removes.
 *   - row older than the stale TTL → never pause (dead server).
 *
 * @param {{inFlight:number, lastChatRequestAt:number, lastChatAppActiveAt:number, updatedAt:number}} signal
 * @param {object} [opts]
 * @param {number} [opts.now] epoch ms
 * @param {number} [opts.pauseMs] chat recency window
 * @param {number} [opts.staleTtlMs]
 * @returns {{pause:boolean, reason:string}}
 */
export function embedPauseDecision(signal, {
  now = Date.now(),
  pauseMs = EMBED_CHAT_PAUSE_MS,
  requestPauseMs = EMBED_REQUEST_PAUSE_MS,
  staleTtlMs = ACTIVITY_STALE_TTL_MS,
} = {}) {
  const updatedAt = Number(signal?.updatedAt) || 0;
  if (chatAppActiveDecision(signal, { now })) return { pause: true, reason: 'chat-app-open' };
  if (updatedAt === 0 || (now - updatedAt) > staleTtlMs) return { pause: false, reason: 'stale' };
  if ((Number(signal?.inFlight) || 0) > 0) return { pause: true, reason: 'in-flight' };
  const lastRequest = Number(signal?.lastRequestAt) || 0;
  if (requestPauseMs > 0 && lastRequest > 0 && (now - lastRequest) < requestPauseMs) {
    return { pause: true, reason: 'recent-request' };
  }
  const lastChat = Number(signal?.lastChatRequestAt) || 0;
  if (lastChat > 0 && (now - lastChat) < pauseMs) return { pause: true, reason: 'recent-chat' };
  return { pause: false, reason: 'quiet' };
}

/**
 * Launch-safe daemon pause decision. The normal embed pause gate protects live
 * product requests; the HID gate protects the broader foreground path before a
 * request exists (typing, topic edit, login/connect interaction, first-turn wait).
 *
 * @param {object} signal server activity signal
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.hidIdleSeconds]
 * @param {number} [opts.foregroundIdleSeconds]
 * @returns {{pause:boolean, reason:string, hidIdleSeconds?:number, foregroundIdleSeconds?:number}}
 */
export function daemonPauseDecision(signal, {
  now = Date.now(),
  hidIdleSeconds,
  foregroundIdleSeconds = FOREGROUND_IDLE_SECONDS,
} = {}) {
  const explicitHold = explicitEmbedPauseDecision({ now });
  if (explicitHold.pause) return explicitHold;

  const activity = embedPauseDecision(signal, { now });
  if (activity.pause) return activity;

  if (foregroundIdleSeconds > 0) {
    const idle = Number.isFinite(Number(hidIdleSeconds))
      ? Math.max(0, Math.floor(Number(hidIdleSeconds)))
      : getIdleSeconds();
    if (idle < foregroundIdleSeconds) {
      return {
        pause: true,
        reason: 'user-active',
        hidIdleSeconds: idle,
        foregroundIdleSeconds,
      };
    }
  }

  return { pause: false, reason: 'quiet' };
}

export function explicitEmbedPauseDecision({
  now = Date.now(),
} = {}) {
  const hold = readEmbedPauseHold({ now, maxCacheMs: 0 });
  if (hold.active) return { pause: true, reason: hold.reason || 'embed-pause-hold' };

  const proofFreeze = readEmbedProofFreezeRequest({ now });
  if (proofFreeze.active) return { pause: true, reason: proofFreeze.reason || 'embed-proof-freeze' };

  return { pause: false, reason: 'no-explicit-hold' };
}

function productShouldPause() {
  return embedPauseDecision(getActivitySignal(db));
}

export function workOrderDerivePauseDecision(signal, {
  now = Date.now(),
} = {}) {
  return firstVectorBootstrapPauseDecision(signal, { now });
}

export function workPauseDecision(signal, work = {}, {
  now = Date.now(),
  hidIdleSeconds,
  foregroundIdleSeconds = FOREGROUND_IDLE_SECONDS,
} = {}) {
  if (work?.slaTier) {
    return firstVectorBootstrapPauseDecision(signal, { now });
  }
  return daemonPauseDecision(signal, { now, hidIdleSeconds, foregroundIdleSeconds });
}

function workShouldPause(work = {}) {
  return workPauseDecision(getActivitySignal(db), work);
}

// st_fd14cdd4 AC9 — bound the WAL the embedder grows. The embedder's vec0 writes
// append to the -wal file; LIVE this grew to 657MB→1.7GB and chat's reads then
// scan an enormous frameset to find the latest committed frame — the second half
// of the AC9 TTFT defect, distinct from the lane CPU grind. The frames accumulate
// DURING the grind (chat quiet), not during a yield, so a yield-only checkpoint
// cannot bound it — MEASURED: 453k frames piled up while grinding. So the daemon
// (the dominant writer, the one process that knows when its own writer is idle)
// checkpoints its own writes at TWO points: (1) PERIODICALLY between slices while
// grinding, keeping the WAL frame count bounded so reads never traverse a giant
// WAL; and (2) on YIELD to chat, when it is paused (writer idle) and can reclaim
// the -wal file. PASSIVE always runs (non-blocking, moves frames into the .db);
// TRUNCATE then reclaims the file to zero when no reader holds the WAL (a reader
// makes it a fast no-op, busy=1 — the next attempt reclaims). Throttled so it runs
// at most once per window regardless of how often it is called. The single-writer
// + SQLCipher constraints hold: the daemon checkpoints its own connection only at
// a slice boundary / pause, never mid-write.
const WAL_CHECKPOINT_THROTTLE_MS = Number(process.env.ROBOTDOJO_DAEMON_WAL_CHECKPOINT_MS) || 10_000;
let lastWalCheckpointAt = 0;

/**
 * Checkpoint the WAL (PASSIVE then TRUNCATE) on the daemon's own connection. Safe
 * to call ONLY when the daemon is not mid-write (a slice boundary / paused), which
 * is the only place it is invoked. Best-effort: a busy/locked DB (a chat read
 * holding the snapshot) surfaces as a non-zero `busy` and is tolerated — the next
 * call retries. Throttled to WAL_CHECKPOINT_THROTTLE_MS so it runs at most once per
 * window across both the periodic and on-yield call sites.
 * @param {string} why a short reason for the log line
 * @returns {boolean} true if a checkpoint was attempted this call
 */
function checkpointWal(why) {
  const now = Date.now();
  if (now - lastWalCheckpointAt < WAL_CHECKPOINT_THROTTLE_MS) return false;
  lastWalCheckpointAt = now;
  // Cap how long the checkpoint may wait on a reader. The daemon's busy_timeout is
  // 2000ms; a TRUNCATE that blocked that long on an active chat reader would itself
  // contend for the lock and could WORSEN chat latency. Lower it to a tiny window
  // around the checkpoint and restore after, mirroring the request-observer flush
  // discipline. A reader-blocked TRUNCATE then returns busy=1 fast (no frames
  // reclaimed) instead of stalling — the next yield retries.
  let prevTimeout;
  try {
    try { prevTimeout = db.pragma('busy_timeout', { simple: true }); } catch { prevTimeout = undefined; }
    try { db.pragma('busy_timeout = 50'); } catch { /* keep going at the existing timeout */ }
    // PASSIVE first: always non-blocking, moves every committed frame it can into
    // the .db so the reader snapshot shrinks even if TRUNCATE is then reader-blocked.
    db.pragma('wal_checkpoint(PASSIVE)');
    // TRUNCATE: reclaim the -wal FILE to zero. Returns busy=1 (no-op) fast if a
    // reader holds the WAL; that is fine — PASSIVE already did the frame work.
    const row = db.pragma('wal_checkpoint(TRUNCATE)');
    const r = Array.isArray(row) ? row[0] : row;
    const busy = Number(r?.busy ?? 0);
    const logFrames = Number(r?.log ?? 0);
    const checkpointed = Number(r?.checkpointed ?? 0);
    log(`wal_checkpoint(TRUNCATE) on yield (${why}) result busy=${busy} log=${logFrames} checkpointed=${checkpointed}`);
  } catch (err) {
    // A contended WAL (chat read holding the snapshot) or transient lock — skip;
    // the next yield retries. Never let a checkpoint failure crash the daemon.
    log(`wal_checkpoint(TRUNCATE) skipped (${why}): ${err?.message || err}`);
  } finally {
    if (prevTimeout !== undefined) {
      try { db.pragma(`busy_timeout = ${prevTimeout}`); } catch { /* best-effort restore */ }
    }
  }
  return true;
}

/**
 * Block until the activity signal says it is safe to embed (or shutdown).
 * Logs a single activity-pause line on the first pause and a single resume line
 * when it clears, so the log shows the yield-to-chat behavior without spamming.
 *
 * st_fd14cdd4 AC9 — deliberately does NOT checkpoint here. While paused, CHAT is
 * the reason we yielded; running a TRUNCATE checkpoint then would CONTEND with the
 * active chat reads for the SQLCipher lock — adding latency exactly when chat is
 * live (and TRUNCATE no-ops anyway while a reader holds the WAL). The WAL is bounded
 * the right way: a periodic PASSIVE+TRUNCATE between slices DURING the quiet grind,
 * where the frames actually pile up and where the checkpoint can reclaim the file
 * without fighting a chat turn. So when chat is active the daemon stays entirely out
 * of the DB's way.
 * @returns {Promise<boolean>} false if shutting down, true if clear to proceed
 */
async function waitForQuiet(work = {}) {
  let pausedLogged = false;
  let iterations = 0;
  const pauseStartMs = Date.now();
  let lastReason = null;
  let reasonStartMs = pauseStartMs;
  while (!ac.signal.aborted) {
    const decision = workPauseDecision(getActivitySignal(db), work);
    if (!decision.pause) {
      if (pausedLogged) log('resume — foreground quiet, embedding continues');
      return true;
    }
    if (decision.reason !== lastReason) {
      lastReason = decision.reason;
      reasonStartMs = Date.now();
    }
    if (!pausedLogged) {
      const detail = decision.reason === 'user-active'
        ? ` idle=${decision.hidIdleSeconds}s<threshold=${decision.foregroundIdleSeconds}s`
        : '';
      log(`activity-pause — ${decision.reason}${detail} (yielding background embedding to foreground)`);
      pausedLogged = true;
    }
    iterations++;
    if (iterations % 60 === 0) {
      const now = Date.now();
      log(`daemon:pause-tick — elapsedMs=${now - pauseStartMs} reason=${decision.reason} reasonElapsedMs=${now - reasonStartMs}`);
    }
    await sleep(PAUSE_POLL_MS);
  }
  return false;
}

export function firstVectorBootstrapPauseDecision(signal, {
  now = Date.now(),
  requestPauseMs = EMBED_REQUEST_PAUSE_MS,
  chatPauseMs = EMBED_CHAT_PAUSE_MS,
  staleTtlMs = ACTIVITY_STALE_TTL_MS,
} = {}) {
  const explicitHold = explicitEmbedPauseDecision({ now });
  if (explicitHold.pause) return explicitHold;

  const updatedAt = Number(signal?.updatedAt) || 0;
  if (updatedAt === 0 || (now - updatedAt) > staleTtlMs) return { pause: false, reason: 'stale' };
  if ((Number(signal?.inFlight) || 0) > 0) return { pause: true, reason: 'in-flight' };
  const lastRequest = Number(signal?.lastRequestAt) || 0;
  if (requestPauseMs > 0 && lastRequest > 0 && (now - lastRequest) < requestPauseMs) {
    return { pause: true, reason: 'recent-request' };
  }
  const lastChat = Number(signal?.lastChatRequestAt) || 0;
  if (lastChat > 0 && (now - lastChat) < chatPauseMs) return { pause: true, reason: 'recent-chat' };
  return { pause: false, reason: 'quiet' };
}

export function firstVectorBootstrapTargets(order, {
  maxTopics = FIRST_VECTOR_BOOTSTRAP_MAX_TOPICS,
} = {}) {
  const limit = Math.max(0, Number(maxTopics) || 0);
  if (limit === 0) return [];
  const rows = Array.isArray(order) ? order : [];
  const shortRows = rows.filter((row) => (Number(row?.shortPending) || 0) > 0);
  const firstVector = shortRows.filter((row) => row?.slaTier === SLA_TIERS.FIRST_VECTOR);
  const valuable = shortRows.filter((row) => row?.slaTier === SLA_TIERS.VALUABLE);
  return (firstVector.length ? firstVector : valuable).slice(0, limit);
}

function firstVectorBootstrapActivityCheck() {
  return firstVectorBootstrapPauseDecision(getActivitySignal(db)).pause;
}

async function waitForFirstVectorBootstrapQuiet(deadlineMs) {
  let pausedLogged = false;
  while (!ac.signal.aborted && Date.now() < deadlineMs) {
    const decision = firstVectorBootstrapPauseDecision(getActivitySignal(db));
    if (!decision.pause) return true;
    if (!pausedLogged) {
      log(`first-vector bootstrap pause — ${decision.reason} (yielding to foreground request)`);
      pausedLogged = true;
    }
    await sleep(PAUSE_POLL_MS);
  }
  return false;
}

async function runFirstVectorBootstrapSeed() {
  if (!FIRST_VECTOR_BOOTSTRAP_ENABLED) return { skipped: true, reason: 'disabled' };
  if (!embeddingsDb) return { skipped: true, reason: 'embeddings-db-unavailable' };
  const pending = pendingBacklogCount(db);
  if (!(pending > 0)) return { skipped: true, reason: 'no-pending' };

  const startedAt = Date.now();
  const deadlineMs = startedAt + FIRST_VECTOR_BOOTSTRAP_MAX_MS;
  const order = await deriveWorkOrderOffThread();
  const targets = firstVectorBootstrapTargets(order, { maxTopics: FIRST_VECTOR_BOOTSTRAP_MAX_TOPICS });
  if (!targets.length) return { skipped: true, reason: 'no-first-vector-targets', pending };

  log(`first-vector bootstrap start — targets=${targets.length} maxChunks=${FIRST_VECTOR_BOOTSTRAP_MAX_CHUNKS} maxMs=${FIRST_VECTOR_BOOTSTRAP_MAX_MS}`);
  let completed = 0;
  let topicsVisited = 0;
  for (const target of targets) {
    if (ac.signal.aborted || Date.now() >= deadlineMs || completed >= FIRST_VECTOR_BOOTSTRAP_MAX_CHUNKS) break;
    if (!(await waitForFirstVectorBootstrapQuiet(deadlineMs))) break;

    const topic = target.topic;
    topicsVisited += 1;
    try {
      const result = await embedChunks(topic, ac.signal, {
        maxBatches: FIRST_VECTOR_BOOTSTRAP_BATCHES_PER_TOPIC,
        shortFirst: true,
        chatHistoryFirst: true,
        coverageFirst: true,
        activityCheck: firstVectorBootstrapActivityCheck,
        onBacklogCompleted: (payload) => noteBacklogCompleted(payload, null),
        onBatchCommitted: () => {
          if (!firstVectorBootstrapActivityCheck()) {
            checkpointWal('first-vector-bootstrap');
          }
        },
        embeddingsDb,
      });
      if (result?.error) throw new Error(result.error);
      const done = (Number(result?.embedded) || 0) + (Number(result?.reused) || 0);
      completed += done;
      if (done > 0) lastProgressAt = Date.now();
      log(`first-vector bootstrap topic="${topic}" +${done} tier=${target.slaTier} total=${completed}`);
      if (result?.embedded > 0) {
        const topicPendingAfter = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE topic=? AND embedded=0 AND skip_embed=0').get(topic).n;
        if (topicPendingAfter === 0) {
          markTopicMigrated(topic);
          checkAndTriggerHnswRebuild();
        }
      }
      if (result?.aborted && result.abortReason === 'activity') {
        log(`first-vector bootstrap yielded to activity after topic="${topic}"`);
      }
    } catch (err) {
      log(`first-vector bootstrap error topic="${topic}": ${err?.message || err}`);
    }
  }
  log(`first-vector bootstrap done — completed=${completed} topics=${topicsVisited} elapsedMs=${Date.now() - startedAt}`);
  return { skipped: false, completed, topicsVisited, elapsedMs: Date.now() - startedAt };
}

async function main() {
  await waitForLaunchStartupGrace();

  const model = localEmbeddingModelStatus();
  log(`start — model installed=${model.installed} state=${model.state || 'n/a'} pause=${ACTIVITY_PAUSE_MS}ms requestPauseMs=${EMBED_REQUEST_PAUSE_MS} chatPauseMs=${EMBED_CHAT_PAUSE_MS} slice=${SLICE_BATCHES}batches`);
  if (!model.installed) {
    log('embedding model not installed — nothing to do; exiting 0 (KeepAlive will respawn)');
    return;
  }
  await runFirstVectorBootstrapSeed();
  await waitForLaunchForegroundQuiet();
  if (ac.signal.aborted) return;
  lastKnownPending = pendingBacklogCount(db);
  log(`pending snapshot — ${lastKnownPending >= 0 ? `${lastKnownPending} chunks pending` : 'unknown'} before work-order derive`);

  // st_2cd1af73 AC-3 — cached work order (see WORK_ORDER_TTL_MS). Re-derived only
  // when stale or empty, so the ~15s/derivation cost on the 333k backlog is paid
  // once per TTL instead of every pass.
  let cachedOrder = null;
  let cachedOrderAt = 0;
  let longOnlyPassCursor = 0;

  // st_db4b3118 — the live lane pool. null in the day profile (single in-process
  // stream); a LanePool of nightLaneCount() lanes while night. Reconciled on every
  // profile transition (created at night entry, destroyed when chat drops to day).
  // Declared here so the activityWatch closure and the embed loop share one binding.
  let lanePool = null;
  // Apply the QoS lift for the start profile up front (a fresh respawn into a quiet
  // night must lift immediately, before the first transition fires).
  log(`start qos — ${applyQosForProfile(getEmbedProfile())} (profile=${getEmbedProfile()})`);
  // The shutdown handler must tear the pool down so no orphan lane survives the
  // daemon. Register here where the binding is in scope.
  teardownLanePool = () => { try { lanePool?.destroy(); } catch { /* ignore */ } };

  // st_fd14cdd4 AC9 — wire the contention pool-drop hook (declared as a no-op at
  // module scope until this binding exists). The SQLITE_BUSY-as-activity path
  // (reconcileEmbedProfileToDay) must FREE the lanes' CPU, not just flip the
  // profile flag: when the server is contending for the writer the lanes are
  // exactly what is starving chat, so cancelInFlight() SIGKILLs every busy lane to
  // free its ~cores at once (durable: the rows it was embedding stay embedded=0),
  // then destroy() + null the binding so no night fan-out keeps grinding while the
  // server wants the DB. The top-of-pass reconcileLanePool rebuilds the pool only
  // after chat genuinely quiets, so a contention storm cannot
  // re-spawn lanes mid-chat. WHY this matters: without freeing the lanes the
  // profile flip is cosmetic — the two ~2-core lane processes keep embedding and
  // chat TTFT stays starved, which is the exact 27s defect this AC fixes. Returns
  // true iff a live night pool was actually torn down (for the contention log line).
  dropLanePoolForContention = (reason) => {
    const { dropped, killed } = laneContentionDrop(lanePool);
    if (!dropped) return false;
    lanePool = null;
    lastContentionDropAt = Date.now();
    log(`lane pool torn down for contention (${reason}) — freed ${killed} busy lane(s)`);
    return true;
  };

  // AC-1: cross-loop progress watchdog. Fires every minute; if pending > 0 but no
  // chunks have been embedded while the daemon is actually runnable, exit for
  // KeepAlive respawn. Intentional foreground pauses do not count as a wedge.
  const watchdogInterval = setInterval(() => {
    const pause = daemonPauseDecision(getActivitySignal(db));
    if (pause.pause) {
      lastProgressAt = Date.now();
      return;
    }
    if (lastKnownPending > 0 && Date.now() - lastProgressAt > WATCHDOG_MAX_IDLE_MS) {
      log(`watchdog-fired — no progress for ${Math.round((Date.now() - lastProgressAt) / 60000)}min with ${lastKnownPending} chunks pending; exiting for KeepAlive respawn`);
      process.exit(0);
    }
  }, 60_000);
  watchdogInterval.unref();

  // df_969e7d39 AC-4 (iteration-4) — start the independent heartbeat emitter on a
  // worker thread. The heartbeat no longer runs on this (main) thread: a main-thread
  // timer cannot fire while the thread is mid-block (~8s wal_checkpoint TRUNCATE,
  // 51–91s day-polite in-process inference), which is what produced the 38–96s gaps
  // across three QA failures. The worker runs on its own OS thread, reading the
  // liveness integers this thread publishes via publishHeartbeatState(), so it fires
  // on schedule through every main-thread block — an UNCONDITIONAL ≤35s guarantee.
  startHeartbeatWorker(lanePool);

  while (!ac.signal.aborted) {
    // st_2cd1af73 NIGHT MODE — reconcile the work-intensity profile to chat-quiet
    // at the top of every pass. Enters night (intraOp→4, short batch→16) only
    // after true quiet; app-open, in-flight, and recent-chat states stay polite.
    // Logged on transition only so steady state is quiet. The yield gates below are
    // unchanged — this changes only how hard the daemon works, never when it yields.
    const profileChange = reconcileEmbedProfile();
    if (profileChange.changed) {
      log(`profile → ${profileChange.profile} (${profileChange.reason}; intraOp=${profileChange.intraOp}, shortBatch=${profileChange.profile === 'night' ? NIGHT_SHORT_BATCH : 'default'}, lanes=${laneCountForProfile(profileChange.profile)}${profileChange.reloaded ? ', session re-init on next embed' : ''}; qos[${profileChange.qos}])`);
    }
    // st_db4b3118 — keep the collapse-to-day behavior at the top of the pass, but
    // do not create night lanes until real backlog is selected below. The previous
    // shape spawned/destroyed lane children even with pending=0, and a stale quiet
    // activity row could make the daemon churn model loads while doing no work.
    if (getEmbedProfile() !== 'night' && lanePool) {
      lanePool = reconcileLanePool(getEmbedProfile(), lanePool);
    }

    // df_969e7d39 AC-4 (iteration-4) — publish liveness: refreshes profile + lane
    // counts every pass for the worker's heartbeat. Sub-microsecond, non-blocking.
    publishHeartbeatState(lanePool);

    // st_fd14cdd4 follow-up — activity-gate the derive without treating an open
    // chat shell as a hard stop. The derive is now off-thread + read-only, so it
    // must still yield to live requests/recent chat but may run while the app is
    // merely open; otherwise a new user who opens chat during first import never
    // gets a normal work order after the bootstrap lane.
    const derivePause = workOrderDerivePauseDecision(getActivitySignal(db));
    const orderAge = Date.now() - cachedOrderAt;
    const wantDerive = !cachedOrder || orderAge >= WORK_ORDER_TTL_MS;
    let shouldDeriveThisPass = wantDerive;
    if (wantDerive && derivePause.pause) {
      // A live request/recent chat is active. Never run the backlog scan now.
      if (cachedOrder && cachedOrder.length) {
        // Reuse the stale order — it is value-ordered and stale only in the ways
        // live cooldown re-filtering (below) already corrects. Better a slightly
        // stale order than reading during a live turn.
        log(`derive deferred — chat active (${derivePause.reason}); reusing cached order (age ${(orderAge / 1000).toFixed(0)}s)`);
        shouldDeriveThisPass = false;
      } else {
        // No order to fall back on (first pass / just drained). Yield to the turn
        // and re-poll.
        const derivable = await waitForFirstVectorBootstrapQuiet(Date.now() + ACTIVITY_PAUSE_MS);
        if (!derivable) continue;
      }
    }
    if (shouldDeriveThisPass) {
      // df_969e7d39 AC-4 — derive OFF the main thread. The await yields the event
      // loop while the child runs the multi-second GROUP-BY scan, so the heartbeat /
      // watchdog / activity-watch timers keep firing throughout (the heartbeat-gap
      // fix). On a non-null result, swap in the fresh order; on null (child error /
      // timeout / unparseable), KEEP the existing cached order and retry next TTL.
      const t0 = Date.now();
      const prevOrder = cachedOrder;
      cachedOrder = await deriveWorkOrderOffThread();
      if (cachedOrder) {
        cachedOrderAt = Date.now();
        if (cachedOrder.length) {
          const totalPending = cachedOrder.reduce((a, t) => a + t.pending, 0);
          log(`work order: ${cachedOrder.length} topics, ${totalPending} chunks pending; head="${cachedOrder[0].topic}" (pri=${cachedOrder[0].priority}) profile=${getEmbedProfile()} deriveMs=${Date.now() - t0} rss=${rssMb()}MB`);
        }
      } else if (prevOrder) {
        // Derive failed but we still have the prior order — keep draining it (it is
        // value-ordered and corrected live by the cooldown re-filter below).
        cachedOrder = prevOrder;
      } else {
        // First boot (or post-drain) with a failed derive and no order to fall back
        // on. Never block forever awaiting the child: sleep and retry next pass.
        await sleep(IDLE_DRAIN_POLL_MS);
        continue;
      }
    }
    // Re-filter the cached order against live cooldown each pass: a topic demoted
    // mid-TTL (its slice blew the budget) must drop out immediately even though the
    // expensive value re-derive has not run yet.
    const order = cachedOrder.filter((t) => !topicInCooldown(t.topic));
    if (!order.length) {
      // Nothing actionable right now (drained, or everything in cooldown). Sleep
      // and force a fresh derive next pass — never terminate.
      cachedOrder = null;
      await sleep(IDLE_DRAIN_POLL_MS);
      continue;
    }
    const totalPending = order.reduce((a, t) => a + t.pending, 0);
    lastKnownPending = totalPending;

    // df_969e7d39 AC-4 (iteration-4) — publish liveness: refreshes pending each pass
    // for the worker's heartbeat. The worker's own clock emits the line; this only
    // keeps the payload integers fresh. Sub-microsecond, non-blocking.
    publishHeartbeatState(lanePool);

    // st_2cd1af73 AC-3 — per-pass progress accounting for the decision trace.
    // The Phase-1→AC-3 wedge was MUTE: every topic deferred (long-dominated +
    // chat "active" from background traffic) so the daemon sliced nothing and
    // looped in silence — an idle night with no log of WHY. We now count chunks
    // embedded this pass and remember which topics were skipped-as-deferred; if a
    // pass embeds zero while pending>0, we log ONE explicit idle-pass line naming
    // the deferred topics + the chat-quiet age + the gate state, so an idle night
    // can never be unexplained again.
    let completedThisPass = 0;
    const deferredThisPass = [];

    // st_2cd1af73 AC-3 — SHORT-FIRST pass ordering (the throughput lever).
    //
    // WHY: value-first alone front-loaded the SLOWEST work. A topic whose NEXT
    // fetch is long (career: 581 pending, 97% long; general: 302, 98% long) embeds
    // ~2600-char inputs that run ~51s per batch on CPU. Sitting at the head, those
    // tiny topics burned minutes for a handful of chunks while `personal`'s ~200k
    // SHORT chunks (~0.17s each, the throughput volume) waited. Measured live: ~16
    // chunks in ~5 minutes — the exit bar (≥1,200 / 45 min) is unreachable that way.
    //
    // The classification that matters with shortFirst fetch is "does this topic
    // still have SHORT chunks?" — NOT its overall long fraction. A topic with short
    // chunks left fetches short next (fast, yieldable) regardless of how long-heavy
    // its tail is; only once its short backlog is gone does the next fetch hit the
    // slow long tail. selectEmbeddingPassOrder keeps short-rich topics dominant
    // while allowing a bounded high-priority long-only trickle.
    // st_2cd1af73 follow-up — bounded long-only trickle. Pure short-first
    // throughput created a starvation shape on the live launch DB: high-priority
    // `career` workbench chunks were long-only, so they waited behind 151k short
    // `personal` chunks even though the work order ranked career first. Include a
    // tiny rotating long-only tail from the already value-sorted order. Rotation is
    // what prevents one larger long-only topic from occupying the only trickle slot
    // for hours while smaller high-value long-only topics wait. The long-input
    // quiet gate below still decides whether it may actually run, and the
    // long-only path is capped to one batch, so a human chat turn stays protected.
    const passOrder = selectEmbeddingPassOrder(order, { longOnlyStart: longOnlyPassCursor });
    const longOnlySelected = passOrder.filter((t) => (t.shortPending || 0) === 0).length;
    if (longOnlySelected > 0) longOnlyPassCursor += longOnlySelected;

    for (const { topic, pending, longShare, shortPending, slaTier } of passOrder) {
      if (ac.signal.aborted) break;
      const work = { topic, pending, longShare, shortPending, slaTier };

      // Yield to chat BEFORE starting a topic-slice.
      if (!(await waitForQuiet(work))) break;

      if (getEmbedProfile() === 'night') {
        lanePool = reconcileLanePool(getEmbedProfile(), lanePool);
        lanePool = await ensureLanePoolReady(lanePool);
      }

      // st_2cd1af73 AC-1/AC-3: long-input wide-quiet gate. A LONG-ONLY topic's
      // next inference holds the CPU ~11s uninterruptibly and starves chat
      // first-token if a turn lands during it, so it runs ONLY when CHAT has been
      // quiet for LONG_INPUT_QUIET_MS. A topic that still has SHORT chunks is NOT
      // gated here — shortFirst makes its next fetch short (instantly yieldable),
      // so it keeps draining through chat activity. The gate therefore keys off
      // "no short work left" (shortPending===0), not the overall longShare — that
      // is what keeps personal's 200k short chunks draining instead of being
      // deferred as nominally "40% long".
      const longOnlyNext = (shortPending || 0) === 0;
      if (longOnlyNext && !longInputQuietEnough()) {
        deferredThisPass.push(`${topic}(${Math.round((longShare || 0) * 100)}%long,${pending}p)`);
        log(`  ${topic}: long-only remaining (${Math.round((longShare || 0) * 100)}% long) and chat recently active — deferring to a wider idle window`);
        continue;
      }

      // RSS ceiling: a separate process, but the model resident set still grows.
      // A breach exits cleanly so KeepAlive respawns fresh (RSS reset to
      // baseline) before the OS jetsam path would kill us.
      //
      // st_db4b3118 — when lanes are live, the gate covers the SUM of the parent
      // PLUS every lane pid: lanes are separate processes, so the parent's own RSS
      // misses them entirely, but the OS jetsam path sees the total. Tearing the
      // pool down before exit frees the lanes immediately; the respawn reloads
      // every model fresh with RSS reset.
      const rss = lanePool ? lanePool.rssGate(WORKER_NAME) : rssCeilingDecision(WORKER_NAME);
      if (!rss.ok) {
        log(`${rss.message} — exiting 0 for a fresh KeepAlive respawn`);
        teardownLanePool();
        return;
      }

      const t0 = Date.now();
      let result;
      // Hard backstop watchdog. The PRIMARY wedge-defense is the time-budget
      // demotion below (finish the committed batch, then demote); this watchdog is
      // only the last-resort ceiling for a pathological slice, set generously above
      // the per-topic budget so it never fires on a healthy long-input slice. It
      // also forwards a master shutdown abort to embedChunks. NOTE: an ONNX
      // inference is uninterruptible, so this abort lands only at the next sub-batch
      // boundary — which is exactly why the demotion path, not the watchdog, is the
      // real fix.
      const watchdogMs = Math.max(SLICE_TIMEOUT_MS, TOPIC_TIME_BUDGET_MS * 2);
      const sliceAc = new AbortController();
      const onMasterAbort = () => sliceAc.abort();
      ac.signal.addEventListener('abort', onMasterAbort, { once: true });
      const watchdog = setTimeout(() => sliceAc.abort(), watchdogMs);
      // st_2cd1af73 AC-1 (residual, daemon end): a single ONNX inference is
      // uninterruptible AND CPU-bound — a long-input batch was measured at 22.7s,
      // and a chat turn landing during it sees first-token blow out (event loop +
      // CPU starved) even though no WAL writer is held. The sub-batch WRITE yield
      // (activityCheck) cannot help while the INFERENCE is the blocker, because the
      // whole batch is embedded before any write. So poll the activity signal on a
      // short interval and abort the slice the INSTANT chat goes active: the abort
      // lands at embedLocalBatch's next internal sub-batch boundary (every
      // ortBatchSize≈2 chunks), freeing CPU within one short inference instead of
      // up to the full multi-second batch. The signal row is ≤1s fresh, so this
      // reacts within ACTIVITY_WATCH_MS + that staleness. Cleared in finally.
      const activityWatch = setInterval(() => {
        try {
          const watchDecision = !sliceAc.signal.aborted
            ? workPauseDecision(getActivitySignal(db), work)
            : { pause: false };
          if (watchDecision.pause) {
            // st_2cd1af73 NIGHT MODE — drop to the polite day profile the INSTANT
            // chat is detected mid-slice, co-located with the abort. This is the
            // ≤2s polite-drop: the abort frees the CPU within one short inference,
            // and flipping the flag here means the next inference (after chat
            // clears) is day-polite without waiting for the top-of-pass reconcile.
            // Cheap when already day (setEmbedProfile is a no-op on no thread change).
            //
            // st_fd14cdd4 AC9 — sliceAc.abort() now propagates THROUGH the lane
            // pool: lib/rag/lane-pool.js embedBatch listens on this signal and
            // SIGKILLs every busy lane, freeing their ~3.7 cores within one watch
            // tick (≤ACTIVITY_WATCH_MS + signal staleness) instead of after the full
            // multi-second lane batch. A lane's IPC inference is uninterruptible from
            // inside, so killing the process is the ONLY way to free its CPU at once;
            // the slices are durable on the parent (rows stay embedded=0), the lanes
            // respawn for the next quiet pass. This replaces the prior "stop
            // dispatching, let in-flight finish" behavior whose multi-second lane
            // grind blew chat TTFT to ~27s under load. The pool tears down to a single
            // day lane at the top of the next pass (reconcileLanePool). The QoS/profile
            // flag flips now so the next inference (after chat clears) is day-polite.
            const beforeProfile = getEmbedProfile();
            const beforeLanes = laneCountForProfile(beforeProfile);
            const dropped = reconcileEmbedProfileToDay(watchDecision.reason);
            if (beforeProfile !== 'day' || dropped) {
              log(`profile → day (${watchDecision.reason}; foreground landed mid-slice — dropping to polite, lanes ${beforeLanes}→1)`);
            }
            // Snapshot how many lanes were grinding, for the yield-proof log.
            const busyLanes = lanePool ? lanePool.lanes.filter((l) => l && l.busy).length : 0;
            sliceAc.abort();
            if (busyLanes > 0) log(`  freed ${busyLanes} in-flight lane(s) on chat-detect — CPU yielded to chat`);

          }
        } catch { /* a transient read failure just means we re-check next tick */ }
      }, ACTIVITY_WATCH_MS);
      let backoffMs = 0;
      try {
        // Embed a bounded slice of this topic, then return to the loop so the
        // activity + RSS checks run between slices. embedChunks does the proven
        // DELETE+INSERT-then-mark-embedded transaction per batch. Passing
        // idleGateWorkerName ARMS the in-loop RSS-ceiling backstop inside
        // embedChunks (without it that check was dead code — options.idleGateWorkerName
        // was undefined, so the ceiling was only ever checked at slice boundaries the
        // daemon could not reach while stuck mid-slice).
        // st_2cd1af73 AC-3 — a LONG-ONLY visit runs ONE batch, not the full
        // SLICE_BATCHES. WHY: a long batch is ~51s of uninterruptible CPU;
        // SLICE_BATCHES=2 of them is ~100–130s, which (a) overruns the 120s per-topic
        // budget and demotes anyway, and (b) holds the loop that long before the
        // daemon returns to cheap short work. Capping a long-only visit to one batch
        // makes it return in ~51s, so a slow topic demotes promptly and steady
        // partial progress is preserved. A topic that still has SHORT chunks keeps
        // the full slice — shortFirst means those batches are fast.
        const topicMaxBatches = longOnlyNext ? 1 : SLICE_BATCHES;
        // st_2cd1af73 NIGHT MODE — in the wide-quiet profile, widen the SHORT-tier
        // batch so the email bulk drains faster. Passed only while the profile is
        // night; embedChunks ignores it (day BATCH_SIZE) when 0. The LONG tier is
        // unaffected inside embedChunks — only short batches widen, RSS stays bound.
        const nightShortBatchSize = getEmbedProfile() === 'night' ? NIGHT_SHORT_BATCH : 0;
        result = await embedChunks(topic, sliceAc.signal, {
          maxBatches: topicMaxBatches,
          idleGateWorkerName: WORKER_NAME,
          nightShortBatchSize,
          // st_db4b3118 — fan this slice's inference across the night lane pool when
          // it exists (lanes>=2); null in day → in-process embed. The parent still
          // does every DB read/write, so single-writer + jetsam hold; only the
          // inference call parallelizes.
          lanePool,
          // st_2cd1af73 AC-3 — drain this topic's SHORT chunks before its long
          // tail. A mixed topic (personal: ~200k short + ~134k long) otherwise
          // pays a long chunk's ~26s in any batch that contains one, so the cheap
          // short bulk crawls at the long chunks' pace. Short-first lets the
          // high-volume short chunks embed at ~12/s, which is what carries the
          // throughput; the long tail follows once the short backlog is gone.
          shortFirst: true,
          // Product chat history is the first lane inside a topic. Recent turns
          // are the highest-leverage substrate for the next turn, so they drain
          // before broader source-breadth seeding.
          chatHistoryFirst: true,
          // First-use intelligence is breadth-first, not row-first. Within a topic,
          // seed the high-signal source slices before letting one huge source
          // cluster consume the hour.
          coverageFirst: true,
          // st_2cd1af73 AC-1 (residual, daemon end): yield the WAL writer to chat
          // BETWEEN sub-batch commits, not just between slices. embedChunks calls
          // this between its sub-batch writes; returning true (a request is
          // in-flight or just landed) makes it stop writing the rest of the
          // current fetched batch and return, so a turn arriving mid-batch sees
          // the writer freed within one sub-batch (sub-second). Same pause
          // decision the slice-boundary waitForQuiet() uses, so behavior is
          // consistent; this just tightens the yield granularity.
          activityCheck: () => workShouldPause(work).pause,
          // st_db4b3118 follow-up — update heartbeat/watchdog state on committed
          // rows, not just after the whole slice returns. A long slice can run past
          // multiple heartbeat ticks; this keeps pending truthful during the slice.
          onBacklogCompleted: (payload) => noteBacklogCompleted(payload, lanePool),
          // st_fd14cdd4 AC9 — checkpoint the WAL between fetched batches DURING the
          // slice, not only between slices. A night slice runs ~167s and writes
          // thousands of vec0 frames; without a mid-slice checkpoint the -wal grew
          // to 632MB (87k uncheckpointed frames) and a chat read landing mid-slice
          // traversed it. checkpointWal self-throttles (≤ once per 10s) and only
          // reclaims when the writer is idle (the batch boundary). GUARD: skip the
          // checkpoint while chat is active — a TRUNCATE then would contend the
          // SQLCipher lock with the live chat read (and no-ops against a reader
          // anyway). When chat is active the daemon is already yielding; the next
          // quiet batch boundary checkpoints. This is the call site the brief named
          // ("between lane batches") that actually bounds the WAL during the grind.
          onBatchCommitted: () => {
            // df_969e7d39 AC-4 (iteration-4) — publish liveness: refreshes lanes +
            // streak between lane batches, the most frequent point during dense
            // embedding. The worker's own clock emits the heartbeat; this keeps the
            // payload integers fresh. Sub-microsecond, non-blocking.
            publishHeartbeatState(lanePool);
            if (!workShouldPause(work).pause) {
              checkpointWal('between-batches (mid-slice, chat quiet)');
            }
          },
          // st_1cfe9061 — route vec0 writes to embeddings.db when open.
          embeddingsDb,
        });
        if (result?.error) {
          throw new Error(result.error);
        }
        const sliceMs = Date.now() - t0;
        // st_2cd1af73 AC-3 — count real completed backlog rows this pass for the
        // idle-pass trace. Signature reuse also drains pending work.
        const completedRows = (Number(result?.embedded) || 0) + (Number(result?.reused) || 0);
        completedThisPass += completedRows;
        if (completedRows > 0) { lastProgressAt = Date.now(); contentionStreak = 0; }
        if (result?.aborted && result.abortReason === 'rss-ceiling') {
          // The in-loop RSS backstop fired mid-slice: exit for a fresh respawn.
          log(`  ${topic}: RSS ceiling hit mid-slice (rss=${rssMb()}MB) — exiting 0 for a fresh KeepAlive respawn`);
          return;
        }
        // st_2cd1af73 AC-1 (residual, daemon end): an 'activity' or 'idle' abort
        // is a BENIGN yield (a chat turn landed / the user returned) — the writer
        // was released on purpose, NOT a pathological slice. Only a non-benign,
        // non-master abort routes to the watchdog-demote. Without this guard the
        // new sub-batch activity yield would wrongly demote a perfectly healthy
        // topic every time it paused for chat.
        const benignAbort = result?.abortReason === 'activity' || result?.abortReason === 'idle';
        if (result?.aborted && benignAbort) {
          log(`  ${topic}: yielded writer to chat (${result.abortReason}) — wrote ${result.embedded} this slice, will resume next pass`);
        } else if (result?.aborted && result.abortReason !== 'signal' && !ac.signal.aborted) {
          // The hard watchdog fired (not a master shutdown): truly pathological.
          log(`  ${topic}: hard watchdog (${(watchdogMs / 1000).toFixed(0)}s) fired — demoting (embedded ${result.embedded} this slice, rss=${rssMb()}MB)`);
          demoteTopic(topic);
        } else if (result?.embedded > 0) {
          log(`  ${topic}: +${result.embedded} (${pending} pending, ${(sliceMs / 1000).toFixed(1)}s, lastBatch=${((result.lastBatchMs || 0) / 1000).toFixed(1)}s, rss=${rssMb()}MB)`);
        }
        // st_1cfe9061 — check if this topic is now fully migrated to embeddings.db.
        if (result?.embedded > 0 && embeddingsDb) {
          const topicPendingAfter = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE topic=? AND embedded=0 AND skip_embed=0').get(topic).n;
          if (topicPendingAfter === 0) {
            markTopicMigrated(topic);
            checkAndTriggerHnswRebuild();
          }
        }
        // st_2cd1af73 AC-3 — per-topic time budget. If this slice's embed work blew
        // the budget, the committed batch is already written; DEMOTE the topic so it
        // moves to the back of the queue (cooldown) and the next topic runs. This is
        // what keeps a slow transcript topic from head-blocking the 335k email bulk.
        // Checked on the slice's MEASURED time, not a guess.
        if (!result?.aborted && sliceMs > TOPIC_TIME_BUDGET_MS) {
          log(`  ${topic}: slice took ${(sliceMs / 1000).toFixed(1)}s > budget ${(TOPIC_TIME_BUDGET_MS / 1000).toFixed(0)}s — demoting to back of queue for ${(TOPIC_COOLDOWN_MS / 1000).toFixed(0)}s`);
          demoteTopic(topic);
        }
      } catch (err) {
        const msg = err?.message || String(err);
        // st_fd14cdd4 AC9 — SQLITE_BUSY IS an activity signal. LIVE finding: when
        // the box is under load the server's activity-row flush (request-observer)
        // gets starved and the row goes STALE, so embedPauseDecision reads
        // "stale → don't pause" and the daemon grinds straight through a chat turn
        // that is actually live — chat TTFT blew to 20–85s while the daemon looped
        // SQLITE_BUSY→grind. But SQLITE_BUSY is the server DIRECTLY telling us it
        // wants the single SQLCipher writer/reader: on this system the only other
        // hot DB user is chat. So treat repeated contention as activity the stale
        // heartbeat failed to report — back off HARD (a real pause window, not a
        // 50–250ms retry) and, if night lanes are up, force the polite day profile
        // (tear the lane pool down) so the daemon stops competing with chat for CPU
        // and the WAL writer. This breaks the starve→stale→grind→starve cycle the
        // stale-row gate could not.
        if (/SQLITE_BUSY|database is locked/i.test(msg)) {
          const isBusySnapshot = err?.code === 'SQLITE_BUSY_SNAPSHOT';
          if (isBusySnapshot) {
            log(`sqlite-busy-snapshot on "${topic}" — stale read snapshot; skipping topic this pass (streak unchanged)`);
            backoffMs = 50 + Math.floor(Math.random() * 150);
          } else {
            contentionStreak += 1;
            if (contentionStreak >= CONTENTION_YIELD_STREAK) {
              backoffMs = CONTENTION_BACKOFF_MS;
              const pc = reconcileEmbedProfileToDay('db contention (server wants the writer)');
              log(`SQLITE_BUSY x${contentionStreak} on "${topic}" — server contending; yielding ${backoffMs}ms${pc ? ' + dropped to day-polite (lanes torn down)' : ''}`);
            } else {
              backoffMs = 50 + Math.floor(Math.random() * 200);
              log(`SQLITE_BUSY on "${topic}" — backing off ${backoffMs}ms and re-checking activity`);
            }
            // df_969e7d39 AC-4 (iteration-4) — publish liveness: a contention storm
            // bumped contentionStreak (and may have torn the lane pool down via
            // reconcileEmbedProfileToDay), so refresh the integers the worker reports.
            // Sub-microsecond, non-blocking.
            publishHeartbeatState(lanePool);
          }
        } else {
          log(`embed error on "${topic}": ${msg} — skipping topic this pass`);
        }
      } finally {
        clearTimeout(watchdog);
        clearInterval(activityWatch);
        ac.signal.removeEventListener('abort', onMasterAbort);
      }
      if (backoffMs) await sleep(backoffMs);
      // If the slice aborted for a master shutdown, the outer loop's aborted
      // check ends the run on the next iteration.
    }

    // st_fd14cdd4 AC9 — bound the WAL between slices. The embedder's writes piled
    // 453k frames into the -wal while grinding (chat quiet), and chat's reads then
    // scanned that giant frameset. Checkpoint here, once per outer pass (throttled),
    // but ONLY when chat is quiet: when chat is active the daemon must stay out of
    // the DB's way, and a TRUNCATE no-ops against a live reader anyway. This is the
    // call site that actually bounds the WAL — the frames accumulate during the
    // grind, so the checkpoint belongs in the grind, not on the chat-active yield.
    if (!ac.signal.aborted && !productShouldPause().pause) {
      checkpointWal('between-slices (chat quiet)');
    }

    // st_2cd1af73 AC-3 — the never-mute-again trace. A pass that completed ZERO
    // backlog rows while real work was pending is the exact wedge shape that wasted the
    // night silently. Emit one explicit line naming WHY: the deferred topics
    // (with their long% and pending count), the age since the last CHAT request,
    // and the gate verdict. With this, an idle night shows a per-cycle reason in
    // the log instead of going dark. Then sleep PAUSE_POLL-style so a fully-
    // deferred pass cannot hot-spin the CPU re-deriving the work order.
    if (!ac.signal.aborted && completedThisPass === 0 && totalPending > 0) {
      const ageMs = chatQuietAgeMs();
      const age = ageMs === Infinity ? 'quiet(no-chat/stale)' : `${(ageMs / 1000).toFixed(1)}s-since-chat`;
      const gate = longInputQuietEnough() ? 'long-gate=OPEN' : 'long-gate=SHUT';
      const why = deferredThisPass.length
        ? `deferred=[${deferredThisPass.join(', ')}]`
        : 'no-topic-sliced (all in cooldown or paused)';
      log(`idle pass — embedded 0/${totalPending} pending; ${why}; chat ${age}; ${gate} (quietMs=${LONG_INPUT_QUIET_MS})`);
      await sleep(IDLE_DRAIN_POLL_MS);
    }
  }
  log('shutting down — loop exited');
}

// Only run the loop when invoked as the entrypoint (launchd / CLI). Importing
// this module for its exports (e.g. daemonWorkOrder in tests) must NOT start the
// loop. argv[1] is the script path launchd/node runs; compare it to this file.
function isEntrypoint() {
  if (process.env.ROBOTDOJO_DAEMON_IMPORT_ONLY === '1' || process.env.NODE_TEST_CONTEXT === '1') {
    return false;
  }
  const invoked = process.argv[1] || '';
  try {
    return import.meta.url === new URL(`file://${invoked}`).href
      || invoked.endsWith('chunk-embed-daemon.mjs');
  } catch {
    return invoked.endsWith('chunk-embed-daemon.mjs');
  }
}

if (isEntrypoint()) {
  await main();
  process.exit(0);
}
