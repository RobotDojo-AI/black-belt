// lib/viewer-corrections.js - typed correction events from rich viewer pages.
//
// Viewer text is a projection. Corrections must land as source events so later
// summary/timeline regeneration is constrained by explicit user truth.
import crypto from 'node:crypto';
import { appendMemoryEvent, listMemoryEvents, stableJson } from './memory-events.js';
import { enqueuePassiveJob } from './passive-jobs.js';
import { getRoutine } from './maintenance-routines.js';

const TARGET_TYPE_ALIASES = {
  people: 'person',
  persons: 'person',
  person: 'person',
  companies: 'company',
  company: 'company',
  places: 'place',
  place: 'place',
  topics: 'topic',
  topic: 'topic',
  workbenches: 'workbench',
  workbench: 'workbench',
  agents: 'agent',
  agent: 'agent',
  entity: 'entity',
  document: 'document',
};

const SECTION_ALIASES = {
  'current-read': '1k_summary',
  current_read: '1k_summary',
  '1k': '1k_summary',
  '1k_summary': '1k_summary',
  'working-brief': '4k_summary',
  working_brief: '4k_summary',
  '4k': '4k_summary',
  '4k_summary': '4k_summary',
  timeline: 'timeline',
  metadata: 'metadata',
};

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function text(value) {
  return String(value ?? '').trim();
}

function normalizeTargetType(value) {
  const key = text(value).toLowerCase().replace(/\s+/g, '_');
  return TARGET_TYPE_ALIASES[key] || key || 'document';
}

function normalizeSection(value) {
  const key = text(value).toLowerCase().replace(/\s+/g, '_');
  return SECTION_ALIASES[key] || key || 'document';
}

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

function updateIfAvailable(db, table, sql, params = []) {
  if (!hasTable(db, table)) return { skipped: true, reason: `${table}_missing` };
  return db.prepare(sql).run(...params);
}

function enqueueRoutineIfAvailable(db, jobType, {
  targetType = 'system',
  targetId = 'maintenance',
  reason = 'viewer-correction',
  payload = {},
} = {}) {
  if (!hasTable(db, 'passive_jobs')) return null;
  const routine = getRoutine(jobType) || { jobType, priority: 50, maxSeconds: 300 };
  return enqueuePassiveJob({
    database: db,
    jobType: routine.jobType,
    uniqueKey: `${routine.jobType}:viewer-correction:${targetType}:${targetId}`,
    targetType,
    targetId,
    priority: Math.max(Number(routine.priority || 50), 55),
    timeoutMs: Number(routine.maxSeconds || 300) * 1000,
    payload: {
      phase: routine.phase || null,
      trigger: 'viewer-correction',
      reason,
      ...payload,
    },
    metadata: { source: 'viewer-corrections' },
    requeueDone: true,
    requeueQuarantined: true,
  });
}

function applyViewerCorrectionInvalidation(db, correction) {
  const invalidation = { dirty: [], jobs: [], errors: [] };
  const targetType = normalizeTargetType(correction.target_type);
  const targetId = text(correction.target_id || correction.target_url);

  const run = (label, fn) => {
    try {
      const result = fn();
      if (result) invalidation.dirty.push(label);
      return result;
    } catch (err) {
      invalidation.errors.push({ label, error: err?.message || String(err) });
      return null;
    }
  };
  const queue = (jobType, options = {}) => {
    try {
      const job = enqueueRoutineIfAvailable(db, jobType, options);
      if (job) invalidation.jobs.push({ job_type: job.job_type, target_type: job.target_type, target_id: job.target_id });
      return job;
    } catch (err) {
      invalidation.errors.push({ label: `queue:${jobType}`, error: err?.message || String(err) });
      return null;
    }
  };

  if (targetType === 'topic' && targetId) {
    run('topic.needs_regen', () => {
      if (!hasTable(db, 'user_topics') || !hasColumn(db, 'user_topics', 'needs_regen')) return null;
      const result = db.prepare("UPDATE user_topics SET needs_regen = 1, updated_at = datetime('now') WHERE slug = ?").run(targetId);
      return result.changes ? result : null;
    });
    queue('maint_topics', { targetType: 'topic', targetId, reason: 'viewer correction changed topic projection' });
  } else if (['person', 'company', 'place'].includes(targetType) && targetId) {
    const table = targetType === 'person' ? 'people' : targetType === 'company' ? 'companies' : 'places';
    run(`${targetType}.needs_regen`, () => {
      if (!hasTable(db, table) || !hasColumn(db, table, 'needs_regen')) return null;
      const result = db.prepare(`UPDATE ${table} SET needs_regen = 1 WHERE id = ?`).run(targetId);
      return result.changes ? result : null;
    });
    queue('maint_enrich', { targetType, targetId, reason: 'viewer correction changed entity projection' });
  } else if (targetType === 'workbench' && targetId) {
    run('workbench.activity', () => updateIfAvailable(db, 'workbenches', `
      UPDATE workbenches
         SET updated_at = datetime('now'),
             last_activity_at = datetime('now')
       WHERE id = ?
    `, [targetId]));
  }

  if (targetId && ['topic', 'person', 'company', 'place', 'workbench'].includes(targetType)) {
    queue('maint_memory_recalc', {
      targetType,
      targetId,
      reason: 'viewer correction changed rendered memory projection',
      payload: {
        corrected_target_type: targetType,
        corrected_target_id: targetId,
        section: correction.section,
      },
    });
  }

  return invalidation;
}

export function normalizeViewerCorrection(input = {}, options = {}) {
  const targetType = normalizeTargetType(input.target_type || input.targetType || input.kind);
  const targetUrl = text(input.target_url || input.targetUrl || input.url);
  const targetId = text(input.target_id || input.targetId || input.entity_id || input.topic_slug || input.workbench_id || targetUrl);
  const correctionText = text(input.correction_text || input.correctionText || input.text || input.message);

  if (!targetType) throw Object.assign(new Error('target_type_required'), { status: 400 });
  if (!targetId && !targetUrl) throw Object.assign(new Error('target_required'), { status: 400 });
  if (options.requireCorrectionText && !correctionText) {
    throw Object.assign(new Error('correction_text_required'), { status: 400 });
  }

  return {
    mode: 'viewer_correction',
    target_type: targetType,
    target_id: targetId || targetUrl,
    target_url: targetUrl,
    target_title: text(input.target_title || input.targetTitle || input.title),
    section: normalizeSection(input.section || input.section_id || input.sectionId),
    claim_text: text(input.claim_text || input.claimText || input.claim),
    correction_text: correctionText,
    source_ref: text(input.source_ref || input.sourceRef || input.source),
    viewer_version: text(input.viewer_version || input.viewerVersion || 'viewer-rich-20260623-3'),
  };
}

export function recordViewerCorrection(db, input = {}, options = {}) {
  const correction = normalizeViewerCorrection(input, { requireCorrectionText: true });
  const targetId = correction.target_id || correction.target_url;
  const idempotencyKey = sha256(stableJson({
    target_type: correction.target_type,
    target_id: targetId,
    target_url: correction.target_url,
    section: correction.section,
    claim_text: correction.claim_text,
    correction_text: correction.correction_text,
    source_ref: correction.source_ref,
  }));
  const links = [];
  if (correction.target_url) {
    links.push({ targetType: 'viewer_url', targetId: correction.target_url, role: 'source' });
  }
  if (correction.source_ref) {
    links.push({ targetType: 'source_ref', targetId: correction.source_ref, role: 'corrects' });
  }

  const result = appendMemoryEvent(db, {
    streamType: `viewer_correction.${correction.target_type}`,
    streamId: `${targetId}:${correction.section}`,
    eventType: 'viewer.correction.recorded',
    actor: options.actor || 'user',
    source: 'viewer.corrections',
    subjectType: correction.target_type,
    subjectId: targetId,
    validAt: options.validAt || input.valid_at || input.validAt,
    recordedAt: options.recordedAt || input.recorded_at || input.recordedAt,
    idempotencyKey,
    payload: correction,
    links,
  });
  const invalidation = applyViewerCorrectionInvalidation(db, correction);

  return {
    inserted: !!result.inserted,
    eventId: result.event?.event_id || null,
    event: result.event,
    correction,
    invalidation,
  };
}

export function viewerCorrectionSummary(eventOrCorrection = {}) {
  const payload = eventOrCorrection.payload || eventOrCorrection;
  const correctionText = text(payload.correction_text || payload.correctionText || payload.text);
  if (!correctionText) return '';
  const bits = [];
  const section = normalizeSection(payload.section || payload.section_id || payload.sectionId);
  if (section) bits.push(`Section: ${section}.`);
  if (payload.claim_text || payload.claimText) bits.push(`Claim corrected: ${text(payload.claim_text || payload.claimText)}.`);
  bits.push(`Correction: ${correctionText}`);
  if (payload.source_ref || payload.sourceRef) bits.push(`Source: ${text(payload.source_ref || payload.sourceRef)}.`);
  return bits.join(' ');
}

export function listViewerCorrections(db, {
  targetType,
  targetId,
  targetUrl = '',
  limit = 20,
} = {}) {
  const normalizedType = normalizeTargetType(targetType);
  const normalizedId = text(targetId);
  const rows = [];
  if (normalizedType && normalizedId) {
    rows.push(...listMemoryEvents(db, {
      eventType: 'viewer.correction.recorded',
      targetType: normalizedType,
      targetId: normalizedId,
      limit,
    }));
  }
  if (targetUrl) {
    rows.push(...listMemoryEvents(db, {
      eventType: 'viewer.correction.recorded',
      targetType: 'viewer_url',
      targetId: targetUrl,
      limit,
    }));
  }

  const seen = new Set();
  return rows
    .filter((row) => {
      if (!row?.event_id || seen.has(row.event_id)) return false;
      seen.add(row.event_id);
      return true;
    })
    .sort((a, b) => String(b.valid_at || '').localeCompare(String(a.valid_at || '')))
    .slice(0, Math.max(1, Math.min(Number(limit || 20), 200)))
    .map((row) => ({
      event_id: row.event_id,
      valid_at: row.valid_at,
      recorded_at: row.recorded_at,
      actor: row.actor,
      target_type: row.subject_type,
      target_id: row.subject_id,
      summary: viewerCorrectionSummary(row),
      ...row.payload,
    }));
}
