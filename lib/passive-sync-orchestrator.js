import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import db from './db.js';
import { secret } from './config.js';
import { classifyPassiveJobDegradation, enqueuePassiveJob, drainPassiveJobs } from './passive-jobs.js';
import { recordIntegrationJobHealth } from './oauth-sync-queue.js';
import { enqueuePipelinesOnDataArrival } from './data-arrival-pipelines.js';
// st_fd14cdd4 AC2: job enumeration derives from the integration registry.
// This module keeps the payload builders and handlers (the "how"); the
// registry declares which jobs exist, their priorities, timeouts, and
// conditions (the "what"). Adding an integration = descriptor + sync module.
import { syncJobEntries } from './integration-registry.js';
import { monarchSyncRunAfter } from './monarch-schedule.js';
export { enqueueIngestOnDataArrival, enqueuePipelinesOnDataArrival } from './data-arrival-pipelines.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIRST_GMAIL_FETCH_LIMIT = 1000;
const DEFAULT_SINCE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_IMESSAGE_SYNC_LIMIT = 500;

export const PASSIVE_SYNC_JOB_TYPES = Object.freeze([
  'oauth_sync',
  'local_sync',
  'granola_sync',
  'granola_call_asana',
  'oura_sync',
  'eight_sleep_sync',
  'asana_sync',
  'notion_sync',
  'imports_snapshot',
  'monarch_sync',
]);

export function monarchSyncRunAfterIso(args) {
  return monarchSyncRunAfter(args);
}

function iso(date = new Date()) {
  return date.toISOString();
}

function dateFrom(value, fallback = new Date(Date.now() - DEFAULT_SINCE_MS)) {
  const d = value ? new Date(value) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sourceEmails(database, vendor, type = null) {
  try {
    const typeClause = type ? 'AND type=?' : '';
    const params = type ? [vendor, type] : [vendor];
    return database.prepare(`
      SELECT DISTINCT email
       FROM accounts
      WHERE vendor=?
         AND status IN ('active', 'connected')
         AND email IS NOT NULL
         AND email != ''
         ${typeClause}
    `).all(...params)
      .map((row) => String(row.email || '').trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function firstSyncEmails(database, vendor, type) {
  try {
    return database.prepare(`
      SELECT DISTINCT email
       FROM accounts
      WHERE vendor=?
         AND type=?
         AND status IN ('active', 'connected')
         AND email IS NOT NULL
         AND email != ''
         AND (synced_at IS NULL OR synced_at = '')
    `).all(vendor, type)
      .map((row) => String(row.email || '').trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hasActiveAccount(database, vendor) {
  try {
    return !!database.prepare(`
      SELECT 1 FROM accounts
       WHERE vendor=?
         AND status IN ('active', 'connected')
       LIMIT 1
    `).get(vendor);
  } catch {
    return false;
  }
}

function makePlan({
  jobType,
  name,
  kind,
  email = null,
  payload = {},
  priority = 50,
  timeoutMs = 120_000,
  maxAttempts = 5,
}) {
  return {
    jobType,
    uniqueKey: `integration:${name}`,
    targetType: 'integration',
    targetId: name,
    priority,
    timeoutMs,
    maxAttempts,
    payload: {
      kind,
      name,
      email,
      ...payload,
    },
    metadata: {
      source: 'passive-sync-orchestrator',
    },
  };
}

// Per-kind payload builders — the only sync-plan knowledge that stays in this
// module. Enumeration (which kinds exist, priorities, timeouts, conditions)
// comes from the registry; payloads need plan-time context (since window,
// first-sync detection) that the registry deliberately does not know about.
const PAYLOAD_BUILDERS = {
  gmail: ({ email, sinceIso, googleFirstMail }) => ({
    since: sinceIso,
    fullSync: googleFirstMail.has(email),
    maxMessages: 100,
    firstFetchLimit: positiveInt(process.env.ROBOTDOJO_FIRST_GMAIL_FETCH_LIMIT, DEFAULT_FIRST_GMAIL_FETCH_LIMIT),
  }),
  calendar: ({ email, sinceIso, googleFirstCalendar }) => ({
    since: sinceIso,
    fullSync: googleFirstCalendar.has(email),
    yearsFuture: 2,
  }),
  contacts: () => ({}),
  photos: ({ sinceIso }) => ({ since: sinceIso, maxItems: 2000 }),
  drive: ({ sinceIso, forceGoogleFull }) => ({
    since: forceGoogleFull ? null : sinceIso,
    maxFiles: forceGoogleFull ? null : 200,
  }),
  'microsoft-mail': ({ sinceIso }) => ({ since: sinceIso, maxMessages: 100 }),
  'microsoft-calendar': () => ({ maxEvents: 500 }),
};

export function planPassiveSyncJobs({
  database = db,
  forceGoogleFull = false,
  sinceDate = new Date(Date.now() - DEFAULT_SINCE_MS),
} = {}) {
  const sinceIso = iso(dateFrom(sinceDate));
  const jobs = [];

  const googleEmails = sourceEmails(database, 'google');
  const buildCtx = {
    sinceIso,
    forceGoogleFull,
    googleFirstMail: new Set((forceGoogleFull ? googleEmails : firstSyncEmails(database, 'google', 'email'))),
    googleFirstCalendar: new Set((forceGoogleFull ? googleEmails : firstSyncEmails(database, 'google', 'calendar'))),
  };
  // Condition context handed to registry job conditions — secrets and account
  // presence are injected so the registry stays import-pure.
  const conditionCtx = {
    secret,
    hasActiveAccount: (vendor) => hasActiveAccount(database, vendor),
  };

  for (const { descriptor, job } of syncJobEntries()) {
    if (typeof job.condition === 'function' && !job.condition(conditionCtx)) continue;

    if (job.perAccount) {
      // Per-account enumeration: active accounts rows by vendor (+type when the
      // job declares one). Microsoft mail enumerates type='email' rows only and
      // calendar type='calendar' only — mail-only mailboxes never plan calendar
      // work (the account-set separation the contract check guards).
      const emails = descriptor.vendor === 'google' && !job.accountType
        ? googleEmails
        : sourceEmails(database, descriptor.vendor, job.accountType);
      const buildPayload = PAYLOAD_BUILDERS[job.kind];
      for (const email of emails) {
        jobs.push(makePlan({
          jobType: job.jobType,
          name: `${job.kind}:${email}`,
          kind: job.kind,
          email,
          priority: job.priority,
          timeoutMs: job.timeoutMs,
          payload: buildPayload ? buildPayload({ email, ...buildCtx }) : { ...(job.payload || {}) },
        }));
      }
      continue;
    }

    jobs.push(makePlan({
      jobType: job.jobType,
      name: job.name || job.kind,
      kind: job.kind,
      priority: job.priority,
      timeoutMs: job.timeoutMs,
      payload: { ...(job.payload || {}) },
    }));
  }

  return jobs;
}

export function enqueuePassiveSyncJobs({
  database = db,
  forceGoogleFull = false,
  sinceDate = new Date(Date.now() - DEFAULT_SINCE_MS),
} = {}) {
  const planned = planPassiveSyncJobs({ database, forceGoogleFull, sinceDate });

  // Bulk-fetch last success/failure for oauth_sync (hourly) and monarch_sync (Saturday AM).
  const existingRows = database.prepare(
    `SELECT unique_key, job_type, last_success_at, last_failure_at
       FROM passive_jobs
      WHERE job_type IN ('oauth_sync', 'monarch_sync')`
  ).all();
  const stampMap = new Map(existingRows.map(r => [r.unique_key, r]));

  const queued = [];
  for (const job of planned) {
    let runAfter;
    if (job.jobType === 'oauth_sync') {
      const prev = stampMap.get(job.uniqueKey)?.last_success_at || null;
      runAfter = prev
        ? new Date(Date.parse(prev) + 3_600_000).toISOString()
        : new Date().toISOString();
    } else if (job.jobType === 'monarch_sync') {
      const row = stampMap.get(job.uniqueKey) || {};
      runAfter = monarchSyncRunAfterIso({
        lastSuccessAt: row.last_success_at || null,
        lastFailureAt: row.last_failure_at || null,
      });
    }
    const recoverTimedOutLocalSync = job.jobType === 'local_sync' && shouldReviveTimedOutLocalSync(database, job.uniqueKey);
    const recoverStarvedLocalSync = job.jobType === 'local_sync' && shouldReviveStarvedLocalSync(database, job.uniqueKey);
    const recoverQuarantinedConnector = shouldReviveQuarantinedConnectorSync(database, job);
    queued.push(enqueuePassiveJob({
      database,
      ...job,
      ...(runAfter !== undefined ? { runAfter } : {}),
      requeueDone: true,
      requeueQuarantined: recoverTimedOutLocalSync || recoverStarvedLocalSync || recoverQuarantinedConnector,
    }));
  }
  return { planned, queued };
}

function shouldReviveStarvedLocalSync(database, uniqueKey) {
  // Deadline quarantine of a local reader that never actually ran (attempts=0,
  // no last_error) is starvation, not a broken reader. Revive so Apple
  // Calendar / Calls / Notes / Photos keep compounding instead of dying after
  // one idle week.
  try {
    const row = database.prepare(`
      SELECT status, last_error, quarantine_reason
        FROM passive_jobs
       WHERE unique_key = ?
       LIMIT 1
    `).get(uniqueKey);
    if (!row || row.status !== 'quarantined') return false;
    if (row.last_error) return false;
    return /deadline:\s*no success since|attempts=0\//i.test(String(row.quarantine_reason || ''));
  } catch {
    return false;
  }
}

function shouldReviveTimedOutLocalSync(database, uniqueKey) {
  try {
    const row = database.prepare(`
      SELECT status, last_error, quarantine_reason
        FROM passive_jobs
       WHERE unique_key = ?
       LIMIT 1
    `).get(uniqueKey);
    if (!row || row.status !== 'quarantined') return false;
    return /ETIMEDOUT|timed out/i.test(`${row.last_error || ''}\n${row.quarantine_reason || ''}`);
  } catch {
    return false;
  }
}

function shouldReviveQuarantinedConnectorSync(database, job) {
  if (!job?.uniqueKey) return false;
  try {
    const row = database.prepare(`
      SELECT job_type, unique_key, target_id, status, last_error, quarantine_reason
        FROM passive_jobs
       WHERE unique_key = ?
       LIMIT 1
    `).get(job.uniqueKey);
    if (!row || row.status !== 'quarantined') return false;
    const degradation = classifyPassiveJobDegradation(row);
    return degradation.action === 'provider_or_network_degraded';
  } catch {
    return false;
  }
}

// st_bf4978b0 — extended to catch a permanently-dead scope (403 PERMISSION_DENIED,
// e.g. photoslibrary.readonly removed by Google since 2025-03-31). Without this,
// the connectivity reconciler would futilely re-enqueue a dead scope every
// cadence instead of letting it settle as a stable Issue. Exported so the
// connectivity reconciler and the anti-regression guard share one predicate.
export function permanentCredentialError(message) {
  return /auth_required|invalid_grant|interaction_required|no refresh token|no_token|re-auth|required|scope not granted|unauthorized|forbidden|permission_denied|removed[_ -]?scope|\b403\b/i.test(String(message || ''));
}

function throwIfResultFailed(result, label) {
  const message = result?.error
    || (Array.isArray(result?.errors) && result.errors.length ? result.errors.join('; ') : null);
  if (!message) return;
  const err = new Error(`${label}: ${message}`);
  if (permanentCredentialError(message)) err.quarantine = true;
  throw err;
}

function recordJobHealth(database, name, status, opts = {}) {
  return recordIntegrationJobHealth(database, name, status, { ...opts, mirrorLedger: false });
}

async function runIntegrationJob(job, fn) {
  const name = job.target_id || job.payload?.name;
  recordJobHealth(db, name, 'running');
  try {
    const result = await fn();
    throwIfResultFailed(result, name);
    recordJobHealth(db, name, 'ok');
    return result || { ok: true };
  } catch (err) {
    recordJobHealth(db, name, permanentCredentialError(err.message) ? 'needs_permission' : 'error', { error: err.message });
    throw err;
  }
}

export function buildPassiveSyncHandlers({
  signal = null,
  syncIMessage: syncIMessageOverride = null,
  syncApplePhotosMetadata: syncApplePhotosMetadataOverride = null,
} = {}) {
  return {
    oauth_sync: async (job) => {
      const { syncGmailAccount } = await import('./gmail-sync.js');
      const { syncCalendarAccount } = await import('./calendar-sync.js');
      const { syncDriveAccount } = await import('./drive-sync.js');
      const { syncOutlookAccount } = await import('./outlook-sync.js');
      const { syncGraphCalendarAccount } = await import('./graph-calendar-sync.js');
      const { syncContactsAccount } = await import('./google-contacts-sync.js');
      const { syncGooglePhotosAccount } = await import('./google-photos-sync.js');
      const { kind, email } = job.payload || {};
      if (signal?.aborted) throw new DOMException('sync aborted', 'AbortError');
      if (!email) throw new Error('oauth sync job missing email');
      return runIntegrationJob(job, async () => {
        if (kind === 'gmail') {
          return syncGmailAccount(email, {
            fullSync: !!job.payload.fullSync,
            since: job.payload.fullSync ? null : dateFrom(job.payload.since),
            maxMessages: job.payload.fullSync ? null : (job.payload.maxMessages || 100),
            maxFetchMessages: job.payload.fullSync ? (job.payload.firstFetchLimit || DEFAULT_FIRST_GMAIL_FETCH_LIMIT) : null,
          });
        }
        if (kind === 'calendar') {
          return syncCalendarAccount(email, {
            fullSync: !!job.payload.fullSync,
            since: job.payload.fullSync ? null : dateFrom(job.payload.since),
            yearsFuture: job.payload.yearsFuture || 2,
          });
        }
        if (kind === 'drive') {
          return syncDriveAccount(email, {
            sinceDate: job.payload.since ? dateFrom(job.payload.since) : null,
            maxFiles: job.payload.maxFiles ?? 200,
          });
        }
        if (kind === 'contacts') return syncContactsAccount(email);
        if (kind === 'photos') return syncGooglePhotosAccount(email, { sinceDate: dateFrom(job.payload.since), maxItems: job.payload.maxItems || 2000 });
        if (kind === 'microsoft-mail') return syncOutlookAccount(email, { sinceDate: dateFrom(job.payload.since), maxMessages: job.payload.maxMessages || 100 });
        if (kind === 'microsoft-calendar') return syncGraphCalendarAccount(email, { maxEvents: job.payload.maxEvents || 500 });
        throw new Error(`unknown oauth sync kind: ${kind}`);
      });
    },

    local_sync: async (job) => {
      const kind = job.payload?.kind;
      return runIntegrationJob(job, async () => {
        if (kind === 'imessage') {
          const syncIMessage = syncIMessageOverride || (await import('./imessage.js')).syncIMessage;
          return syncIMessage({ limit: positiveInt(job.payload?.limit, DEFAULT_IMESSAGE_SYNC_LIMIT) });
        }
        if (kind === 'apple-photos') {
          const syncApplePhotosMetadata = syncApplePhotosMetadataOverride || (await import('../scripts/sync-apple-photos-metadata.js')).syncApplePhotosMetadata;
          return syncApplePhotosMetadata({ limit: positiveInt(job.payload?.limit, 1000) });
        }
        // st_fd14cdd4 Phase 2: Apple local readers run continuously as
        // low-priority passive jobs (registry-conditioned on store presence),
        // not only at onboard. In-process calls — the readers are bounded
        // read-only SQLite scans that no-op gracefully and stamp their own
        // stats; a child process would only add spawn overhead.
        if (kind === 'apple-calendar') {
          const { syncAppleCalendar } = await import('./apple-calendar-reader.js');
          return syncAppleCalendar();
        }
        if (kind === 'apple-mail') {
          const { syncAppleMail } = await import('./apple-mail-reader.js');
          return syncAppleMail();
        }
        if (kind === 'apple-calls') {
          const { syncAppleCalls } = await import('./apple-calls-reader.js');
          return syncAppleCalls();
        }
        if (kind === 'apple-notes') {
          const { syncAppleNotes } = await import('./apple-notes-reader.js');
          return syncAppleNotes();
        }
        throw new Error(`unknown local sync kind: ${kind}`);
      });
    },

    granola_sync: async (job) => {
      const { syncGranola } = await import('./granola-sync.js');
      return runIntegrationJob(job, () => syncGranola());
    },

    granola_call_asana: async (job) => {
      const { createGranolaCallAsanaTask } = await import('./granola-call-asana.js');
      const transcriptId = job.payload?.transcriptId || job.target_id;
      return createGranolaCallAsanaTask({ database: db, transcriptId });
    },

    oura_sync: async (job) => {
      const { syncOuraLatest } = await import('./oura-sync.js');
      return runIntegrationJob(job, () => syncOuraLatest());
    },

    eight_sleep_sync: async (job) => {
      const { syncEightSleepLatest } = await import('./eight-sleep-sync.js');
      return runIntegrationJob(job, () => syncEightSleepLatest());
    },

    asana_sync: async (job) => {
      const { syncAsanaContext } = await import('./asana-context-sync.js');
      const provider = job.payload?.provider || job.target_id || 'asana';
      const token = provider === 'asana_secondary' ? secret('ASANA_PAT_SECONDARY') : secret('ASANA_PAT');
      return runIntegrationJob(job, () => syncAsanaContext({ token, provider, limit: 100 }));
    },

    notion_sync: async (job) => {
      const { pushTopicsToNotion } = await import('./notion-sync.js');
      return runIntegrationJob(job, () => pushTopicsToNotion({ maxTopics: job.payload?.maxTopics || 25 }));
    },

    imports_snapshot: async (job) => {
      const { computeImportsSnapshot } = await import('./imports-snapshot.js');
      return runIntegrationJob(job, () => computeImportsSnapshot());
    },

    monarch_sync: async (job) => {
      const { syncMonarch } = await import('./monarch-sync.js');
      return runIntegrationJob(job, async () => {
        const result = await syncMonarch();
        if (result && result.promoted === false) {
          // Pulled but not promoted: fail the job so last_success (the Saturday
          // clock) is not stamped. last_failure_at drives the 24h backoff.
          const err = new Error(`monarch pull not promoted: ${result.reason || 'suspect'}`);
          err.code = 'MONARCH_NOT_PROMOTED';
          throw err;
        }
        if (result && result.ok === false) {
          throw new Error(result.error || result.reason || 'monarch sync failed');
        }
        return result || { ok: true };
      });
    },
  };
}

// st_fd14cdd4 AC5/AC8 (Key decision 7) — inbound-data syncs trigger the shared
// data-arrival replay. Notion is outbound and imports_snapshot is a UI cache
// recompute, so neither lands pipeline-relevant rows. We trigger on any
// completed data-bearing sync rather than parsing per-handler "rows written"
// counts: handler result shapes are not uniform, and a false-positive costs
// bounded idle-gated slices that find nothing.
const DATA_ARRIVAL_SYNC_TYPES = new Set(['oauth_sync', 'local_sync', 'granola_sync', 'monarch_sync']);

export async function drainPassiveSyncJobs({
  database = db,
  worker = 'sync',
  limit = positiveInt(process.env.ROBOTDOJO_SYNC_DRAIN_LIMIT, 8),
  jobTypes = PASSIVE_SYNC_JOB_TYPES,
  signal = null,
  idleCheck = null,
  // df_02d633dc — forwarded unchanged into drainPassiveJobs. Default null keeps
  // the legacy ordering; scripts/sync.js passes 'round_robin_by_type'.
  fairnessMode = null,
} = {}) {
  const results = await drainPassiveJobs({
    database,
    worker,
    jobTypes,
    handlers: buildPassiveSyncHandlers({ signal }),
    limit,
    idleCheck,
    fairnessMode,
  });
  try {
    const landed = results.some((r) => r?.ok && DATA_ARRIVAL_SYNC_TYPES.has(r?.job?.job_type));
    if (landed) enqueuePipelinesOnDataArrival(database, { source: 'passive-sync-data-arrival' });
  } catch (err) {
    // The trigger is an accelerator, never a sync failure: the 15-min
    // freshness floor / daily replay catches anything missed.
    console.warn('[passive-sync] data-arrival pipeline enqueue failed:', err.message);
  }
  return results;
}
