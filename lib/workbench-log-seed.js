/**
 * Dreaming (deterministic half): ensure every topic and every non-noise
 * entity has a workbench and a LOG.md file.
 *
 * Never invents a Decision. Never copies context.md / context_md into the
 * log — that was the old summary card sneaking back. Decision, Why, and
 * next steps are the reasoned half (`lib/workbench-log-reason.js`).
 */
import { MEANINGFUL_PERSON_PREDICATE } from './network-queries.js';
import { REPO_ROOT } from './robotdojo-paths.js';
import {
  ensureDefaultEntityWorkbench,
  ensureDefaultTopicWorkbench,
  primaryWorkbenchForTarget,
} from './workbenches.js';

function hasTable(db, name) {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  catch { return false; }
}

function seedOne(db, target, repoRoot) {
  const wb = target.type === 'topic'
    ? ensureDefaultTopicWorkbench(db, target.id, { repoRoot })
    : ensureDefaultEntityWorkbench(db, target.type, target.id, { repoRoot });
  return { seeded: false, id: wb?.id || null, root: wb?.root_path || null };
}

export function listLogSeedTargets(db) {
  const targets = [];
  if (hasTable(db, 'user_topics')) {
    for (const row of db.prepare('SELECT slug, label, context_md FROM user_topics WHERE visible = 1').all()) {
      targets.push({ type: 'topic', id: row.slug, label: row.label, rank: 0, contextPath: null, inline: row.context_md });
    }
  }
  if (hasTable(db, 'people')) {
    for (const row of db.prepare(`
      SELECT id, display_name AS label, context_file_path AS contextPath, entity_rank AS rank,
             personal_tier AS personalTier, business_tier AS businessTier
      FROM people WHERE ${MEANINGFUL_PERSON_PREDICATE}
    `).all()) {
      targets.push({
        type: 'person',
        id: row.id,
        label: row.label,
        rank: row.rank,
        contextPath: row.contextPath,
        personalTier: row.personalTier,
        businessTier: row.businessTier,
      });
    }
  }
  if (hasTable(db, 'companies')) {
    for (const row of db.prepare(`
      SELECT id, name AS label, context_file_path AS contextPath, entity_rank AS rank
      FROM companies
      WHERE COALESCE(archived, 0) = 0
        AND (
          COALESCE(people_count, 0) > 0
          OR entity_rank IS NOT NULL
          OR (context_file_path IS NOT NULL AND length(context_file_path) > 0)
        )
    `).all()) {
      targets.push({ type: 'company', id: String(row.id), label: row.label, rank: row.rank, contextPath: row.contextPath });
    }
  }
  if (hasTable(db, 'places')) {
    for (const row of db.prepare(`
      SELECT CAST(id AS TEXT) AS id, name AS label, context_file_path AS contextPath, entity_rank AS rank
      FROM places
      WHERE COALESCE(archived, 0) = 0
        AND (entity_rank IS NOT NULL OR COALESCE(years_lived, 0) > 0)
    `).all()) {
      targets.push({ type: 'place', id: row.id, label: row.label, rank: row.rank, contextPath: row.contextPath });
    }
  }
  return targets;
}

export function seedWorldLogs(db, { maxCreates = 80, repoRoot = REPO_ROOT } = {}) {
  const cap = Math.max(1, Math.min(Number(maxCreates) || 80, 5000));
  const targets = listLogSeedTargets(db);
  let created = 0;
  let seeded = 0;
  let scanned = 0;
  let ops = 0;
  for (const target of targets) {
    scanned += 1;
    const existing = primaryWorkbenchForTarget(db, target.type, target.id);
    if (existing) continue;
    if (ops >= cap) break;
    try {
      const result = seedOne(db, target, repoRoot);
      if (result.id) {
        created += 1;
        ops += 1;
      }
    } catch {
      /* keep walking */
    }
  }
  return { scanned, created, seeded, remaining: Math.max(0, targets.length - scanned), total: targets.length };
}
