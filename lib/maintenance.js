import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT } from './workbench-files.js';

export const DEFAULT_FIRST_IMPORT_BUDGET_CENTS = 2500;
export const DEFAULT_TOP_ENTITIES_PER_TYPE = 100;

export function loadMaintenanceRegistry(repoRoot = REPO_ROOT) {
  return JSON.parse(readFileSync(resolve(repoRoot, 'config/background-routines.json'), 'utf8'));
}

export function validateMaintenanceRegistry(registry) {
  const errors = [];
  if (!registry || !Array.isArray(registry.routines)) errors.push('registry.routines must be an array');
  const ids = new Set();
  for (const routine of registry?.routines || []) {
    for (const field of ['id', 'kind', 'owner', 'entrypoint', 'trigger', 'writes', 'overlap_guard', 'failure_policy', 'status_surface']) {
      if (routine[field] === undefined || routine[field] === null || routine[field] === '') errors.push(`${routine.id || '<unknown>'}: missing ${field}`);
    }
    if (ids.has(routine.id)) errors.push(`${routine.id}: duplicate routine id`);
    ids.add(routine.id);
    if (!Array.isArray(routine.writes)) errors.push(`${routine.id}: writes must be an array`);
    if (!Array.isArray(routine.log_paths)) errors.push(`${routine.id}: log_paths must be an array`);
    for (const key of ['canonical_context_writer', 'rag_writer', 'backup_writer', 'launch_required']) {
      if (typeof routine[key] !== 'boolean') errors.push(`${routine.id}: ${key} must be boolean`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function stableJobId(parts) {
  return 'mj_' + crypto.createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 16);
}

export function markMaintenanceDirty(db, {
  targetType,
  targetId,
  jobType = 'context_refresh',
  reason,
  priority = 50,
  policyTier = 'auto',
  budgetCents = DEFAULT_FIRST_IMPORT_BUDGET_CENTS,
  metadata = {},
} = {}) {
  if (!targetType || !targetId || !reason) throw new Error('maintenance dirty marker requires targetType, targetId, and reason');
  const id = stableJobId([targetType, targetId, jobType, reason]);
  db.prepare(`
    INSERT INTO maintenance_queue
      (id, target_type, target_id, job_type, reason, priority, policy_tier, budget_cents, metadata, queued_at, updated_at)
    VALUES
      (@id, @targetType, @targetId, @jobType, @reason, @priority, @policyTier, @budgetCents, @metadata, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      priority=max(priority, excluded.priority),
      policy_tier=excluded.policy_tier,
      budget_cents=excluded.budget_cents,
      metadata=excluded.metadata,
      status=CASE WHEN status IN ('done', 'skipped', 'failed') THEN 'queued' ELSE status END,
      updated_at=datetime('now')
  `).run({
    id,
    targetType,
    targetId: String(targetId),
    jobType,
    reason,
    priority,
    policyTier,
    budgetCents,
    metadata: JSON.stringify(metadata || {}),
  });

  if (targetType === 'topic') {
    db.prepare("UPDATE user_topics SET needs_regen = 1, updated_at = datetime('now') WHERE slug = ?").run(String(targetId));
  } else if (targetType === 'person') {
    db.prepare("UPDATE people SET needs_regen = 1 WHERE id = ?").run(String(targetId));
  } else if (targetType === 'company') {
    db.prepare("UPDATE companies SET needs_regen = 1 WHERE id = ?").run(String(targetId));
  } else if (targetType === 'place') {
    db.prepare("UPDATE places SET needs_regen = 1 WHERE id = ?").run(String(targetId));
  }

  return { id, target_type: targetType, target_id: String(targetId), job_type: jobType, reason };
}

export function recordMaintenanceLedger(db, {
  jobId = null,
  routineId,
  targetType,
  targetId,
  action,
  status = 'planned',
  artifactPath = '',
  artifactHash = '',
  costCents = 0,
  metadata = {},
} = {}) {
  if (!routineId || !targetType || !targetId || !action) throw new Error('maintenance ledger requires routineId, targetType, targetId, and action');
  return db.prepare(`
    INSERT INTO maintenance_ledger
      (job_id, routine_id, target_type, target_id, action, status, artifact_path, artifact_hash, cost_cents, metadata)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, routineId, targetType, String(targetId), action, status, artifactPath, artifactHash, costCents, JSON.stringify(metadata || {}));
}

export function entityDensity(entity = {}) {
  return Number(entity.linked_chunks || 0)
    + Number(entity.timeline_events || 0)
    + Number(entity.distinct_sources || 0) * 3
    + Number(entity.recent_interactions || 0) * 2
    + Number(entity.explicit_mentions || 0) * 4;
}

export function planEnrichment({
  topics = [],
  entities = { people: [], companies: [], places: [] },
  budgetCents = DEFAULT_FIRST_IMPORT_BUDGET_CENTS,
  topPerType = DEFAULT_TOP_ENTITIES_PER_TYPE,
  batch = true,
} = {}) {
  const jobs = [];
  const addJob = (kind, id, tier, inputTokens, outputTokens, reason) => {
    const cost = estimateContextCostCents({ tier, inputTokens, outputTokens, batch });
    jobs.push({ kind, id: String(id), tier, inputTokens, outputTokens, estimated_cost_cents: cost, reason });
  };

  for (const topic of topics) {
    addJob('topic', topic.slug || topic.id, 'sonnet', topic.input_tokens || 8000, topic.output_tokens || 1000, 'all-topics-sonnet');
  }

  const entityKindMap = { people: 'person', companies: 'company', places: 'place' };
  for (const [kind, rows] of Object.entries(entities)) {
    const sorted = [...rows].sort((a, b) => entityDensity(b) - entityDensity(a));
    sorted.forEach((entity, idx) => {
      const type = entityKindMap[kind] || kind.replace(/s$/, '');
      if (idx < topPerType) addJob(type, entity.id, 'sonnet', entity.input_tokens || 8000, entity.output_tokens || 1000, 'top-density-sonnet');
      else if (entityDensity(entity) > 5) addJob(type, entity.id, 'haiku', entity.input_tokens || 3000, entity.output_tokens || 600, 'middle-density-haiku');
      else addJob(type, entity.id, 'cpu', 0, 0, 'long-tail-cpu');
    });
  }

  let running = 0;
  for (const job of jobs) {
    if (job.tier === 'cpu') {
      job.status = 'planned';
      continue;
    }
    if (running + job.estimated_cost_cents <= budgetCents) {
      running += job.estimated_cost_cents;
      job.status = 'planned';
    } else {
      job.status = 'blocked_budget';
    }
  }

  return {
    budget_cents: budgetCents,
    batch,
    estimated_cost_cents: Math.round(running * 100) / 100,
    jobs,
    counts: jobs.reduce((acc, job) => {
      acc[job.tier] = (acc[job.tier] || 0) + 1;
      return acc;
    }, {}),
    blocked: jobs.filter(j => j.status === 'blocked_budget').length,
  };
}

export function estimateContextCostCents({ tier, inputTokens = 0, outputTokens = 0, batch = true }) {
  if (tier === 'cpu') return 0;
  const rates = {
    sonnet: { input: 3, output: 15 },
    haiku: { input: 0.8, output: 4 },
  }[tier] || { input: 3, output: 15 };
  const discount = batch ? 0.5 : 1;
  return ((inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output) * 100 * discount;
}

export function queueTrendingUpgrade(db, { targetType, targetId, activityScore = 0, budgetCents = DEFAULT_FIRST_IMPORT_BUDGET_CENTS, metadata = {} }) {
  if (!['topic', 'person', 'company', 'place'].includes(targetType)) throw new Error(`unsupported trending target: ${targetType}`);
  const threshold = targetType === 'topic' ? 3 : 5;
  if (activityScore < threshold) return { queued: false, reason: 'below-threshold' };
  const job = markMaintenanceDirty(db, {
    targetType,
    targetId,
    jobType: 'context_refresh',
    reason: 'trending-upgrade',
    priority: 90,
    policyTier: 'sonnet',
    budgetCents,
    metadata: { ...metadata, activityScore },
  });
  recordMaintenanceLedger(db, {
    jobId: job.id,
    routineId: 'maintenance-planner',
    targetType,
    targetId,
    action: 'queue-trending-sonnet-upgrade',
    status: 'planned',
    metadata: { activityScore },
  });
  return { queued: true, job };
}
