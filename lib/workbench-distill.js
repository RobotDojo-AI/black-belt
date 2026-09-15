import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import crypto from 'node:crypto';
import { applyTopicContext } from './topic-context-apply.js';
import { REPO_ROOT, resolveRepoPath, stableId } from './workbench-files.js';
import { getWorkbench, topicContextPath } from './workbenches.js';
import { entityContextPath } from './context-paths.js';
import { buildEntityFloor, formatEntityFactBullets } from './entity-floor.js';
import { markMaintenanceDirty, recordMaintenanceLedger } from './maintenance.js';
import { USER_CONTEXTS_REL } from './robotdojo-paths.js';

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

export function targetPathFor(targetType, targetId, db = null) {
  if (targetType === 'topic') return db ? topicContextPath(db, targetId) : `${USER_CONTEXTS_REL}/topics/${targetId}/context.md`;
  if (targetType === 'person') return entityContextPath('person', targetId, db);
  if (targetType === 'company') return entityContextPath('company', targetId, db);
  if (targetType === 'place') return entityContextPath('place', targetId, db);
  throw new Error(`unsupported promotion target: ${targetType}`);
}

export function buildPromotionCandidate({ workbench, item, sourcePath, changeSummary }) {
  const title = item?.title || basename(sourcePath || workbench.root_path || 'workbench');
  return [
    `## Workbench Promotion: ${title}`,
    '',
    changeSummary || workbench.latest_state || workbench.summary || 'Reviewed workbench finding.',
    '',
    `Source: ${sourcePath || item?.path || workbench.resume_path || workbench.root_path}`,
  ].join('\n');
}

/**
 * Chat injects the ## Summary tier of context.md (topic/entity), not the full
 * History tail. Promotions that only append under History never reach chat.
 * This keeps a compact bullet under ## Summary so research lands in the
 * layer chat actually reads, while the full promotion block still archives
 * under History via appendOnce.
 */
export function collectAttachedEntityFactBullets(db, workbench, { maxPerEntity = 8, maxTotal = 24 } = {}) {
  const bullets = [];
  for (const attachment of workbench?.attachments || []) {
    if (!['person', 'company', 'place'].includes(attachment.target_type)) continue;
    try {
      const floor = buildEntityFloor(db, {
        id: attachment.target_id,
        type: attachment.target_type,
        name: attachment.label,
        display_name: attachment.label,
      });
      bullets.push(...formatEntityFactBullets(floor, { max: maxPerEntity }));
    } catch { /* floor optional per attachment */ }
    if (bullets.length >= maxTotal) break;
  }
  return bullets.slice(0, maxTotal);
}

export function injectFactsSection(markdown, facts, { maxBullet = 280 } = {}) {
  const bullets = (Array.isArray(facts) ? facts : [facts])
    .map((fact) => String(fact || '').replace(/^#+\s+/gm, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((fact) => `- ${fact.slice(0, maxBullet)}`);
  if (!bullets.length) return String(markdown || '').trimEnd() || '# Context\n';
  const block = `## Facts\n\n${bullets.join('\n')}\n`;
  const text = String(markdown || '').trimEnd();
  if (/^## Facts\b/m.test(text)) {
    return text.replace(/^## Facts[ \t]*\n+(?:- .+\n+)*/m, `${block}\n`);
  }
  if (/^## Summary\b/m.test(text)) {
    return text.replace(/^(## Summary[ \t]*\n+)/m, `${block}\n$1`);
  }
  const titleMatch = text.match(/^(#[^\n]*\n+)/);
  if (titleMatch) {
    return `${titleMatch[1]}\n${block}\n${text.slice(titleMatch[0].length).replace(/^\n+/, '')}`;
  }
  if (!text) return `# Context\n\n${block}`;
  return `${block}\n${text}\n`;
}

export function injectPromotionIntoSummary(markdown, changeSummary, { maxBullet = 400 } = {}) {
  const text = String(markdown || '').trimEnd();
  const bulletRaw = String(changeSummary || '')
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxBullet);
  if (!bulletRaw) return text || '# Context\n';
  const bullet = `- ${bulletRaw.replace(/^[-*]\s*/, '')}`;
  // Already present (idempotent re-promote).
  if (text.includes(bulletRaw.slice(0, Math.min(60, bulletRaw.length)))) {
    return text || `# Context\n\n## Summary\n\n${bullet}\n`;
  }
  if (/^## Summary\b/m.test(text)) {
    return text.replace(/^(## Summary[ \t]*\n+)/m, (m) => `${m}${bullet}\n`);
  }
  const titleMatch = text.match(/^(#[^\n]*\n+)/);
  if (titleMatch) {
    return `${titleMatch[1]}\n## Summary\n\n${bullet}\n\n${text.slice(titleMatch[0].length).replace(/^\n+/, '')}`;
  }
  if (!text) return `# Context\n\n## Summary\n\n${bullet}\n`;
  return `## Summary\n\n${bullet}\n\n${text}\n`;
}

export async function promoteWorkbenchFinding(db, args = {}, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const workbench = getWorkbench(db, args.id || args.workbench_id);
  if (!workbench) throw new Error(`workbench not found: ${args.id || args.workbench_id}`);

  const [targetType, targetId] = parseTarget(args.target, args.target_type, args.target_id);
  const reviewer = args.reviewer || 'codex';
  const sourcePath = args.source_path || args.item_path || workbench.resume_path || workbench.root_path;
  const item = args.item_id
    ? workbench.items.find(i => i.id === args.item_id)
    : workbench.items.find(i => i.path === sourcePath);
  const targetPath = args.target_path || targetPathFor(targetType, targetId, db);
  if (!options.dryRun && !args.body && !args.change_summary) {
    throw new Error('applied workbench promotions require reviewed compact body or change_summary');
  }
  if (args.body) validateReviewedBody(args.body);
  const candidate = args.body || buildPromotionCandidate({
    workbench,
    item,
    sourcePath,
    changeSummary: args.change_summary,
  });
  const existing = existsSync(resolve(repoRoot, targetPath))
    ? readFileSync(resolve(repoRoot, targetPath), 'utf8')
    : `# ${targetId}\n\n## Summary\n\n\n## History\n\n`;
  // Chat reads ## Summary first — put a compact finding there, then archive
  // the full promotion block (idempotent append) for deep workbench history.
  const summarySeed = args.change_summary || compactBodyForFact(args.body) || candidate.split('\n').slice(2, 4).join(' ');
  const withSummary = injectPromotionIntoSummary(existing, summarySeed);
  const promotedContent = appendOnce(withSummary, candidate);
  const promotedHash = sha256(promotedContent);
  const promotionId = `wbp_${stableId(workbench.id, sourcePath, targetType, targetId, promotedHash)}`;
  const entityTable = targetType === 'person' ? 'people' : targetType === 'company' ? 'companies' : targetType === 'place' ? 'places' : '';
  if (!options.dryRun && targetType !== 'topic') {
    assertEntityTarget(db, entityTable, targetId, targetType);
  }

  const result = {
    dry_run: !!options.dryRun,
    promotion_id: promotionId,
    workbench_id: workbench.id,
    item_id: item?.id || null,
    source_path: sourcePath || '',
    target_type: targetType,
    target_id: targetId,
    target_path: targetPath,
    reviewer,
    change_summary: args.change_summary || 'Reviewed workbench promotion',
    promoted_hash: promotedHash,
  };
  if (options.dryRun) return result;

  mkdirSync(dirname(resolve(repoRoot, targetPath)), { recursive: true });
  writeFileSync(resolve(repoRoot, targetPath), promotedContent);

  if (targetType === 'topic') {
    await applyTopicContext(db, {
      slug: targetId,
      contextMd: promotedContent,
      sourceType: 'workbench',
      source: `workbench:${workbench.id}`,
    });
    markMaintenanceDirty(db, {
      targetType: 'topic',
      targetId,
      reason: 'workbench-promotion',
      priority: 95,
      policyTier: 'sonnet',
      metadata: { workbench_id: workbench.id, sourcePath },
    });
  } else {
    writeEntityFact(db, {
      entityType: targetType,
      entityId: targetId,
      factValue: args.change_summary || compactBodyForFact(args.body),
      sourcePath,
    });
    const update = db.prepare(`UPDATE ${entityTable} SET needs_regen = 1 WHERE id = ?`).run(targetId);
    if (update.changes !== 1) throw new Error(`entity promotion target not updated: ${targetType}:${targetId}`);
    markMaintenanceDirty(db, {
      targetType,
      targetId,
      reason: 'workbench-promotion',
      priority: 95,
      policyTier: 'sonnet',
      metadata: { workbench_id: workbench.id, sourcePath },
    });
  }
  recordMaintenanceLedger(db, {
    jobId: promotionId,
    routineId: 'workbench-promote',
    targetType,
    targetId,
    action: 'promote-reviewed-finding',
    status: 'done',
    artifactPath: targetPath,
    artifactHash: promotedHash,
    metadata: { workbench_id: workbench.id, sourcePath },
  });

  db.prepare(`
    INSERT INTO workbench_promotions
      (id, workbench_id, item_id, source_path, target_type, target_id, target_path, reviewer, change_summary, promoted_hash, status, metadata)
    VALUES
      (@id, @workbench_id, @item_id, @source_path, @target_type, @target_id, @target_path, @reviewer, @change_summary, @promoted_hash, 'applied', @metadata)
    ON CONFLICT(id) DO UPDATE SET
      status='applied',
      promoted_at=datetime('now')
  `).run({
    id: promotionId,
    workbench_id: workbench.id,
    item_id: item?.id || null,
    source_path: sourcePath || '',
    target_type: targetType,
    target_id: targetId,
    target_path: targetPath,
    reviewer,
    change_summary: args.change_summary || 'Reviewed workbench promotion',
    promoted_hash: promotedHash,
    metadata: JSON.stringify(args.metadata || {}),
  });

  if (item?.id) {
    db.prepare(`UPDATE workbench_items SET status='promoted', updated_at=datetime('now') WHERE id = ?`).run(item.id);
  }
  return result;
}

function validateReviewedBody(body = '') {
  const text = String(body);
  if (text.length > 2500) throw new Error('reviewed promotion body is too large; promote compact synthesis only');
  const lines = text.split(/\r?\n/);
  if (lines.length > 80) throw new Error('reviewed promotion body has too many lines; promote compact synthesis only');
}

function assertEntityTarget(db, table, targetId, targetType) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(targetId);
  if (!row) throw new Error(`entity promotion target not found: ${targetType}:${targetId}`);
}

function writeEntityFact(db, { entityType, entityId, factValue, sourcePath }) {
  const value = String(factValue || '').trim();
  if (!value) throw new Error('entity promotion requires compact fact value');
  db.prepare(`
    INSERT INTO entity_facts
      (entity_id, entity_type, fact_type, fact_value, source_event_ids, valid_at, model_tier)
    VALUES
      (?, ?, 'general', ?, ?, datetime('now','utc'), 'sonnet')
  `).run(entityId, entityType, value.slice(0, 2000), JSON.stringify([sourcePath || 'workbench']));
}

function compactBodyForFact(body = '') {
  return String(body)
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function appendOnce(existing, candidate) {
  const marker = candidate.split('\n')[0];
  if (existing.includes(marker)) return existing;
  return `${existing.trimEnd()}\n\n${candidate.trim()}\n`;
}

function parseTarget(target, targetType, targetId) {
  if (targetType && targetId) return [targetType, targetId];
  const raw = String(target || '');
  const match = raw.match(/^(topic|person|company|place):(.+)$/);
  if (!match) throw new Error('promotion target must be target_type/target_id or type:id');
  return [match[1], match[2]];
}

export function loadPromotionSource(path, repoRoot = REPO_ROOT) {
  const abs = resolveRepoPath(path, repoRoot);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}
