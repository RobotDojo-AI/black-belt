import db from './db.js';
import { enqueuePassiveJob } from './passive-jobs.js';
import { getRoutine } from './maintenance-routines.js';
import { maintSliceSecondsFor, maintTimeoutMsFor } from './passive-maintenance-handlers.js';

export const DATA_ARRIVAL_PIPELINES = Object.freeze([
  'pipeline_ingest',
  'maint_memory_recalc',
  'maint_timeline_recalc',
]);
// Context/enrichment is intentionally chained after pipeline_entities
// completion in lib/passive-maintenance-handlers.js. Raw data arrival is too
// early: topic/entity context should synthesize over the current graph.
export const DATA_ARRIVAL_MEMORY_LANES = Object.freeze([
  'immutable-event-log',
  'source-enrichment',
  'workbench-replay',
  'snapshot-reconstruction',
  'conflict-detection',
  'context-packing',
]);
const DATA_ARRIVAL_DEBOUNCE_MS = Number(process.env.ROBOTDOJO_INGEST_DEBOUNCE_MS || 2 * 60_000);

function payloadForRoutine(routine) {
  const payload = {
    phase: routine.phase,
    maxSeconds: maintSliceSecondsFor(routine),
    trigger: 'data-arrival',
  };
  if (routine.id === 'maint_memory_recalc' || routine.jobType === 'maint_memory_recalc') {
    payload.pipeline = 'precision-memory';
    payload.lanes = [...DATA_ARRIVAL_MEMORY_LANES];
  }
  return payload;
}

export function enqueuePipelinesOnDataArrival(database = db, options = {}) {
  const activeDb = database || db;
  const source = options.source || 'data-arrival';
  const runAfter = new Date(Date.now() + DATA_ARRIVAL_DEBOUNCE_MS).toISOString();
  const queued = [];
  for (const jobType of DATA_ARRIVAL_PIPELINES) {
    const routine = getRoutine(jobType);
    if (!routine) continue;
    queued.push(enqueuePassiveJob({
      database: activeDb,
      jobType: routine.jobType,
      uniqueKey: `${routine.jobType}:data-arrival`,
      targetType: 'system',
      targetId: routine.targetId || 'maintenance',
      priority: routine.priority,
      timeoutMs: maintTimeoutMsFor(routine),
      runAfter,
      payload: payloadForRoutine(routine),
      metadata: { source },
      requeueDone: true,
    }));
  }
  return queued;
}

export function enqueueIngestOnDataArrival(database = db, options = {}) {
  return enqueuePipelinesOnDataArrival(database, options)
    .find((job) => job?.job_type === 'pipeline_ingest') || null;
}
