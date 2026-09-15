/**
 * Per-turn chat observability — OTEL GenAI semconv mirror.
 *
 * Five lifecycle hooks: startChatTurn, recordPhase, recordFirstToken,
 * recordCompletion, recordError. Each writes deterministically to the
 * `chat_turn_metrics` table via parameterized statements.
 *
 * No-silent-swallow contract: every helper catches DB errors, logs to stderr
 * with the turn_id, returns a falsy signal. Throws never escape past the
 * helper boundary — observability failures must not break a chat turn but
 * MUST be visible (st_384c0149 retro: synthesis-downstream-of-observability
 * cannot tolerate silent loss).
 *
 * The default export uses the shared `lib/db.js` singleton. Tests inject a
 * different db handle via `setObservabilityDb(db)` to drive in-memory cases.
 */
import crypto from 'node:crypto';
import sharedDb from '../db.js';

const DEFAULT_TURN_METRIC_BUSY_TIMEOUT_MS = 25;
const TURN_INSERT_BUSY_RETRY_MS = [50, 150, 400, 1000];

function isSqliteBusyError(err) {
  const message = String(err?.message || err?.code || err || '');
  return err?.code === 'SQLITE_BUSY'
    || err?.code === 'SQLITE_LOCKED'
    || /SQLITE_(BUSY|LOCKED)|database is locked|database locked/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// WHY a swappable holder: tests want an in-memory DB without monkey-patching
// the module graph. setObservabilityDb() replaces the active handle for the
// duration of the test; tests reset it in `after` (or just let the next call
// re-set it).
let _db = sharedDb;

export function setObservabilityDb(db) {
  _db = db;
}

export function getObservabilityDb() {
  return _db;
}

/**
 * Log a per-helper failure to stderr with the turn_id. Returned non-throwing
 * so callers can chain without try/catch every site.
 */
function logFailure(operation, turnId, err) {
  // No-silent-swallow contract: stderr line names the operation + turn_id +
  // message. Synthesis pipelines downstream parse stderr for `[chat-turn] failed`.
  process.stderr.write(
    `[chat-turn] failed to write ${operation} for turn_id=${turnId}: ${err.message}\n`,
  );
}

function configuredTurnMetricBusyTimeoutMs() {
  const value = process.env.ROBOTDOJO_TURN_METRIC_BUSY_TIMEOUT_MS;
  if (value == null || value === '') return DEFAULT_TURN_METRIC_BUSY_TIMEOUT_MS;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_TURN_METRIC_BUSY_TIMEOUT_MS;
}

function withTurnMetricBusyTimeout(fn) {
  let prevTimeout;
  let shouldRestore = false;
  try {
    try {
      prevTimeout = _db.pragma('busy_timeout', { simple: true });
      shouldRestore = prevTimeout !== undefined;
    } catch { /* fake/test DB or driver without pragma */ }
    try { _db.pragma(`busy_timeout = ${configuredTurnMetricBusyTimeoutMs()}`); } catch {}
    return fn();
  } finally {
    if (shouldRestore) {
      try { _db.pragma(`busy_timeout = ${prevTimeout}`); } catch {}
    }
  }
}

/**
 * Insert the initial row synchronously. Returns the turn_id (caller threads it
 * everywhere). On DB failure: logs to stderr, returns null. Caller MUST tolerate
 * null — downstream helpers are no-ops when called with null.
 *
 * Kept for back-compat and for callers that are NOT on the chat critical path
 * (the synchronous INSERT is fine there). The streaming chat route uses
 * {@link newTurnId} + {@link startChatTurnDeferred} instead, so the INSERT never
 * blocks the pre-first-token path behind the single SQLCipher writer.
 *
 * @param {object} args
 * @param {string} args.conversation_id - convId for this turn
 * @param {string} args.provider_name - 'anthropic' | 'ollama' etc.
 * @param {string} [args.request_model] - the model id sent to the provider
 * @param {string} args.belt - 'white' | 'black' | 'demo'
 * @returns {string|null} turn_id
 */
export function startChatTurn({ conversation_id, provider_name, request_model = null, belt }) {
  const turn_id = crypto.randomUUID();
  try {
    insertTurnRow(turn_id, { conversation_id, provider_name, request_model, belt, request_start_ms: Date.now() });
    return turn_id;
  } catch (err) {
    logFailure('startChatTurn', turn_id, err);
    return null;
  }
}

// ── Deferred-insert path (st_2cd1af73 AC-1 residual: keep DB writes off the
//    pre-first-token critical path) ─────────────────────────────────────────
//
// WHY: routes/chat.js used to run the synchronous startChatTurn() INSERT BEFORE
// the stream's first `status` frame. Under the embed daemon's continuous writes
// that INSERT blocked for SECONDS behind the single SQLCipher writer (a 27.7s
// `INSERT INTO conversations` hold was captured), making an observability write
// the dominant TTFT term. The fix splits turn creation in two:
//
//   1. newTurnId() — synchronous, pure crypto.randomUUID(), zero DB. The route
//      has a turn_id to thread into recordFirstToken/recordError/recordCompletion
//      immediately, with NO write on the path to the status frame.
//   2. startChatTurnDeferred() — enqueues the INSERT for the NEXT macrotask
//      (setImmediate), so it runs only AFTER the status frame has flushed. It
//      returns a promise the route awaits before persistMessages, so the
//      conversation/turn row is guaranteed present by stream end.
//
// Late-arriving UPDATEs are not lost: recordFirstToken/recordCompletion/
// recordError BUFFER their effect when the row is not yet inserted, and the
// buffer is replayed in insert order the instant the INSERT lands. So even a
// first token that arrives before the deferred INSERT (vanishingly unlikely —
// first token is hundreds of ms out, the INSERT fires on the next tick) still
// materializes ttft_ms correctly. No turn is ever dropped.

// turn_id → true once the row is known to exist in the DB (insert succeeded).
const _rowReady = new Set();
// turn_id → array of { fn, args } UPDATE closures buffered until the row exists.
const _pendingUpdates = new Map();
// turn_id → resolved Promise of the deferred INSERT (so the route can await it
// before persist). Cleared on completion to bound the map.
const _insertPromises = new Map();

/** Synchronous, DB-free turn id. Thread it into the record* helpers at once. */
export function newTurnId() {
  return crypto.randomUUID();
}

/**
 * Run the raw INSERT for a turn row. Throws on DB failure (callers decide how to
 * surface). Separated so both the sync and deferred paths share one statement.
 */
function insertTurnRow(turn_id, { conversation_id, provider_name, request_model = null, belt, request_start_ms }) {
  withTurnMetricBusyTimeout(() => {
    _db.prepare(`
      INSERT INTO chat_turn_metrics
        (turn_id, conversation_id, operation_name, provider_name, request_model, request_start_ms, belt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      turn_id,
      conversation_id,
      'chat',
      provider_name,
      request_model,
      request_start_ms,
      belt,
    );
  });
  _rowReady.add(turn_id);
  flushPendingUpdates(turn_id);
}

/**
 * Replay any UPDATEs buffered before the row existed, in arrival order, then
 * drop the buffer. Each buffered closure is a no-arg call that re-invokes the
 * original UPDATE now that _rowReady has the id.
 */
function flushPendingUpdates(turn_id) {
  const pending = _pendingUpdates.get(turn_id);
  if (!pending) return;
  _pendingUpdates.delete(turn_id);
  for (const replay of pending) {
    try { replay(); } catch (err) { logFailure('flushPendingUpdate', turn_id, err); }
  }
}

/**
 * Buffer an UPDATE closure when the row is not yet inserted. Returns true if the
 * effect was buffered (caller must NOT also run it now), false if the row is
 * ready and the caller should run the UPDATE immediately.
 *
 * request_start_ms is captured by the closure's own arguments at call time, so a
 * replayed first-token/error stamp reflects when it ACTUALLY happened, not when
 * the buffer drained. ttft_ms math (first_token - start) stays honest.
 */
function bufferIfRowNotReady(turn_id, replay) {
  if (_rowReady.has(turn_id)) return false;
  let arr = _pendingUpdates.get(turn_id);
  if (!arr) { arr = []; _pendingUpdates.set(turn_id, arr); }
  arr.push(replay);
  return true;
}

/**
 * Insert the turn row on the NEXT macrotask so it never runs before the caller's
 * first SSE frame flushes. Returns a promise that resolves AFTER the INSERT has
 * been attempted (success or logged failure) — the route awaits it before
 * persistMessages so the conversation/turn row is present at stream end.
 *
 * On DB failure the promise still resolves (never rejects) — observability must
 * not break a chat turn. A failed INSERT leaves the row "not ready"; any buffered
 * UPDATEs are dropped on completeTurn() so the maps never leak.
 *
 * @param {string} turn_id - from newTurnId()
 * @param {object} args - same shape as startChatTurn args
 * @returns {Promise<boolean>} true if the row was inserted, false on failure
 */
export function startChatTurnDeferred(turn_id, { conversation_id, provider_name, request_model = null, belt }) {
  const request_start_ms = Date.now();
  const p = new Promise((resolveOuter) => {
    setImmediate(async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          insertTurnRow(turn_id, { conversation_id, provider_name, request_model, belt, request_start_ms });
          resolveOuter(true);
          return;
        } catch (err) {
          if (!isSqliteBusyError(err) || attempt >= TURN_INSERT_BUSY_RETRY_MS.length) {
            logFailure('startChatTurnDeferred', turn_id, err);
            resolveOuter(false);
            return;
          }
          await sleep(TURN_INSERT_BUSY_RETRY_MS[attempt]);
        }
      }
    });
  });
  _insertPromises.set(turn_id, p);
  return p;
}

/**
 * Await the deferred INSERT for a turn (no-op if it already landed or was never
 * deferred). The route calls this right before persistMessages so the row is
 * guaranteed present for recordCompletion's UPDATE.
 *
 * @param {string} turn_id
 * @returns {Promise<void>}
 */
export async function awaitTurnInsert(turn_id) {
  const p = _insertPromises.get(turn_id);
  if (p) { try { await p; } catch { /* never rejects, but be safe */ } }
}

/**
 * Release per-turn buffering state. MUST be called once the turn is fully done
 * (after recordCompletion/recordError) so _rowReady / _pendingUpdates /
 * _insertPromises do not grow unbounded across a long-lived server. Any UPDATEs
 * still buffered (the INSERT failed and never readied the row) are dropped here.
 *
 * @param {string} turn_id
 */
export function completeTurn(turn_id) {
  if (!turn_id) return;
  _rowReady.delete(turn_id);
  _pendingUpdates.delete(turn_id);
  _insertPromises.delete(turn_id);
}

/** Test helper: clear all deferred-turn buffering state. */
export function _resetTurnBuffersForTest() {
  _rowReady.clear();
  _pendingUpdates.clear();
  _insertPromises.clear();
}

/**
 * Record a lifecycle phase. Today this is a no-op write (the phase event
 * itself is sent over SSE in real time and consumed by the indicator).
 * Future: persist phase trace as JSON column for replay/debugging.
 *
 * Kept as a callable hook so the route can wire `onPhase` callbacks without
 * scattering "is observability up?" checks. No-op when turn_id is null.
 */
export function recordPhase(turn_id, phase_name) {
  if (!turn_id) return;
  // Intentional no-op: phase events live on the wire. This hook exists so
  // callers can add column-level phase trace later without changing call sites.
  void phase_name;
}

/**
 * Record the moment the first model token (or simulated stall surrogate)
 * arrived. UPDATE-only — does nothing if turn_id is null or the row is gone.
 *
 * st_2cd1af73 Phase 6 — also materializes the honest TTFT. first_token_ms and
 * request_start_ms are both absolute epochs; ttft_ms is their difference, the
 * actual time-to-first-token. We compute it in-statement from the row's own
 * request_start_ms (set at startChatTurn) rather than threading another arg
 * through every call site, and clamp negatives to NULL so a clock skew or an
 * out-of-order row never records a nonsense duration. Only real chat turns
 * reach this helper; historical warmup-ping rows were written by a separate
 * path and never called recordFirstToken, so they stay ttft_ms = NULL by
 * construction.
 */
export function recordFirstToken(turn_id, now = Date.now()) {
  if (!turn_id) return;
  // Capture `now` (the real first-token instant) so a buffered replay records the
  // true ttft, not the buffer-drain time. The CASE clause clamps a negative
  // (clock-skew) duration to NULL, exactly as before.
  if (bufferIfRowNotReady(turn_id, () => recordFirstToken(turn_id, now))) return;
  try {
    withTurnMetricBusyTimeout(() => {
      _db.prepare(`
        UPDATE chat_turn_metrics
        SET first_token_ms = ?,
            ttft_ms = CASE
              WHEN request_start_ms IS NOT NULL AND ? > request_start_ms
              THEN ? - request_start_ms
              ELSE NULL
            END
        WHERE turn_id = ? AND first_token_ms IS NULL
      `).run(now, now, now, turn_id);
    });
  } catch (err) {
    logFailure('recordFirstToken', turn_id, err);
  }
}

/**
 * Record completion: usage totals, cost estimate, tools used, response model,
 * assistant message id. UPDATE-only.
 *
 * st_74f45a1a R2 amendment — also persist Anthropic prompt-cache token
 * counters. The SDK returns `cache_creation_input_tokens` and
 * `cache_read_input_tokens` on `response.usage` when prompt caching is in
 * effect. AC 11 asserts cache_read_input_tokens > 0 on the second turn of
 * a warm conversation.
 *
 * @param {string} turn_id
 * @param {object} args
 * @param {object} [args.usage] - { input_tokens, output_tokens,
 *                                   cache_creation_input_tokens?,
 *                                   cache_read_input_tokens? }
 * @param {number} [args.cost_cents]
 * @param {Array}  [args.tools_used] - tool name array (serialized JSON)
 * @param {string} [args.response_model]
 * @param {number} [args.assistant_message_id]
 */
export function recordCompletion(turn_id, args = {}) {
  if (!turn_id) return;
  // Stamp completion at CALL time and pin it on args so a buffered replay records
  // the real completion instant rather than the buffer-drain time.
  const completion_ms = Number.isFinite(args._completion_ms) ? args._completion_ms : Date.now();
  if (bufferIfRowNotReady(turn_id, () => recordCompletion(turn_id, { ...args, _completion_ms: completion_ms }))) return;
  try {
    const {
      usage = {},
      cost_cents = null,
      tools_used = null,
      response_model = null,
      provider_name = null,
      assistant_message_id = null,
    } = args;
    withTurnMetricBusyTimeout(() => {
      _db.prepare(`
        UPDATE chat_turn_metrics
        SET completion_ms = ?,
            input_tokens = ?,
            output_tokens = ?,
            cache_creation_input_tokens = ?,
            cache_read_input_tokens = ?,
            cost_cents = ?,
            tools_used = ?,
            response_model = COALESCE(?, response_model),
            provider_name = COALESCE(?, provider_name),
            assistant_message_id = COALESCE(?, assistant_message_id)
        WHERE turn_id = ?
      `).run(
        completion_ms,
        usage.input_tokens ?? null,
        usage.output_tokens ?? null,
        usage.cache_creation_input_tokens ?? null,
        usage.cache_read_input_tokens ?? null,
        cost_cents,
        tools_used ? JSON.stringify(tools_used) : null,
        response_model,
        provider_name,
        assistant_message_id,
        turn_id,
      );
    });
  } catch (err) {
    logFailure('recordCompletion', turn_id, err);
  }
}

function jsonOrNull(value) {
  if (value === undefined || value === null) return null;
  try { return JSON.stringify(value); } catch { return null; }
}

/**
 * Record the safe memory-context trace for this turn.
 *
 * This stores shape, not private content: tier, character count, section names,
 * source classes, target types, event type names, cache-hit, and timeout flags.
 */
export function recordMemoryContext(turn_id, summary = {}) {
  if (!turn_id) return;
  const captured = {
    present: Boolean(summary.present),
    cache_hit: Boolean(summary.cache_hit),
    timeout: Boolean(summary.timeout),
    tier: summary.tier || null,
    chars: Number.isFinite(Number(summary.chars)) ? Number(summary.chars) : 0,
    sections: Array.isArray(summary.sections) ? summary.sections : [],
    source_types: Array.isArray(summary.source_types) ? summary.source_types : [],
    target_types: Array.isArray(summary.target_types) ? summary.target_types : [],
    event_types: Array.isArray(summary.event_types) ? summary.event_types : [],
    has_latest: Boolean(summary.has_latest),
    has_snapshots: Boolean(summary.has_snapshots),
    has_conflicts: Boolean(summary.has_conflicts),
    has_chronology: Boolean(summary.has_chronology),
  };
  if (bufferIfRowNotReady(turn_id, () => recordMemoryContext(turn_id, captured))) return;
  try {
    withTurnMetricBusyTimeout(() => {
      _db.prepare(`
        UPDATE chat_turn_metrics
        SET memory_context_present = ?,
            memory_context_cache_hit = ?,
            memory_context_tier = ?,
            memory_context_chars = ?,
            memory_context_sections_json = ?,
            memory_context_source_types_json = ?,
            memory_context_target_types_json = ?,
            memory_context_event_types_json = ?,
            memory_context_timeout = ?,
            memory_context_has_latest = ?,
            memory_context_has_snapshots = ?,
            memory_context_has_conflicts = ?,
            memory_context_has_chronology = ?,
            memory_context_summary_json = ?
        WHERE turn_id = ?
      `).run(
        captured.present ? 1 : 0,
        captured.cache_hit ? 1 : 0,
        captured.tier,
        captured.chars,
        jsonOrNull(captured.sections),
        jsonOrNull(captured.source_types),
        jsonOrNull(captured.target_types),
        jsonOrNull(captured.event_types),
        captured.timeout ? 1 : 0,
        captured.has_latest ? 1 : 0,
        captured.has_snapshots ? 1 : 0,
        captured.has_conflicts ? 1 : 0,
        captured.has_chronology ? 1 : 0,
        jsonOrNull(captured),
        turn_id,
      );
    });
  } catch (err) {
    logFailure('recordMemoryContext', turn_id, err);
  }
}

/**
 * Record whether the who-is-who ego block was present in the assembled system
 * prompt for this turn (st_df0a8d71 AC-7).
 *
 * WHY its own columns instead of riding enrichment_health_json: absence of the
 * graph-truth block is the exact silent failure the defect story could not
 * observe (research soft-fail #10 — stable_context:ok fired even when identity
 * was empty). Dedicated columns make "did graph truth reach the prompt?" a
 * one-column query for the nightly quiz and the blocked-turn audit.
 */
export function recordEgoBlock(turn_id, { present = false, chars = 0 } = {}) {
  if (!turn_id) return;
  const captured = {
    present: Boolean(present),
    chars: Number.isFinite(Number(chars)) ? Math.max(0, Math.round(Number(chars))) : 0,
  };
  if (bufferIfRowNotReady(turn_id, () => recordEgoBlock(turn_id, captured))) return;
  try {
    withTurnMetricBusyTimeout(() => {
      _db.prepare(`
        UPDATE chat_turn_metrics
        SET ego_block_present = ?,
            ego_block_chars = ?
        WHERE turn_id = ?
      `).run(captured.present ? 1 : 0, captured.chars, turn_id);
    });
  } catch (err) {
    logFailure('recordEgoBlock', turn_id, err);
  }
}

/**
 * Record additive enrichment health for this turn.
 *
 * This stores mechanics only: layer name, status, and duration. No private
 * prompt text, no retrieved content, no entity names. Fallbacks are statuses
 * that released chat to the base model path: fault/error/timeout.
 */
export function recordEnrichmentHealth(turn_id, events = []) {
  if (!turn_id) return;
  const captured = (Array.isArray(events) ? events : [])
    .map((event) => ({
      layer: String(event?.layer || '').trim().slice(0, 80),
      status: String(event?.status || '').trim().slice(0, 40),
      ms: Number.isFinite(Number(event?.ms)) ? Math.max(0, Math.round(Number(event.ms))) : 0,
    }))
    .filter((event) => event.layer && event.status);
  const fallbackCount = captured.filter((event) =>
    ['fault', 'error', 'timeout'].includes(event.status)
  ).length;
  if (bufferIfRowNotReady(turn_id, () => recordEnrichmentHealth(turn_id, captured))) return;
  try {
    withTurnMetricBusyTimeout(() => {
      _db.prepare(`
        UPDATE chat_turn_metrics
        SET enrichment_fallback_count = ?,
            enrichment_health_json = ?
        WHERE turn_id = ?
      `).run(
        fallbackCount,
        jsonOrNull(captured),
        turn_id,
      );
    });
  } catch (err) {
    logFailure('recordEnrichmentHealth', turn_id, err);
  }
}

/**
 * Record an error path. Three taxonomy keys today: 'simulated_stall',
 * 'simulated_error', 'llm_error'. `recovery_path` captures what the client
 * was supposed to do (e.g. 'db_rehydrate'). UPDATE-only.
 */
export function recordError(turn_id, args = {}) {
  if (!turn_id) return;
  const completion_ms = Number.isFinite(args._completion_ms) ? args._completion_ms : Date.now();
  if (bufferIfRowNotReady(turn_id, () => recordError(turn_id, { ...args, _completion_ms: completion_ms }))) return;
  try {
    const { error_type, error_message = null, recovery_path = null } = args;
    withTurnMetricBusyTimeout(() => {
      _db.prepare(`
        UPDATE chat_turn_metrics
        SET error_type = ?,
            error_message = ?,
            recovery_path = ?,
            completion_ms = COALESCE(completion_ms, ?)
        WHERE turn_id = ?
      `).run(
        error_type || null,
        error_message,
        recovery_path,
        completion_ms,
        turn_id,
      );
    });
  } catch (err) {
    logFailure('recordError', turn_id, err);
  }
}
