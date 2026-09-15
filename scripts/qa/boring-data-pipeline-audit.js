#!/usr/bin/env node
/**
 * Boring data pipeline audit.
 *
 * Read-only wrapper around the boring-pipeline contract and cadence-safe live
 * status. This command answers: are the invariants guarded, is the live pipeline
 * healthy, and is final completion still pending or proven?
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CONTRACT_FILE = 'architecture/data-pipeline-boring-contract.md';
const SAFE_CONTRACT_TESTS = Object.freeze([
  'tests/data-pipeline-boring-contract.test.js',
  'tests/data-pipeline-status-contract.test.js',
]);
const SAFE_DP7_TESTS = Object.freeze([
  'tests/data-plane-proof.test.js',
  'tests/specs/admin-data-plane-proof.test.js',
  'tests/live-data-plane-proof-cli.test.js',
  'tests/browser-warm-launch-contract.test.js',
  'tests/chat/entity-context-cards.test.js',
]);
const SAFE_INVARIANT_TESTS = Object.freeze({
  'DP-1': Object.freeze([
    'tests/drain-personal-embeddings-contract.test.js',
    'tests/data-pipeline-status-contract.test.js',
    'tests/migration.test.js',
  ]),
  'DP-2': Object.freeze([
    'tests/topic-routing-policy.test.js',
    'tests/reclassify-launch-contract.test.js',
    'tests/routing-residue-audit.test.js',
  ]),
  'DP-3': Object.freeze([
    'tests/topic-lifecycle-vector-parity.test.js',
    'tests/source-topic-metadata-repair.test.js',
    'tests/ann/global-index-launch-contract.test.js',
  ]),
  'DP-4': Object.freeze([
    'tests/drain-personal-embeddings-contract.test.js',
    'tests/embed-value-order.test.js',
    'tests/embed-value-rank.test.js',
    'tests/embed-batch.test.js',
    'tests/sync-foreground-yield-contract.test.js',
    'tests/data-pipeline-status-contract.test.js',
  ]),
  'DP-5': Object.freeze([
    'tests/ann/global-index-launch-contract.test.js',
    'tests/routing-fallback-guard.test.js',
    'tests/chat/basic-chat-context-orchestration.test.js',
    'tests/chat/do-no-harm.test.js',
  ]),
  'DP-6': Object.freeze([
    'tests/data-pipeline-status-contract.test.js',
  ]),
});
const STATUS_COMMAND = Object.freeze([
  'scripts/qa/data-pipeline-status.js',
  '--summary-json',
  '--respect-cadence',
  '--strict',
]);
const LATEST_STATUS_COMMAND = Object.freeze([
  'scripts/qa/data-pipeline-status.js',
  '--latest-summary-json',
  '--strict',
]);
const TRANSIENT_STATUS_RETRY_ACTIONS = Object.freeze([
  'inspect_drain_progress',
  'watch_lane_respawn_or_restart_drain',
]);
const TRANSIENT_STATUS_RETRY_BLOCKER_ACTIONS = Object.freeze([
  'restart_embedding_drain_wrapper',
]);
const UNSAFE_OPERATOR_ACTIONS = Object.freeze([
  'continue_post_drain_chain',
  'delete_live_db_files',
  'delete_live_wal_files',
  'delete_unverified_backup',
  'delete_vector_store',
  'inspect_logs',
  'manual_db_edits',
  'manual_memory_link_edits',
  'manual_topic_updates',
  'manual_vector_repair',
  'refresh_stoplight_proof',
  'restart_services',
  'retune_lanes',
  'run_final_product_proof',
  'run_post_drain_repairs',
  'start_post_drain_work',
  'start_extra_process',
  'start_second_writer',
]);
const KNOWN_OPERATOR_ACTIONS = Object.freeze([
  'clear_temporary_drain_launchd_label',
  'fix_database_access',
  'free_disk_space',
  'inspect_blocker',
  'inspect_drain_progress',
  'inspect_drain_rate_and_load',
  'inspect_embedding_counts',
  'inspect_embedding_drain_handoff',
  'inspect_embedding_drain_process',
  'inspect_embedding_work_order_head',
  'inspect_handoff_and_post_drain_status',
  'inspect_post_drain_lock_owner',
  'inspect_post_drain_completion_evidence',
  'inspect_post_drain_log',
  'inspect_vector_table_audit',
  'inspect_warning',
  'refresh_data_pipeline_status_cache',
  'refresh_launch_stoplight',
  'refresh_post_drain_preflight',
  'repair_embedding_work_order_inputs',
  'repair_vector_tables',
  'rerun_embedding_drain',
  'rerun_final_product_proof',
  'rerun_global_ann_rebuild',
  'rerun_or_fix_post_drain_preflight',
  'rerun_post_drain_preflight',
  'rerun_post_drain_preflight_read_only',
  'rerun_split_vector_repair',
  'rerun_status_probe',
  'restart_embed_daemon',
  'restart_embedding_drain',
  'restart_embedding_drain_worker',
  'restart_embedding_drain_wrapper',
  'restart_or_inspect_post_drain_watcher',
  'restart_post_drain_runner',
  'restart_post_drain_watcher',
  'run_memory_refocus',
  'run_memory_refocus_projection',
  'run_post_drain_preflight',
  'run_routing_residue_repair',
  'watch_lane_respawn_or_restart_drain',
]);
const WAIT_FORBIDDEN_ACTIONS = Object.freeze([
  'inspect_logs',
  'restart_services',
  'retune_lanes',
  'refresh_stoplight_proof',
  'continue_post_drain_chain',
  'start_post_drain_work',
  'run_post_drain_repairs',
  'run_final_product_proof',
  'start_second_writer',
  'manual_db_edits',
  'manual_topic_updates',
  'manual_vector_repair',
  'manual_memory_link_edits',
]);
const CLOSE_FORBIDDEN_ACTIONS = Object.freeze([
  'continue_post_drain_chain',
  'delete_live_db_files',
  'delete_live_wal_files',
  'delete_unverified_backup',
  'delete_vector_store',
  'manual_db_edits',
  'manual_memory_link_edits',
  'manual_topic_updates',
  'manual_vector_repair',
  'refresh_stoplight_proof',
  'restart_services',
  'retune_lanes',
  'run_final_product_proof',
  'run_post_drain_repairs',
  'start_post_drain_work',
  'start_second_writer',
]);
const TRANSIENT_STATUS_RETRY_DELAY_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_BORING_AUDIT_STATUS_RETRY_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5000;
})();
const STATUS_READ_TIMEOUT_MS = (() => {
  const raw = Number(process.env.ROBOTDOJO_BORING_AUDIT_STATUS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 45_000;
})();
const INVARIANTS = Object.freeze([
  ['DP-1', 'Single owner, single writer, durable handoff'],
  ['DP-2', 'Unknown data never defaults to Personal'],
  ['DP-3', 'Topic movement preserves retrieval'],
  ['DP-4', 'Background embeddings yield to chat'],
  ['DP-5', 'Degraded retrieval is visible and repaired'],
  ['DP-6', 'Status asks for action only when action is real'],
  ['DP-7', 'Final proof is end-to-end'],
]);
const FINAL_PRODUCT_PROOF_REQUIRED_ROWS = Object.freeze([
  'local_readiness',
  'login_session',
  'private_chat',
  'chat_open_daemon_quiet',
  'chat_stall_recovery',
  'browser_product_proof',
  'foreground_activity_signal',
  'data_pipeline_invariants',
  'retrieval_sentinel',
]);
const REQUIRED_DATA_PLANE_BOUNDARIES = Object.freeze([
  'db',
  'passive_jobs',
  'import_classification',
  'raw_source',
  'search',
  'embedding',
  'first_use_context',
  'semantic_retrieval',
  'entity_enrichment',
  'chat_context',
]);
const BROWSER_ENTITY_CARD_PROOF = Object.freeze({
  row: 'browser_product_proof',
  spec: 'scripts/qa/tests/chat-browser-real-turn.spec.js',
  test_name: 'real browser entity-network turn answers from the local entity card',
  seed_marker: 'browser product proof seed in the local entity network',
  network_question: 'Use my data: is ${name} in my entity network? Answer briefly.',
  direct_find_question: 'Find ${name} in my entity network.',
  negative_premise_question: "Why isn't ${name} in my entity network?",
  expected_answer: 'Yes. ${name} is in your network.',
});
const FINAL_BACKLOG_COUNTER_KEYS = Object.freeze([
  'pending_embeddings',
  'personal_pending',
  'non_personal_pending',
  'work_order_selectable_pending',
  'work_order_blocked_pending',
]);
const HEALTHY_NON_ACTION_STATUS_ACTIONS = Object.freeze({
  wait: 'wait_for_embedding_drain',
  watch: 'watch_post_drain_watcher_start',
  monitor: 'monitor_post_drain_step',
});
const ACTION_REQUIRED_STATUS_ACTIONS = Object.freeze({
  inspect_warning: 'inspect_warning',
  fix_blocker: 'inspect_blocker',
  close_goal: 'close_data_pipeline_goal',
});

function usage() {
  return [
    'Usage: node scripts/qa/boring-data-pipeline-audit.js [--json] [--strict] [--require-complete] [--skip-contract-tests]',
    '',
    'Read-only audit for the boring data pipeline contract.',
    '',
    'Default strictness proves contract, invariant checks, and live health. Use --require-complete only after the post-drain chain should be done.',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    json: false,
    strict: false,
    requireComplete: false,
    skipContractTests: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--require-complete') opts.requireComplete = true;
    else if (arg === '--skip-contract-tests') opts.skipContractTests = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.requireComplete && opts.skipContractTests) {
    throw new Error('--require-complete cannot be combined with --skip-contract-tests');
  }
  return opts;
}

function runNode(args, { timeout = 30_000 } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
    timeout,
  });
  return {
    command: ['node', ...args].join(' '),
    status: result.status,
    signal: result.signal || null,
    ok: result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error?.message || null,
  };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, Number(ms) || 0)));
}

function uniqueActions(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    const items = Array.isArray(list) ? list : (typeof list === 'string' ? [list] : []);
    for (const item of items) {
      const action = typeof item === 'string' ? item.trim() : '';
      if (!action || seen.has(action)) continue;
      seen.add(action);
      out.push(action);
    }
  }
  return out;
}

function boundOperatorActions(actions) {
  const unsafe = new Set(UNSAFE_OPERATOR_ACTIONS);
  const known = new Set(KNOWN_OPERATOR_ACTIONS);
  const allowed = [];
  const suppressedUnsafe = [];
  const suppressedUnknown = [];
  for (const action of uniqueActions(actions)) {
    if (unsafe.has(action)) suppressedUnsafe.push(action);
    else if (known.has(action)) allowed.push(action);
    else suppressedUnknown.push(action);
  }
  return {
    allowed,
    suppressed: [...suppressedUnsafe, ...suppressedUnknown],
    suppressed_unsafe: suppressedUnsafe,
    suppressed_unknown: suppressedUnknown,
  };
}

function blockerForbiddenActions(firstAllowed) {
  const base = ['continue_post_drain_chain', 'start_second_writer', 'manual_db_edits', 'manual_topic_updates'];
  if (firstAllowed !== 'free_disk_space') return base;
  return [
    ...base,
    'restart_embedding_drain',
    'restart_embedding_drain_wrapper',
    'restart_embedding_drain_worker',
    'delete_live_db_files',
    'delete_live_wal_files',
    'delete_vector_store',
    'delete_unverified_backup',
  ];
}

function nonActionStatusMatches(statusAction) {
  const expectedAction = HEALTHY_NON_ACTION_STATUS_ACTIONS[statusAction?.kind];
  return statusAction?.operator_action_required === false
    && typeof expectedAction === 'string'
    && expectedAction === statusAction?.action;
}

function actionRequiredStatusMatches(statusAction, actions = []) {
  const expectedAction = ACTION_REQUIRED_STATUS_ACTIONS[statusAction?.kind];
  if (statusAction?.operator_action_required !== true || typeof expectedAction !== 'string') return false;
  if (statusAction?.kind === 'close_goal') return expectedAction === statusAction?.action;
  const expectedConcreteAction = uniqueActions(actions)[0] || expectedAction;
  return expectedConcreteAction === statusAction?.action;
}

function malformedNonActionRule(kind, statusAction) {
  return {
    kind,
    operator_action_required: true,
    action: 'inspect_status',
    message: `inspect malformed ${kind} status action before touching the pipeline`,
    allowed_actions: ['inspect_status'],
    forbidden_actions: [...WAIT_FORBIDDEN_ACTIONS],
    recheck_after: statusAction?.recheck_after || null,
  };
}

function malformedActionRequiredRule(kind, statusAction) {
  return {
    kind,
    operator_action_required: true,
    action: 'inspect_status',
    message: `inspect malformed ${kind} status action before touching the pipeline`,
    allowed_actions: ['inspect_status'],
    forbidden_actions: [...WAIT_FORBIDDEN_ACTIONS, 'close_data_pipeline_goal'],
    recheck_after: statusAction?.recheck_after || null,
  };
}

function runTestGroup(files, { label, skip = false, timeout = 90_000 } = {}) {
  const command = ['node', '--test', ...files].join(' ');
  if (skip) {
    return {
      ok: true,
      skipped: true,
      files,
      command,
      status: null,
      summary: `${label} skipped by --skip-contract-tests`,
    };
  }

  const missing = files.filter((file) => !existsSync(resolve(REPO_ROOT, file)));
  if (missing.length) {
    return {
      ok: false,
      skipped: false,
      files,
      command,
      status: null,
      summary: `${label} missing test files: ${missing.join(', ')}`,
      missing,
    };
  }

  const result = runNode(['--test', ...files], { timeout });
  return {
    ok: result.ok,
    skipped: false,
    files,
    command: result.command,
    status: result.status,
    signal: result.signal,
    summary: result.ok ? `${label} passed` : `${label} failed`,
    stderr: result.stderr.trim(),
    stdout_tail: result.stdout.split('\n').slice(-12).join('\n').trim(),
    error: result.error,
  };
}

function runSequentialTestFiles(files, { label, skip = false, timeout = 90_000 } = {}) {
  const command = files.map((file) => ['node', '--test', file].join(' ')).join(' && ');
  if (skip) {
    return {
      ok: true,
      skipped: true,
      serial: true,
      files,
      command,
      status: null,
      summary: `${label} skipped by --skip-contract-tests`,
    };
  }

  const missing = files.filter((file) => !existsSync(resolve(REPO_ROOT, file)));
  if (missing.length) {
    return {
      ok: false,
      skipped: false,
      serial: true,
      files,
      command,
      status: null,
      summary: `${label} missing test files: ${missing.join(', ')}`,
      missing,
    };
  }

  const results = [];
  for (const file of files) {
    const result = runNode(['--test', file], { timeout });
    results.push({
      file,
      command: result.command,
      status: result.status,
      signal: result.signal,
      ok: result.ok,
      stderr: result.stderr.trim(),
      stdout_tail: result.stdout.split('\n').slice(-12).join('\n').trim(),
      error: result.error,
    });
    if (!result.ok) break;
  }

  const failed = results.find((result) => result.ok !== true);
  return {
    ok: !failed,
    skipped: false,
    serial: true,
    files,
    command,
    status: failed ? failed.status : 0,
    signal: failed?.signal || null,
    summary: failed ? `${label} failed in ${failed.file}` : `${label} passed`,
    stderr: failed?.stderr || '',
    stdout_tail: failed?.stdout_tail || results.at(-1)?.stdout_tail || '',
    error: failed?.error || null,
    results,
  };
}

function runContractTests({ skip = false } = {}) {
  return runTestGroup(SAFE_CONTRACT_TESTS, {
    label: 'safe contract tests',
    skip,
    timeout: 60_000,
  });
}

function runInvariantTests({ skip = false } = {}) {
  const groups = {};
  for (const [id, files] of Object.entries(SAFE_INVARIANT_TESTS)) {
    groups[id] = runTestGroup(files, {
      label: `${id} invariant tests`,
      skip,
      timeout: 120_000,
    });
  }
  const ok = Object.values(groups).every((group) => group.ok === true);
  return {
    ok,
    skipped: skip,
    summary: skip
      ? 'safe invariant tests skipped by --skip-contract-tests'
      : ok
        ? 'safe invariant tests passed'
        : 'safe invariant tests failed',
    groups,
  };
}

function runDp7SafeTests({ skip = false } = {}) {
  return runSequentialTestFiles(SAFE_DP7_TESTS, {
    label: 'safe DP-7 import/browser/data-plane tests',
    skip,
    timeout: 120_000,
  });
}

function remainingRisksFromContract() {
  const contractPath = resolve(REPO_ROOT, CONTRACT_FILE);
  if (!existsSync(contractPath)) {
    return {
      ok: false,
      summary: `${CONTRACT_FILE} is missing`,
      risks: [],
    };
  }
  const text = readFileSync(contractPath, 'utf8');
  const start = text.indexOf('## Remaining Risks Ranked By User Impact');
  const end = text.indexOf('## Operator Rule', start);
  if (start === -1 || end === -1 || end <= start) {
    return {
      ok: false,
      summary: 'remaining risks block missing from contract',
      risks: [],
    };
  }
  const block = text.slice(start, end);
  const risks = [...block.matchAll(/^(\d+)\.\s+\*\*(.+?)\*\*\s*(.+)$/gm)]
    .map((match) => ({
      rank: Number(match[1]),
      title: match[2].trim(),
      detail: match[3].trim(),
    }));
  const ordered = risks.every((risk, index) => risk.rank === index + 1);
  const ok = risks.length > 0 && ordered;
  return {
    ok,
    summary: ok ? `${risks.length} ranked remaining risk(s)` : 'remaining risks are missing or not rank-ordered',
    risks,
  };
}

export function unresolvedCompletionRiskConflicts(remainingRisks, { completionProved = false } = {}) {
  if (completionProved === true) return [];
  const risks = Array.isArray(remainingRisks?.risks) ? remainingRisks.risks : [];
  const patterns = [
    /has not completed/i,
    /currently degraded/i,
    /during active drain/i,
    /until post-drain/i,
    /until zero backlog/i,
  ];
  return risks.filter((risk) => patterns.some((pattern) =>
    pattern.test(`${risk.title || ''} ${risk.detail || ''}`)));
}

export function parseStatusPayload(stdout) {
  const text = String(stdout || '');
  if (!text.trim()) {
    return { payload: null, parse_error: null, recovered_from_mixed_stdout: false };
  }
  try {
    return { payload: JSON.parse(text), parse_error: null, recovered_from_mixed_stdout: false };
  } catch (firstErr) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return { payload: null, parse_error: firstErr.message, recovered_from_mixed_stdout: false };
    }
    try {
      return {
        payload: JSON.parse(text.slice(start, end + 1)),
        parse_error: null,
        recovered_from_mixed_stdout: true,
      };
    } catch (secondErr) {
      return { payload: null, parse_error: secondErr.message, recovered_from_mixed_stdout: false };
    }
  }
}

function readStatus() {
  const result = runNode([...STATUS_COMMAND], { timeout: STATUS_READ_TIMEOUT_MS });
  const parsed = parseStatusPayload(result.stdout);
  const payload = parsed.payload;
  const cleanStdout = parsed.recovered_from_mixed_stdout !== true;
  if (!payload && (result.error || result.status !== 0 || result.signal)) {
    const fallback = runNode([...LATEST_STATUS_COMMAND], { timeout: STATUS_READ_TIMEOUT_MS });
    const fallbackParsed = parseStatusPayload(fallback.stdout);
    const fallbackPayload = fallbackParsed.payload;
    const fallbackCleanStdout = fallbackParsed.recovered_from_mixed_stdout !== true;
    if (fallbackPayload) {
      return {
        ok: fallback.ok && fallbackPayload?.ok === true && fallbackCleanStdout,
        command: fallback.command,
        primary_command: result.command,
        fallback_source: 'latest_summary_json_after_primary_status_failure',
        fallback_used: true,
        primary_status: result.status,
        primary_signal: result.signal,
        primary_stderr: result.stderr.trim(),
        primary_error: result.error,
        status: fallback.status,
        signal: fallback.signal,
        parse_error: fallbackParsed.parse_error,
        recovered_from_mixed_stdout: fallbackParsed.recovered_from_mixed_stdout,
        payload: fallbackPayload,
        stderr: fallback.stderr.trim(),
        error: fallback.error,
      };
    }
  }
  return {
    ok: result.ok && payload?.ok === true && cleanStdout,
    command: result.command,
    fallback_used: false,
    status: result.status,
    signal: result.signal,
    parse_error: parsed.parse_error,
    recovered_from_mixed_stdout: parsed.recovered_from_mixed_stdout,
    payload,
    stderr: result.stderr.trim(),
    error: result.error,
  };
}

export function transientStatusRetryNeeded(status) {
  const payload = status?.payload || {};
  if (!payload || status?.parse_error || status?.recovered_from_mixed_stdout === true) return false;
  if (payload.phase !== 'draining') return false;
  if (payload.complete === true) return false;
  if (payload.status_action?.operator_action_required !== true) return false;
  const warningActions = uniqueActions(payload.warning_summary?.operator_actions, payload.status_action?.warning_actions);
  if (payload.ok === true && (payload.blocker_summary?.total || 0) === 0 && warningActions.length > 0) {
    return warningActions.every((action) => TRANSIENT_STATUS_RETRY_ACTIONS.includes(action));
  }
  const blockerActions = uniqueActions(
    payload.blocker_summary?.operator_actions,
    payload.status_action?.blocker_actions,
  );
  if (payload.status_action?.kind === 'fix_blocker' && blockerActions.length > 0) {
    return blockerActions.every((action) => TRANSIENT_STATUS_RETRY_BLOCKER_ACTIONS.includes(action));
  }
  return false;
}

async function readStatusWithTransientRetry() {
  const attempts = [];
  let current = readStatus();
  attempts.push({
    ok: current.ok,
    phase: current.payload?.phase || null,
    pending_embeddings: current.payload?.db?.pending_embeddings ?? null,
    status_action: current.payload?.status_action || null,
    warning_actions: uniqueActions(current.payload?.warning_summary?.operator_actions, current.payload?.status_action?.warning_actions),
    blocker_actions: uniqueActions(current.payload?.blocker_summary?.operator_actions, current.payload?.status_action?.blocker_actions),
  });
  if (transientStatusRetryNeeded(current)) {
    await sleep(TRANSIENT_STATUS_RETRY_DELAY_MS);
    current = readStatus();
    attempts.push({
      ok: current.ok,
      phase: current.payload?.phase || null,
      pending_embeddings: current.payload?.db?.pending_embeddings ?? null,
      status_action: current.payload?.status_action || null,
      warning_actions: uniqueActions(current.payload?.warning_summary?.operator_actions, current.payload?.status_action?.warning_actions),
      blocker_actions: uniqueActions(current.payload?.blocker_summary?.operator_actions, current.payload?.status_action?.blocker_actions),
    });
  }
  return { ...current, attempts };
}

export function dp7ProofEvidence(live) {
  const launchContract = live?.launch_contract || null;
  const steps = Array.isArray(launchContract?.steps) ? launchContract.steps : [];
  const stepById = Object.fromEntries(steps.map((step) => [step?.id, step]));
  const finalBacklog = stepById.final_writer_release_and_backlog || null;
  const finalProductProof = stepById.final_product_proof || null;
  const productProof = live?.final_product_proof || null;
  const productProofRows = productProof?.rows && typeof productProof.rows === 'object'
    ? productProof.rows
    : {};
  const productProofRequiredRows = new Set(Array.isArray(productProof?.required_rows)
    ? productProof.required_rows
    : []);
  const missingRequestedRows = FINAL_PRODUCT_PROOF_REQUIRED_ROWS
    .filter((id) => !productProofRequiredRows.has(id));
  const missingGreenRows = FINAL_PRODUCT_PROOF_REQUIRED_ROWS
    .filter((id) => !productProofRows?.[id]?.status);
  const nonGreenRows = FINAL_PRODUCT_PROOF_REQUIRED_ROWS
    .filter((id) => productProofRows?.[id]?.status && productProofRows[id].status !== 'green');
  const browserEntityCardProof = browserEntityCardProofFromRow(productProofRows?.[BROWSER_ENTITY_CARD_PROOF.row] || {});
  const dataPlaneProof = dataPlaneProofFromProductProof(productProof, productProofRows);
  const dataPlaneProofVerdict = dataPlaneProofVerdictFromProductProof(productProof);
  const deferredExactProofRows = FINAL_PRODUCT_PROOF_REQUIRED_ROWS
    .filter((id) => {
      const current = productProofRows?.[id] || {};
      const evidence = current.evidence || {};
      if (evidence?.active_drain_block?.blocked_by_active_embedding_drain === true) return true;
      if (evidence?.active_drain_block?.exact_ann_proof_deferred === true) return true;
      if (evidence?.data_plane_proof?.active_drain_block?.blocked_by_active_embedding_drain === true) return true;
      if (evidence?.blocked_by_active_embedding_drain === true) return true;
      return /active embedding drain|proof n\/a|exact proof n\/a|exact_ann_proof_deferred/i.test(
        `${current.detail || ''} ${evidence?.active_drain_block?.next_action || ''}`,
      );
    });
  const productProofRowsRequested = FINAL_PRODUCT_PROOF_REQUIRED_ROWS
    .every((id) => productProofRequiredRows.has(id));
  const productProofRowsGreen = FINAL_PRODUCT_PROOF_REQUIRED_ROWS
    .every((id) => productProofRows?.[id]?.status === 'green');
  const productProofOk = productProof?.ok === true
    && productProofRowsRequested
    && productProofRowsGreen
    && browserEntityCardProof.ok === true
    && dataPlaneProof.ok === true
    && dataPlaneProofVerdict.ok === true
    && deferredExactProofRows.length === 0;
  const nextStep = launchContract?.next_step || null;
  const pendingStepIds = steps
    .filter((step) => step?.status === 'pending')
    .map((step) => step.id)
    .filter(Boolean);
  const blockedStepIds = steps
    .filter((step) => step?.status === 'blocked')
    .map((step) => step.id)
    .filter(Boolean);
  const retrievalReady = live?.retrieval?.global_ann_ready === true;
  const launchContractClosed = launchContract?.status === 'ok'
    && launchContract?.ok === true
    && launchContract?.counts?.pending === 0
    && launchContract?.counts?.blocked === 0
    && !nextStep;
  const closeGoalReady = live?.status_action?.kind === 'close_goal'
    && live?.status_action?.action === 'close_data_pipeline_goal'
    && live?.status_action?.operator_action_required === true;
  const liveStatusClosed = live?.ok === true && live?.complete === true;
  const backlogCounters = live?.db && typeof live.db === 'object'
    ? Object.fromEntries(FINAL_BACKLOG_COUNTER_KEYS.map((key) => [key, live.db[key]]))
    : null;
  const missingBacklogCounters = FINAL_BACKLOG_COUNTER_KEYS
    .filter((key) => !backlogCounters || backlogCounters[key] == null || backlogCounters[key] === '');
  const invalidBacklogCounters = FINAL_BACKLOG_COUNTER_KEYS
    .filter((key) => !missingBacklogCounters.includes(key)
      && !Number.isFinite(Number(backlogCounters[key])));
  const nonzeroBacklogCounters = FINAL_BACKLOG_COUNTER_KEYS
    .filter((key) => !missingBacklogCounters.includes(key)
      && !invalidBacklogCounters.includes(key)
      && Number(backlogCounters[key]) !== 0);
  const backlogZero = missingBacklogCounters.length === 0
    && invalidBacklogCounters.length === 0
    && nonzeroBacklogCounters.length === 0
    && FINAL_BACKLOG_COUNTER_KEYS.every((key) => {
      const value = Number(backlogCounters[key]);
      return Number.isFinite(value) && value === 0;
    });
  const closeBar = {
    live_status_closed: liveStatusClosed,
    backlog_zero: backlogZero,
    launch_contract_closed: launchContractClosed,
    final_writer_release: finalBacklog?.status === 'ok',
    final_product_step: finalProductProof?.status === 'ok',
    product_proof: productProofOk,
    retrieval: retrievalReady,
    close_goal: closeGoalReady,
  };
  const proved = liveStatusClosed
    && backlogZero
    && launchContractClosed
    && finalBacklog?.status === 'ok'
    && finalProductProof?.status === 'ok'
    && productProofOk
    && retrievalReady
    && closeGoalReady;
  const pendingEvidence = nextStep?.id
    ? `${nextStep.id}: ${nextStep.detail || nextStep.status || 'pending'}`
    : 'waiting for drain zero, post-drain chain, and final product proof';
  return {
    ok: proved,
    status: proved ? 'proved' : 'pending_post_drain_final_proof',
    evidence: proved
      ? 'status action close_data_pipeline_goal; live backlog zero; launch contract ok; retrieval ready; final backlog and named product proof rows are green'
      : pendingEvidence,
    close_bar: closeBar,
    launch_contract_status: launchContract?.status || null,
    launch_contract_ok: launchContract?.ok === true,
    launch_contract_closed: launchContractClosed,
    launch_contract_counts: launchContract?.counts || null,
    launch_contract_steps: steps.map((step) => ({
      id: step?.id || null,
      status: step?.status || null,
    })),
    pending_step_ids: pendingStepIds,
    blocked_step_ids: blockedStepIds,
    live_status_ok: live?.ok === true,
    live_status_complete: live?.complete === true,
    live_status_closed: liveStatusClosed,
    backlog_zero: backlogZero,
    backlog: backlogCounters
      ? Object.fromEntries(FINAL_BACKLOG_COUNTER_KEYS.map((key) => [key, Number(backlogCounters[key])]))
      : null,
    missing_backlog_counters: missingBacklogCounters,
    invalid_backlog_counters: invalidBacklogCounters,
    nonzero_backlog_counters: nonzeroBacklogCounters,
    status_action_kind: live?.status_action?.kind || null,
    status_action_action: live?.status_action?.action || null,
    status_action_operator_action_required: live?.status_action?.operator_action_required === true,
    next_step: nextStep,
    final_writer_release_and_backlog: finalBacklog,
    final_product_proof: finalProductProof,
    product_proof: {
      present: Boolean(productProof),
      ok: productProofOk,
      status_ok: productProof?.ok === true,
      required_rows_requested: productProofRowsRequested,
      required_rows_green: productProofRowsGreen,
      required_rows: [...FINAL_PRODUCT_PROOF_REQUIRED_ROWS],
      missing_requested_rows: missingRequestedRows,
      missing_green_rows: missingGreenRows,
      non_green_rows: nonGreenRows,
      deferred_exact_proof_rows: deferredExactProofRows,
      browser_entity_card_proof: browserEntityCardProof,
      data_plane_proof: dataPlaneProof,
      data_plane_proof_verdict: dataPlaneProofVerdict,
    },
    retrieval: live?.retrieval ? {
      global_ann_ready: live.retrieval.global_ann_ready === true,
      global_ann_state: live.retrieval.global_ann_state || null,
      global_ann_reason: live.retrieval.global_ann_reason || null,
      vector_projection_mode: live.retrieval.vector_projection_mode || null,
      stale_vectors_skipped: live.retrieval.stale_vectors_skipped === true,
      source_projection_ok: live.retrieval.source_projection?.ok === true,
      source_projection_lag_chunks: live.retrieval.source_projection?.lag_chunks ?? null,
      source_projection_within_lag: live.retrieval.source_projection?.within_lag ?? null,
      source_projection_missing_vectors: live.retrieval.source_projection?.missing_vectors ?? null,
      source_projection_malformed_rows: live.retrieval.source_projection?.malformed_rows ?? null,
    } : null,
  };
}

function dataPlaneProofVerdictFromProductProof(productProof) {
  const verdict = productProof?.data_plane_proof_verdict && typeof productProof.data_plane_proof_verdict === 'object'
    ? productProof.data_plane_proof_verdict
    : null;
  const missingBoundaries = Array.isArray(verdict?.missing_boundaries)
    ? verdict.missing_boundaries.map((item) => String(item))
    : [...REQUIRED_DATA_PLANE_BOUNDARIES];
  const nonGreenBoundaries = Array.isArray(verdict?.non_green_boundaries)
    ? verdict.non_green_boundaries.map((item) => String(item))
    : [];
  const importClassificationOk = verdict?.import_classification_ok === true;
  const firstUseContextOk = verdict?.first_use_context_ok === true;
  const ok = verdict?.ok === true
    && missingBoundaries.length === 0
    && nonGreenBoundaries.length === 0
    && importClassificationOk
    && firstUseContextOk;
  return {
    present: Boolean(verdict),
    ok,
    source: verdict ? 'final_product_proof.data_plane_proof_verdict' : null,
    missing_boundaries: missingBoundaries,
    non_green_boundaries: nonGreenBoundaries,
    import_classification_ok: importClassificationOk,
    first_use_context_ok: firstUseContextOk,
  };
}

function dataPlaneProofFromProductProof(productProof, productProofRows) {
  const candidates = [];
  if (productProof?.data_plane_proof && typeof productProof.data_plane_proof === 'object') {
    candidates.push({ source: 'final_product_proof.data_plane_proof', proof: productProof.data_plane_proof });
  }
  for (const [id, row] of Object.entries(productProofRows || {})) {
    if (row?.data_plane_proof && typeof row.data_plane_proof === 'object') {
      candidates.push({ source: `${id}.data_plane_proof`, proof: row.data_plane_proof });
    }
    if (row?.evidence?.data_plane_proof && typeof row.evidence.data_plane_proof === 'object') {
      candidates.push({ source: `${id}.evidence.data_plane_proof`, proof: row.evidence.data_plane_proof });
    }
  }

  const candidate = candidates.find(({ proof }) => proof?.ok === true) || candidates[0] || null;
  const proof = candidate?.proof || null;
  const required = Array.isArray(proof?.required_boundaries)
    ? proof.required_boundaries.map((item) => String(item))
    : [];
  const boundaries = proof?.boundaries && typeof proof.boundaries === 'object' ? proof.boundaries : {};
  const missingBoundaries = REQUIRED_DATA_PLANE_BOUNDARIES
    .filter((id) => !required.includes(id) || !boundaries[id]);
  const nonGreenBoundaries = REQUIRED_DATA_PLANE_BOUNDARIES
    .filter((id) => boundaries[id] && boundaries[id].ok !== true);
  const importChecks = boundaries.import_classification?.checks || {};
  const firstUseChecks = boundaries.first_use_context?.checks || {};
  const importClassificationOk = boundaries.import_classification?.ok === true
    && importChecks.unknown_started_uncategorized === true
    && importChecks.unknown_not_personal === true;
  const firstUseContextOk = boundaries.first_use_context?.ok === true
    && firstUseChecks.proof_chunk_pending_embedding === true
    && firstUseChecks.bounded_context_before_embedding === true;
  const ok = proof?.ok === true
    && missingBoundaries.length === 0
    && nonGreenBoundaries.length === 0
    && importClassificationOk
    && firstUseContextOk;
  return {
    present: Boolean(proof),
    ok,
    source: candidate?.source || null,
    required_boundaries: [...REQUIRED_DATA_PLANE_BOUNDARIES],
    missing_boundaries: missingBoundaries,
    non_green_boundaries: nonGreenBoundaries,
    import_classification_ok: importClassificationOk,
    first_use_context_ok: firstUseContextOk,
  };
}

function browserEntityCardProofFromRow(row) {
  if (row?.browser_entity_card_proof && typeof row.browser_entity_card_proof === 'object') {
    return {
      ...row.browser_entity_card_proof,
      ok: row.browser_entity_card_proof.ok === true,
    };
  }
  const evidence = row?.evidence || {};
  const contract = evidence?.entity_card_contract || {};
  const specs = Array.isArray(evidence?.specs) ? evidence.specs.map((item) => String(item)) : [];
  const markers = contract?.markers && typeof contract.markers === 'object' ? contract.markers : {};
  const proof = {
    required: true,
    spec: BROWSER_ENTITY_CARD_PROOF.spec,
    spec_listed: specs.includes(BROWSER_ENTITY_CARD_PROOF.spec),
    result_ok: evidence?.result?.ok === true,
    contract_ok: contract?.ok === true,
    markers: {
      test_name: markers.test_name === true,
      seed_marker: markers.seed_marker === true,
      network_question: markers.network_question === true,
      direct_find_question: markers.direct_find_question === true,
      negative_premise_question: markers.negative_premise_question === true,
      expected_answer: markers.expected_answer === true,
    },
  };
  proof.ok = proof.spec_listed
    && proof.result_ok
    && proof.contract_ok
    && Object.values(proof.markers).every(Boolean);
  return proof;
}

export function operatorRuleEvidence(live, dp7 = dp7ProofEvidence(live)) {
  const statusAction = live?.status_action || {};
  const kind = statusAction.kind || 'unknown';
  if (kind === 'wait') {
    if (!nonActionStatusMatches(statusAction)) return malformedNonActionRule(kind, statusAction);
    return {
      kind,
      operator_action_required: false,
      action: 'wait',
      message: 'wait - do not inspect logs, restart services, retune lanes, start another writer, or edit data/topics; do not refresh stoplight proof or start post-drain work',
      allowed_actions: ['wait_for_next_cadence'],
      forbidden_actions: [...WAIT_FORBIDDEN_ACTIONS],
      recheck_after: statusAction.recheck_after || null,
    };
  }
  if (kind === 'watch') {
    if (!nonActionStatusMatches(statusAction)) return malformedNonActionRule(kind, statusAction);
    return {
      kind,
      operator_action_required: false,
      action: 'watch_post_drain_watcher_start',
      message: 'watch post-drain watcher start - do not manually run the post-drain chain',
      allowed_actions: ['watch_post_drain_watcher_start'],
      forbidden_actions: ['continue_post_drain_chain', 'manual_db_edits', 'manual_topic_updates', 'start_second_writer'],
      recheck_after: statusAction.recheck_after || null,
    };
  }
  if (kind === 'monitor') {
    if (!nonActionStatusMatches(statusAction)) return malformedNonActionRule(kind, statusAction);
    return {
      kind,
      operator_action_required: false,
      action: 'monitor_post_drain_step',
      message: 'monitor post-drain step - watcher owns backup, reclassification, context, ANN, memory, and final proof',
      allowed_actions: ['monitor_post_drain_step'],
      forbidden_actions: ['continue_post_drain_chain', 'manual_db_edits', 'manual_topic_updates', 'start_second_writer'],
      recheck_after: statusAction.recheck_after || null,
    };
  }
  if (kind === 'inspect_warning') {
    const actions = uniqueActions(live?.warning_summary?.operator_actions, statusAction.warning_actions);
    if (!actionRequiredStatusMatches(statusAction, actions)) return malformedActionRequiredRule(kind, statusAction);
    const bounded = boundOperatorActions(actions);
    return {
      kind,
      operator_action_required: true,
      action: 'inspect_warning',
      message: `inspect only named warning action(s) - ${bounded.allowed.join(', ') || 'none listed'}`,
      allowed_actions: bounded.allowed,
      suppressed_unsafe_actions: bounded.suppressed_unsafe,
      suppressed_unknown_actions: bounded.suppressed_unknown,
      forbidden_actions: ['start_second_writer', 'manual_db_edits', 'manual_topic_updates', 'restart_unrelated_services'],
      recheck_after: null,
    };
  }
  if (kind === 'fix_blocker') {
    const actions = uniqueActions(live?.blocker_summary?.operator_actions, statusAction.blocker_actions);
    if (!actionRequiredStatusMatches(statusAction, actions)) return malformedActionRequiredRule(kind, statusAction);
    const bounded = boundOperatorActions(actions);
    const firstAllowed = bounded.allowed.slice(0, 1);
    const firstAction = firstAllowed[0] || null;
    const deferredActions = bounded.allowed.slice(1);
    return {
      kind,
      operator_action_required: true,
      action: 'fix_blocker',
      message: `fix first blocker only - ${firstAction || 'see blocker details'}${deferredActions.length ? '; rerun strict status before deferred actions' : ''}`,
      allowed_actions: firstAllowed,
      deferred_actions: deferredActions,
      suppressed_unsafe_actions: bounded.suppressed_unsafe,
      suppressed_unknown_actions: bounded.suppressed_unknown,
      forbidden_actions: blockerForbiddenActions(firstAction),
      recheck_after: null,
    };
  }
  if (kind === 'close_goal') {
    if (dp7?.ok !== true) {
      return {
        kind,
        operator_action_required: true,
        action: 'inspect_status',
        message: 'close_goal claimed but completion proof is not green - inspect status',
        allowed_actions: ['inspect_status'],
        forbidden_actions: ['close_data_pipeline_goal', 'start_second_writer', 'manual_db_edits'],
        recheck_after: null,
      };
    }
    return {
      kind,
      operator_action_required: true,
      action: 'close_data_pipeline_goal',
      message: 'completion proof is green - close the data-pipeline goal',
      allowed_actions: ['close_data_pipeline_goal'],
      forbidden_actions: [...CLOSE_FORBIDDEN_ACTIONS],
      recheck_after: null,
    };
  }
  const fallbackBounded = boundOperatorActions(statusAction.action);
  const fallbackAction = fallbackBounded.allowed[0] || 'inspect_status';
  return {
    kind,
    operator_action_required: statusAction.operator_action_required === true,
    action: fallbackAction,
    message: `inspect status action - ${kind}`,
    allowed_actions: fallbackBounded.allowed,
    suppressed_unsafe_actions: fallbackBounded.suppressed_unsafe,
    suppressed_unknown_actions: fallbackBounded.suppressed_unknown,
    forbidden_actions: ['start_second_writer', 'manual_db_edits'],
    recheck_after: statusAction.recheck_after || null,
  };
}

export function operatorActionsText(operatorRule) {
  if (operatorRule?.operator_action_required !== true) return null;
  const allowed = Array.isArray(operatorRule.allowed_actions)
    ? operatorRule.allowed_actions.join(',')
    : '';
  const deferred = Array.isArray(operatorRule.deferred_actions)
    ? operatorRule.deferred_actions.join(',')
    : '';
  const suppressed = Array.isArray(operatorRule.suppressed_unsafe_actions)
    ? operatorRule.suppressed_unsafe_actions.join(',')
    : '';
  const unknown = Array.isArray(operatorRule.suppressed_unknown_actions)
    ? operatorRule.suppressed_unknown_actions.join(',')
    : '';
  const forbidden = Array.isArray(operatorRule.forbidden_actions)
    ? operatorRule.forbidden_actions.join(',')
    : '';
  return `operator_actions: allowed=${allowed || 'none'} deferred=${deferred || 'none'} suppressed=${suppressed || 'none'} unknown=${unknown || 'none'} forbidden=${forbidden || 'none'}`;
}

export function statusActionIsHealthy(live, dp7 = dp7ProofEvidence(live)) {
  const action = live?.status_action || null;
  if (!action?.kind) return false;
  if (action.operator_action_required === false) {
    return nonActionStatusMatches(action);
  }
  if (action.operator_action_required !== true) return false;
  return action.kind === 'close_goal' && dp7?.ok === true;
}

export function statusAttemptSummary(attempts) {
  if (!Array.isArray(attempts) || attempts.length <= 1) return null;
  const formatAttempt = (attempt) => {
    const kind = attempt?.status_action?.kind || 'unknown';
    const action = attempt?.status_action?.action || 'unknown';
    const blockerActions = uniqueActions(attempt?.blocker_actions);
    const warningActions = uniqueActions(attempt?.warning_actions);
    const detail = blockerActions.length
      ? blockerActions.join(',')
      : warningActions.length
        ? warningActions.join(',')
        : action;
    return `${kind}/${detail}`;
  };
  return {
    attempts: attempts.length,
    first: formatAttempt(attempts[0]),
    last: formatAttempt(attempts[attempts.length - 1]),
  };
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function speedPostureEvidence(live, operatorRule = operatorRuleEvidence(live)) {
  const phase = live?.phase || null;
  const pending = finiteNumberOrNull(live?.db?.pending_embeddings);
  const trendRate = finiteNumberOrNull(live?.trend?.rate_per_hour);
  const trendEta = finiteNumberOrNull(live?.trend?.eta_hours);
  const sampleRate = finiteNumberOrNull(live?.live_progress?.observed_sample_rate_per_hour);
  const effectiveEta = live?.effective_eta || live?.eta || null;
  const sampleEta = finiteNumberOrNull(effectiveEta?.non_authoritative_sample_hours);
  const statusKind = live?.status_action?.kind || null;
  const memoryHeadroom = live?.memory_headroom || {};
  const memoryPressure = memoryHeadroom.pressure || null;
  const memoryOk = memoryHeadroom.ok === true;
  const canAddLane = memoryHeadroom.can_add_lane_by_rss === true;
  const waitOnly = statusKind === 'wait'
    && live?.status_action?.operator_action_required === false
    && operatorRule?.action === 'wait';
  const allowedActions = Array.isArray(operatorRule?.allowed_actions) ? operatorRule.allowed_actions : [];
  const accelerationAllowed = Boolean(canAddLane && allowedActions.some((action) =>
    /^(retune_lanes|add_embedding_lane|increase_embedding_lanes)$/.test(action)));
  const mode = Number.isFinite(pending) && pending > 0 && phase === 'draining'
    ? 'historical_repair'
    : phase === 'complete'
      ? 'complete'
      : 'pipeline_state';
  const reason = waitOnly
    ? canAddLane
      ? 'status says wait; acceleration still requires an explicit operator action'
      : 'status says wait and memory headroom forbids adding lanes'
    : accelerationAllowed
      ? 'status requires action and memory headroom allows a lane change'
      : 'obey status action before changing throughput';
  return {
    mode,
    user_speed_goal: 'fast_first_use',
    first_use_readiness_bar: 'direct_local_evidence_reaches_chat_while_pending_embedding',
    first_use_failure_action: 'fix_import_classification_local_search_entity_card_or_chat_context',
    backfill_speed_goal: 'safe_historical_repair',
    normal_user_path: 'bounded_local_evidence_before_full_vector_backfill',
    raw_throughput_launch_metric: false,
    status_kind: statusKind,
    wait_only: waitOnly,
    pending_embeddings: Number.isFinite(pending) ? pending : null,
    trend_rate_per_hour: Number.isFinite(trendRate) ? trendRate : null,
    trend_eta_hours: Number.isFinite(trendEta) ? trendEta : null,
    sample_rate_per_hour: Number.isFinite(sampleRate) ? sampleRate : null,
    sample_eta_hours: Number.isFinite(sampleEta) ? sampleEta : null,
    memory_pressure: memoryPressure,
    memory_ok: memoryOk,
    can_add_lane_by_rss: canAddLane,
    acceleration_allowed: accelerationAllowed,
    reason,
  };
}

export function drainMovementEvidence(live, operatorRule = operatorRuleEvidence(live)) {
  const progress = live?.live_progress || {};
  const eta = live?.effective_eta || live?.eta || {};
  const lanes = live?.drain?.lanes || {};
  const hold = live?.drain?.hold || {};
  const state = progress.state || null;
  const etaReason = eta.live_eta_unavailable_reason || progress.eta_unavailable_reason || null;
  const holdAlive = hold.process_alive === true;
  const waitOnly = live?.status_action?.kind === 'wait'
    && live?.status_action?.operator_action_required === false
    && operatorRule?.action === 'wait';
  const effectiveWriter = lanes.effective_count === 1
    || lanes.effective_mode === 'single_in_process_writer'
    || lanes.effective_mode === 'yielding_to_foreground';
  const warmupNoSample = state === 'fresh_no_progress'
    && etaReason === 'warmup_no_rate_sample_yet'
    && holdAlive
    && waitOnly
    && effectiveWriter;
  const stallSignal = state === 'fresh_no_progress'
    && warmupNoSample !== true
    && live?.trend?.moving !== true;
  const reason = warmupNoSample
    ? 'current pass has no rate sample yet; live hold is healthy and status says wait'
    : live?.trend?.moving === true
      ? 'longer trend is moving; use status action before interpreting current-pass noise'
      : operatorRule?.message || 'obey status action before interpreting movement';
  return {
    state,
    eta_unavailable_reason: etaReason,
    current_run_completed: finiteNumberOrNull(progress.current_run_completed_from_db),
    hold_alive: holdAlive,
    effective_writer_mode: lanes.effective_mode || null,
    trend_moving: live?.trend?.moving === true,
    wait_only: waitOnly,
    warmup_no_sample: warmupNoSample,
    stall_signal: stallSignal,
    reason,
  };
}

function invariantRows({ contract, invariantTests, dp7SafeTests, status, proofChecksSkipped = false }) {
  const live = status.payload || {};
  const dp7 = dp7ProofEvidence(live);
  const statusHealthy = status.ok === true
    && live.ok === true
    && statusActionIsHealthy(live, dp7);
  return INVARIANTS.map(([id, title]) => {
    if (proofChecksSkipped) {
      return {
        id,
        title,
        status: 'not_proved',
        evidence: 'safe tests were skipped by --skip-contract-tests; run without skip for operator proof',
      };
    }
    if (id === 'DP-7') {
      if (dp7SafeTests?.ok !== true) {
        return {
          id,
          title,
          status: 'not_proved',
          evidence: dp7SafeTests?.summary || 'safe DP-7 import/browser/data-plane tests did not pass',
        };
      }
      return {
        id,
        title,
        status: dp7.status,
        evidence: dp7.evidence,
      };
    }
    const group = invariantTests.groups?.[id] || null;
    if (contract.ok && group?.ok === true && statusHealthy) {
      return {
        id,
        title,
        status: 'guarded',
        evidence: group.skipped
          ? 'safe tests were skipped; cadence-safe live status is healthy'
          : `${group.files.length} invariant test file(s) passed and cadence-safe live status is healthy`,
      };
    }
    return {
      id,
      title,
      status: 'not_proved',
      evidence: contract.ok
        ? group?.ok === false
          ? group.summary
          : 'live status is not healthy'
        : 'contract tests failed',
    };
  });
}

async function buildReport(opts) {
  const contractFilePresent = existsSync(resolve(REPO_ROOT, CONTRACT_FILE));
  const contract = contractFilePresent
    ? runContractTests({ skip: opts.skipContractTests })
    : {
      ok: false,
      skipped: false,
      command: ['node', '--test', ...SAFE_CONTRACT_TESTS].join(' '),
      status: null,
      summary: `${CONTRACT_FILE} is missing`,
    };
  const invariantTests = contractFilePresent
    ? runInvariantTests({ skip: opts.skipContractTests })
    : {
      ok: false,
      skipped: false,
      summary: `${CONTRACT_FILE} is missing`,
      groups: {},
    };
  const dp7SafeTests = contractFilePresent
    ? runDp7SafeTests({ skip: opts.skipContractTests })
    : {
      ok: false,
      skipped: false,
      command: ['node', '--test', ...SAFE_DP7_TESTS].join(' '),
      status: null,
      summary: `${CONTRACT_FILE} is missing`,
    };
  const remainingRisks = remainingRisksFromContract();
  const status = await readStatusWithTransientRetry();
  const live = status.payload || {};
  const dp7Proof = dp7ProofEvidence(live);
  const operatorRule = operatorRuleEvidence(live, dp7Proof);
  const speedPosture = speedPostureEvidence(live, operatorRule);
  const drainMovement = drainMovementEvidence(live, operatorRule);
  const completionRiskConflicts = unresolvedCompletionRiskConflicts(remainingRisks, {
    completionProved: dp7Proof.ok === true,
  });
  const remainingRiskCompletionOk = completionRiskConflicts.length === 0;
  const proofChecksSkipped = opts.skipContractTests === true;
  const healthOk = !proofChecksSkipped
    && contractFilePresent
    && contract.ok === true
    && invariantTests.ok === true
    && dp7SafeTests.ok === true
    && remainingRisks.ok === true
    && status.ok === true
    && live.ok === true
    && statusActionIsHealthy(live, dp7Proof);
  const completionOk = dp7Proof.ok === true && remainingRiskCompletionOk;
  const ok = healthOk && (!opts.requireComplete || completionOk);
  const rows = invariantRows({ contract, invariantTests, dp7SafeTests, status, proofChecksSkipped });
  return {
    ok,
    health_ok: healthOk,
    complete: completionOk,
    require_complete: opts.requireComplete,
    proof_checks_skipped: proofChecksSkipped,
    contract_file: {
      path: CONTRACT_FILE,
      present: contractFilePresent,
    },
    contract_tests: contract,
    invariant_tests: invariantTests,
    dp7_safe_tests: dp7SafeTests,
    remaining_risks: {
      ...remainingRisks,
      completion_ok: remainingRiskCompletionOk,
      completion_conflicts: completionRiskConflicts,
    },
    dp7_proof: dp7Proof,
    operator_rule: operatorRule,
    speed_posture: speedPosture,
    drain_movement: drainMovement,
    live_status: {
      ok: status.ok,
      command: status.command,
      primary_command: status.primary_command || null,
      fallback_used: status.fallback_used === true,
      fallback_source: status.fallback_source || null,
      primary_status: status.primary_status ?? null,
      primary_signal: status.primary_signal || null,
      primary_stderr: status.primary_stderr || null,
      primary_error: status.primary_error || null,
      phase: live.phase || null,
      complete: live.complete === true,
      pending_embeddings: live.db?.pending_embeddings ?? null,
      work_order: live.db ? {
        selectable_pending: live.db.work_order_selectable_pending ?? null,
        blocked_pending: live.db.work_order_blocked_pending ?? null,
        head: live.db.work_order_head || null,
        topics: live.db.work_order_topics || [],
        ordering: live.db.work_order_ordering || null,
      } : null,
      status_action: live.status_action || null,
      warning_summary: live.warning_summary || null,
      warning_details: live.warning_details || [],
      blocker_summary: live.blocker_summary || null,
      launch_contract: live.launch_contract || null,
      final_product_proof: live.final_product_proof || null,
      retrieval: live.retrieval || null,
      effective_eta: live.effective_eta || live.eta || null,
      eta: live.eta || null,
      trend: live.trend || null,
      memory_headroom: live.memory_headroom || null,
      live_progress: live.live_progress || null,
      drain: live.drain || null,
      services: live.services || null,
      code_freshness: live.code_freshness || null,
      post_drain: live.post_drain || null,
      snapshot: live.snapshot || null,
      attempts: status.attempts || [],
      parse_error: status.parse_error,
      recovered_from_mixed_stdout: status.recovered_from_mixed_stdout === true,
      stderr: status.stderr,
      error: status.error,
    },
    invariants: rows,
    remaining: rows.filter((row) => row.status !== 'guarded' && row.status !== 'proved'),
  };
}

function printText(report) {
  console.log(`boring_data_pipeline: ${report.health_ok ? 'healthy' : 'attention_required'} complete=${report.complete}`);
  if (report.proof_checks_skipped) {
    console.log('proof_checks: skipped - not valid operator proof');
  }
  console.log(`contract: ${report.contract_tests.summary}`);
  console.log(`invariants: ${report.invariant_tests.summary}`);
  console.log(`dp7_safe_tests: ${report.dp7_safe_tests.summary}`);
  console.log(`remaining_risks: ${report.remaining_risks.summary}`);
  if (report.remaining_risks.completion_conflicts?.length) {
    const conflicts = report.remaining_risks.completion_conflicts
      .map((risk) => `risk_${risk.rank}`)
      .join(',');
    console.log(`remaining_risks_completion: blocked_by=${conflicts}`);
  } else if (report.remaining_risks.ok === true) {
    console.log('remaining_risks_completion: clear');
  }
  for (const risk of report.remaining_risks.risks || []) {
    const detail = risk.detail ? ` ${risk.detail}` : '';
    console.log(`risk_${risk.rank}: ${risk.title}${detail}`);
  }
  const live = report.live_status;
  console.log(`status: phase=${live.phase || 'unknown'} pending=${live.pending_embeddings ?? 'unknown'} action=${live.status_action?.kind || 'unknown'} operator_action=${live.status_action?.operator_action_required === true}`);
  const warningSummary = live.warning_summary || null;
  if (warningSummary && Number(warningSummary.total) > 0) {
    const warningDetails = Array.isArray(live.warning_details) ? live.warning_details : [];
    const actions = uniqueActions(
      warningSummary.operator_actions,
      warningDetails.map((detail) => detail?.action),
    );
    const codes = uniqueActions(warningDetails.map((detail) => detail?.code));
    console.log(`warnings: total=${warningSummary.total ?? 'unknown'} info=${warningSummary.info ?? 'unknown'} expected_while_draining=${warningSummary.all_expected_while_draining === true} operator_action=${warningSummary.operator_action_required === true} actions=${actions.join(',') || 'none'} codes=${codes.join(',') || 'none'}`);
  }
  const retry = statusAttemptSummary(live.attempts);
  if (retry) {
    console.log(`status_retry: attempts=${retry.attempts} first=${retry.first} last=${retry.last}`);
  }
  if (live.status_action?.recheck_after) {
    console.log(`next_check: ${live.status_action.recheck_after}`);
  }
  const progress = live.live_progress || null;
  const eta = live.effective_eta || live.eta || null;
  if (eta) {
    console.log(
      `eta: authoritative_hours=${eta.hours ?? 'unknown'}` +
      ` source=${eta.authoritative_eta_source || 'none'}` +
      ` sample_hours=${eta.non_authoritative_sample_hours ?? 'unknown'}` +
      ` sample_rate_per_hour=${eta.non_authoritative_sample_rate_per_hour ?? 'unknown'}` +
      ` sample_representative=${eta.non_authoritative_sample_representative === true}` +
      ` reason=${eta.non_authoritative_sample_reason || eta.live_eta_unavailable_reason || 'unknown'}`,
    );
  }
  if (progress) {
    console.log(`progress: state=${progress.state || 'unknown'} pending=${progress.pending ?? 'unknown'} current_run_completed=${progress.current_run_completed_from_db ?? 'unknown'} observed_rate_per_hour=${progress.observed_sample_rate_per_hour ?? 'unknown'} sample_eta_hours=${eta?.non_authoritative_sample_hours ?? 'unknown'} representative=${progress.observed_rate_representative === true} required_rate_per_hour=${progress.required_rate_per_hour_for_target ?? 'unknown'} yielding=${progress.yielding_to_foreground === true}`);
  }
  const movement = report.drain_movement || null;
  if (movement) {
    console.log(`drain_movement: state=${movement.state || 'unknown'} eta_reason=${movement.eta_unavailable_reason || 'none'} current_run_completed=${movement.current_run_completed ?? 'unknown'} hold_alive=${movement.hold_alive === true} writer=${movement.effective_writer_mode || 'unknown'} trend_moving=${movement.trend_moving === true} wait_only=${movement.wait_only === true} warmup_no_sample=${movement.warmup_no_sample === true} stall_signal=${movement.stall_signal === true} reason=${movement.reason || 'unknown'}`);
  }
  const workOrder = live.work_order || null;
  if (workOrder) {
    const topics = Array.isArray(workOrder.topics) ? workOrder.topics : [];
    const head = topics
      .map((topic) => `${topic.topic}=p${topic.priority}/pending${topic.pending}/email${topic.email_share}/short${topic.short_pending}/long${topic.long_pending}`)
      .join(',');
    console.log(`work_order: selectable=${workOrder.selectable_pending ?? 'unknown'} blocked=${workOrder.blocked_pending ?? 'unknown'} sorted=${workOrder.ordering?.ok === true} rule=${workOrder.ordering?.rule || 'unknown'} head=${head || 'empty'}`);
  }
  const trend = live.trend || null;
  if (trend) {
    console.log(`trend: basis=${trend.basis || 'unknown'} requested_window_hours=${trend.requested_window_hours ?? 'unknown'} window_hours=${trend.window_hours ?? 'unknown'} samples=${trend.sample_count ?? 'unknown'} pending_drained=${trend.pending_drained ?? 'unknown'} rate_per_hour=${trend.rate_per_hour ?? 'unknown'} eta_hours=${trend.eta_hours ?? 'unknown'} representative=${trend.representative === true} reason=${trend.representative_reason || 'none'} moving=${trend.moving === true}`);
  }
  const memoryHeadroom = live.memory_headroom || null;
  if (memoryHeadroom) {
    console.log(`memory_headroom: ok=${memoryHeadroom.ok === true} pressure=${memoryHeadroom.pressure || 'unknown'} available_gb=${memoryHeadroom.available_gb ?? 'unknown'} drain_process_visible=${memoryHeadroom.drain_process_visible === true} respawn_grace=${memoryHeadroom.respawn_grace === true} drain_rss_headroom_mb=${memoryHeadroom.drain_rss_headroom_mb ?? 'unknown'} projected_rss_with_one_more_lane_mb=${memoryHeadroom.projected_rss_with_one_more_lane_mb ?? 'unknown'} can_add_lane_by_rss=${memoryHeadroom.can_add_lane_by_rss === true} recommendation=${memoryHeadroom.recommendation || 'none'}`);
  }
  const lanes = live.drain?.lanes || null;
  const hold = live.drain?.hold || null;
  const respawn = live.drain?.respawn_grace || null;
  const watcherStatus = live.services?.post_drain_watcher_status || live.post_drain?.status || null;
  if (lanes || hold || watcherStatus) {
    console.log(`drain: lanes=${lanes?.effective_count ?? 'unknown'} mode=${lanes?.effective_mode || 'unknown'} rss_mb=${lanes?.rss_mb ?? 'unknown'} recommendation=${lanes?.recommendation || 'none'} hold_alive=${hold?.process_alive === true} respawn_grace=${respawn?.ok === true} respawn_log_age_ms=${respawn?.log_age_ms ?? 'unknown'} watcher=${watcherStatus || 'unknown'}`);
  }
  const codeFreshness = live.code_freshness || null;
  if (codeFreshness) {
    const staleEmbedDaemonFiles = Array.isArray(codeFreshness.embed_daemon_stale_files)
      ? codeFreshness.embed_daemon_stale_files.length
      : 'unknown';
    console.log(`code_freshness: all_current=${codeFreshness.all_current === true} drain_wrapper_current=${codeFreshness.drain_wrapper_current === true} drain_worker_current=${codeFreshness.drain_worker_current === true} embed_daemon_current=${codeFreshness.embed_daemon_current === true} embed_daemon_stale_files=${staleEmbedDaemonFiles} post_drain_runner_current=${codeFreshness.post_drain_runner_current === true}`);
  }
  const postDrain = live.post_drain || null;
  if (postDrain) {
    const ann = postDrain.preflight_ann_source_freshness || null;
    const memory = postDrain.memory_refocus_projection || null;
    console.log(`post_drain: status=${postDrain.status || 'unknown'} fresh=${postDrain.fresh === true} preflight_ok=${postDrain.preflight_ok === true} ann_lag=${ann?.lag_chunks ?? 'unknown'} ann_within_lag=${ann?.within_lag === true} memory_after=${memory?.after ?? 'unknown'} memory_threshold=${memory?.threshold ?? 'unknown'} memory_ok=${memory?.ok === true}`);
  }
  if (report.operator_rule?.message) {
    console.log(`operator_rule: ${report.operator_rule.message}`);
    const actionText = operatorActionsText(report.operator_rule);
    if (actionText) console.log(actionText);
  }
  const speed = report.speed_posture || null;
  if (speed) {
    console.log(`speed_posture: mode=${speed.mode || 'unknown'} user_speed_goal=${speed.user_speed_goal || 'unknown'} first_use_bar=${speed.first_use_readiness_bar || 'unknown'} first_use_failure_action=${speed.first_use_failure_action || 'unknown'} backfill_speed_goal=${speed.backfill_speed_goal || 'unknown'} normal_user_path=${speed.normal_user_path || 'unknown'} raw_throughput_launch_metric=${speed.raw_throughput_launch_metric === true} status=${speed.status_kind || 'unknown'} wait_only=${speed.wait_only === true} pending=${speed.pending_embeddings ?? 'unknown'} trend_rate_per_hour=${speed.trend_rate_per_hour ?? 'unknown'} trend_eta_hours=${speed.trend_eta_hours ?? 'unknown'} sample_rate_per_hour=${speed.sample_rate_per_hour ?? 'unknown'} sample_eta_hours=${speed.sample_eta_hours ?? 'unknown'} memory_pressure=${speed.memory_pressure || 'unknown'} memory_ok=${speed.memory_ok === true} can_add_lane_by_rss=${speed.can_add_lane_by_rss === true} acceleration_allowed=${speed.acceleration_allowed === true} reason=${speed.reason || 'unknown'}`);
  }
  for (const row of report.invariants) {
    const evidence = row.evidence ? ` (${row.evidence})` : '';
    console.log(`${row.id}: ${row.status} - ${row.title}${evidence}`);
  }
  if (report.dp7_proof) {
    const next = report.dp7_proof.next_step;
    if (next?.id) {
      console.log(`dp7_next: ${next.id} - ${next.detail || next.status || 'pending'}`);
    }
    const launchCounts = report.dp7_proof.launch_contract_counts || {};
    const pendingStepIds = report.dp7_proof.pending_step_ids?.length
      ? report.dp7_proof.pending_step_ids.join(',')
      : 'none';
    const blockedStepIds = report.dp7_proof.blocked_step_ids?.length
      ? report.dp7_proof.blocked_step_ids.join(',')
      : 'none';
    console.log(`dp7_steps: status=${report.dp7_proof.launch_contract_status || 'unknown'} contract_ok=${report.dp7_proof.launch_contract_ok === true} counts_ok=${launchCounts.ok ?? 'unknown'} pending=${launchCounts.pending ?? 'unknown'} blocked=${launchCounts.blocked ?? 'unknown'} next=${next?.id || 'none'} pending_ids=${pendingStepIds} blocked_ids=${blockedStepIds}`);
    if (report.dp7_proof.product_proof) {
      const proof = report.dp7_proof.product_proof;
      const missingRequested = proof.missing_requested_rows?.length
        ? proof.missing_requested_rows.join(',')
        : 'none';
      const missingGreen = proof.missing_green_rows?.length
        ? proof.missing_green_rows.join(',')
        : 'none';
      const nonGreen = proof.non_green_rows?.length
        ? proof.non_green_rows.join(',')
        : 'none';
      const deferredExact = proof.deferred_exact_proof_rows?.length
        ? proof.deferred_exact_proof_rows.join(',')
        : 'none';
      const dataPlane = proof.data_plane_proof || {};
      const missingDataPlane = dataPlane.missing_boundaries?.length
        ? dataPlane.missing_boundaries.join(',')
        : 'none';
      const nonGreenDataPlane = dataPlane.non_green_boundaries?.length
        ? dataPlane.non_green_boundaries.join(',')
        : 'none';
      const dataPlaneVerdict = proof.data_plane_proof_verdict || {};
      const missingDataPlaneVerdict = dataPlaneVerdict.missing_boundaries?.length
        ? dataPlaneVerdict.missing_boundaries.join(',')
        : 'none';
      const nonGreenDataPlaneVerdict = dataPlaneVerdict.non_green_boundaries?.length
        ? dataPlaneVerdict.non_green_boundaries.join(',')
        : 'none';
      console.log(`dp7_product_proof: present=${proof.present === true} missing_requested=${missingRequested} missing_green=${missingGreen} non_green=${nonGreen} deferred_exact=${deferredExact} browser_entity_card=${proof.browser_entity_card_proof?.ok === true} data_plane=${dataPlane.ok === true} data_plane_source=${dataPlane.source || 'none'} data_plane_missing=${missingDataPlane} data_plane_non_green=${nonGreenDataPlane} import_classification=${dataPlane.import_classification_ok === true} first_use_context=${dataPlane.first_use_context_ok === true} data_plane_verdict=${dataPlaneVerdict.ok === true} data_plane_verdict_source=${dataPlaneVerdict.source || 'none'} data_plane_verdict_missing=${missingDataPlaneVerdict} data_plane_verdict_non_green=${nonGreenDataPlaneVerdict} import_classification_verdict=${dataPlaneVerdict.import_classification_ok === true} first_use_context_verdict=${dataPlaneVerdict.first_use_context_ok === true}`);
    }
    const closeBar = report.dp7_proof.close_bar || {};
    const backlog = report.dp7_proof.backlog || {};
    const missingBacklog = report.dp7_proof.missing_backlog_counters?.length
      ? report.dp7_proof.missing_backlog_counters.join(',')
      : 'none';
    const invalidBacklog = report.dp7_proof.invalid_backlog_counters?.length
      ? report.dp7_proof.invalid_backlog_counters.join(',')
      : 'none';
    const nonzeroBacklog = report.dp7_proof.nonzero_backlog_counters?.length
      ? report.dp7_proof.nonzero_backlog_counters.join(',')
      : 'none';
    console.log(`dp7_backlog: zero=${report.dp7_proof.backlog_zero === true} missing=${missingBacklog} invalid=${invalidBacklog} nonzero=${nonzeroBacklog} pending_embeddings=${backlog.pending_embeddings ?? 'unknown'} personal_pending=${backlog.personal_pending ?? 'unknown'} non_personal_pending=${backlog.non_personal_pending ?? 'unknown'} work_order_selectable_pending=${backlog.work_order_selectable_pending ?? 'unknown'} work_order_blocked_pending=${backlog.work_order_blocked_pending ?? 'unknown'}`);
    console.log(`dp7_close_bar: live_status_closed=${closeBar.live_status_closed === true} backlog_zero=${closeBar.backlog_zero === true} launch_contract_closed=${closeBar.launch_contract_closed === true} final_writer_release=${closeBar.final_writer_release === true} final_product_step=${closeBar.final_product_step === true} product_proof=${closeBar.product_proof === true} retrieval=${closeBar.retrieval === true} close_goal=${closeBar.close_goal === true}`);
    if (report.dp7_proof.retrieval) {
      const retrieval = report.dp7_proof.retrieval;
      console.log(`retrieval: global_ann_ready=${retrieval.global_ann_ready === true} state=${retrieval.global_ann_state || 'unknown'} reason=${retrieval.global_ann_reason || 'none'} vector_mode=${retrieval.vector_projection_mode || 'unknown'} stale_vectors_skipped=${retrieval.stale_vectors_skipped === true} source_ok=${retrieval.source_projection_ok === true} source_lag=${retrieval.source_projection_lag_chunks ?? 'unknown'} within_lag=${retrieval.source_projection_within_lag === true} missing_vectors=${retrieval.source_projection_missing_vectors ?? 'unknown'} malformed_rows=${retrieval.source_projection_malformed_rows ?? 'unknown'}`);
    }
  }
  if (report.remaining.length) {
    console.log(`remaining: ${report.remaining.map((row) => row.id).join(', ')}`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs();
  } catch (err) {
    console.error(`[boring-data-pipeline-audit] ${err.message}`);
    console.error(usage());
    process.exit(2);
  }
  if (opts.help) {
    console.log(usage());
    return;
  }

  const report = await buildReport(opts);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printText(report);
  if ((opts.strict || opts.requireComplete) && !report.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
