/**
 * MECE Topic Taxonomy — Black Belt feature.
 *
 * Five T1 tiers: Work, Family, Personal, Education, Newsletters.
 * Mutually exclusive at T1 level. Multiple T2s allowed within a single T1.
 *
 * White Belt users manage their own flat topic list (user_topics table).
 * Black Belt users get this smart hierarchical framework.
 *
 * ARCHITECTURE
 *   Ships with a generic default (`./taxonomy-default.js`) — zero user data.
 *   On load, merges with the user's override file at
 *   `~/robotdojo/config/taxonomy.user.json` (local only, never committed).
 *
 *   User overrides can seed T1/T2 topics on first import.
 *   The user file shape mirrors DEFAULT_TIERS:
 *
 *     {
 *       "Work":   { "topics": { "current":  { "label": "...", "desc": "..." } } },
 *       "Family": { "topics": { "my-child": { "label": "...", "desc": "..." } } }
 *     }
 *
 *   After a row exists in user_topics, runtime edits live in the database.
 *   This file is bootstrap/import substrate, not the live source of truth.
 */

import { homedir } from 'node:os';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TIERS, DEFAULT_DOC_TYPE_MAP } from './taxonomy-default.js';
import { topicPairForDocTypeMap } from './topic-routing-policy.js';

const USER_TAXONOMY_PATH = process.env.ROBOTDOJO_TAXONOMY_PATH
  || resolve(homedir(), 'robotdojo', 'config', 'taxonomy.user.json');

// Default taxonomy scaffold for fresh installs — generic structure with no owner data.
// Loaded when user file is missing or has no visible T2 topics.
const DEFAULT_TAXONOMY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'taxonomy.default.json');

function loadDefaultTaxonomy() {
  if (!existsSync(DEFAULT_TAXONOMY_PATH)) return null;
  try {
    return JSON.parse(readFileSync(DEFAULT_TAXONOMY_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[taxonomy] failed to parse default taxonomy: ${err.message}`);
    return null;
  }
}

function loadUserOverride() {
  // Read env var at call time so ROBOTDOJO_TAXONOMY_PATH set after module load is honoured
  // (module cache reuse across test files would otherwise bake in the wrong path).
  const path = process.env.ROBOTDOJO_TAXONOMY_PATH
    || resolve(homedir(), 'robotdojo', 'config', 'taxonomy.user.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.warn(`[taxonomy] failed to parse ${path}: ${err.message} — using defaults only`);
    return null;
  }
}

function isGeneratedTestTopicSlug(slug) {
  return /^(qa-|e2e|test-|t2-scope)/.test(String(slug || ''));
}

function isDeprecatedRoutingTopic(tierName, slug) {
  return tierName === 'Uncategorized' && slug === 'needs-routing';
}

function mergeTiers(defaults, userOverride) {
  if (!userOverride) return defaults;
  const merged = {};
  for (const [tierName, tierDef] of Object.entries(defaults)) {
    const userTier = userOverride[tierName] || {};
    const userTopics = userTier.topics || {};
    // Start with default topics; layer user topics on top; strip marked-deleted.
    const topics = { ...tierDef.topics };
    for (const [slug, meta] of Object.entries(userTopics)) {
      if (isGeneratedTestTopicSlug(slug)) continue;
      if (isDeprecatedRoutingTopic(tierName, slug)) continue;
      if (meta && meta._delete === true) { delete topics[slug]; continue; }
      topics[slug] = meta;
    }
    merged[tierName] = {
      ...tierDef,
      ...(userTier.hidden !== undefined ? { hidden: userTier.hidden } : {}),
      topics,
    };
  }
  // Allow user to add net-new T1 tiers (rare, but legal).
  for (const [tierName, userTier] of Object.entries(userOverride)) {
    if (!merged[tierName]) merged[tierName] = userTier;
  }
  return merged;
}

const _userOverride = loadUserOverride();
export const TIERS = mergeTiers(DEFAULT_TIERS, _userOverride);

/**
 * Merged doc_type → {t1, t2} map. Generic defaults from taxonomy-default.js;
 * user-specific overrides from ~/robotdojo/config/taxonomy.user.json "docTypeMap".
 */
export const DOC_TYPE_MAP = Object.assign({}, DEFAULT_DOC_TYPE_MAP, _userOverride?.docTypeMap || {});

/** Look up T1/T2 for a doc_type string. Falls back to childless Uncategorized. */
export function topicForDocType(docType) {
  return topicPairForDocTypeMap(DOC_TYPE_MAP, docType);
}

// --- Derived lookups ---

export const TOPIC_TO_TIER = {};
export const TOPIC_LABELS = {};
export const LABEL_TO_SLUG = {};
export const TIER_TOPICS = {};
export const ALL_TOPICS = [];

for (const [tier, tierConfig] of Object.entries(TIERS)) {
  TIER_TOPICS[tier] = [];
  TOPIC_TO_TIER[tierConfig.slug] = tier;

  for (const [slug, meta] of Object.entries(tierConfig.topics || {})) {
    TOPIC_TO_TIER[slug] = tier;
    TOPIC_LABELS[slug] = meta.label;
    LABEL_TO_SLUG[meta.label] = slug;
    TIER_TOPICS[tier].push(slug);
    ALL_TOPICS.push(slug);
  }
}

// --- Taxonomy write-back ---

/**
 * T1 slug → T1 label map derived from DEFAULT_TIERS (e.g. { work: 'Work', family: 'Family' }).
 * Used by writeTaxonomyUserJson to find the correct tier key for a T2 topic's parent_slug.
 */
export const SLUG_TO_TIER = Object.fromEntries(
  Object.entries(DEFAULT_TIERS).map(([name, def]) => [def.slug, name])
);

/**
 * Atomically write an updated taxonomy.user.json.
 *
 * updaterFn receives a deep clone of the current file and must return the modified
 * object. Writes to a .tmp file then renames (POSIX atomic). Synchronous — safe
 * to call from synchronous route handlers.
 *
 * Silently no-ops if the file does not exist yet and updaterFn returns null.
 *
 * @param {(taxonomy: object) => object} updaterFn
 */
export function writeTaxonomyUserJson(updaterFn) {
  const current = loadUserOverride() || {};
  const updated = updaterFn(JSON.parse(JSON.stringify(current)));
  if (updated == null) return;
  const tmp = USER_TAXONOMY_PATH + '.tmp';
  mkdirSync(dirname(USER_TAXONOMY_PATH), { recursive: true });
  writeFileSync(tmp, JSON.stringify(updated, null, 2), { mode: 0o600 });
  renameSync(tmp, USER_TAXONOMY_PATH);
}

// --- DB sync ---

// T1 tier icons (not stored in taxonomy JSON — derived here for upserts).
const TIER_ICONS = {
  work: 'work',
  family: 'home',
  personal: 'person',
  education: 'school',
  newsletters: 'rss_feed',
  uncategorized: 'inbox',
};

/**
 * Seed taxonomy.user.json → user_topics table.
 *
 * Called from db.js at boot. Idempotent and create-missing-only: once a row
 * exists in user_topics, user edits to label, description, icon, hierarchy,
 * order, and visibility must survive restart.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function syncTaxonomyToDb(db) {
  let override = loadUserOverride();

  // Fallback: if no user file exists, seed from the default scaffold.
  // This gives fresh BB users a starting topic structure without requiring manual setup.
  // The scaffold has no owner-specific data (config/taxonomy.default.json).
  // WHY only on missing file: if the user file exists, trust it as-is — the user may
  // have intentionally cleared some tiers. We never silently overwrite user config.
  if (!override) {
    const defaultTax = loadDefaultTaxonomy();
    if (!defaultTax) return;
    console.info('[taxonomy] no user taxonomy file — seeding from taxonomy.default.json');
    override = defaultTax;
  }

  // T1: seed tier root rows. Existing rows are live runtime state.
  const upsertT1 = db.prepare(`
    INSERT INTO user_topics (slug, label, description, icon, sort_order, parent_slug, visible, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, NULL, ?, datetime('now'), datetime('now'))
    ON CONFLICT(slug) DO NOTHING
  `);

  // T2: seed user-specified topics without overwriting existing runtime rows.
  const upsertT2 = db.prepare(`
    INSERT INTO user_topics (slug, label, description, icon, sort_order, parent_slug, visible, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(slug) DO NOTHING
  `);

  db.transaction(() => {
    for (const [tierName, userTier] of Object.entries(override)) {
      // Match override key to a DEFAULT_TIERS entry to get slug + group number.
      const defaultEntry = Object.entries(DEFAULT_TIERS).find(([k]) => k === tierName);
      if (!defaultEntry) continue;
      const [, defaultTier] = defaultEntry;
      const tierHidden = userTier.hidden === true || defaultTier.hidden === true;
      // st_2d941f89 (gap 3) — prefer the DEFAULT tier's label override
      // (defaultTier.label, e.g. "Unfiled" for Uncategorized) over the raw
      // override-file key so a user override that only sets `icon`/`hidden`
      // on a tier never silently reverts its display label back to the JSON
      // key. Every other tier has no override, so defaultTier.label === its
      // own tierName — zero behavior change there.
      upsertT1.run(defaultTier.slug, defaultTier.label || tierName, userTier.icon || TIER_ICONS[defaultTier.slug] || 'folder', defaultTier.group ?? 99, tierHidden ? 0 : 1);
      let order = 0;
      for (const [slug, meta] of Object.entries(userTier.topics || {})) {
        if (isGeneratedTestTopicSlug(slug)) continue;
        if (isDeprecatedRoutingTopic(tierName, slug)) continue;
        if (meta._delete === true) continue;
        const isHidden = meta.hidden === true || meta._hidden === true;
        // Use explicit sort_order if present in JSON (written by writeTaxonomyUserJson on reorder);
        // fall back to position order for entries that predate write-back.
        const sortOrder = meta.sort_order != null ? meta.sort_order : ++order;
        upsertT2.run(
          slug,
          meta.label,
          meta.desc || meta.description || null,
          meta.icon || null,
          sortOrder,
          defaultTier.slug,
          isHidden ? 0 : 1,
        );
      }
    }
  })();
}

// --- Migration helpers ---

/**
 * Generate a skeleton user override file from current DB state. Writes
 * `~/robotdojo/config/taxonomy.user.json` if it does not exist. Callers pass
 * a `db` handle; we read conversation tags to seed per-user topics.
 *
 * This is idempotent — it never overwrites an existing file. The user must
 * run this explicitly; Ori does not auto-regenerate user data.
 */
export function generateUserTaxonomyFromDb(db) {
  if (existsSync(USER_TAXONOMY_PATH)) {
    return { created: false, reason: 'already-exists', path: USER_TAXONOMY_PATH };
  }
  const tags = db.prepare(
    "SELECT DISTINCT json_each.value as tag FROM conversations, json_each(conversations.tags) WHERE json_each.value != '' AND conversations.deleted_at IS NULL LIMIT 500"
  ).all().map(r => r.tag).filter(t => !/^(import-|[0-9a-f]{8}-)/.test(t));
  // Bucket into tiers by simple keyword heuristics — the user edits the file
  // manually to refine. We never invent real names; just pass tags through.
  const override = { Work: { topics: {} }, Family: { topics: {} }, Personal: { topics: {} } };
  for (const tag of tags) {
    const slug = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug || DEFAULT_TIERS.Work.topics[slug] || DEFAULT_TIERS.Family.topics[slug] || DEFAULT_TIERS.Personal.topics[slug]) continue;
    // Default unknown tags to Work; user can re-bucket.
    override.Work.topics[slug] = { label: tag, desc: '' };
  }
  mkdirSync(dirname(USER_TAXONOMY_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(USER_TAXONOMY_PATH, JSON.stringify(override, null, 2), { mode: 0o600 });
  return { created: true, path: USER_TAXONOMY_PATH, topics_seeded: Object.keys(override.Work.topics).length };
}
