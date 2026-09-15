/**
 * MECE Topic Taxonomy — generic defaults (ships with the repo).
 *
 * SINGLE SOURCE OF TRUTH: `config/taxonomy.default.json`. This module derives
 * `DEFAULT_TIERS` from that JSON so the in-memory taxonomy (TIERS, TOPIC_LABELS,
 * classification description signal) and the DB seed (`syncTaxonomyToDb`) always
 * agree. Previously this file hard-coded a *different* T2 set (technical/writing/
 * projects) than the JSON seed (career/current-role/side-projects), so the DB and
 * the in-memory lookups disagreed and topic classification had no description
 * signal. st_fcdbe84f WS1.
 *
 * These are the out-of-the-box topics a new Black Belt user sees. Users override
 * them by writing `~/robotdojo/config/taxonomy.user.json` (see `lib/taxonomy.js`).
 *
 * Design rules:
 *   - No user-specific data (no real employer names, schools, children) ships in
 *     the default. Specific roles/degrees/hobbies are shaped onto these generic
 *     slots from the user's own data at runtime (WS4), never committed here.
 *   - Topic hierarchy is exactly two tiers: T1 (parent) and T2 (child).
 *   - Ambiguous intake goes to the hidden Uncategorized root, not Personal.
 *   - A user's override file can add, remove, or relabel T2 topics within a T1
 *     tier but cannot change T1 tier identity.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { UNKNOWN_TOPIC_PAIR } from './topic-routing-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TAXONOMY_PATH = resolve(__dirname, '../config/taxonomy.default.json');

// Fallback T1 icons when a tier omits one in the JSON.
const TIER_ICONS = {
  work: 'work',
  family: 'home',
  personal: 'person',
  education: 'school',
  newsletters: 'rss_feed',
  uncategorized: 'inbox',
};

/**
 * Build DEFAULT_TIERS from config/taxonomy.default.json. Tier `group` is the
 * insertion order (0-based); `slug` is the lower-cased tier name. Each T2 maps
 * its `description` → `desc` (the field both the DB seed and classification read).
 */
function buildDefaultTiers() {
  const json = JSON.parse(readFileSync(DEFAULT_TAXONOMY_PATH, 'utf8'));
  const tiers = {};
  let group = 0;
  for (const [tierName, tier] of Object.entries(json)) {
    const slug = tierName.toLowerCase();
    const topics = {};
    for (const [tslug, t] of Object.entries(tier.topics || {})) {
      topics[tslug] = {
        label: t.label,
        desc: t.description || t.desc || '',
        ...(t.icon ? { icon: t.icon } : {}),
        ...(t.sort_order != null ? { sort_order: t.sort_order } : {}),
        ...(t.hidden ? { hidden: true } : {}),
      };
    }
    tiers[tierName] = {
      group: group++,
      slug,
      icon: tier.icon || TIER_ICONS[slug] || 'folder',
      // st_2d941f89 (gap 3) — optional T1 label override. Every tier defaults
      // to its own JSON key as the label (unchanged behavior); only
      // "Uncategorized" sets an explicit `label` ("Unfiled") so the SLUG
      // (derived from the key, above) stays 'uncategorized' — untouched,
      // matching lib/topic-routing-policy.js's UNCATEGORIZED_T1 — while the
      // DISPLAY text changes. See lib/topic-routing-policy.js's
      // UNCATEGORIZED_LABEL WHY comment for the full rationale.
      label: tier.label || tierName,
      ...(tier.description ? { description: tier.description } : {}),
      ...(tier.hidden ? { hidden: true } : {}),
      topics,
    };
  }
  return tiers;
}

export const DEFAULT_TIERS = buildDefaultTiers();

/**
 * Default doc_type → T1/T2 mapping used for the INITIAL placement of a dropped
 * file before classification (CLS-B) re-homes it. Ambiguous defaults use
 * Uncategorized with no T2. User overrides live in
 * ~/robotdojo/config/taxonomy.user.json under the "docTypeMap" key;
 * topicForDocType() in taxonomy.js resolves the merged result.
 */
export const DEFAULT_DOC_TYPE_MAP = {
  'tax_return':           { t1: 'family',   t2: 'finances' },
  'utility_bill':         { t1: 'family',   t2: 'home' },
  'lease':                { t1: 'family',   t2: 'home' },
  'mortgage':             { t1: 'family',   t2: 'home' },
  'insurance_policy':     { t1: 'family',   t2: 'home' },
  'id_document':          { t1: 'family',   t2: 'home' },
  'vehicle_registration': { t1: 'family',   t2: 'home' },
  'receipt':              { t1: 'family',   t2: 'finances' },
  'receipts_csv':         { t1: 'family',   t2: 'finances' },
  'financial_statement':  { t1: 'family',   t2: 'finances' },
  'legal_doc':            { t1: 'family',   t2: 'home' },
  'lab_report':           { t1: 'personal', t2: 'health' },
  'medical_record':       { t1: 'personal', t2: 'health' },
  'health_export':        { t1: 'personal', t2: 'health' },
  // People/network data: entities own people. Until a sharper topic exists,
  // keep the source in the explicit routing queue instead of Personal.
  'contacts_csv':         UNKNOWN_TOPIC_PAIR,
  'linkedin_export':      UNKNOWN_TOPIC_PAIR,
  'photo':                UNKNOWN_TOPIC_PAIR,
  'document':             UNKNOWN_TOPIC_PAIR,
  'csv':                  UNKNOWN_TOPIC_PAIR,
  'email':                UNKNOWN_TOPIC_PAIR,
  'email_mbox':           UNKNOWN_TOPIC_PAIR,
  'email_archive':        UNKNOWN_TOPIC_PAIR,
  'archive':              UNKNOWN_TOPIC_PAIR,
  'llm_export':           UNKNOWN_TOPIC_PAIR,
  'google_takeout':       UNKNOWN_TOPIC_PAIR,
  'other':                UNKNOWN_TOPIC_PAIR,
  // User-specific work docs default to work/side-projects; override in docTypeMap.
  'agency_xlsx':          { t1: 'work',     t2: 'side-projects' },
};
