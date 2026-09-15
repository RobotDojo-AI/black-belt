// Central policy for ambiguous topic placement.
//
// "Personal" is a real scope, not the system's junk drawer. Ambiguous data
// lands in the hidden Uncategorized root until classification or recalc can
// move it to a sharper topic.

export const UNCATEGORIZED_T1 = 'uncategorized';
export const NEEDS_ROUTING_T2 = 'needs-routing';
export const NEEDS_ROUTING_TOPIC = UNCATEGORIZED_T1;
export const PERSONAL_TOPIC = 'personal';

// st_2d941f89 (gap 3) — the owner-confirmed DISPLAY label for the catch-all,
// distinct from the real "personal" topic label so unfiled content reads as
// "not yet filed," not as a second personal bucket. This is a LABEL change
// only — the routing SLUG stays UNCATEGORIZED_T1 ('uncategorized') everywhere;
// renaming the slug itself would be a live chunk-topic data migration (the
// UNIQUE(topic, source_type, source_id, chunk_index) constraint + every
// existing `topic = 'uncategorized'` reference across the routing/reclassify
// pipeline), which is explicitly out of scope for a code-only change and is
// the owner-run migration this story separates out. Single source of truth
// for the label string: lib/db.js's seed migrations and lib/taxonomy.js's
// default-tier sync both read this constant so a fresh install's T1 row and
// any owner-run relabel of an existing install agree on the exact text.
export const UNCATEGORIZED_LABEL = 'Unfiled';

export const UNKNOWN_TOPIC_PAIR = Object.freeze({
  t1: UNCATEGORIZED_T1,
  t2: null,
});

export const UNKNOWN_TOPIC_ALIASES = new Set([
  '',
  'general',
  'other',
  'misc',
  'miscellaneous',
  'unknown',
  'unclassified',
  NEEDS_ROUTING_T2,
  'personal/learning',
]);

export const IMPORT_TAG_PREFIXES = Object.freeze([
  'import-',
]);

export const PERSONAL_SCOPE_REVIEW_SOURCE_TYPES = Object.freeze([
  'llm_export',
  'drive',
  'transcript',
  'file',
  'document',
  'drop_folder_file',
]);

export const ROUTING_QUEUE_DOC_TYPES = Object.freeze([
  'archive',
  'contacts_csv',
  'csv',
  'document',
  'drive',
  'drop_folder_file',
  'email',
  'email_archive',
  'email_mbox',
  'file',
  'google_takeout',
  'linkedin_export',
  'llm_export',
  'other',
  'transcript',
]);

export const NON_CLASSIFIABLE_TOPIC_SLUGS = Object.freeze([
  'canary-test-row',
  'tool-child',
  'tool-parent',
  UNCATEGORIZED_T1,
  NEEDS_ROUTING_T2,
]);

export const NON_CLASSIFIABLE_TOPIC_PREFIXES = Object.freeze([
  'qa-persist-',
  'qa-probe-',
  'qa-rename-modal-',
]);

export const NON_CLASSIFIABLE_ROOT_SLUGS = Object.freeze([
  'projects',
  'technical',
  'work',
  'family',
  'personal',
  'education',
  'newsletters',
  UNCATEGORIZED_T1,
]);

export function unknownTopicPair() {
  return { ...UNKNOWN_TOPIC_PAIR };
}

export function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isImportTag(value) {
  const slug = normalizeSlug(value);
  return IMPORT_TAG_PREFIXES.some((prefix) => slug.startsWith(prefix))
    || slug === 'local-chat-transcript';
}

export function personalScopeNeedsRoutingSourceType(value) {
  const sourceType = String(value || '').trim().toLowerCase();
  return PERSONAL_SCOPE_REVIEW_SOURCE_TYPES.includes(sourceType);
}

export function docTypeRequiresRoutingQueue(value) {
  const docType = String(value || '').trim().toLowerCase();
  return ROUTING_QUEUE_DOC_TYPES.includes(docType);
}

export function topicSlugIsClassifiable(value) {
  const slug = normalizeSlug(value);
  if (!slug) return false;
  if (NON_CLASSIFIABLE_TOPIC_SLUGS.includes(slug)) return false;
  return !NON_CLASSIFIABLE_TOPIC_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

export function normalizeMemoryTopicSlug(value, { fallback = false } = {}) {
  const slug = normalizeSlug(value);
  if (slug === `${UNCATEGORIZED_T1}/${NEEDS_ROUTING_T2}`) return NEEDS_ROUTING_TOPIC;
  if (slug === UNCATEGORIZED_T1) return NEEDS_ROUTING_TOPIC;
  if (slug === NEEDS_ROUTING_T2) return NEEDS_ROUTING_TOPIC;
  if (slug === 'personal/learning') return NEEDS_ROUTING_TOPIC;
  if (!slug || UNKNOWN_TOPIC_ALIASES.has(slug)) {
    return fallback ? NEEDS_ROUTING_TOPIC : null;
  }
  if (isImportTag(slug)) return null;
  if (slug.includes('/')) {
    const parts = slug.split('/').filter(Boolean);
    return normalizeMemoryTopicSlug(parts[parts.length - 1], { fallback });
  }
  return slug;
}

export function memoryTopicLink(value, { fallback = false, role = 'scope' } = {}) {
  const targetId = normalizeMemoryTopicSlug(value, { fallback });
  if (!targetId) return null;
  return {
    targetType: 'topic',
    targetId,
    role: targetId === NEEDS_ROUTING_TOPIC && role === 'scope' ? 'needs-routing' : role,
  };
}

export function topicPairForDocTypeMap(docTypeMap, docType) {
  if (docTypeRequiresRoutingQueue(docType)) return unknownTopicPair();
  const mapped = docTypeMap?.[docType];
  if (mapped?.t1 || mapped?.t2) {
    return {
      t1: mapped.t1 || UNKNOWN_TOPIC_PAIR.t1,
      t2: mapped.t2 || UNKNOWN_TOPIC_PAIR.t2,
    };
  }
  return unknownTopicPair();
}
