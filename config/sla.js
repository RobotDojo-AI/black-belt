/**
 * SLA constants and assertion helper for chat TTFT (st_24c158ae).
 *
 * Single source of truth for the warm/cold TTFT bounds enforced across all
 * chat-path tests. Production relay measurement fixes Ask/warm ≤3000ms and
 * cold ≤4000ms; this module turns those values into a runtime contract the
 * tests can fail against.
 *
 * WHY a helper instead of an inline literal:
 *   - One place to change the bound — no grep-and-replace across N test files
 *   - Tests can override via env var (ROBOTDOJO_SLA_OVERRIDE_*_MS) to prove
 *     the bound is read at call time, not module load — guards against the
 *     "test imports the helper but also hardcodes a literal" anti-pattern
 *   - Throws a diagnostic with both elapsed and bound — failure messages are
 *     self-explanatory without grepping
 *
 * WHY override env reads happen at call time, not module load:
 *   The behavioral spec (tests/specs/st_24c158ae.test.js) needs to import this
 *   module, then mutate the env var, then call assertTTFT() and observe the
 *   new bound. If the values were resolved at module-load time, the mutation
 *   would have no effect — the spec would see stale bounds and silently fail
 *   to test the override. Reading process.env on every call is cheap and makes
 *   the behavioral contract truthful.
 */

export const WARM_TTFT_MS = 3000;
export const COLD_TTFT_MS = 4000;
export const CONTEXT_TTFT_MS = 6000;
export const DEEP_TTFT_MS = 12000;

export function formatDurationSeconds(ms) {
  const value = Number(ms);
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const rounded = Math.round(safe / 100) / 10;
  return `${(safe > 0 ? Math.max(0.1, rounded) : 0).toFixed(1)}s`;
}

/**
 * Resolve the bound for a kind ('warm' or 'cold') at call time.
 * Env override (ROBOTDOJO_SLA_OVERRIDE_WARM_MS / _COLD_MS) takes precedence.
 */
function boundFor(kind) {
  if (kind === 'warm') {
    const override = process.env.ROBOTDOJO_SLA_OVERRIDE_WARM_MS;
    if (override !== undefined && override !== '') {
      const n = Number(override);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return WARM_TTFT_MS;
  }
  if (kind === 'cold') {
    const override = process.env.ROBOTDOJO_SLA_OVERRIDE_COLD_MS;
    if (override !== undefined && override !== '') {
      const n = Number(override);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return COLD_TTFT_MS;
  }
  if (kind === 'context') {
    const override = process.env.ROBOTDOJO_SLA_OVERRIDE_CONTEXT_MS;
    if (override !== undefined && override !== '') {
      const n = Number(override);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return CONTEXT_TTFT_MS;
  }
  if (kind === 'deep') {
    const override = process.env.ROBOTDOJO_SLA_OVERRIDE_DEEP_MS;
    if (override !== undefined && override !== '') {
      const n = Number(override);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return DEEP_TTFT_MS;
  }
  throw new Error(`assertTTFT: invalid kind '${kind}' — must be 'warm', 'cold', 'context', or 'deep'`);
}

/**
 * Throw iff elapsed > bound for the named kind. Diagnostic includes both the
 * measured elapsed and the bound used so failure messages are self-contained.
 *
 * @param {number} elapsedMs - measured TTFT in milliseconds
 * @param {'warm'|'cold'|'context'|'deep'} kind - which SLA to enforce
 */
export function assertTTFT(elapsedMs, kind) {
  const bound = boundFor(kind);
  if (elapsedMs > bound) {
    throw new Error(`TTFT ${formatDurationSeconds(elapsedMs)} exceeds ${kind} SLA ${formatDurationSeconds(bound)}`);
  }
}
