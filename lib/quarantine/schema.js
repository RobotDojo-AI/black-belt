/**
 * schema.js — action enum + decision-shape validator for smart-quarantine.
 *
 * WHY a separate module: the action enum is the load-bearing security boundary.
 * Cursor CVE GHSA-82wg-qcm4-fp2w showed that single-layer (LLM-only) enforcement
 * fails — the model can be coaxed into proposing actions outside the schema.
 * We enforce in TWO layers: this exported set is consumed by both the LLM tool
 * schema (lib/quarantine/tier-1/llm-schema.js) AND the executor's allowlist guard
 * (lib/quarantine/executor.js). Single source of truth → no drift between layers.
 */

export const ALLOWED_ACTIONS = Object.freeze(['fix-code', 'move-to-canonical', 'quarantine']);

/**
 * validateDecision — defense-in-depth check before executor dispatch.
 *
 * Returns { ok: true } or { ok: false, error: '<reason>' }.
 * Required fields per the LLM tool schema: file, what_it_is, intent, action,
 * destination, confidence, reason. The classifier may also include warnings (array).
 *
 * NOT a substitute for the executor's ALLOWED_ACTIONS guard — both layers run.
 */
export function validateDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    return { ok: false, error: 'decision must be an object' };
  }
  const required = ['file', 'action', 'destination'];
  for (const key of required) {
    if (typeof decision[key] !== 'string' || decision[key].length === 0) {
      return { ok: false, error: `missing or empty field: ${key}` };
    }
  }
  if (!ALLOWED_ACTIONS.includes(decision.action)) {
    return { ok: false, error: `action not in ALLOWED_ACTIONS: ${decision.action}` };
  }
  if (decision.confidence !== undefined) {
    if (typeof decision.confidence !== 'number' || decision.confidence < 0 || decision.confidence > 1) {
      return { ok: false, error: `confidence must be 0..1, got: ${decision.confidence}` };
    }
  }
  return { ok: true };
}
