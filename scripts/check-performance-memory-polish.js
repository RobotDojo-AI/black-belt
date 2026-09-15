#!/usr/bin/env node
/**
 * Registration + performance contract check (st_fd14cdd4 AC4).
 *
 * Asserts the integration registration contract across its derived surfaces:
 * OAuth callbacks queue (never inline-sync), the passive orchestrator
 * enumerates and clears queued work, Microsoft account sets stay typed, and —
 * since st_fd14cdd4 — every surface derives from lib/integration-registry.js
 * (bidirectional: a descriptor without a surface is red, a surface entry
 * without a descriptor is red).
 *
 * Enforced in scripts/pre-commit.sh and npm test (tests/registration-contract
 * .test.js runs it green on the real tree and proves a deliberate violation
 * turns it red). History: the pre-st_fd14cdd4 version asserted literals in
 * scripts/sync.js that st_27561b77 moved into lib/passive-sync-orchestrator.js,
 * leaving the checker dead-red and unwired — the exact failure mode AC4 bans.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function must(path, pattern, message) {
  const text = read(path);
  if (pattern instanceof RegExp ? !pattern.test(text) : !text.includes(pattern)) {
    failures.push(`${path}: ${message}`);
  }
}

function mustNot(path, pattern, message) {
  const text = read(path);
  if (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern)) {
    failures.push(`${path}: ${message}`);
  }
}

function mustExist(path) {
  if (!existsSync(join(root, path))) failures.push(`${path}: missing`);
}

mustExist('lib/oauth-sync-queue.js');
must('lib/oauth-sync-queue.js', 'queueOAuthSync', 'OAuth sync queue helper must exist');
must('lib/oauth-sync-queue.js', 'queueIntegrationJobs', 'API-key source connections must queue background import jobs');
must('lib/oauth-sync-queue.js', 'recordIntegrationJobHealth', 'background workers must clear queued import jobs');
must('lib/oauth-sync-queue.js', 'recordAccountIntegrationJobResult', 'background workers must clear per-account queued jobs without aggregate masking');
must('lib/oauth-sync-queue.js', "status = 'queued'", 'queued sync state must be written to integration_health');
must('lib/oauth-sync-queue.js', 'backgroundStateFromHealth', 'background health rows must translate to product states');

must('routes/oauth.js', 'queueOAuthSync(db, \'google\', email)', 'Google callback must queue sync after token storage');
mustNot('routes/oauth.js', 'ingest-orchestrator', 'Google callback must not emit heavy ingest work inline');
mustNot('routes/oauth.js', 'syncGmailAccount(email', 'Google callback must not run Gmail sync inline');
mustNot('routes/oauth.js', 'syncCalendarAccount(email', 'Google callback must not run Calendar sync inline');
mustNot('routes/oauth.js', 'setImmediate(() =>', 'Google callback must not hide inline sync behind setImmediate');

must('routes/oauth-microsoft.js', 'queueOAuthSync(db, \'microsoft\', email)', 'Microsoft callback must queue sync after token storage');
must('routes/oauth-microsoft.js', 'upsertMicrosoftAccounts(db, email', 'Microsoft callback must make the account visible without sync');
mustNot('routes/oauth-microsoft.js', 'syncOutlookAccount(email', 'Microsoft callback must not run Outlook sync inline');
mustNot('routes/oauth-microsoft.js', 'syncGraphCalendarAccount', 'Microsoft callback must not run Graph Calendar sync inline');

const accounts = read('routes/accounts.js');
const importsRouteMatch = accounts.match(/routes\.get\('\/api\/accounts\/imports'[\s\S]*?\n\}\);/);
if (!importsRouteMatch) {
  failures.push('routes/accounts.js: imports route not found');
} else {
  const importsRoute = importsRouteMatch[0]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  for (const forbidden of ['computeImportsSnapshot', 'syncAll', 'checkpoint', 'VACUUM', 'optimize', 'embed']) {
    if (importsRoute.includes(forbidden)) {
      failures.push(`routes/accounts.js: imports polling route must not start ${forbidden}`);
    }
  }
}
const importsRefreshRouteMatch = accounts.match(/routes\.post\('\/api\/accounts\/imports\/refresh'[\s\S]*?\n\}\);/);
if (!importsRefreshRouteMatch) {
  failures.push('routes/accounts.js: imports refresh route not found');
} else {
  const importsRefreshRoute = importsRefreshRouteMatch[0]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  for (const forbidden of ['computeImportsSnapshot', 'syncAll', 'checkpoint', 'VACUUM', 'optimize', 'embed']) {
    if (importsRefreshRoute.includes(forbidden)) {
      failures.push(`routes/accounts.js: imports refresh route must not start ${forbidden}`);
    }
  }
  if (!importsRefreshRoute.includes("recordIntegrationJobHealth(db, 'imports-snapshot', 'queued')")) {
    failures.push('routes/accounts.js: imports refresh route must queue background snapshot work');
  }
}
must('lib/imports-envelope.js', 'refresh_needed', 'imports freshness must tell the UI when background refresh is needed');
must('lib/imports-envelope.js', "status: freshness?.latest && !isStale(freshness.latest) ? 'ready' : 'queued'", 'stale import snapshot must be represented as queued status');

must('routes/accounts.js', 'queueApiKeyBackgroundImport(provider)', 'API-key source save must queue background import work');

// ── Passive sync orchestrator (st_27561b77 moved the worker here from
//    scripts/sync.js; st_fd14cdd4 re-pointed these assertions and made the
//    enumeration registry-derived) ────────────────────────────────────────────
must('scripts/sync.js', 'passive-sync-orchestrator', 'scheduled sync worker must drain through the passive orchestrator');
must('lib/passive-sync-orchestrator.js', "from './integration-registry.js'", 'sync plan enumeration must derive from the integration registry');
must('lib/passive-sync-orchestrator.js', './oura-sync.js', 'Oura must run from the scheduled background import worker');
must('lib/passive-sync-orchestrator.js', './eight-sleep-sync.js', 'Eight Sleep must run from the scheduled background import worker');
must('lib/passive-sync-orchestrator.js', 'runIntegrationJob', 'scheduled jobs must clear their queued health rows through the shared job wrapper');
must('lib/passive-sync-orchestrator.js', "recordJobHealth(db, name, 'running')", 'scheduled jobs must expose running state');
must('lib/passive-sync-orchestrator.js', 'sourceEmails(database, descriptor.vendor, job.accountType)', 'per-account jobs must enumerate typed active accounts from the registry declaration');
must('lib/passive-sync-orchestrator.js', 'name: `${job.kind}:${email}`', 'per-account queue rows must be named {kind}:{email} so workers clear them');
must('lib/integration-health.js', "listConnectedMicrosoftAccounts('email')", 'Microsoft mail health probes must enumerate email accounts only');
must('lib/integration-health.js', "listConnectedMicrosoftAccounts('calendar')", 'Microsoft calendar health probes must enumerate calendar accounts only');
mustNot('lib/integration-health.js', 'const msAccounts = listConnectedMicrosoftAccounts();', 'Microsoft health probes must not use an untyped account set');
must('lib/integration-health.js', "WHERE source='graph' AND account_id=?", 'Microsoft calendar health lastSync must be account-scoped');
must('routes/accounts.js', 'getMicrosoftCalendarCount(db, email)', 'Microsoft calendar product count must be account-scoped');
mustNot('routes/accounts.js', '...listConnectedMicrosoftAccounts(),', 'Microsoft account cards must not merge registry-only emails as live connected rows');
must('routes/accounts.js', "listConnectedMicrosoftAccounts('email')", 'Microsoft live card rows must include typed email accounts only');
must('routes/accounts.js', "listConnectedMicrosoftAccounts('calendar')", 'Microsoft live card rows must include typed calendar accounts only');
must('routes/accounts.js', "source: 'legacy_registry'", 'Registry-only Microsoft tokens must surface as repair rows');
must('routes/accounts.js', 'strongestLaunchState', 'Microsoft per-product health must aggregate by severity');
must('lib/microsoft-oauth.js', "type IN ('email','calendar')", 'Untyped Microsoft account listing must not include unsupported DB account types');
must('lib/accounts-queries.js', "WHERE source='graph' AND account_id=?", 'Microsoft calendar account counts must not be global graph totals');
// st_fd14cdd4: the integration doc-count SQL moved into the registry descriptor.
must('lib/integration-registry.js', "WHERE source='graph' AND account_id=?", 'Microsoft calendar integration counts must not be global graph totals');
must('lib/passive-sync-orchestrator.js', 'computeImportsSnapshot', 'scheduled sync worker must refresh import snapshots in the background');
mustNot('routes/accounts.js', 'getGoogleContactsTotal(db)', 'Apple card must not count Google Contacts as Apple-local contacts');
mustNot('lib/chat-tools/index.js', /sync-(?:drive|granola|notion|oura)\.js/, 'chat must not expose manual sync tools');
mustNot('apps/chat/modules/chat.js', /sync_(?:drive|granola|notion|oura)/, 'chat UI must not advertise manual sync tools');

for (const state of ['queued', 'running', 'paused', 'failed', 'done']) {
  must('lib/launch-integrations.js', `'${state}'`, `launch states must include ${state}`);
  must('apps/account/app.js', `${state}:`, `account UI must label ${state}`);
}

// ── Integration registry ↔ surface derivation (st_fd14cdd4 AC2/AC4) ─────────
// The registry is import-pure (no db, no config) so this check can load it
// without opening the database. Every assertion here is bidirectional teeth:
// a descriptor whose surface is missing turns the commit red, and a surface
// that stops reading the registry turns the commit red.

// Direction 1 — surfaces read the registry.
for (const surface of [
  'lib/passive-sync-orchestrator.js',
  'lib/oauth-sync-queue.js',
  'lib/integration-health.js',
  'lib/integrations-queries.js',
  'lib/launch-integrations.js',
  'lib/integration-reconciler.js',
]) {
  must(surface, 'integration-registry', `${surface} must derive from the integration registry`);
}
must('scripts/integration-monitor.js', 'integration-reconciler', 'health monitor cadence must run the registration reconciler');
// st_fd14cdd4 P6 — the scheduling plane derives too: the supervisor probe
// seeds from the declarative routine spec (never a hardcoded type list) and
// the history backfill enumerates registry-declared integrations (never
// hardcoded Google).
must('lib/passive-supervisor.js', 'maintenance-routines', 'supervisor routine seeding must derive from lib/maintenance-routines.js');
must('lib/passive-supervisor.js', 'historyBackfillEntries', 'supervisor backfill seeding must derive from the integration registry');
must('lib/passive-supervisor.js', 'historySweepEntries', 'supervisor history-sweep seeding must derive from the integration registry (st_fd14cdd4 reopen)');
mustNot('lib/passive-supervisor.js', 'NIGHTLY_TYPES = [', 'supervisor must not regrow a hardcoded overnight type list');

// Direction 2 — every descriptor is fully derivable.
try {
  const registry = await import(pathToFileURL(join(root, 'lib/integration-registry.js')).href);

  for (const problem of registry.validateRegistry()) {
    failures.push(`lib/integration-registry.js: ${problem}`);
  }

  const descriptors = registry.listIntegrations();
  if (descriptors.length < 19) {
    failures.push(`lib/integration-registry.js: only ${descriptors.length} descriptors — the sealed research inventory names 19 sources`);
  }

  const orchestratorSource = read('lib/passive-sync-orchestrator.js');
  const healthSource = read('lib/integration-health.js');
  const dedicatedJobTypes = new Set(['granola_sync', 'oura_sync', 'eight_sleep_sync', 'asana_sync', 'notion_sync', 'imports_snapshot', 'monarch_sync']);
  for (const descriptor of descriptors) {
    for (const job of descriptor.jobs || []) {
      // Every declared job must have a handler the drain can dispatch:
      // oauth_sync/local_sync dispatch by kind; the dedicated job types have
      // whole-type handlers.
      const hasKindDispatch = orchestratorSource.includes(`kind === '${job.kind}'`);
      const hasTypeHandler = dedicatedJobTypes.has(job.jobType) && orchestratorSource.includes(`${job.jobType}: async`);
      if (!hasKindDispatch && !hasTypeHandler) {
        failures.push(`lib/passive-sync-orchestrator.js: registry job '${job.kind}' (${descriptor.id}) has no handler dispatch`);
      }
    }
    // Every declared fixed probe must have an implementation binding.
    for (const probeName of descriptor.probeNames || []) {
      if (!new RegExp(`['"]?${probeName.replace(/[-]/g, '\\-')}['"]?:\\s*probe`).test(healthSource)) {
        failures.push(`lib/integration-health.js: registry probe '${probeName}' (${descriptor.id}) has no probe function binding`);
      }
    }
  }

  // History-sweep derivation (st_fd14cdd4 reopen): every declared sweep needs
  // (a) a runner mode in scripts/backfill-participants.js — a declared source
  // with no executor would seed jobs that quarantine forever — and (b) a
  // handler family the maintenance drain dispatches (MAINTENANCE_JOB_TYPES).
  const sweepRunnerSource = read('scripts/backfill-participants.js');
  const handlersMod = await import(pathToFileURL(join(root, 'lib/passive-maintenance-handlers.js')).href);
  for (const { descriptor, spec } of registry.historySweepEntries()) {
    if (!spec?.source || !sweepRunnerSource.includes(`${spec.source}:`)) {
      failures.push(`scripts/backfill-participants.js: declared history sweep '${spec?.source}' (${descriptor.id}) has no runner mode`);
    }
    if (!handlersMod.MAINTENANCE_JOB_TYPES.includes(spec?.jobType)) {
      failures.push(`lib/passive-maintenance-handlers.js: history sweep jobType '${spec?.jobType}' (${descriptor.id}) has no maintenance handler family`);
    }
  }

  // Card derivation: importing launch-integrations throws if any registry card
  // id it references is missing (requireCard), and the state vocabulary must
  // stay closed — new states need a deliberate contract change, not drift.
  const launch = await import(pathToFileURL(join(root, 'lib/launch-integrations.js')).href);
  const expectedStates = [
    'connected', 'needs_key', 'needs_oauth', 'needs_permission', 'importing', 'ready',
    'queued', 'running', 'paused', 'partial', 'failed', 'done', 'error_recoverable',
  ];
  if (JSON.stringify([...launch.ACCOUNT_INTEGRATION_STATES]) !== JSON.stringify(expectedStates)) {
    failures.push('lib/launch-integrations.js: ACCOUNT_INTEGRATION_STATES vocabulary changed — the set is closed (st_fd14cdd4)');
  }
  if (launch.ACCOUNT_INTEGRATION_CONTRACTS.length !== 18) {
    failures.push(`lib/launch-integrations.js: expected 18 card contracts, got ${launch.ACCOUNT_INTEGRATION_CONTRACTS.length}`);
  }
} catch (err) {
  failures.push(`integration registry import failed: ${err.message}`);
}

must('scripts/qa/chat-hot-path-probe.js', '--max-total-ms', 'chat hot-path probe must enforce max-total-ms');
must('scripts/qa/chat-hot-path-probe.js', 'exceeds max', 'chat hot-path probe must fail when context build exceeds threshold');

must('lib/migrations/083_launch_chat_hot_path_indexes.sql', 'idx_companies_visible_name', 'company hot-path index must exist');
must('lib/migrations/083_launch_chat_hot_path_indexes.sql', 'idx_chunk_entities_type_entity_chunk', 'entity chunk hot-path index must exist');

mustExist('tests/performance-memory-polish.test.js');

// ── Foreground latency smoke (load-tolerant) ────────────────────────────────
// The smoke asserts page-shell latency against the LIVE server, so a busy
// machine (always-on maintenance, a concurrent session) can transiently push
// one endpoint past budget. This checker gates pre-commit; one noisy sample
// must not block commits. Retry once after a short settle — only two
// consecutive failures (a persistent regression) turn the checker red.
const SMOKE_RETRY_DELAY_MS = 3000;

function runForegroundSmoke() {
  const result = spawnSync(process.execPath, ['scripts/qa/foreground-smoke.js', '--max-ms=1500'], {
    cwd: root,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  // Spawn-level failure (timeout kill, missing file) has status null — red.
  return {
    ok: result.status === 0,
    output: ((result.stdout || '') + (result.stderr || '')).trim(),
  };
}

const firstSmoke = runForegroundSmoke();
if (!firstSmoke.ok) {
  await new Promise((resolve) => setTimeout(resolve, SMOKE_RETRY_DELAY_MS));
  const retrySmoke = runForegroundSmoke();
  if (!retrySmoke.ok) {
    failures.push(
      `scripts/qa/foreground-smoke.js: failed twice (run + retry after ${SMOKE_RETRY_DELAY_MS}ms — persistent, not load noise)\n`
      + `first run:\n${firstSmoke.output}\nretry:\n${retrySmoke.output}`,
    );
  }
}

if (failures.length) {
  console.error('[check-performance-memory-polish] FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[check-performance-memory-polish] ok');
