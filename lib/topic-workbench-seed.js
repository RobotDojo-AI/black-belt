// lib/topic-workbench-seed.js - default topic workbench creation/backfill.
//
// Topics own compact context; workbenches own deep, replayable substrate. This
// bridge keeps the dependency direction clean: topic CRUD can ask for a default
// workbench without lib/topics.js importing the workbench layer.

import { ensureDefaultTopicWorkbench } from './workbenches.js';
import { recalcMemory } from './memory-recalc.js';

export function isGeneratedQaTopicSlug(slug) {
  return /^(qa-persist|qa-rename-modal|qa-probe)-/.test(String(slug || ''));
}

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function hasWorkbenchTables(db) {
  return hasTable(db, 'workbenches') && hasTable(db, 'workbench_attachments');
}

function existingPrimaryTopicWorkbenchId(db, slug) {
  if (!hasWorkbenchTables(db)) return null;
  return db.prepare(`
    SELECT w.id
      FROM workbenches w
      JOIN workbench_attachments a ON a.workbench_id = w.id
     WHERE a.target_type = 'topic'
       AND a.target_id = ?
       AND COALESCE(a.role, 'primary') = 'primary'
       AND w.status != 'archived'
     ORDER BY w.updated_at DESC
     LIMIT 1
  `).get(slug)?.id || null;
}

function topicRows(db, { includeHidden = false } = {}) {
  if (!hasTable(db, 'user_topics')) return [];
  if (!hasWorkbenchTables(db)) {
    const where = includeHidden ? '1 = 1' : 'COALESCE(visible, 1) = 1';
    return db.prepare(`
      SELECT slug, label, parent_slug, COALESCE(visible, 1) AS visible,
             NULL AS workbench_id
        FROM user_topics
       WHERE ${where}
       ORDER BY COALESCE(parent_slug, ''), sort_order, label, slug
    `).all();
  }
  const where = includeHidden ? '1 = 1' : 'COALESCE(t.visible, 1) = 1';
  return db.prepare(`
    SELECT t.slug, t.label, t.parent_slug, COALESCE(t.visible, 1) AS visible,
           w.id AS workbench_id
      FROM user_topics t
      LEFT JOIN workbench_attachments a
        ON a.target_type = 'topic'
       AND a.target_id = t.slug
       AND COALESCE(a.role, 'primary') = 'primary'
      LEFT JOIN workbenches w
        ON w.id = a.workbench_id
       AND w.status != 'archived'
     WHERE ${where}
     ORDER BY COALESCE(t.parent_slug, ''), t.sort_order, t.label, t.slug
  `).all();
}

export function topicWorkbenchCoverage(db, options = {}) {
  const rows = topicRows(db, options);
  const missing = rows.filter((row) => !row.workbench_id);
  return {
    ok: true,
    include_hidden: Boolean(options.includeHidden),
    topics: rows.length,
    with_workbench: rows.length - missing.length,
    missing: missing.map((row) => ({
      slug: row.slug,
      label: row.label,
      parent_slug: row.parent_slug || null,
      visible: row.visible !== 0,
    })),
  };
}

export async function ensureTopicWorkbench(db, slug, options = {}) {
  if (isGeneratedQaTopicSlug(slug)) {
    return {
      ok: true,
      slug,
      created: false,
      skipped: true,
      workbench_id: null,
      root_path: null,
      recalc: null,
    };
  }
  const before = !existingPrimaryTopicWorkbenchId(db, slug);
  const workbench = ensureDefaultTopicWorkbench(db, slug, options);
  let recalc = null;
  if (options.recalc) {
    recalc = await recalcMemory(db, { id: workbench.id }, options);
  }
  return {
    ok: true,
    slug,
    created: before,
    workbench_id: workbench.id,
    root_path: workbench.root_path,
    recalc,
  };
}

export async function backfillTopicWorkbenches(db, options = {}) {
  const rows = topicRows(db, { includeHidden: options.includeHidden });
  const missing = rows.filter((row) => !row.workbench_id);
  const results = [];
  if (options.dryRun) {
    return {
      ok: true,
      dry_run: true,
      include_hidden: Boolean(options.includeHidden),
      topics: rows.length,
      existing: rows.length - missing.length,
      missing: missing.map((row) => row.slug),
      created: 0,
      recalculated: 0,
      workbenches: [],
    };
  }

  for (const row of missing) {
    results.push(await ensureTopicWorkbench(db, row.slug, options));
  }

  return {
    ok: true,
    include_hidden: Boolean(options.includeHidden),
    topics: rows.length,
    existing: rows.length - missing.length,
    missing: missing.length,
    created: results.filter((row) => row.created).length,
    recalculated: results.filter((row) => row.recalc).length,
    workbenches: results,
  };
}
