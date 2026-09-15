/**
 * network-classify.js — import compatibility stub.
 *
 * backfillClassifications is the BB-only LLM classification backfill.
 * Phase 5 (05-score.js) unconditionally overwrites N1 for all people
 * using origin-based rules (work domain → Professional, iMessage-only → Personal).
 *
 * WHY this stub returns empty stats: the real implementation lives in the
 * encrypted BB module. On WB installs (or when BB module is absent), Phase 4
 * calls this and gets a no-op. Phase 5 does the real N1 assignment via
 * deterministic origin rules — no LLM needed.
 *
 * WHY not throw: callers wrap this in try/catch and log "Classification skipped".
 * Returning empty stats is more informative than throwing — the caller can
 * distinguish "BB absent" from an actual error.
 */
export async function backfillClassifications(opts = {}) {
  return { classified: 0, skipped: 0, llmUsed: 0 };
}
