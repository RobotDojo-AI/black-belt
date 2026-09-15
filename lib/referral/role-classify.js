/**
 * lib/referral/role-classify.js — st_b879a361
 *
 * classifyRole(title, companyType) → { bucket, priority }
 *
 * Dispatches on companyType ∈ {'startup','bigTech','vc'}. Unknown / null
 * companyType falls back to startup ontology (most permissive — many people
 * have unknown employer domains but still hold classifiable titles).
 *
 * Algorithm:
 *   1. If title is null/empty/whitespace → return excluded.
 *   2. If EXCLUDED_PATTERNS matches → return excluded (function-first).
 *   3. Walk buckets in priority order: founder, c-level, vp, engineering,
 *      design, business. First-pattern-match wins.
 *   4. No match in any bucket → return excluded.
 *
 * Note on overlap: 'Senior Product Manager' would match BOTH the
 * 'Senior Product Manager' business pattern AND a vp pattern in big-tech
 * (`(?:Senior|Group)\s+(?:Product\s+)?Manager\b` is in business). Bucket
 * order chooses the first bucket whose pattern fires — business comes
 * AFTER vp, so vp wins only if a vp-only pattern fires first. For "Senior
 * Product Manager" in big-tech the business bucket wins because no vp
 * pattern matches.
 */

import { ROLE_PATTERNS, EXCLUDED_PATTERNS, BUCKET_PRIORITY } from './ontologies.js';

const BUCKET_ORDER = ['founder', 'c-level', 'vp', 'engineering', 'design', 'business'];

/**
 * @param {string|null|undefined} title
 * @param {'startup'|'bigTech'|'vc'|'unknown'|null|undefined} companyType
 * @returns {{ bucket: 'founder'|'c-level'|'vp'|'engineering'|'design'|'business'|'excluded', priority: number }}
 */
export function classifyRole(title, companyType) {
  const t = (title || '').trim();
  if (!t) return { bucket: 'excluded', priority: BUCKET_PRIORITY.excluded };

  // Function-first exclusion: marketing / CS / HR / recruiting / PR / comms.
  for (const pat of EXCLUDED_PATTERNS) {
    if (pat.test(t)) return { bucket: 'excluded', priority: BUCKET_PRIORITY.excluded };
  }

  // Dispatch to the per-type ontology. Unknown falls back to startup.
  const ontology = ROLE_PATTERNS[companyType] || ROLE_PATTERNS.startup;

  for (const bucket of BUCKET_ORDER) {
    const patterns = ontology[bucket] || [];
    for (const pat of patterns) {
      if (pat.test(t)) {
        return { bucket, priority: BUCKET_PRIORITY[bucket] };
      }
    }
  }

  return { bucket: 'excluded', priority: BUCKET_PRIORITY.excluded };
}
