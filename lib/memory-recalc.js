// lib/memory-recalc.js - replay generated memory surfaces from immutable sources.
//
// Recalc is deliberately projection-only: it never edits source facts, imported
// files, chat transcripts, or memory_events. It regenerates derived surfaces
// from the full source set so late historical evidence can be inserted and then
// reflected in the right tier: workbench SYNTHESIS.md, topic context_md (~4k),
// and topic identity description (~1k when empty).

import { synthesizeWorkbench } from './workbench-synthesis.js';
import { reconstructSnapshots } from './snapshots.js';

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function activeWorkbenchIds(db) {
  if (!hasTable(db, 'workbenches')) return [];
  return db.prepare(`
    SELECT id
    FROM workbenches
    WHERE status != 'archived'
    ORDER BY COALESCE(last_activity_at, updated_at, created_at, id) DESC
  `).all().map((row) => row.id);
}

function topicWorkbenchIds(db, topic) {
  if (!hasTable(db, 'workbench_attachments')) return [];
  return db.prepare(`
    SELECT DISTINCT w.id
    FROM workbenches w
    JOIN workbench_attachments a ON a.workbench_id = w.id
    WHERE w.status != 'archived'
      AND a.target_type = 'topic'
      AND a.target_id = ?
    ORDER BY COALESCE(w.last_activity_at, w.updated_at, w.created_at, w.id) DESC
  `).all(topic).map((row) => row.id);
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

export async function recalcMemory(db, args = {}, options = {}) {
  const workbenchId = args.workbenchId || args.workbench_id || args.id || null;
  const topic = args.topic || args.topicSlug || args.topic_slug || null;
  const target = args.target || args.query || null;
  const all = args.all === true || args.scope === 'all';

  const targets = [];
  if (workbenchId) targets.push({ id: workbenchId });
  else if (target) targets.push({ target });
  else if (topic) targets.push(...topicWorkbenchIds(db, topic).map((id) => ({ id })));
  else if (all) targets.push(...activeWorkbenchIds(db).map((id) => ({ id })));
  else {
    throw new Error('memory-recalc: pass --id, --target, --topic, or --all');
  }

  const results = [];
  for (const workbench of targets) {
    results.push(await synthesizeWorkbench(db, workbench, options));
  }

  let snapshotBackfill = { ok: true, scanned: 0, inserted: 0, existing: 0, snapshots: [] };
  if (workbenchId) {
    snapshotBackfill = reconstructSnapshots(db, { targetType: 'workbench', targetId: workbenchId });
  } else if (topic) {
    snapshotBackfill = reconstructSnapshots(db, { targetType: 'topic', targetId: topic });
  } else if (all) {
    snapshotBackfill = reconstructSnapshots(db, {});
  } else if (results.length) {
    const ids = results.map((result) => result.workbench_id).filter(Boolean);
    for (const id of ids) {
      const partial = reconstructSnapshots(db, { targetType: 'workbench', targetId: id });
      snapshotBackfill.scanned += partial.scanned || 0;
      snapshotBackfill.inserted += partial.inserted || 0;
      snapshotBackfill.existing += partial.existing || 0;
      snapshotBackfill.snapshots.push(...(partial.snapshots || []));
    }
  }

  return {
    ok: true,
    scope: workbenchId ? 'workbench' : target ? 'target' : topic ? 'topic' : 'all',
    target: workbenchId || target || topic || 'all',
    workbenches: results,
    count: results.length,
    generated_tiers: [
      'workbench:SYNTHESIS.md',
      'topic:context_md:4000',
      'topic:description:1000-if-empty',
      'db:workbenches.latest_state_next_action',
      'memory:projection_watermarks',
      'memory:snapshots:official-and-inferred',
      'memory:conflicts:detected',
    ],
    snapshots: {
      scanned: snapshotBackfill.scanned || 0,
      inserted: snapshotBackfill.inserted || 0,
      existing: snapshotBackfill.existing || 0,
    },
    source_set_hashes: unique(results.map((result) => result.source_set_hash)),
  };
}
