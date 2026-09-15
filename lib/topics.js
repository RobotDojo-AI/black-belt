/**
 * Topics — user_topics intelligence substrate.
 *
 * user_topics is not a settings table. Each row is a named knowledge domain
 * with a Sonnet-synthesized context_md that becomes Layer 0 in every
 * topic-scoped chat turn. The T1/T2 hierarchy is the left nav surface;
 * context_md is what makes it intelligent.
 *
 * Intelligence loop:
 *   taxonomy.js seeds descriptions on boot →
 *   ingest/index.js sets needs_regen=1 on all topics →
 *   the maint_topics routine calls generateTopicContext per flagged topic →
 *   RAG (25 chunks) + entity context files + Sonnet synthesis →
 *   context_md (≤12K chars) written to user_topics →
 *   chat-context.js injects it as Layer 0 for topic-scoped turns
 *
 * Functions here own the topic mutations (CRUD, ordering, context writes).
 * Synthesis trigger lives in updateTopic (description change → fire-and-forget).
 * Synthesis logic lives in topic-context.js.
 *
 * Routing constraint: batch-order route MUST be registered before /:slug in
 * Hono — this module exports pure functions; the route file controls order.
 */

import { topicSlugIsClassifiable } from './topic-routing-policy.js';

/**
 * The set of registry topic slugs a Granola folder title can match against
 * (st_1169bfc7). Sourced from user_topics — the canonical topic taxonomy the
 * reclassifier already reads — filtered by the shared topicSlugIsClassifiable
 * guard so tool/canary/qa-* rows never become a routable folder target.
 *
 * WHY user_topics over workbenches: both carry the real topics, but workbenches
 * also carries qa-* test rows; user_topics is the clean set, and the stamped
 * transcripts.topic must be a slug the rest of the system recognizes — exactly
 * user_topics. Thin-facade: db injected. Pure read, no writes.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Set<string>}
 */
export function topicSlugSet(db) {
  const rows = db.prepare('SELECT slug FROM user_topics').all();
  const set = new Set();
  for (const row of rows) {
    if (topicSlugIsClassifiable(row.slug)) set.add(row.slug);
  }
  return set;
}

function cleanSlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeVisible(value, fallback = 1) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'visible' || v === 'shown') return 1;
    if (v === 'false' || v === 'hidden') return 0;
  }
  return fallback;
}

function nullableParent(value) {
  return value === undefined ? undefined : (value || null);
}

function sameParentClause(parentSlug) {
  return parentSlug == null ? 'parent_slug IS NULL' : 'parent_slug = ?';
}

function sameParentArgs(parentSlug) {
  return parentSlug == null ? [] : [parentSlug];
}

function nextSortOrder(db, parentSlug) {
  const where = sameParentClause(parentSlug);
  const args = sameParentArgs(parentSlug);
  // New T2s belong at the front of the VISIBLE sibling list. MAX(sort_order)+1
  // buried Deca after hidden Work history (Elephant, McKinsey, …) so the
  // owner opened Work and did not see the topic they just made.
  const vis = db.prepare(
    `SELECT MIN(sort_order) AS m FROM user_topics WHERE ${where} AND COALESCE(visible, 1) = 1`
  ).get(...args);
  if (Number.isFinite(vis?.m)) return vis.m - 1;
  const any = db.prepare(`SELECT MAX(sort_order) AS m FROM user_topics WHERE ${where}`).get(...args);
  return Number.isFinite(any?.m) ? any.m + 1 : 0;
}

function resolveTopic(db, slug) {
  const slugHyphen = String(slug || '').replace(/_/g, '-');
  let existing = db.prepare('SELECT slug, parent_slug, sort_order, visible FROM user_topics WHERE slug = ? OR slug = ? LIMIT 1')
    .get(slug, slugHyphen);
  if (!existing) {
    const labelForm = String(slug || '').replace(/_/g, ' ');
    existing = db.prepare('SELECT slug, parent_slug, sort_order, visible FROM user_topics WHERE lower(label) = lower(?) LIMIT 1').get(labelForm);
  }
  // df_d6970c76 Fix 3 (defense-in-depth): the lower(label) fallback only
  // strips underscore→space, so a hyphenated name-derived slug like
  // "career-deep-tech-dashboard" (the form a stale warm-cache produces from
  // label "Career Deep-Tech Dashboard") never matches. Scan once more,
  // running cleanSlug(label) over every row and matching the request slug
  // verbatim — cleanSlug("Career Deep-Tech Dashboard") === "career-deep-tech-dashboard".
  // Exact-slug and exact-label matches above take precedence; this scan only
  // runs when nothing else matched. Deterministic order (slug ASC) so two
  // labels that happen to slugify identically resolve to the same row every time.
  if (!existing) {
    const target = String(slug || '').toLowerCase();
    if (target) {
      const candidates = db.prepare('SELECT slug, parent_slug, sort_order, visible, label FROM user_topics ORDER BY slug ASC').all();
      for (const row of candidates) {
        if (cleanSlug(row.label) === target) {
          existing = { slug: row.slug, parent_slug: row.parent_slug, sort_order: row.sort_order, visible: row.visible };
          break;
        }
      }
    }
  }
  return existing || null;
}

function validateParent(db, slug, parentSlug) {
  if (parentSlug == null) return null;
  const cleanParent = cleanSlug(parentSlug);
  if (!cleanParent) return null;
  if (cleanParent === slug) throw new Error('A topic cannot be its own parent.');
  const parent = db.prepare('SELECT slug, parent_slug FROM user_topics WHERE slug = ?').get(cleanParent);
  if (!parent) throw new Error(`Parent topic "${cleanParent}" not found.`);
  if (parent.parent_slug) throw new Error('T2 topics cannot be parents.');
  let cursor = parent.parent_slug;
  const seen = new Set([cleanParent]);
  while (cursor) {
    if (cursor === slug) throw new Error('A topic cannot be moved under its own child.');
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = db.prepare('SELECT parent_slug FROM user_topics WHERE slug = ?').get(cursor)?.parent_slug;
  }
  return cleanParent;
}

function sortTopicNodes(nodes) {
  return nodes.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.label).localeCompare(String(b.label)) || String(a.slug).localeCompare(String(b.slug)));
}

export function repairTopics(db) {
  const rows = db.prepare('SELECT slug, parent_slug, visible FROM user_topics').all();
  const updateVisible = db.prepare("UPDATE user_topics SET visible = ?, updated_at = datetime('now') WHERE slug = ?");
  const updateOrder = db.prepare("UPDATE user_topics SET sort_order = ?, updated_at = datetime('now') WHERE slug = ?");

  db.transaction(() => {
    for (const row of rows) {
      if (!row.parent_slug) {
        const visible = row.visible === 2 ? 0 : normalizeVisible(row.visible, 1);
        updateVisible.run(visible, row.slug);
      } else {
        updateVisible.run(normalizeVisible(row.visible, 1), row.slug);
      }
    }

    const ordered = db.prepare('SELECT slug, parent_slug FROM user_topics ORDER BY COALESCE(parent_slug, \'\'), sort_order, label, slug').all();
    const buckets = new Map();
    for (const row of ordered) {
      const key = row.parent_slug || '__root__';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row.slug);
    }
    for (const slugs of buckets.values()) slugs.forEach((slug, index) => updateOrder.run(index, slug));
  })();

  return { ok: true, repaired: rows.length };
}

/**
 * One-time migration from the old split T1 semantics.
 * Legacy T1: visible=0 shown, visible=2 hidden. Canonical: 1 shown, 0 hidden.
 */
export function migrateLegacyTopicVisibility(db) {
  const legacyHidden = db.prepare("SELECT COUNT(*) AS n FROM user_topics WHERE parent_slug IS NULL AND visible = 2").get()?.n || 0;
  if (legacyHidden > 0) {
    db.prepare(`
      UPDATE user_topics
         SET visible = CASE WHEN visible = 2 THEN 0 ELSE 1 END,
             updated_at = datetime('now')
       WHERE parent_slug IS NULL
         AND (visible IS NULL OR visible IN (0, 2))
    `).run();
  } else {
    db.prepare("UPDATE user_topics SET visible = 1, updated_at = datetime('now') WHERE parent_slug IS NULL AND visible IS NULL").run();
  }
  db.prepare("UPDATE user_topics SET visible = 1, updated_at = datetime('now') WHERE parent_slug IS NOT NULL AND visible IS NULL").run();
}

export const repairTopicRows = repairTopics;

/**
 * Build the T1/T2 topic hierarchy.
 * T1 = parent_slug IS NULL (group headers). T2 = parent_slug IS NOT NULL.
 * Unknown parent_slugs surface as orphaned roots so nothing is silently lost.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ type: 'hierarchy', topics: object[] }}
 */
export function isJunkTopicSlug(slug = '') {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return false;
  if (/^(qa-persist|qa-probe|qa-rename-modal|qa-rename)-/.test(s)) return true;
  if (/^hist-/.test(s)) return true;
  if (/-hier$/.test(s)) return true;
  return s === 'api-define' || s === 'recap-live' || s === 'maint-new-topic'
    || s === 'tool-parent' || s === 'tool-child';
}

export function isFixtureTopic(row = {}) {
  if (isJunkTopicSlug(row.slug || row.context || row.id)) return true;
  const blob = [row.slug, row.label, row.description, row.name]
    .map((v) => String(v || '').toLowerCase())
    .join(' ');
  return /(?:^|[^a-z])qa[-_](?:persist|probe|rename|modal)\b/.test(blob)
    || /\bqa persist\b|\bqa probe\b|\bqa rename\b/.test(blob);
}

export function getTopicsHierarchy(db) {
  const rows = db.prepare(
    'SELECT slug, label, description, icon, visible, sort_order, parent_slug FROM user_topics ORDER BY sort_order, label'
  ).all().filter((row) => !isFixtureTopic(row));

  const bySlug = Object.fromEntries(rows.map(r => [r.slug, { ...r, children: [] }]));
  const roots = [];
  for (const r of rows) {
    if (!r.parent_slug) {
      roots.push(bySlug[r.slug]);
    } else if (bySlug[r.parent_slug]) {
      bySlug[r.parent_slug].children.push(bySlug[r.slug]);
    } else {
      roots.push(bySlug[r.slug]);
    }
  }
  sortTopicNodes(roots);
  roots.forEach(r => sortTopicNodes(r.children));
  return { type: 'hierarchy', topics: roots };
}

/**
 * Return all T2 labels and T1 groups for the left nav.
 * Includes all T2 topics (visible and hidden) so Manage Topics mode can show/restore them.
 * Does NOT include inboxCount — callers compose that from lib/conversations.getInboxCount().
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ labels: object[], groups: object[] }}
 */
export function getLabels(db, { includeRootLabels = false } = {}) {
  const topicRows = db.prepare(
    `SELECT slug, label, description, context_md, sort_order, parent_slug, icon, visible
       FROM user_topics
      WHERE ${includeRootLabels ? '1 = 1' : 'parent_slug IS NOT NULL'}
      ORDER BY sort_order, label`
  ).all();
  const labels = topicRows.filter((r) => !isFixtureTopic(r)).map(r => ({
    slug: r.slug,
    name: r.label,
    context: r.slug,        // CRITICAL: context === slug (no underscore normalization)
    description: r.description || '',
    has_context: !!(r.context_md),
    icon: r.icon || null,
    sort_order: r.sort_order,
    parent_slug: r.parent_slug || null,
    visible: r.visible === 1,
  }));

  const groupRows = db.prepare(
    'SELECT slug, label, icon, description, sort_order, visible FROM user_topics WHERE parent_slug IS NULL ORDER BY sort_order, label'
  ).all();
  const groups = groupRows.filter((r) => !isFixtureTopic(r)).map(r => ({
    slug: r.slug,
    name: r.label,
    icon: r.icon || 'folder',
    description: r.description || null,
    sort_order: r.sort_order,
    visible: r.visible === 1,
  }));
  const hiddenParents = new Set(groups.filter((g) => g.visible === false).map((g) => g.slug));
  for (const label of labels) {
    if (label.parent_slug && hiddenParents.has(label.parent_slug)) label.visible = false;
  }

  // last_seen used to run one full conversations scan per T2
  // (json_extract(tags) LIKE '%slug%'). The left nav never reads last_seen,
  // and the scan could stall GET /api/labels long enough that the client
  // kept a warm cache from before Deca existed.
  return { labels, groups };
}

/**
 * Create a topic. Upserts if slug already exists (restores without losing sort_order).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ slug: string, label: string, description?: string, icon?: string, parent_slug?: string, visible?: number }} body
 * @returns {{ ok: boolean, slug: string, label: string, description: string|null, icon: string|null, parent_slug: string|null }}
 */
export function createTopic(db, body) {
  const { label, description, icon, parent_slug, visible } = body;
  const clean = cleanSlug(body.slug || label);
  if (!clean || !label?.trim()) return { error: 'validation_error' };
  const parentSlug = nullableParent(parent_slug) ?? null;
  try { validateParent(db, clean, parentSlug); } catch (e) { return { error: 'validation_error', message: e.message }; }

  const existing = db.prepare('SELECT slug, parent_slug, sort_order, created_at, visible FROM user_topics WHERE slug = ?').get(clean);
  if (existing) {
    const nextParent = parent_slug === undefined ? existing.parent_slug : parentSlug;
    const childCount = db.prepare('SELECT COUNT(*) AS n FROM user_topics WHERE parent_slug = ?').get(clean)?.n || 0;
    if (nextParent && childCount > 0) return { error: 'validation_error', message: 'T1 topics with children cannot be reparented.' };
    const nextOrder = parent_slug !== undefined && nextParent !== existing.parent_slug
      ? nextSortOrder(db, nextParent)
      : existing.sort_order;
    db.prepare("UPDATE user_topics SET label = ?, description = COALESCE(?, description), icon = COALESCE(?, icon), parent_slug = ?, sort_order = ?, visible = ?, needs_regen = 1, updated_at = datetime('now') WHERE slug = ?")
      .run(label.trim(), description || null, icon || null, nextParent, nextOrder, normalizeVisible(visible, existing.visible ?? 1), clean);
  } else {
    db.prepare("INSERT INTO user_topics (slug, label, description, icon, parent_slug, sort_order, visible, needs_regen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))")
      .run(clean, label.trim(), description || null, icon || (parentSlug ? 'label' : 'folder'), parentSlug, nextSortOrder(db, parentSlug), normalizeVisible(visible, 1));
  }
  return { ok: true, slug: clean, label: label.trim(), description: description || null, icon: icon || null, parent_slug: parentSlug };
}

/**
 * Update a topic. Handles slug resolution (exact → hyphen → label form).
 * Two-step parent_slug UPDATE: COALESCE cannot set NULL, so we detect 'parent_slug'
 * in the parsed body and run an unconditional UPDATE when present.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} slug - From route param (may be _ or - form)
 * @param {object} body - Parsed request body
 * @param {Function} generateTopicContext - Fire-and-forget synthesis function from topic-context.js
 * @returns {{ ok: boolean } | null} null = not found
 */
export function updateTopic(db, slug, body, generateTopicContext) {
  const { label, description, sort_order, icon, visible } = body;
  const parentSlugPresent = 'parent_slug' in body;
  const parent_slug = nullableParent(body.parent_slug);

  const existing = resolveTopic(db, slug);
  if (!existing) return null;
  const resolvedSlug = existing.slug;
  let nextParent = existing.parent_slug || null;
  let nextOrder = sort_order ?? existing.sort_order;

  if (parentSlugPresent) {
    try { nextParent = validateParent(db, resolvedSlug, parent_slug ?? null); } catch (e) { return { error: 'validation_error', message: e.message }; }
    const childCount = db.prepare('SELECT COUNT(*) AS n FROM user_topics WHERE parent_slug = ?').get(resolvedSlug)?.n || 0;
    if (nextParent && childCount > 0) return { error: 'validation_error', message: 'T1 topics with children cannot be reparented.' };
    if ((existing.parent_slug || null) !== nextParent && sort_order === undefined) nextOrder = nextSortOrder(db, nextParent);
  }

  db.prepare("UPDATE user_topics SET label = COALESCE(?, label), description = COALESCE(?, description), sort_order = COALESCE(?, sort_order), icon = COALESCE(?, icon), visible = COALESCE(?, visible), parent_slug = ?, needs_regen = 1, updated_at = datetime('now') WHERE slug = ?")
    .run(label || null, description || null, nextOrder ?? null, icon || null, visible !== undefined ? normalizeVisible(visible, existing.visible ?? 1) : null, nextParent, resolvedSlug);

  // Any topic shape change sets needs_regen=1 so scripts/topic-edit-watcher.js
  // picks it up after the 5-minute debounce window. The watcher refreshes
  // description_embedding, runs the scoped reclassifier, and then regenerates
  // context_md if chunks moved. This keeps topic edits server-owned without
  // spawning a second DB writer from the HTTP handler.
  //
  // The legacy fire-and-forget path is still available via
  // POST /api/topics/:slug/context/refresh for explicit user requests.
  if (description?.trim()) {
    db.prepare("UPDATE user_topics SET needs_regen = 1, updated_at = datetime('now') WHERE slug = ?")
      .run(resolvedSlug);
  }

  return { ok: true };
}

export function renameTopicSlug(db, oldSlug, newSlug) {
  if (!oldSlug || !newSlug || oldSlug === newSlug) return { ok: false, changes: 0 };
  const topicChange = db.prepare("UPDATE user_topics SET slug = ?, updated_at = datetime('now') WHERE slug = ?")
    .run(newSlug, oldSlug);
  db.prepare("UPDATE user_topics SET parent_slug = ?, updated_at = datetime('now') WHERE parent_slug = ?")
    .run(newSlug, oldSlug);
  return { ok: topicChange.changes > 0, changes: topicChange.changes };
}

export function reparentTopicChildren(db, fromSlug, toSlug) {
  if (!fromSlug || !toSlug || fromSlug === toSlug) return { ok: false, changes: 0 };
  const result = db.prepare("UPDATE user_topics SET parent_slug = ?, updated_at = datetime('now') WHERE parent_slug = ?")
    .run(toSlug, fromSlug);
  return { ok: true, changes: result.changes };
}

export function deleteTopicRow(db, slug) {
  if (!slug) return { ok: false, changes: 0 };
  const result = db.prepare('DELETE FROM user_topics WHERE slug = ?').run(slug);
  return { ok: result.changes > 0, changes: result.changes };
}

export function markTopicNeedsRegen(db, slug) {
  if (!slug) return { ok: false, changes: 0 };
  const result = db.prepare("UPDATE user_topics SET needs_regen = 1, updated_at = datetime('now') WHERE slug = ?").run(slug);
  return { ok: result.changes > 0, changes: result.changes };
}

/**
 * Delete a topic. T1 with children requires confirm=true; cascade removes all children.
 * T2 is hard-deleted. Tags are removed from all conversations that reference the slug.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} slug
 * @param {boolean} confirm - Required true for T1 deletion when children exist
 * @returns {{ ok: boolean } | { needsConfirm: true, childCount: number } | null} null = not found
 */
export function deleteTopic(db, slug, confirm) {
  const row = db.prepare('SELECT parent_slug FROM user_topics WHERE slug = ?').get(slug);
  if (!row) return null;

  const isT1 = !row.parent_slug;

  if (isT1) {
    const children = db.prepare('SELECT slug, visible FROM user_topics WHERE parent_slug = ?').all(slug);
    const childCount = db.prepare('SELECT COUNT(*) as n FROM user_topics WHERE parent_slug = ?').get(slug)?.n || 0;
    if (childCount > 0 && !confirm) {
      const visibleChildCount = children.filter(c => c.visible !== 0).length;
      return { needsConfirm: true, childCount: visibleChildCount || childCount };
    }
    db.transaction(() => {
      children.forEach(c => _removeTagFromConvs(db, c.slug));
      db.prepare('DELETE FROM user_topics WHERE parent_slug = ?').run(slug);
      db.prepare('DELETE FROM user_topics WHERE slug = ?').run(slug);
    })();
    return { ok: true };
  }

  // T2 hard delete
  _removeTagFromConvs(db, slug);
  const result = db.prepare('DELETE FROM user_topics WHERE slug = ?').run(slug);
  if (result.changes === 0) return null;
  return { ok: true };
}

/**
 * Batch-update sort_order for a list of topic slugs.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} slugs - Ordered array of topic slugs; index becomes sort_order
 * @returns {{ ok: boolean }}
 */
export function batchOrder(db, slugs) {
  return moveTopics(db, Array.isArray(slugs) ? { slugs } : slugs);
}

export function moveTopics(db, { parent_slug = undefined, slugs = [] } = {}) {
  if (!Array.isArray(slugs) || slugs.length === 0) return { error: 'slugs_required' };
  const rows = db.prepare(`SELECT slug, parent_slug FROM user_topics WHERE slug IN (${slugs.map(() => '?').join(',')})`).all(...slugs);
  if (rows.length !== slugs.length) return { error: 'not_found' };
  const parentSlug = parent_slug === undefined ? (rows[0].parent_slug || null) : (parent_slug || null);
  if (rows.some(r => (r.parent_slug || null) !== parentSlug)) return { error: 'mixed_parent' };
  const allSiblings = db.prepare(`SELECT slug FROM user_topics WHERE ${sameParentClause(parentSlug)} ORDER BY sort_order, label, slug`).all(...sameParentArgs(parentSlug)).map(r => r.slug);
  const given = new Set(slugs);
  const rest = allSiblings.filter((s) => !given.has(s));
  const ordered = [...slugs, ...rest];
  const stmt = db.prepare("UPDATE user_topics SET sort_order = ?, updated_at = datetime('now') WHERE slug = ?");
  db.transaction(() => { ordered.forEach((s, i) => stmt.run(i, s)); })();
  return { ok: true };
}

/**
 * Get the synthesized context_md for a topic.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} slug
 * @returns {{ slug: string, context_md: string|null }}
 */
/**
 * Browser URL for a topic: /t1 or /t1/t2. Slash command /work stays agent-only.
 */
export function topicPublicUrl(db, slug) {
  const row = db?.prepare?.('SELECT slug, parent_slug FROM user_topics WHERE slug = ?').get(slug);
  if (row?.parent_slug) return `/${row.parent_slug}/${row.slug}`;
  if (row?.slug) return `/${row.slug}`;
  const raw = String(slug || '').replace(/^\/+|\/+$/g, '');
  return raw ? `/${raw}` : '/';
}

export function getTopicContext(db, slug) {
  const row = db.prepare('SELECT context_md FROM user_topics WHERE slug = ?').get(slug);
  return { slug, context_md: row?.context_md || null };
}

/**
 * Write user-edited context_md. Logs the edit to topic_context_history.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} slug
 * @param {string} content
 * @returns {{ ok: boolean }}
 */
export function updateTopicContext(db, slug, content) {
  db.prepare("UPDATE user_topics SET context_md = ?, updated_at = datetime('now') WHERE slug = ?").run(content, slug);
  db.prepare('INSERT INTO topic_context_history (topic_slug, content, source) VALUES (?, ?, ?)').run(slug, content, 'user');
  return { ok: true };
}

/**
 * Patch a label (T2 topic) field by field: visible, name, sort_order, parent.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} tagName
 * @param {{ visible?: number, name?: string, sort_order?: number, parent?: string|null }} patch
 * @returns {{ ok: boolean }|null} null if not found
 */
export function patchLabel(db, tagName, { visible, name, sort_order, parent }) {
  const result = updateTopic(db, tagName, { visible, label: name, sort_order, ...(parent !== undefined ? { parent_slug: parent || null } : {}) });
  return result?.error ? null : result;
}

/**
 * Create a new label (simple quick-add, without full topic upsert logic).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ name: string, parent?: string, icon?: string, description?: string }} body
 * @returns {{ ok: boolean, slug: string }|{ error: string, slug?: string }}
 */
export function createLabel(db, body) {
  const { name, parent, icon, description } = body;
  const slug = cleanSlug(name);
  if (db.prepare('SELECT slug FROM user_topics WHERE slug = ?').get(slug)) return { error: 'conflict', slug };
  return createTopic(db, { slug, label: name, icon, description, parent_slug: parent || null });
}

/**
 * Delete a label by tag name.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} tagName
 * @returns {{ ok: boolean }|null} null if not found
 */
export function deleteLabel(db, tagName) {
  return deleteTopic(db, tagName, true);
}

/**
 * Remove only caller-owned exact test fixture slugs.
 * Startup and admin checkpoint paths must never delete topics by naming pattern.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} slugs
 * @returns {number} rows deleted
 */
export function cleanupTestTopics(db, slugs = []) {
  const cleanSlugs = [...new Set(slugs.map(s => String(s || '').trim()).filter(Boolean))];
  if (cleanSlugs.length === 0) return 0;
  const placeholders = cleanSlugs.map(() => '?').join(', ');
  return db.prepare(`DELETE FROM user_topics WHERE slug IN (${placeholders})`).run(...cleanSlugs).changes;
}

// Internal helper — removes a topic tag from all conversations that reference it.
// Called from deleteTopic cascade only; not exported.
// st_f0adee6f: also null out conversations.topic_slug and clear conversation_topics
// rows for the deleted slug so the multi-topic junction stays consistent. Any
// affected conversation will be re-evaluated by the background reclassify spawn
// fired from the DELETE /api/topics/:slug handler.
function _removeTagFromConvs(db, tagSlug) {
  const convs = db.prepare("SELECT id, tags FROM conversations WHERE tags LIKE ? AND deleted_at IS NULL").all('%"' + tagSlug + '"%');
  const upd = db.prepare("UPDATE conversations SET tags = ? WHERE id = ?");
  convs.forEach(c => {
    const tags = JSON.parse(c.tags || '[]').filter(t => t !== tagSlug);
    upd.run(JSON.stringify(tags), c.id);
  });
  // Null the primary topic on any conversation that pointed at this slug — mark
  // method 'keyword' so the reclassify sweep picks it up (the 'user' guard
  // protects manual assignments).
  db.prepare("UPDATE conversations SET topic_slug = NULL, topic_set_method = 'keyword', updated_at = datetime('now') WHERE topic_slug = ? AND (topic_set_method IS NULL OR topic_set_method != 'user')").run(tagSlug);
  // Drop every junction row for this slug — primary AND secondary.
  db.prepare("DELETE FROM conversation_topics WHERE topic_slug = ?").run(tagSlug);
}
