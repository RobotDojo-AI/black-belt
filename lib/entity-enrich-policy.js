/**
 * lib/entity-enrich-policy.js
 *
 * st_b50005df Phase 4 — the single decision point for "should entity enrichment
 * run right now?".
 *
 * THE PRODUCT DEFAULT IS ON. Entity enrichment is Black-Belt-gated by design
 * (paid feature, the customer's own API keys). Launch starts every customer on a
 * Black Belt trial, so a new customer's chat is deep from session one BECAUSE
 * enrichment fires by default the moment BB is active. That is the whole point
 * of Phase 4: "everyone starts Black Belt, must be awesome."
 *
 * THE OWNER-BOX OPT-OUT IS EXPLICIT, NOT THE DEFAULT. Enrichment was disabled
 * only on the owner's development machine to avoid re-spending Haiku budget on a
 * ~18.6k-entity history that is already enriched. That is a LOCAL override the
 * owner opts into, not the shipped behavior. It is expressed as a single env
 * flag (ROBOTDOJO_ENRICH_OWNER_BOX_DISABLED=1). When the flag is absent — the
 * shipped state — enrichment runs under BB. When the flag is set, enrichment
 * pauses on that one box and says so plainly. Nothing in the product code path
 * disables enrichment by default.
 *
 * This module holds ZERO I/O and ZERO LLM calls — it is a pure predicate over
 * (bbActive, env) so it is trivially testable and cannot itself trigger spend.
 * BB-activeness is resolved by the caller (lib/cohort/active.js isBBActive) and
 * passed in; this module never re-derives entitlement.
 */

// The explicit, opt-in, owner-box-only env flag. Absent in the shipped product.
export const OWNER_BOX_ENRICH_OPT_OUT_ENV = 'ROBOTDOJO_ENRICH_OWNER_BOX_DISABLED';

/**
 * Is the owner-box opt-out explicitly set? Only the literal '1' counts so a
 * stray empty-string export does not accidentally disable a customer's
 * enrichment. This is the ONLY thing that turns enrichment off while BB is
 * active.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isOwnerBoxEnrichmentDisabled(env = process.env) {
  return env[OWNER_BOX_ENRICH_OPT_OUT_ENV] === '1';
}

/**
 * The product decision: should entity enrichment run?
 *
 * Truth table (this IS the Phase 4 contract):
 *   bbActive=false                          -> OFF  (reason 'bb_inactive')
 *   bbActive=true,  opt-out absent (default) -> ON   (the shipped default)
 *   bbActive=true,  opt-out set ('1')        -> OFF  (reason 'owner_box_opt_out')
 *
 * @param {{ bbActive: boolean, env?: NodeJS.ProcessEnv }} args
 * @returns {{ enabled: boolean, reason: string }}
 */
export function enrichmentDecision({ bbActive, env = process.env }) {
  if (!bbActive) {
    return { enabled: false, reason: 'bb_inactive' };
  }
  if (isOwnerBoxEnrichmentDisabled(env)) {
    // The ONLY off-switch while BB is active, and it is explicit + local.
    return { enabled: false, reason: 'owner_box_opt_out' };
  }
  // Default: Black Belt is active and no explicit opt-out — enrichment runs.
  return { enabled: true, reason: 'bb_active_default_on' };
}

/**
 * Boolean convenience wrapper for callers that only need the gate result.
 *
 * @param {{ bbActive: boolean, env?: NodeJS.ProcessEnv }} args
 * @returns {boolean}
 */
export function isEnrichmentEnabled(args) {
  return enrichmentDecision(args).enabled;
}
