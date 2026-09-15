#!/usr/bin/env node
/**
 * scripts/check-integration-truth.js — the anti-regression guard.
 *
 * st_bf4978b0 AC7 — fails the build if any integration status lies or any
 * recoverable connectivity stall goes unhealed. Deterministic, NO LLM. Opens
 * the live encrypted DB via lib/db.js (whose default path resolves to exactly
 * ~/.robotdojo/robotdojo.db — never the stale user/databases copy) and asserts
 * the running launchd env has the freshness monitor loaded.
 *
 * Shares its Healthy predicate with the backend (lib/integration-status.js) and
 * its stall predicate with the reconciler (lib/connectivity-reconciler.js), so
 * the guard can never diverge from what the code actually does.
 *
 *   node scripts/check-integration-truth.js            # run every check
 *   node scripts/check-integration-truth.js --check green-earned   # run one
 *
 * Exit 0 = all pass. Exit 1 = one or more invariants broken (printed).
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import db from '../lib/db.js';
import {
  wouldRenderHealthy,
  isFailedStatus,
  isFalseRed,
  isInternalHealthName,
  normStatus,
  staleWindowForName,
  isCardFalseRed,
  cardBucket,
  isFirstPartyCard,
} from '../lib/integration-status.js';
import {
  detectStalledConnectivityJobs,
  classifyConnectivityStall,
  healAttemptRecorded,
} from '../lib/connectivity-reconciler.js';
import { hasLiveProbe } from '../lib/api-key-probe.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(__dir, '..', 'apps', 'account', 'app.js');
const MONITOR_LABEL = 'com.robotdojo.integration-monitor';
const PROACTIVE_REFRESH_MS = Number(process.env.ROBOTDOJO_PROACTIVE_REFRESH_MS) > 0
  ? Number(process.env.ROBOTDOJO_PROACTIVE_REFRESH_MS)
  : 30 * 60_000;

function pass(detail) { return { ok: true, detail }; }
function fail(detail) { return { ok: false, detail }; }

function allHealthRows() {
  return db.prepare('SELECT * FROM integration_health').all();
}

// Slice a top-level `function NAME(...) { ... }` body out of source by brace
// matching — used for the static routing assertions.
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const brace = src.indexOf('{', start);
  if (brace === -1) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(brace, i + 1); }
  }
  return null;
}

// ── AC1 — both renderers route through the single three-bucket classifier ────
function checkBuckets() {
  const src = readFileSync(APP_JS, 'utf8');
  if (!/function _integrationBucket\(/.test(src)) return fail('_integrationBucket classifier missing from app.js');

  // Static: both renderers derive from _integrationBucket (directly, or via
  // _integrationStatusDot which does).
  const dotBody = functionBody(src, '_integrationStatusDot');
  const circleBody = functionBody(src, '_integStatusCircle');
  const healthBody = functionBody(src, '_integrationHealthHtml');
  if (!dotBody || !/_integrationBucket\(/.test(dotBody)) return fail('_integrationStatusDot does not route through _integrationBucket');
  if (!circleBody || !/_integrationBucket\(/.test(circleBody)) return fail('legacy _integStatusCircle does not route through _integrationBucket');
  if (!healthBody || !/_integrationStatusDot\(/.test(healthBody)) return fail('_integrationHealthHtml does not route through the status dot');

  // Static: the only labels the classifier emits are the three buckets.
  const bucketBody = functionBody(src, '_integrationBucket');
  const labels = [...bucketBody.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
  const bad = labels.filter((l) => !['Healthy', 'Imported', 'Issue'].includes(l));
  if (bad.length) return fail(`_integrationBucket emits a non-three-bucket label: ${[...new Set(bad)].join(', ')}`);

  // Runtime: every live health row classifies deterministically into a known
  // bucket (healthy | issue) — never a fourth state.
  const rows = allHealthRows();
  for (const row of rows) {
    const healthy = wouldRenderHealthy(row);
    if (healthy !== true && healthy !== false) return fail(`row ${row.name} did not classify to a boolean bucket`);
  }
  return pass(`3-bucket classifier is the single derivation; ${rows.length} live rows classify cleanly`);
}

// ── AC2 — Healthy is earned, never defaulted; failed → Issue immediately ─────
function checkGreenEarned() {
  const rows = allHealthRows();
  const now = Date.now();
  const violations = [];
  for (const row of rows) {
    const status = normStatus(row.status);
    const healthy = wouldRenderHealthy(row, { now });
    // A failed status may never render Healthy (no grace).
    if (healthy && isFailedStatus(status)) violations.push(`${row.name}: failed status '${status}' rendering Healthy`);
    // A success status may only render Healthy with a fresh live verification.
    if (healthy) {
      if (!row.verified_at) violations.push(`${row.name}: Healthy with NULL verified_at (unearned green)`);
      else {
        const age = now - Date.parse(row.verified_at);
        const win = staleWindowForName(row.name);
        if (!(age < win)) violations.push(`${row.name}: Healthy while verification is ${Math.round(age / 60000)}m old (> ${Math.round(win / 60000)}m window)`);
      }
    }
  }
  if (violations.length) return fail(`green-earned violations:\n    - ${violations.join('\n    - ')}`);
  const green = rows.filter((r) => wouldRenderHealthy(r, { now })).length;
  return pass(`no unearned/stale green across ${rows.length} rows (${green} legitimately Healthy)`);
}

// ── AC2 mirror — no FALSE-RED: a working integration must not render Issue ───
// The earned-green check (checkGreenEarned) only asserts "nothing green is
// unverified." That is one-sided: it let a wall of genuinely-working
// integrations render a permanent FALSE Issue because their probes never
// recorded a live verification (verified_at stayed NULL), so the classifier
// defaulted them to Issue — the mirror image of unearned green, and the exact
// hole that passed every prior machine check. This closes it: any user-facing
// row reporting a success status while verified_at is NULL is a false-red.
// Staleness (verified_at present but old) is the intended degradation, NOT a
// false-red; internal infra rows are exempt (they carry no live signal).
function checkNoFalseRed() {
  const rows = allHealthRows();
  const violations = [];
  for (const row of rows) {
    if (isFalseRed(row)) {
      violations.push(`${row.name}: probe reports '${normStatus(row.status)}' (working) but verified_at is NULL → renders a FALSE Issue`);
    }
  }
  if (violations.length) return fail(`no-false-red violations (working integrations rendering a false Issue):\n    - ${violations.join('\n    - ')}`);
  const userFacing = rows.filter((r) => !isInternalHealthName(r.name)).length;
  return pass(`no working integration renders a false Issue across ${userFacing} user-facing rows`);
}

// ── AC2 mirror at the CARD layer — a false-red born in card assembly ─────────
// checkNoFalseRed (above) inspects integration_health ROWS and is STRUCTURALLY
// BLIND to a false-red created when routes/accounts.js assembles a CARD from
// those rows: an aggregate/group parent (Google/Microsoft/Asana) whose own
// verified_at stayed NULL even though its child accounts are verified & healthy,
// or a first-party Chat card that renders Issue for lack of an external probe.
// Both render a permanent FALSE Issue that every DB-row check passed. This
// closes the gap by assembling the REAL card payload IN-PROCESS against the live
// DB — the exact builder the HTTP route calls, no server up, no network — and
// failing on any card that is working yet would render a false Issue.
async function checkCardTruth() {
  let payload;
  try {
    const { buildIntegrationCardsPayload } = await import('../routes/accounts.js');
    // c=null + cacheChecked:true never dereferences the Hono context and skips
    // the cache read, forcing a fresh assembly from the live DB.
    payload = await buildIntegrationCardsPayload(null, { userKey: 'guard-card-truth', cacheChecked: true });
  } catch (e) {
    return fail(`could not assemble the card payload in-process: ${e?.message || e}`);
  }
  const cards = [];
  for (const section of (payload?.sections || [])) {
    for (const card of (section.cards || [])) cards.push(card);
  }
  // First-party Robot Dojo rows classify as first-party cards.
  for (const r of (payload?.robot_dojo?.rows || [])) {
    cards.push({
      provider: r.provider,
      name: r.label || r.provider,
      substrate_type: 'first-party',
      connected: r.state !== 'failed',
      launch_state: r.state,
      status: r.state,
      verified_at: r.verified_at || null,
    });
  }
  const now = Date.now();
  const violations = [];
  for (const card of cards) {
    if (isCardFalseRed(card, { now, serverLive: true })) {
      const kind = isFirstPartyCard(card)
        ? 'first-party'
        : (Array.isArray(card.accounts) && card.accounts.length ? 'aggregate parent' : 'leaf');
      violations.push(`${card.name || card.provider} (${kind}): working but renders a FALSE Issue (verified_at not inherited/stamped in card assembly)`);
    }
  }
  if (violations.length) return fail(`card-truth violations (working cards rendering a false Issue in assembly):\n    - ${violations.join('\n    - ')}`);
  const healthy = cards.filter((c) => cardBucket(c, { now }) === 'healthy').length;
  return pass(`no assembled card renders a false Issue across ${cards.length} cards (${healthy} Healthy)`);
}

// ── AC3 — schema carries verified_at; recency reads it; no failed row fresh ──
function checkSchema() {
  const cols = db.prepare('PRAGMA table_info(integration_health)').all().map((c) => c.name);
  if (!cols.includes('verified_at')) return fail('integration_health is missing the verified_at column');
  return pass('integration_health.verified_at present (live-verification field distinct from last_check/last_sync)');
}

function checkRecency() {
  const src = readFileSync(APP_JS, 'utf8');
  const bucketBody = functionBody(src, '_integrationBucket') || '';
  // The Healthy hover's age must be sourced from the live-verification value.
  if (!/Verified live \$\{_fmtAge\(verifiedAt\)/.test(bucketBody)) return fail('Healthy recency is not sourced from verifiedAt in _integrationBucket');
  if (!/function _integrationVerifiedAt\(/.test(src)) return fail('_integrationVerifiedAt reader missing');
  // Runtime: no failed integration is classified Healthy (a last-sync value can
  // never outlive a failed status as a fresh positive "updated").
  const bad = allHealthRows().filter((r) => isFailedStatus(r.status) && wouldRenderHealthy(r));
  if (bad.length) return fail(`failed rows surfacing a fresh Healthy update: ${bad.map((r) => r.name).join(', ')}`);
  return pass('Healthy recency reads verified_at; no failed row shows a fresh positive update');
}

// ── AC4 — no refreshable OAuth token has LAPSED (expired) un-renewed ─────────
// AC4's invariant is "our side never lets a token we could have refreshed
// lapse" — i.e. expire. A token merely sitting INSIDE the proactive window
// (0 < msToExpiry < PROACTIVE_REFRESH_MS) is the expected transient state: the
// 15-min monitor pass refreshes it well before it expires (window 30m > cadence
// 15m). Failing on in-window tokens made this guard flaky (it tripped for up to
// one monitor cadence every refresh cycle — QA st_bf4978b0). The real violation
// is a refreshable token that actually EXPIRED (msToExpiry < 0): proactive
// refresh failed to renew it. The separate `monitor` check backstops the
// "refresher not running at all" case.
async function checkOauthRefresh() {
  const violations = [];
  try {
    const { getGoogleTokens, listConnectedGoogleAccounts } = await import('../lib/google-oauth.js');
    for (const email of listConnectedGoogleAccounts()) {
      const tokens = getGoogleTokens(email);
      if (!tokens?.refresh || !tokens.expiry) continue; // no refreshable token / unknown expiry
      const acct = db.prepare("SELECT status FROM accounts WHERE vendor='google' AND email=? LIMIT 1").get(email);
      if (acct?.status === 'needs_reauth') continue; // genuine revocation = correctly Issue, not our fault
      const msToExpiry = Date.parse(tokens.expiry) - Date.now();
      if (Number.isFinite(msToExpiry) && msToExpiry < 0) {
        violations.push(`google ${email}: token lapsed ${Math.round(-msToExpiry / 60000)}m ago, refreshable but un-renewed — proactive refresh failed`);
      }
    }
  } catch (e) { /* keychain/env unavailable — skip google */ void e; }
  try {
    const { getMicrosoftTokens, listConnectedMicrosoftAccounts } = await import('../lib/microsoft-oauth.js');
    for (const email of new Set(listConnectedMicrosoftAccounts())) {
      const tokens = getMicrosoftTokens(email);
      if (!tokens?.refresh || !tokens.expiry) continue;
      const acct = db.prepare("SELECT status FROM accounts WHERE vendor='microsoft' AND email=? LIMIT 1").get(email);
      if (acct?.status === 'needs_reauth') continue;
      const msToExpiry = Date.parse(tokens.expiry) - Date.now();
      if (Number.isFinite(msToExpiry) && msToExpiry < 0) {
        violations.push(`microsoft ${email}: token lapsed, refreshable but un-renewed — proactive refresh failed`);
      }
    }
  } catch (e) { void e; }
  if (violations.length) return fail(`oauth-refresh violations:\n    - ${violations.join('\n    - ')}`);
  return pass('no refreshable OAuth token has lapsed un-renewed');
}

// ── AC6 — recoverable stalls healed; user-action surfaced not restarted ──────
function checkStalls() {
  const now = Date.now();
  const stalled = detectStalledConnectivityJobs(db, now);
  const violations = [];
  const health = new Map(allHealthRows().map((r) => [r.name, r]));
  for (const job of stalled) {
    const cls = classifyConnectivityStall(job);
    if (cls.recoverable) {
      // A recoverable stall with no recorded heal attempt is the exact rot the
      // guard exists to catch.
      if (!healAttemptRecorded(job, now)) violations.push(`${cls.name}: recoverable stall with no heal attempt recorded`);
    } else {
      // A user-action / dead-scope stall is a violation ONLY if it renders
      // Healthy (it must be surfaced as Issue with a reconnect prompt). It is
      // NOT a violation merely for lacking an auto-restart — this is the clause
      // that keeps a correctly-surfaced FDA/Photos Issue from false-failing.
      const row = health.get(cls.name);
      if (row && wouldRenderHealthy(row, { now })) violations.push(`${cls.name}: user-action stall rendering Healthy instead of Issue`);
    }
  }
  if (violations.length) return fail(`stall violations:\n    - ${violations.join('\n    - ')}`);
  return pass(`${stalled.length} stalled connectivity job(s); recoverable ones healed, user-action ones surfaced as Issue`);
}

// ── AC7 — the freshness monitor is loaded in the RUNNING launchd env ─────────
function checkMonitor() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const targets = uid != null
    ? [`gui/${uid}/${MONITOR_LABEL}`, `system/${MONITOR_LABEL}`]
    : [`system/${MONITOR_LABEL}`];
  for (const target of targets) {
    const res = spawnSync('launchctl', ['print', target], { stdio: 'ignore' });
    if (res.status === 0) return pass(`${MONITOR_LABEL} loaded in the running launchd env (${target})`);
  }
  // Fallback: launchctl list (older/user domain form).
  const list = spawnSync('launchctl', ['list'], { encoding: 'utf8' });
  if (list.status === 0 && list.stdout.includes(MONITOR_LABEL)) return pass(`${MONITOR_LABEL} present in launchctl list`);
  return fail(`${MONITOR_LABEL} is NOT loaded — verified_at would freeze and every live connection eventually reads Issue`);
}

// ── AC6/AC8 — a 403 PERMISSION_DENIED removed-scope is non-recoverable ───────
function checkDeadScope() {
  // Synthetic: the classifier must treat a removed-scope 403 as non-recoverable
  // so the reconciler never futilely re-enqueues it (this holds even when no
  // live dead-scope job currently exists).
  const synthetic = classifyConnectivityStall({ job_type: 'oauth_sync', target_id: 'photos:test@example.com', last_error: 'PERMISSION_DENIED: photoslibrary scope removed', status: 'failed' });
  if (!synthetic.deadScope) return fail('classifier does not recognize PERMISSION_DENIED as a dead scope');
  if (synthetic.recoverable) return fail('a dead-scope (403 PERMISSION_DENIED) job is wrongly classified recoverable — it would be re-enqueued forever');

  // Live: any real dead-scope connectivity job must be non-recoverable and must
  // NOT carry a fresh re-animation marker (i.e. it settled, not oscillating).
  const rows = db.prepare("SELECT * FROM passive_jobs WHERE job_type IN ('oauth_sync','local_sync')").all();
  const violations = [];
  for (const job of rows) {
    const err = `${job.last_error || ''} ${job.quarantine_reason || ''}`;
    if (!/permission_denied|removed[_ -]?scope|\b403\b|photoslibrary/i.test(err)) continue;
    const cls = classifyConnectivityStall(job);
    if (cls.recoverable) violations.push(`${cls.name}: dead-scope job classified recoverable`);
    if (/re-animated by connectivity reconciler/i.test(job.last_error || '')) violations.push(`${cls.name}: dead-scope job was re-animated (should never re-enqueue)`);
  }
  if (violations.length) return fail(`dead-scope violations:\n    - ${violations.join('\n    - ')}`);
  return pass('403 PERMISSION_DENIED removed-scope is non-recoverable and never re-enqueued (settles as a stable Issue)');
}

// ── AC5 — keys re-verify on cadence + on real use; no NULL-verified name seam ─
function checkKeyVerify() {
  const health = readFileSync(join(__dir, '..', 'lib', 'integration-health.js'), 'utf8');
  const status = readFileSync(join(__dir, '..', 'lib', 'integration-status.js'), 'utf8');
  const wiring = [];
  if (!/probeApiKeyLive/.test(health)) wiring.push('cadence probes do not run the live handshake (probeApiKeyLive)');
  if (!/verifiedLive: true/.test(health)) wiring.push('a 200 handshake does not stamp verifiedLive');
  if (!/export function recordLiveVerification/.test(status)) wiring.push('recordLiveVerification helper missing');
  if (wiring.length) return fail(`key-verify wiring gaps:\n    - ${wiring.join('\n    - ')}`);

  // Runtime name-seam guard (Failure manifest #3): a model key whose probe is
  // succeeding (status ok) must carry a non-NULL verified_at under the SAME name
  // the card reads — else the card reads Issue forever while the probe passes.
  const violations = [];
  for (const name of ['anthropic', 'openai', 'google', 'xai']) {
    const row = db.prepare('SELECT status, verified_at FROM integration_health WHERE name=?').get(name);
    if (!row) continue;
    if (hasLiveProbe(name) && normStatus(row.status) === 'ok' && !row.verified_at) {
      violations.push(`${name}: probe status 'ok' but verified_at is NULL (unverified name seam)`);
    }
  }
  if (violations.length) return fail(`key-verify violations:\n    - ${violations.join('\n    - ')}`);
  return pass('cadence + on-use verification wired; every succeeding model key carries a live verified_at');
}

// ── AC5 — no live network probe on the chat critical path (Chat Speed P0) ────
function checkChatPathClean() {
  const gateway = readFileSync(join(__dir, '..', 'lib', 'llm-gateway.js'), 'utf8');
  const provider = readFileSync(join(__dir, '..', 'lib', 'llm', 'anthropic.js'), 'utf8');
  const violations = [];
  // No live network probe (a /v1/models handshake) may be added to the token path.
  if (/probeApiKeyLive/.test(gateway)) violations.push('llm-gateway.js references probeApiKeyLive on the chat path');
  if (/probeApiKeyLive/.test(provider)) violations.push('lib/llm/anthropic.js references probeApiKeyLive on the chat path');
  // The on-use verification must be fire-and-forget, never awaited on the token path.
  if (/await\s+recordLiveVerification/.test(gateway) || /await\s+recordLiveVerification/.test(provider)) {
    violations.push('recordLiveVerification is awaited on the token path');
  }
  const fireAndForget = /queueMicrotask\(\(\) => \{ try \{ recordLiveVerification/;
  if (/recordLiveVerification/.test(gateway) && !fireAndForget.test(gateway)) violations.push('gateway recordLiveVerification is not fire-and-forget via queueMicrotask');
  if (/recordLiveVerification/.test(provider) && !fireAndForget.test(provider)) violations.push('provider recordLiveVerification is not fire-and-forget via queueMicrotask');
  if (violations.length) return fail(`chat-path violations:\n    - ${violations.join('\n    - ')}`);
  return pass('no live network probe on the chat path; on-use verification is fire-and-forget (no TTFT cost)');
}

// ── AC8 — Google/Microsoft OAuth accounts are live and stable ────────────────
function checkOauthStable() {
  const rows = db.prepare("SELECT vendor, email, status, last_error FROM accounts WHERE vendor IN ('google','microsoft')").all();
  const revoked = rows.filter((r) => r.status === 'needs_reauth' || /invalid_grant/i.test(r.last_error || ''));
  if (revoked.length) {
    return fail(`OAuth accounts not stable (revoked / invalid_grant): ${revoked.map((r) => `${r.vendor}:${r.email}`).join(', ')}`);
  }
  return pass(`${rows.length} Google/Microsoft OAuth account(s) live and stable (active, no invalid_grant)`);
}

const CHECKS = {
  buckets: checkBuckets,
  'green-earned': checkGreenEarned,
  'no-false-red': checkNoFalseRed,
  'card-truth': checkCardTruth,
  schema: checkSchema,
  recency: checkRecency,
  'oauth-refresh': checkOauthRefresh,
  'key-verify': checkKeyVerify,
  'chat-path-clean': checkChatPathClean,
  stalls: checkStalls,
  monitor: checkMonitor,
  'dead-scope': checkDeadScope,
  'oauth-stable': checkOauthStable,
};

async function main() {
  const argIdx = process.argv.indexOf('--check');
  const only = argIdx !== -1 ? process.argv[argIdx + 1] : null;
  if (only && !CHECKS[only]) {
    process.stderr.write(`unknown check '${only}'. known: ${Object.keys(CHECKS).join(', ')}\n`);
    process.exit(2);
  }
  const names = only ? [only] : Object.keys(CHECKS);
  let failed = 0;
  for (const name of names) {
    let result;
    try { result = await CHECKS[name](); } catch (e) { result = fail(`threw: ${e?.message || e}`); }
    if (result.ok) {
      process.stdout.write(`  ok   ${name} — ${result.detail}\n`);
    } else {
      failed += 1;
      process.stdout.write(`  FAIL ${name} — ${result.detail}\n`);
    }
  }
  process.stdout.write(failed ? `\n${failed}/${names.length} check(s) FAILED\n` : `\nall ${names.length} check(s) passed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[check-integration-truth] fatal:', e?.message || e); process.exit(1); });
