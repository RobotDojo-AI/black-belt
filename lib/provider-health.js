/**
 * lib/provider-health.js — st_b57e6ec5
 *
 * Deterministic, read-only provider-health signal so the chat UI can, when
 * enabled, tell the customer honestly that the upstream AI provider is
 * erroring — instead of the wait reading as a Robot Dojo problem.
 *
 * WHY THERE IS NO LATENCY PATH (removed post-build, Bunshin gate FAIL):
 * The first cut of this module also read `chat_turn_metrics.ttft_ms` and
 * flagged 'degraded' on a sustained high average. ttft_ms is stamped
 * request_start_ms → first_token_ms (lib/observability/chat-turn.js), and
 * first_token_ms fires at the 'streaming' phase — AFTER Robot Dojo's entire
 * local pipeline (context assembly, memory search, tool calls) has already
 * run. It is TOTAL TURN latency, not provider latency. A bounded historical
 * replay showed ~5,337 of 12,913 rolling windows would have read
 * 'degraded: slow_first_token' with ZERO provider errors recorded in the
 * same window — that's local cold-start/context-build slowness, not
 * Anthropic. Shipping a "the AI service is slow" banner off that signal
 * would blame the provider for Robot Dojo's own latency, which inverts this
 * story's entire premise (owner: "we should communicate server-side issues
 * to the consumer so they don't blame us" — not fabricate blame the other
 * direction).
 *
 * No warmup `trigger_reason` is a clean isolated provider ping either —
 * every one (chat-cache-prewarm, fullturn-prewarm, speculative-ping,
 * boot-default-provider) does local work (context assembly, cache warming)
 * alongside the Anthropic call, so its latency is equally contaminated. A
 * trustworthy latency-based banner needs a DEDICATED, isolated Anthropic
 * health probe — a bare completion call with no local work riding along —
 * which is a separate, future story, not this one.
 *
 * WHAT SHIPS TODAY: the ERROR-ONLY path. `chat_turn_metrics.error_type` +
 * `warmup_events.error`, matched against Anthropic's overload/rate-limit/5xx
 * error shapes. This is a clean signal: an error recorded on either surface
 * came back from the provider (or the network path to it), never from local
 * compute. Even so, it ships FLAG-GATED OFF BY DEFAULT
 * (config/defaults.json `providerHealth.enabled`, env override
 * ROBOTDOJO_PROVIDER_HEALTH_ENABLED) — the historical overload-shaped error
 * volume is thin (36 of 843 warmup error rows, 0 of 101 chat_turn_metrics
 * error rows), so turning the customer-facing banner on is a deliberate
 * owner decision, not a silent default.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

let CONFIG_ENABLED = false;
let WINDOW_MS = 15 * 60 * 1000;
let MIN_OVERLOAD_ERRORS = 2;

try {
  const raw = readFileSync(resolve(homedir(), 'robotdojo', 'config', 'defaults.json'), 'utf8');
  const cfg = JSON.parse(raw)?.providerHealth;
  if (typeof cfg?.enabled === 'boolean') CONFIG_ENABLED = cfg.enabled;
  if (Number.isFinite(cfg?.windowMs) && cfg.windowMs > 0) WINDOW_MS = cfg.windowMs;
  if (Number.isFinite(cfg?.minOverloadErrors) && cfg.minOverloadErrors > 0) MIN_OVERLOAD_ERRORS = Math.floor(cfg.minOverloadErrors);
} catch {
  // No defaults.json or no providerHealth section — keep the safe built-ins
  // (enabled:false). This module must not crash chat because a config file
  // is missing.
}

if (process.env.ROBOTDOJO_PROVIDER_HEALTH_WINDOW_MS) {
  const v = Number(process.env.ROBOTDOJO_PROVIDER_HEALTH_WINDOW_MS);
  if (Number.isFinite(v) && v > 0) WINDOW_MS = v;
}
if (process.env.ROBOTDOJO_PROVIDER_HEALTH_MIN_OVERLOAD_ERRORS) {
  const v = Number(process.env.ROBOTDOJO_PROVIDER_HEALTH_MIN_OVERLOAD_ERRORS);
  if (Number.isFinite(v) && v > 0) MIN_OVERLOAD_ERRORS = Math.floor(v);
}

/** How far back the rolling window looks for overload-shaped error samples. */
export const PROVIDER_HEALTH_WINDOW_MS = WINDOW_MS;
/** Minimum overload-shaped errors in the window before the signal trips degraded (anti-single-fluke guard). */
export const PROVIDER_HEALTH_MIN_OVERLOAD_ERRORS = MIN_OVERLOAD_ERRORS;

/**
 * Whether the customer-facing degraded banner is turned on. Read from
 * config/defaults.json `providerHealth.enabled` (default false), overridable
 * per-call via ROBOTDOJO_PROVIDER_HEALTH_ENABLED — read at CALL time (not
 * module load), mirroring routes/chat.js's `qaSimulationAllowed()` pattern,
 * so flipping the env between requests works in tests without a module
 * reload and an ops flip doesn't need a server restart to take effect on
 * the next request.
 *
 * @returns {boolean}
 */
export function isProviderHealthEnabled() {
  const raw = process.env.ROBOTDOJO_PROVIDER_HEALTH_ENABLED;
  if (raw != null && raw !== '') {
    return /^(1|true|yes)$/i.test(String(raw).trim());
  }
  return CONFIG_ENABLED;
}

// Anthropic's overload/rate-limit/5xx error shapes. Matched against the raw
// SDK error message already recorded in chat_turn_metrics.error_message /
// warmup_events.error — no new classification write, just a read-time regex.
const OVERLOAD_PATTERN = /overloaded|rate.?limit|too many requests|529|503|502|service unavailable|capacity/i;

/** The honest, calm, plain-English message shown in the chat UI when degraded. */
export const PROVIDER_DEGRADED_MESSAGE = 'AI service responding slowly right now — replies may take longer than usual.';

/**
 * Compute the current provider-health verdict from recent observability
 * rows. Two indexed SELECTs (chat_turn_metrics.request_start_ms and
 * warmup_events.started_at are both indexed), each bounded to the rolling
 * window and filtered to error rows only — no full-table scan, no write, no
 * LLM call. Latency is intentionally NOT read here (see module doc).
 *
 * Always computes the real signal regardless of isProviderHealthEnabled() —
 * callers decide whether to act on it (routes/chat.js gates the
 * customer-facing frame on the flag; lib/server.js reports the read
 * unconditionally for ops visibility, tagged with `enabled`).
 *
 * @param {object} db - better-sqlite3 handle
 * @param {object} [opts]
 * @param {number} [opts.now] - epoch ms "now", injectable for tests
 * @param {string} [opts.provider='anthropic']
 * @returns {{
 *   status: 'ok'|'degraded',
 *   reason: 'overload_errors'|null,
 *   overload_error_count: number,
 *   window_ms: number,
 *   min_overload_errors: number,
 *   checked_at: string,
 * }}
 */
export function getProviderHealth(db, { now = Date.now(), provider = 'anthropic' } = {}) {
  const since = now - WINDOW_MS;
  let overloadCount = 0;

  try {
    const turnRows = db.prepare(`
      SELECT error_message
      FROM chat_turn_metrics
      WHERE provider_name = ?
        AND operation_name = 'chat'
        AND request_start_ms >= ?
        AND error_type = 'llm_error'
    `).all(provider, since);
    for (const row of turnRows) {
      if (OVERLOAD_PATTERN.test(row.error_message || '')) overloadCount++;
    }
  } catch {
    // Table missing (fresh/test DB) or a transient read error — treat as
    // "no signal from this source", never throw. Provider health must not
    // be able to break the chat turn it is trying to describe.
  }

  try {
    const warmupRows = db.prepare(`
      SELECT error
      FROM warmup_events
      WHERE provider = ?
        AND started_at >= ?
        AND error IS NOT NULL
    `).all(provider, since);
    for (const row of warmupRows) {
      if (OVERLOAD_PATTERN.test(row.error || '')) overloadCount++;
    }
  } catch {
    // Same tolerance as above.
  }

  const status = overloadCount >= MIN_OVERLOAD_ERRORS ? 'degraded' : 'ok';
  const reason = status === 'degraded' ? 'overload_errors' : null;

  return {
    status,
    reason,
    overload_error_count: overloadCount,
    window_ms: WINDOW_MS,
    min_overload_errors: MIN_OVERLOAD_ERRORS,
    checked_at: new Date(now).toISOString(),
  };
}

/**
 * Plain-English message for a degraded signal. Returns null when the
 * signal is 'ok' — callers use null as "do not show a banner", never an
 * empty string (keeps the falsy check unambiguous at call sites).
 *
 * @param {{status: string}} signal - the object getProviderHealth() returns
 * @returns {string|null}
 */
export function providerHealthMessage(signal) {
  if (!signal || signal.status !== 'degraded') return null;
  return PROVIDER_DEGRADED_MESSAGE;
}
