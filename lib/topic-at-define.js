/**
 * @slug plus a sentence defines that topic (st_c5c4e824).
 *
 * Writes user_topics.description and sets needs_regen. Missing T2 is created
 * under the current T1 (or Uncategorized). Never T3.
 */
export const INTELLIGENCE_TIER = 'extraction';

import { createTopic, updateTopic } from './topics.js';
import { UNCATEGORIZED_T1, UNCATEGORIZED_LABEL } from './topic-routing-policy.js';
import { getTopicLiveConfig } from './topic-live-thread.js';

const RESERVED_AT_SLUGS = new Set(['miyagi']);

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function titleizeSlug(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Parse `@slug` plus a sentence from composer text.
 * @returns {{ slug: string, sentence: string }|null}
 */
export function parseAtDefine(text, { minSentenceChars } = {}) {
  const min = Number(minSentenceChars ?? getTopicLiveConfig().atDefineMinSentenceChars) || 8;
  const raw = String(text || '');
  const m = raw.match(/(?:^|\s)@([a-z][a-z0-9-]{0,62})\s+(\S[\s\S]*)/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  if (RESERVED_AT_SLUGS.has(slug)) return null;
  const sentence = String(m[2] || '').trim();
  if (sentence.length < min) return null;
  return { slug, sentence };
}

function ensureUncategorizedT1(db) {
  if (!hasTable(db, 'user_topics')) return;
  const existing = db.prepare('SELECT slug FROM user_topics WHERE slug = ?').get(UNCATEGORIZED_T1);
  if (existing) return;
  createTopic(db, {
    slug: UNCATEGORIZED_T1,
    label: UNCATEGORIZED_LABEL,
    parent_slug: null,
    visible: 0,
  });
}

/**
 * Parent for a newly defined T2: current T1, or the T1 of a current T2,
 * or Uncategorized when no topic is selected. Never a T2 (never T3).
 */
export function resolveAtDefineParent(db, currentTopicSlug) {
  if (!currentTopicSlug) {
    ensureUncategorizedT1(db);
    return UNCATEGORIZED_T1;
  }
  const row = db.prepare('SELECT slug, parent_slug FROM user_topics WHERE slug = ?').get(currentTopicSlug);
  if (!row) {
    ensureUncategorizedT1(db);
    return UNCATEGORIZED_T1;
  }
  if (!row.parent_slug) return row.slug;
  return row.parent_slug;
}

/**
 * Upsert description for @slug. Creates a T2 under the current T1 when missing.
 */
export function applyAtDefine(db, { text, currentTopicSlug } = {}) {
  const parsed = parseAtDefine(text);
  if (!parsed) return { ok: false, reason: 'no_define' };

  const existing = db.prepare(
    'SELECT slug, parent_slug, description FROM user_topics WHERE slug = ?',
  ).get(parsed.slug);
  if (existing) {
    const result = updateTopic(db, existing.slug, { description: parsed.sentence });
    if (result?.error) return { ok: false, ...result };
    const row = db.prepare('SELECT slug, parent_slug, description, needs_regen FROM user_topics WHERE slug = ?').get(existing.slug);
    return {
      ok: true,
      created: false,
      slug: row.slug,
      parent_slug: row.parent_slug,
      description: row.description,
      needs_regen: row.needs_regen,
    };
  }

  const parentSlug = resolveAtDefineParent(db, currentTopicSlug);
  const parent = db.prepare('SELECT slug, parent_slug FROM user_topics WHERE slug = ?').get(parentSlug);
  if (parent?.parent_slug) {
    return { ok: false, error: 'validation_error', message: 'T2 topics cannot be parents.' };
  }

  const created = createTopic(db, {
    slug: parsed.slug,
    label: titleizeSlug(parsed.slug),
    description: parsed.sentence,
    parent_slug: parentSlug,
  });
  if (created?.error) return { ok: false, ...created };
  const row = db.prepare('SELECT slug, parent_slug, description, needs_regen FROM user_topics WHERE slug = ?').get(created.slug);
  return {
    ok: true,
    created: true,
    slug: row.slug,
    parent_slug: row.parent_slug,
    description: row.description,
    needs_regen: row.needs_regen,
  };
}
