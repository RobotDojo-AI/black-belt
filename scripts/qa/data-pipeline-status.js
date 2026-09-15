#!/usr/bin/env node
/**
 * Data pipeline launch status.
 *
 * One read-only surface for the embedding drain and post-drain handoff. The
 * `ok` flag means "healthy and supervised"; `complete` means the whole data
 * repair chain has finished.
 */

export const INTELLIGENCE_TIER = 'verification';

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const STATUS_SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(STATUS_SCRIPT_FILE), '..', '..');
const CONFIG_DIR = process.env.ROBOTDOJO_CONFIG || resolve(homedir(), '.robotdojo');
const RUNTIME_DIR = resolve(CONFIG_DIR, 'runtime');
const LOG_DIR = resolve(CONFIG_DIR, 'logs');
const POST_DRAIN_LABEL = process.env.ROBOTDOJO_STATUS_POST_DRAIN_LABEL
  || 'com.robotdojo.post-embedding-drain-pipeline.codex';
const DRAIN_LABEL = process.env.ROBOTDOJO_STATUS_DRAIN_LABEL
  || 'com.robotdojo.drain-personal-embeddings.codex2guard';
const DAEMON_LABEL = process.env.ROBOTDOJO_STATUS_EMBED_DAEMON_LABEL
  || 'com.robotdojo.chunk-embed-daemon';
const DRAIN_WRAPPER_FILE = resolve(REPO_ROOT, 'scripts/migration/run-embedding-drain-guarded.mjs');
const DRAIN_WORKER_FILE = resolve(REPO_ROOT, 'scripts/migration/drain-personal-embeddings.mjs');
const EMBED_DAEMON_FILES = [
  resolve(REPO_ROOT, 'scripts/chunk-embed-daemon.mjs'),
  resolve(REPO_ROOT, 'lib/rag/embed.js'),
  resolve(REPO_ROOT, 'lib/rag/lane-pool.js'),
  resolve(REPO_ROOT, 'lib/rag/work-order.js'),
  resolve(REPO_ROOT, 'lib/chunk-worker.js'),
];
const POST_DRAIN_RUNNER_FILE = resolve(REPO_ROOT, 'scripts/migration/run-post-embedding-drain-pipeline.mjs');
const POST_DRAIN_STATUS_FILE = process.env.ROBOTDOJO_POST_DRAIN_STATUS_FILE
  || resolve(RUNTIME_DIR, 'post-embedding-drain-pipeline.json');
const POST_DRAIN_LOCK_FILE = process.env.ROBOTDOJO_POST_DRAIN_LOCK_FILE
  || resolve(RUNTIME_DIR, 'post-embedding-drain-pipeline.lock');
const POST_DRAIN_LOG_FILE = process.env.ROBOTDOJO_POST_DRAIN_LOG_FILE
  || resolve(LOG_DIR, 'post-embedding-drain-pipeline.log');
const POST_DRAIN_LAUNCHD_LOG_FILE = resolve(LOG_DIR, 'post-embedding-drain-pipeline.launchd.log');
const POST_DRAIN_PREFLIGHT_FILE = process.env.ROBOTDOJO_POST_DRAIN_PREFLIGHT_RESULT_FILE
  || resolve(RUNTIME_DIR, 'post-drain-preflight.json');
const STATUS_SUMMARY_FILE = process.env.ROBOTDOJO_STATUS_SUMMARY_FILE
  || resolve(RUNTIME_DIR, 'data-pipeline-status-summary.json');
const STATUS_HISTORY_FILE = process.env.ROBOTDOJO_STATUS_HISTORY_FILE
  || resolve(RUNTIME_DIR, 'data-pipeline-status-history.json');
const POST_DRAIN_PREFLIGHT_SCRIPT = resolve(REPO_ROOT, 'scripts/qa/post-drain-preflight.js');
const REQUIRED_POST_DRAIN_PREFLIGHT_COMMANDS = Object.freeze([
  'scripts/migration/run-post-embedding-drain-pipeline.mjs',
  'scripts/qa/post-drain-preflight.js',
  'scripts/backup-dispatcher.js',
  'scripts/ingest/05-reclassify-chunks.js',
  'scripts/migration/repair-split-vec-orphans.mjs',
  'scripts/qa/check-vec-orphans.js',
  'scripts/repair-source-topic-metadata.js',
  'scripts/maintenance-phases.js',
  'scripts/build-global-hnsw.js',
  'scripts/repair-memory-routing.js',
  'scripts/refocus-memory-routing.js',
  'scripts/memory-recalc.js',
  'scripts/qa/routing-residue-audit.js',
  'scripts/qa/launch-stoplight.js',
]);
const REQUIRED_POST_DRAIN_PREFLIGHT_DEPENDENCIES = Object.freeze([
  'lib/db.js',
  'lib/config.js',
  'lib/chat-models.js',
  'lib/rag/embed.js',
  'lib/rag/retrieve.js',
  'lib/rag/work-order.js',
  'lib/rag/lane-pool.js',
  'lib/data-plane-proof.js',
  'lib/chat-context.js',
  'lib/split-vector-store.js',
  'lib/topic-routing-policy.js',
  'lib/memory-scope-routing.js',
  'lib/topic-context.js',
  'lib/ann/usearch-adapter.js',
  'lib/embed-pause-hold.js',
  'lib/embed-proof-freeze.js',
  'lib/maintenance-routines.js',
  'lib/request-observer.js',
  'scripts/backup-to-gcp.js',
  'scripts/background-status.js',
  'scripts/qa/tests/first-session-launch.spec.js',
  'scripts/qa/tests/chat-browser-real-turn.spec.js',
  'scripts/qa/tests/chat-path-matrix.spec.js',
  'scripts/qa/tests/env.js',
  'scripts/qa/tests/frontend-workbench-helpers.js',
  'scripts/qa/global-setup.js',
  'playwright.config.js',
  'config/sla.js',
]);
const HANDOFF_FILE = process.env.ROBOTDOJO_DRAIN_HANDOFF_FILE
  || resolve(RUNTIME_DIR, 'embedding-drain-handoff.json');
const STOPLIGHT_LATEST = process.env.ROBOTDOJO_STATUS_STOPLIGHT_LATEST
  || resolve(LOG_DIR, 'launch-stoplight-latest.json');
const FINAL_PRODUCT_PROOF_SNAPSHOT_DIR = resolve(LOG_DIR, 'launch-stoplight-snapshots');
const MAX_WATCHER_STATUS_AGE_MS = envNumber('ROBOTDOJO_STATUS_MAX_WATCHER_STATUS_AGE_MS', 15 * 60_000);
const MAX_STATUS_SUMMARY_AGE_MS = envNumber('ROBOTDOJO_STATUS_SUMMARY_MAX_AGE_MS', 5 * 60_000);
const MAX_STATUS_HISTORY_AGE_MS = envNumber('ROBOTDOJO_STATUS_HISTORY_MAX_AGE_MS', 7 * 24 * 60 * 60_000);
const MAX_STATUS_HISTORY_POINTS = envNumber('ROBOTDOJO_STATUS_HISTORY_MAX_POINTS', 1000);
const MAX_READY_HANDOFF_AGE_MS = envNumber(
  'ROBOTDOJO_STATUS_MAX_READY_HANDOFF_AGE_MS',
  envNumber('ROBOTDOJO_POST_DRAIN_MAX_READY_HANDOFF_AGE_MS', 6 * 60 * 60_000),
);
const DEFAULT_POST_DRAIN_PREFLIGHT_MAX_AGE_MS = 72 * 60 * 60_000;
const MAX_PREFLIGHT_AGE_MS = envNumber('ROBOTDOJO_STATUS_MAX_POST_DRAIN_PREFLIGHT_AGE_MS', DEFAULT_POST_DRAIN_PREFLIGHT_MAX_AGE_MS);
const MAX_PREFLIGHT_ANN_SOURCE_LAG = envNumber('ROBOTDOJO_STATUS_MAX_PREFLIGHT_ANN_SOURCE_LAG', 2048);
const MAX_STOPLIGHT_AGE_MS = envNumber('ROBOTDOJO_STATUS_MAX_STOPLIGHT_AGE_MS', 30 * 60_000);
const DRAIN_TREND_WINDOW_MS = envNumber('ROBOTDOJO_STATUS_DRAIN_TREND_WINDOW_MS', 48 * 60 * 60_000);
const DRAIN_TREND_MAX_POINTS = envNumber('ROBOTDOJO_STATUS_DRAIN_TREND_MAX_POINTS', 24);
const MAX_DRAIN_LOG_AGE_MS = envNumber('ROBOTDOJO_STATUS_MAX_DRAIN_LOG_AGE_MS', 15 * 60_000);
const DRAIN_LOG_TAIL_BYTES = envNumber('ROBOTDOJO_STATUS_DRAIN_LOG_TAIL_BYTES', 256 * 1024);
const DRAIN_LOG_SCAN_LINES = envNumber('ROBOTDOJO_STATUS_DRAIN_LOG_SCAN_LINES', 5000);
const MAX_DRAIN_ETA_HOURS = envNumber('ROBOTDOJO_STATUS_MAX_DRAIN_ETA_HOURS', 48);
const TARGET_DRAIN_HOURS = envNumber('ROBOTDOJO_STATUS_TARGET_DRAIN_HOURS', MAX_DRAIN_ETA_HOURS);
const MIN_REPRESENTATIVE_ETA_COMPLETED = envNumber('ROBOTDOJO_STATUS_MIN_REPRESENTATIVE_ETA_COMPLETED', 512);
const MIN_REPRESENTATIVE_TREND_HOURS = envNumber('ROBOTDOJO_STATUS_MIN_REPRESENTATIVE_TREND_HOURS', 1);
const MIN_REPRESENTATIVE_TREND_DRAINED = envNumber('ROBOTDOJO_STATUS_MIN_REPRESENTATIVE_TREND_DRAINED', MIN_REPRESENTATIVE_ETA_COMPLETED);
const TREND_ZERO_REBOUND_MAX_MS = envNumber('ROBOTDOJO_STATUS_TREND_ZERO_REBOUND_MAX_MS', 30 * 60_000);
const TREND_ZERO_REBOUND_MIN_PENDING = envNumber('ROBOTDOJO_STATUS_TREND_ZERO_REBOUND_MIN_PENDING', 1000);
const HEALTHY_DRAIN_RECHECK_MS = envNumber('ROBOTDOJO_STATUS_HEALTHY_DRAIN_RECHECK_MS', 30 * 60_000);
const POST_DRAIN_RECHECK_MS = envNumber('ROBOTDOJO_STATUS_POST_DRAIN_RECHECK_MS', 5 * 60_000);
const ACTION_REQUIRED_RECHECK_MS = envNumber('ROBOTDOJO_STATUS_ACTION_REQUIRED_RECHECK_MS', 0);
const MIN_FREE_GB = envNumber('ROBOTDOJO_STATUS_MIN_FREE_GB', envNumber('ROBOTDOJO_DRAIN_MIN_FREE_GB', 6));
const WORK_ORDER_HEAD_LIMIT = envNumber('ROBOTDOJO_STATUS_WORK_ORDER_HEAD_LIMIT', 8);
const EMBED_LONG_INPUT_CHARS = envNumber('ROBOTDOJO_EMBED_LONG_INPUT_CHARS', 2000);
const VALUE_RANK_ENTITY_FLOOR = 1_000_000_000_000;
const DRAIN_MAX_LANES = 3;
const DRAIN_RSS_CEILING_MB = envNumber('ROBOTDOJO_EMBED_RSS_CEILING_MB', 6000);
const MIN_DRAIN_RSS_HEADROOM_MB = envNumber('ROBOTDOJO_STATUS_MIN_DRAIN_RSS_HEADROOM_MB', 750);
const MIN_ACTIVE_DRAIN_CPU_PCT = envNumber('ROBOTDOJO_STATUS_MIN_ACTIVE_DRAIN_CPU_PCT', 5);
const MAX_ACTIVE_DRAIN_WARMUP_MS = envNumber('ROBOTDOJO_STATUS_MAX_ACTIVE_DRAIN_WARMUP_MS', 90_000);
const MAX_GUARDED_DRAIN_RESPAWN_GRACE_MS = envNumber('ROBOTDOJO_STATUS_MAX_GUARDED_DRAIN_RESPAWN_GRACE_MS', 90_000);
const MAIN_DB_BASENAME = basename(process.env.ROBOTDOJO_DB || 'robotdojo.db');
const VECTOR_DB_BASENAME = basename(process.env.ROBOTDOJO_EMBEDDINGS_DB || 'embeddings.db');
const MAX_POST_DRAIN_PERSONAL_UNEXPLAINED_IMPORTS = envNumber('ROBOTDOJO_POST_DRAIN_MAX_PERSONAL_UNEXPLAINED_IMPORTS', 0);
const MAX_POST_DRAIN_PERSONAL_SOURCE_METADATA_ROWS = envNumber('ROBOTDOJO_POST_DRAIN_MAX_PERSONAL_SOURCE_METADATA_ROWS', 0);
const MAX_POST_DRAIN_NEEDS_ROUTING_CHUNKS = envNumber('ROBOTDOJO_POST_DRAIN_MAX_NEEDS_ROUTING_CHUNKS', 500);
const MAX_POST_DRAIN_NEEDS_ROUTING_MEMORY = envNumber('ROBOTDOJO_POST_DRAIN_MAX_NEEDS_ROUTING_MEMORY', 500);
const FINAL_PRODUCT_PROOF_ROWS = Object.freeze([
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
const FINAL_PRODUCT_PROOF_EXPECTED_ROW_IDS = Object.freeze([
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
const FINAL_PRODUCT_PROOF_COMMAND_ARGS = Object.freeze([
  'scripts/qa/launch-stoplight.js',
  '--row',
  'private_chat',
  '--row',
  'chat_open_daemon_quiet',
  '--row',
  'chat_stall_recovery',
  '--row',
  'browser_product_proof',
  '--row',
  'data_pipeline_invariants',
  '--row',
  'retrieval_sentinel',
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
const ANN_DIR = process.env.ROBOTDOJO_ANN_DIR || resolve(homedir(), '.robotdojo-ann');
const GLOBAL_ANN_HOT_FILE = resolve(ANN_DIR, 'hot.usearch');
const GLOBAL_ANN_FULL_FILE = resolve(ANN_DIR, 'full.usearch');
const GLOBAL_ANN_SIDECAR_FILE = resolve(ANN_DIR, 'sidecar.json');
const GLOBAL_ANN_LOCK_FILE = resolve(ANN_DIR, 'sidecar.json.building');
const GLOBAL_ANN_DRIFT = (() => {
  const raw = parseFloat(process.env.ROBOTDOJO_ANN_REBUILD_DRIFT || '');
  return Number.isFinite(raw) && raw > 0 ? raw : 0.005;
})();
const GLOBAL_ANN_MIN_NEW_CHUNKS = envNumber('ROBOTDOJO_ANN_REBUILD_MIN_CHUNKS', 64);
const GLOBAL_ANN_DIM = 1024;

const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');
const summaryJsonMode = args.has('--summary-json');
const latestSummaryJsonMode = args.has('--latest-summary-json');
const respectCadenceMode = args.has('--respect-cadence');
const strictMode = args.has('--strict');
const helpMode = args.has('--help') || args.has('-h');
const AGENT_LOOP_COMMAND = 'node scripts/qa/data-pipeline-status.js --summary-json --respect-cadence --strict';
const LIVE_REFRESH_COMMAND = 'node scripts/qa/data-pipeline-status.js --summary-json --strict';
const originalConsoleLog = console.log.bind(console);
const jsonStdoutMode = latestSummaryJsonMode || summaryJsonMode || jsonMode;

function suppressDbBootNoticesForJson() {
  if (!jsonStdoutMode || helpMode) return;
  process.env.ROBOTDOJO_SUPPRESS_DB_BOOT_NOTICES = '1';
}

function guardJsonStdout() {
  if (!jsonStdoutMode || helpMode) return;
  console.log = (...parts) => {
    console.error(parts.join(' '));
  };
}

function emitJson(payload) {
  originalConsoleLog(JSON.stringify(payload, null, 2));
}

function printHelp() {
  console.log(`Usage: node scripts/qa/data-pipeline-status.js [options]

Read-only status for the embedding drain and post-drain repair chain.

Options:
  --summary-json          Print compact JSON and refresh the cached status snapshot.
  --summary-json --respect-cadence
                          Return the cached compact JSON while status_action.cadence
                          says to defer; avoids needless live DB/vector probes.
  --latest-summary-json   Print the latest cached compact JSON without live probing.
  --json                  Print full live JSON evidence.
  --strict                Exit non-zero when the returned status is not ok.
  --help, -h              Show this help.

Agent loop default:
  ${AGENT_LOOP_COMMAND}
`);
}

if (helpMode) {
  printHelp();
  process.exit(0);
}

suppressDbBootNoticesForJson();
guardJsonStdout();

function envNumber(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function fileSha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function processAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function processStartMs(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return null;
  const result = spawnSync('ps', ['-p', String(n), '-o', 'lstart='], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 3000,
  });
  if (result.status !== 0) return null;
  const raw = String(result.stdout || '').trim();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function pathWithinDir(path, dir) {
  if (!path || !dir) return false;
  const resolvedPath = resolve(String(path));
  const resolvedDir = resolve(String(dir));
  return resolvedPath.startsWith(`${resolvedDir}/`);
}

function ageMs(isoOrMs) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(String(isoOrMs || ''));
  return Number.isFinite(ms) ? Math.max(0, Date.now() - ms) : null;
}

function launchdRows() {
  const result = spawnSync('launchctl', ['list'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 5000,
  });
  const lines = String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: String(result.stderr || '').trim(),
    lines,
  };
}

function launchdEvidence(rows, label) {
  const line = rows.lines.find((candidate) => candidate.endsWith(`\t${label}`))
    || rows.lines.find((candidate) => candidate.includes(label))
    || null;
  const fields = line ? line.split(/\s+/) : [];
  const listPid = fields[0] && fields[0] !== '-' ? Number(fields[0]) : null;
  const listStatus = fields[1] && fields[1] !== '-' ? Number(fields[1]) : null;
  const listProcessAlive = listPid ? processAlive(listPid) : false;
  const print = listProcessAlive ? null : launchdPrintEvidence(launchdPrintText(label), label);
  const printPid = Number(print?.pid);
  const printProcessAlive = printPid ? processAlive(printPid) : false;
  const pid = listProcessAlive ? listPid : printProcessAlive ? printPid : listPid || print?.pid || null;
  const status = Number.isFinite(listStatus) ? listStatus : print?.last_exit_code ?? null;
  const present = Boolean(line) || print?.present === true;
  return {
    label,
    present,
    line,
    pid,
    status,
    process_alive: listProcessAlive || printProcessAlive,
    source: listProcessAlive ? 'launchctl_list' : printProcessAlive ? 'launchctl_print' : present ? 'launchctl_present' : null,
    launchctl_list: {
      ok: rows.ok,
      present: Boolean(line),
      pid: Number.isFinite(listPid) ? listPid : null,
      status: Number.isFinite(listStatus) ? listStatus : null,
      process_alive: listProcessAlive,
    },
    launchctl_print: print,
  };
}

function launchdPrintText(label) {
  if (!label || typeof process.getuid !== 'function') {
    return { ok: false, status: null, stderr: 'launchd uid unavailable', stdout: '' };
  }
  const result = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: String(result.stderr || '').trim(),
    stdout: String(result.stdout || ''),
  };
}

function launchdPrintEvidence(print, label) {
  const stdout = String(print?.stdout || '');
  const pid = Number(stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1]);
  const lastExitCode = Number(stdout.match(/^\s*last exit code\s*=\s*(-?\d+)\s*$/m)?.[1]);
  const state = stdout.match(/^\s*state\s*=\s*([^\n]+)\s*$/m)?.[1]?.trim() || null;
  const activeCount = Number(stdout.match(/^\s*active count\s*=\s*(\d+)\s*$/m)?.[1]);
  const present = print?.ok === true && (stdout.includes(`${label} = {`) || Boolean(state));
  return {
    ok: print?.ok === true,
    status: print?.status ?? null,
    stderr: print?.stderr || '',
    present,
    state,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    last_exit_code: Number.isFinite(lastExitCode) ? lastExitCode : null,
    active_count: Number.isFinite(activeCount) ? activeCount : null,
  };
}

function drainRequestedLanesEvidence({ drainLog }) {
  const fromLog = Number(drainLog?.latest_run_start?.lanes);
  if (Number.isFinite(fromLog) && fromLog > 0) {
    return { count: fromLog, source: 'drain_log_start' };
  }
  const launchd = launchdPrintText(DRAIN_LABEL);
  const match = launchd.stdout.match(/\bROBOTDOJO_EMBED_LANES=(\d+)\b/);
  if (match) {
    return {
      count: Number(match[1]),
      source: 'launchd_arguments',
      launchd_ok: launchd.ok,
    };
  }
  return {
    count: null,
    source: null,
    launchd_ok: launchd.ok,
    error: launchd.stderr || (launchd.ok ? 'ROBOTDOJO_EMBED_LANES not found' : 'launchctl print failed'),
  };
}

function diskEvidence(path = CONFIG_DIR) {
  const result = spawnSync('df', ['-Pk', path], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 3000,
  });
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  const fields = (lines[1] || '').trim().split(/\s+/);
  const availableKb = Number(fields[3]);
  const freeGb = Number.isFinite(availableKb) ? availableKb / 1024 / 1024 : null;
  return {
    ok: result.status === 0 && freeGb !== null,
    path,
    free_gb: freeGb === null ? null : Number(freeGb.toFixed(2)),
    min_free_gb: MIN_FREE_GB,
    above_floor: freeGb === null ? false : freeGb >= MIN_FREE_GB,
  };
}

function systemMemoryEvidence() {
  const vm = spawnSync('vm_stat', [], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 3000,
  });
  const mem = spawnSync('sysctl', ['-n', 'hw.memsize'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 3000,
  });
  const text = String(vm.stdout || '');
  const pageSize = Number(text.match(/page size of (\d+) bytes/i)?.[1] || 0);
  const physicalBytes = Number(String(mem.stdout || '').trim());
  const values = {};
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^"?([^":]+)"?:\s+(\d+)\.?$/);
    if (match) values[match[1].trim().toLowerCase()] = Number(match[2]);
  }
  const gb = (pages) => pageSize > 0 ? (Number(pages || 0) * pageSize) / (1024 ** 3) : null;
  const physicalGb = Number.isFinite(physicalBytes) && physicalBytes > 0 ? physicalBytes / (1024 ** 3) : null;
  const availableGbRaw = ['pages free', 'pages speculative', 'pages inactive']
    .reduce((sum, key) => sum + (gb(values[key]) || 0), 0);
  const compressorGbRaw = gb(values['pages occupied by compressor']);
  const compressorRatio = physicalGb ? compressorGbRaw / physicalGb : null;
  const pressure = (() => {
    if (vm.status !== 0 || !pageSize || !physicalGb) return 'unknown';
    if (compressorRatio !== null && compressorRatio >= 0.35) return 'high_compression';
    if (availableGbRaw < 1) return 'low_available';
    return 'ok';
  })();
  return {
    ok: vm.status === 0 && mem.status === 0 && pageSize > 0 && Boolean(physicalGb),
    pressure,
    page_size: pageSize || null,
    physical_gb: physicalGb === null ? null : Number(physicalGb.toFixed(1)),
    available_gb: Number(availableGbRaw.toFixed(2)),
    compressor_gb: compressorGbRaw === null ? null : Number(compressorGbRaw.toFixed(2)),
    compressor_ratio: compressorRatio === null ? null : Number(compressorRatio.toFixed(3)),
  };
}

function processRows() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pcpu=,pmem=,rss=,command='], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 5000,
  });
  const rows = String(result.stdout || '').split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpu_pct: Number(match[3]),
      mem_pct: Number(match[4]),
      rss_kb: Number(match[5]),
      rss_mb: Number((Number(match[5]) / 1024).toFixed(1)),
      command: match[6],
    };
  }).filter(Boolean);
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: String(result.stderr || '').trim(),
    rows,
  };
}

function drainIntensityEvidence({ hold, disk, systemMemory, liveProgress }) {
  const table = processRows();
  const drainPid = Number(hold?.pid || 0);
  const parent = table.rows.find((row) => row.pid === drainPid) || null;
  const lanes = table.rows
    .filter((row) => row.ppid === drainPid && row.command.includes('scripts/chunk-embed-lane.mjs'))
    .map((row) => {
      const index = Number(row.command.match(/chunk-embed-lane\.mjs\s+(\d+)/)?.[1]);
      return {
        pid: row.pid,
        index: Number.isFinite(index) ? index : null,
        cpu_pct: row.cpu_pct,
        mem_pct: row.mem_pct,
        rss_mb: row.rss_mb,
      };
    })
    .sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
  const parentRss = parent?.rss_mb || 0;
  const laneRss = lanes.reduce((sum, lane) => sum + (Number(lane.rss_mb) || 0), 0);
  const totalRss = Number((parentRss + laneRss).toFixed(1));
  const totalCpu = Number(((parent?.cpu_pct || 0) + lanes.reduce((sum, lane) => sum + (Number(lane.cpu_pct) || 0), 0)).toFixed(1));
  const estimatedNextLaneRss = lanes.length
    ? Math.max(...lanes.map((lane) => Number(lane.rss_mb) || 0))
    : 0;
  const projectedRss = Number((totalRss + estimatedNextLaneRss).toFixed(1));
  const rssHeadroom = Number((DRAIN_RSS_CEILING_MB - totalRss).toFixed(1));
  const canAddLaneByRss = lanes.length > 0
    && lanes.length < DRAIN_MAX_LANES
    && projectedRss < DRAIN_RSS_CEILING_MB;
  const etaSlow = Number(liveProgress?.eta_hours_at_latest_pass_rate || 0) > MAX_DRAIN_ETA_HOURS;
  const diskOk = disk?.above_floor === true;
  const recommendation = (() => {
    if (!table.ok) return 'process table unavailable';
    if (!parent) return 'drain process not visible';
    if (systemMemory?.pressure === 'high_compression' && lanes.length >= DRAIN_MAX_LANES) return 'do not increase intensity: already at max lanes and memory compression is high';
    if (systemMemory?.pressure === 'low_available' && lanes.length >= DRAIN_MAX_LANES) return 'do not increase intensity: already at max lanes and available memory is low';
    if (lanes.length >= DRAIN_MAX_LANES && rssHeadroom < MIN_DRAIN_RSS_HEADROOM_MB) return 'keep current intensity: already at max lanes and RSS headroom is narrow';
    if (lanes.length >= DRAIN_MAX_LANES) return 'already at max configured lane count';
    if (!canAddLaneByRss) return 'keep current intensity: insufficient lane RSS headroom';
    if (!diskOk) return 'keep current intensity: disk is near the floor';
    if (systemMemory?.pressure === 'high_compression') return 'keep current intensity: memory compression is already high';
    if (systemMemory?.pressure === 'low_available') return 'keep current intensity: available memory is low';
    if (etaSlow) return 'manual acceleration possible: restart temporary drain with ROBOTDOJO_EMBED_LANES=3 only when foreground chat is idle';
    return 'keep current intensity';
  })();
  return {
    ok: table.ok && Boolean(parent),
    process_table_ok: table.ok,
    drain_pid: drainPid || null,
    parent: parent ? {
      pid: parent.pid,
      cpu_pct: parent.cpu_pct,
      mem_pct: parent.mem_pct,
      rss_mb: parent.rss_mb,
    } : null,
    lanes,
    lane_count: lanes.length,
    max_lane_count: DRAIN_MAX_LANES,
    total_cpu_pct: totalCpu,
    total_rss_mb: totalRss,
    rss_ceiling_mb: DRAIN_RSS_CEILING_MB,
    rss_headroom_mb: rssHeadroom,
    estimated_next_lane_rss_mb: estimatedNextLaneRss,
    projected_rss_with_one_more_lane_mb: projectedRss,
    can_add_lane_by_rss: canAddLaneByRss,
    auto_acceleration: false,
    recommendation,
  };
}

function effectiveDrainCapacityEvidence({
  activeEmbeddingDrain,
  requestedLanes,
  drainIntensity,
  hold,
  liveProgress,
}) {
  const requested = Number(requestedLanes);
  const childLanes = Number(drainIntensity?.lane_count);
  const parentAlive = Boolean(drainIntensity?.parent && hold?.active === true && hold?.process_alive === true);
  const parentCpuPct = Number(drainIntensity?.parent?.cpu_pct);
  const parentCpuActive = Number.isFinite(parentCpuPct) && parentCpuPct >= MIN_ACTIVE_DRAIN_CPU_PCT;
  const logAgeMs = Number(liveProgress?.log_age_ms);
  const withinWarmupWindow = Number.isFinite(logAgeMs) && logAgeMs <= MAX_ACTIVE_DRAIN_WARMUP_MS;
  const yielding = liveProgress?.yielding_to_foreground === true;
  const moving = liveProgress?.state === 'moving';
  const activeWarmup = liveProgress?.state === 'fresh_no_progress'
    && liveProgress?.log_fresh === true
    && (parentCpuActive || withinWarmupWindow);
  const singleInProcessWriter = activeEmbeddingDrain === true
    && requested === 1
    && childLanes === 0
    && parentAlive
    && (moving || activeWarmup);
  const effectiveCount = singleInProcessWriter ? 1 : childLanes;
  const expectedPause = activeEmbeddingDrain === true && yielding;
  return {
    requested: Number.isFinite(requested) ? requested : null,
    child_lanes: Number.isFinite(childLanes) ? childLanes : null,
    effective_count: Number.isFinite(effectiveCount) ? effectiveCount : null,
    mode: expectedPause
      ? 'yielding_to_foreground'
      : singleInProcessWriter
        ? 'single_in_process_writer'
        : 'child_lane_processes',
    ok: Number.isFinite(requested) && requested > 0 && Number.isFinite(effectiveCount)
      ? expectedPause || effectiveCount >= requested
      : null,
    parent_alive: parentAlive,
    parent_cpu_pct: Number.isFinite(parentCpuPct) ? parentCpuPct : null,
    parent_cpu_active: parentCpuActive,
    within_warmup_window: withinWarmupWindow,
    active_warmup: activeWarmup,
    active_in_process_writer: singleInProcessWriter,
    yielding,
    moving,
  };
}

function latestDrainLogPath() {
  try {
    const candidates = readdirSync(LOG_DIR)
      .filter((name) => /^drain-personal-embeddings.*\.log$/.test(name))
      .map((name) => {
        const file = resolve(LOG_DIR, name);
        let mtimeMs = 0;
        try { mtimeMs = statSync(file).mtimeMs; } catch {}
        return { file, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.file || resolve(LOG_DIR, 'drain-personal-embeddings.log');
  } catch {
    return resolve(LOG_DIR, 'drain-personal-embeddings.log');
  }
}

function tailLines(text, n = 80) {
  const lines = String(text || '').split('\n');
  return lines.slice(Math.max(0, lines.length - n)).filter(Boolean);
}

function readTailText(path, maxBytes = DRAIN_LOG_TAIL_BYTES) {
  const stat = statSync(path);
  const bytes = Math.max(1, Math.min(stat.size, maxBytes));
  const start = Math.max(0, stat.size - bytes);
  const buffer = Buffer.alloc(bytes);
  const fd = openSync(path, 'r');
  try {
    const read = readSync(fd, buffer, 0, bytes, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function drainLogEvidence() {
  const path = latestDrainLogPath();
  if (!existsSync(path)) return { ok: false, path, reason: 'missing' };
  const stat = statSync(path);
  const lines = tailLines(readTailText(path), DRAIN_LOG_SCAN_LINES);
  const latestRunStartIndex = lines.findLastIndex((line) => line.includes('[drain-personal] start topic='));
  const currentRunLines = latestRunStartIndex >= 0 ? lines.slice(latestRunStartIndex) : lines;
  const latestRunStartLine = latestRunStartIndex >= 0 ? lines[latestRunStartIndex] : null;
  const runStartMatch = latestRunStartLine?.match(/\[drain-personal\] start topic=([^\s]+)\s+pending=(\d+)\s+lanes=(\d+)/);
  const latestPassIndex = currentRunLines.findLastIndex((line) => line.includes('[drain-personal] pass='));
  const latestPassLine = latestPassIndex >= 0 ? currentRunLines[latestPassIndex] : null;
  const passMatch = latestPassLine?.match(/\bpass=(\d+)(?:\s+topic=([^\s]+))?\s+embedded=(\d+)\s+completed=(\d+)\s+reused=(\d+)\s+pending=(\d+)\s+rate_per_hour=(\d+)\s+aborted=([^\s]+)/);
  const latestDrainProgressIndex = currentRunLines.findLastIndex((line) => line.includes('[drain-personal] progress '));
  const latestDrainProgressLine = latestDrainProgressIndex >= 0 ? currentRunLines[latestDrainProgressIndex] : null;
  const drainProgressMatch = latestDrainProgressLine?.match(/\bpass=([^\s]+)\s+topic=([^\s]+)\s+completed=(\d+)\s+embedded=(\d+)\s+reused=(\d+)\s+pending_estimate=([^\s]+)\s+rate_per_hour=(\d+)\s+elapsed_ms=(\d+)/);
  const latestProgressIndex = currentRunLines.findLastIndex((line) => /^\[embed\]\s+topic="[^"]+"\s+embedded\s+\d+\s+chunks\b/.test(line));
  const latestProgressLine = latestProgressIndex >= 0 ? currentRunLines[latestProgressIndex] : null;
  const progressMatch = latestProgressLine?.match(/^\[embed\]\s+topic="([^"]+)"\s+embedded\s+(\d+)\s+chunks\b/);
  const latestPauseIndex = currentRunLines.findLastIndex((line) => (
    line.includes('chat busy')
      || line.includes('chat active mid-pass')
      || line.includes('aborted during embedBatch')
      || line.includes('proof-freeze')
  ));
  const latestPauseLine = latestPauseIndex >= 0 ? lines[latestPauseIndex] : null;
  const latestMovementIndex = Math.max(latestPassIndex, latestDrainProgressIndex, latestProgressIndex);
  const currentPause = latestPauseIndex >= 0 && latestPauseIndex > latestMovementIndex;
  return {
    ok: true,
    path,
    tail_bytes: DRAIN_LOG_TAIL_BYTES,
    scan_lines: DRAIN_LOG_SCAN_LINES,
    mtime_ms: stat.mtimeMs,
    mtime_age_ms: ageMs(stat.mtimeMs),
    latest_run_start: runStartMatch ? {
      line: latestRunStartLine,
      topic: runStartMatch[1],
      pending: Number(runStartMatch[2]),
      lanes: Number(runStartMatch[3]),
    } : null,
    latest_progress: progressMatch ? {
      line: latestProgressLine,
      topic: progressMatch[1],
      embedded: Number(progressMatch[2]),
    } : null,
    latest_pass: passMatch ? {
      line: latestPassLine,
      pass: Number(passMatch[1]),
      topic: passMatch[2] || null,
      embedded: Number(passMatch[3]),
      completed: Number(passMatch[4]),
      reused: Number(passMatch[5]),
      pending: Number(passMatch[6]),
      rate_per_hour: Number(passMatch[7]),
      aborted: passMatch[8],
    } : null,
    latest_drain_progress: drainProgressMatch ? {
      line: latestDrainProgressLine,
      pass: drainProgressMatch[1] === 'unknown' ? null : Number(drainProgressMatch[1]),
      topic: drainProgressMatch[2],
      completed: Number(drainProgressMatch[3]),
      embedded: Number(drainProgressMatch[4]),
      reused: Number(drainProgressMatch[5]),
      pending_estimate: drainProgressMatch[6] === 'unknown' ? null : Number(drainProgressMatch[6]),
      rate_per_hour: Number(drainProgressMatch[7]),
      elapsed_ms: Number(drainProgressMatch[8]),
    } : null,
    latest_pause: latestPauseLine ? {
      line: latestPauseLine,
      current: currentPause,
      superseded_by_movement: !currentPause && latestMovementIndex > latestPauseIndex,
    } : null,
  };
}

function guardedDrainRespawnGraceEvidence({
  activeEmbeddingDrain,
  db,
  hold,
  services,
  liveProgress,
  drainLog,
}) {
  const pending = Number(db?.chunks?.pending);
  const logAgeMs = Number(liveProgress?.log_age_ms ?? drainLog?.mtime_age_ms);
  const holdMissing = hold?.active !== true || hold?.reason !== 'drain_personal_embeddings_sole_writer';
  const holdOwnerDead = hold?.active === true && hold?.process_alive !== true;
  const holdNeedsGrace = holdMissing || holdOwnerDead;
  const wrapperAlive = services?.drain_wrapper?.present === true
    && services?.drain_wrapper?.process_alive === true;
  const recentLog = Number.isFinite(logAgeMs)
    && logAgeMs <= MAX_GUARDED_DRAIN_RESPAWN_GRACE_MS;
  const recentActivity = liveProgress?.state === 'moving'
    || Boolean(drainLog?.latest_drain_progress)
    || Boolean(drainLog?.latest_progress)
    || Boolean(drainLog?.latest_pass)
    || Boolean(drainLog?.latest_run_start);
  const ok = activeEmbeddingDrain === true
    && Number.isFinite(pending)
    && pending > 0
    && wrapperAlive
    && holdNeedsGrace
    && liveProgress?.ok === true
    && recentLog
    && recentActivity;
  return {
    ok,
    hold_missing: holdMissing,
    hold_owner_dead: holdOwnerDead,
    wrapper_alive: wrapperAlive,
    recent_log: recentLog,
    recent_activity: recentActivity,
    log_age_ms: Number.isFinite(logAgeMs) ? logAgeMs : null,
    max_grace_ms: MAX_GUARDED_DRAIN_RESPAWN_GRACE_MS,
  };
}

function stoplightEvidence() {
  const report = readJson(STOPLIGHT_LATEST);
  if (!report) return { ok: false, path: STOPLIGHT_LATEST, reason: 'missing_or_invalid' };
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  const checkedAge = ageMs(report.checked_at);
  const progressRowId = byId.embedding_drain_progress?.evidence?.progress
    ? 'embedding_drain_progress'
    : byId.personal_drain_progress?.evidence?.progress
      ? 'personal_drain_progress'
      : null;
  const progress = progressRowId ? byId[progressRowId]?.evidence?.progress || null : null;
  return {
    ok: report.ok === true,
    path: STOPLIGHT_LATEST,
    checked_at: report.checked_at || null,
    checked_age_ms: checkedAge,
    fresh: checkedAge !== null && checkedAge <= MAX_STOPLIGHT_AGE_MS,
    data_plane_proof: report.data_plane_proof && typeof report.data_plane_proof === 'object'
      ? report.data_plane_proof
      : null,
    data_plane_proof_verdict: report.data_plane_proof_verdict && typeof report.data_plane_proof_verdict === 'object'
      ? report.data_plane_proof_verdict
      : null,
    rows: {
      embed_writer_exclusivity: byId.embed_writer_exclusivity?.status || null,
      embedding_drain_progress: byId.embedding_drain_progress?.status || null,
      personal_drain_progress: byId.personal_drain_progress?.status || null,
    },
    final_product_rows: Object.fromEntries(FINAL_PRODUCT_PROOF_ROWS.map((id) => {
      const row = byId[id] || null;
      return [id, {
        status: row?.status || null,
        detail: row?.detail || null,
        duration_ms: row?.duration_ms ?? null,
        evidence: row?.evidence && typeof row.evidence === 'object' ? row.evidence : null,
        data_plane_proof: row?.data_plane_proof && typeof row.data_plane_proof === 'object'
          ? row.data_plane_proof
          : null,
        browser_entity_card_proof: row?.browser_entity_card_proof && typeof row.browser_entity_card_proof === 'object'
          ? row.browser_entity_card_proof
          : null,
        deferred_exact_proof: row?.deferred_exact_proof === true,
      }];
    })),
    progress_row_id: progressRowId,
    progress,
  };
}

function drainPendingFromProgressEvidence(evidence) {
  const candidates = [
    evidence?.counts_after?.pending,
    evidence?.global_counts_after?.pending,
    evidence?.personal_counts_after?.pending,
    evidence?.post_drain_watcher?.readiness?.pending_embeddings,
    evidence?.log?.latest_drain_progress?.pending_estimate,
    evidence?.log?.latest_pass?.pending,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function statusHistoryPendingPoints() {
  const history = readJson(STATUS_HISTORY_FILE);
  const rows = Array.isArray(history?.points) ? history.points : [];
  return rows.map((row) => {
    const checkedMs = Date.parse(String(row?.checked_at || ''));
    const pending = Number(row?.pending);
    if (!Number.isFinite(checkedMs) || !Number.isFinite(pending) || pending < 0) return null;
    return {
      checked_at: new Date(checkedMs).toISOString(),
      checked_ms: checkedMs,
      pending,
      source: row.source || 'status_history',
      status: row.status || null,
      phase: row.phase || null,
      ok: row.ok === true,
      complete: row.complete === true,
      action: row.action || null,
      action_kind: row.action_kind || null,
    };
  }).filter(Boolean);
}

function roundedTrendHours(hours) {
  if (!Number.isFinite(hours)) return null;
  if (hours > 0 && hours < 0.01) return 0.01;
  return Number(hours.toFixed(hours < 1 ? 2 : 1));
}

function filterImplausibleTrendZeroBridges(points) {
  const ordered = [...(Array.isArray(points) ? points : [])]
    .filter((point) => Number.isFinite(Number(point?.checked_ms)) && Number.isFinite(Number(point?.pending)))
    .sort((a, b) => Number(a.checked_ms) - Number(b.checked_ms));
  return ordered.filter((point, index, list) => {
    const pending = Number(point.pending);
    if (pending !== 0) return true;
    if (point.complete === true || point.ok === true) return true;
    const prev = [...list.slice(0, index)].reverse().find((candidate) => Number(candidate.pending) >= TREND_ZERO_REBOUND_MIN_PENDING);
    const next = list.slice(index + 1).find((candidate) => Number(candidate.pending) >= TREND_ZERO_REBOUND_MIN_PENDING);
    if (!prev || !next) return true;
    const reboundMs = Number(next.checked_ms) - Number(point.checked_ms);
    if (!Number.isFinite(reboundMs) || reboundMs < 0 || reboundMs > TREND_ZERO_REBOUND_MAX_MS) return true;
    return false;
  });
}

function drainTrendEvidence({ db }) {
  const cutoffMs = Date.now() - DRAIN_TREND_WINDOW_MS;
  const snapshotPoints = statusHistoryPendingPoints();
  try {
    for (const file of readdirSync(FINAL_PRODUCT_PROOF_SNAPSHOT_DIR)) {
      if (!file.endsWith('.json')) continue;
      const snapshotPath = resolve(FINAL_PRODUCT_PROOF_SNAPSHOT_DIR, file);
      const report = readJson(snapshotPath);
      const checkedMs = Date.parse(String(report?.checked_at || ''));
      if (!Number.isFinite(checkedMs)) continue;
      const rows = Array.isArray(report?.rows) ? report.rows : [];
      for (const row of rows) {
        if (!['embedding_drain_progress', 'personal_drain_progress'].includes(row?.id)) continue;
        const pending = drainPendingFromProgressEvidence(row.evidence || {});
        if (pending === null) continue;
        snapshotPoints.push({
          checked_at: new Date(checkedMs).toISOString(),
          checked_ms: checkedMs,
          pending,
          source: row.id,
          status: row.status || null,
        });
      }
    }
  } catch {
    // Missing snapshots are valid on a fresh install; live status still reports current movement.
  }
  const orderedSnapshots = filterImplausibleTrendZeroBridges(snapshotPoints)
    .sort((a, b) => a.checked_ms - b.checked_ms)
    .filter((point, index, list) => index === 0
      || point.checked_ms !== list[index - 1].checked_ms
      || point.pending !== list[index - 1].pending
      || point.source !== list[index - 1].source);
  const points = orderedSnapshots.filter((point) => point.checked_ms >= cutoffMs);
  const previousPoint = [...orderedSnapshots].reverse().find((point) => point.checked_ms < cutoffMs) || null;
  if (db?.ok === true) {
    const pending = Number(db.chunks?.pending);
    if (Number.isFinite(pending) && pending >= 0) {
      const checkedMs = Date.now();
      points.push({
        checked_at: new Date(checkedMs).toISOString(),
        checked_ms: checkedMs,
        pending,
        source: 'live_status',
        status: 'current',
      });
    }
  }
  let basis = 'requested_window';
  if (points.length < 2 && previousPoint) {
    points.unshift(previousPoint);
    basis = 'extended_last_known_progress';
  } else if (points.length < 2) {
    basis = 'insufficient_history';
  }
  const ordered = filterImplausibleTrendZeroBridges(points)
    .sort((a, b) => a.checked_ms - b.checked_ms)
    .filter((point, index, list) => index === 0
      || point.checked_ms !== list[index - 1].checked_ms
      || point.pending !== list[index - 1].pending
      || point.source !== list[index - 1].source);
  const first = ordered[0] || null;
  const last = ordered[ordered.length - 1] || null;
  const elapsedHours = first && last
    ? (last.checked_ms - first.checked_ms) / (60 * 60 * 1000)
    : null;
  const pendingDrained = first && last ? first.pending - last.pending : null;
  const ratePerHour = elapsedHours && elapsedHours > 0 && pendingDrained !== null
    ? pendingDrained / elapsedHours
    : null;
  const etaHours = last && Number.isFinite(ratePerHour) && ratePerHour > 0
    ? last.pending / ratePerHour
    : null;
  const trendRepresentative = ordered.length >= 2
    && Number.isFinite(elapsedHours)
    && elapsedHours >= MIN_REPRESENTATIVE_TREND_HOURS
    && Number(pendingDrained) >= MIN_REPRESENTATIVE_TREND_DRAINED;
  const trendReason = trendRepresentative
    ? null
    : ordered.length < 2
      ? 'insufficient_history'
      : Number(pendingDrained) <= 0
        ? 'trend_not_moving'
        : !Number.isFinite(elapsedHours) || elapsedHours < MIN_REPRESENTATIVE_TREND_HOURS
          ? 'trend_window_too_short'
          : Number(pendingDrained) < MIN_REPRESENTATIVE_TREND_DRAINED
            ? 'trend_delta_too_small'
            : 'trend_not_representative';
  return {
    ok: ordered.length >= 2,
    basis,
    requested_window_hours: Number((DRAIN_TREND_WINDOW_MS / (60 * 60 * 1000)).toFixed(1)),
    representative: trendRepresentative,
    representative_reason: trendReason,
    min_representative_window_hours: MIN_REPRESENTATIVE_TREND_HOURS,
    min_representative_pending_drained: MIN_REPRESENTATIVE_TREND_DRAINED,
    window_hours: elapsedHours === null
      ? Number((DRAIN_TREND_WINDOW_MS / (60 * 60 * 1000)).toFixed(1))
      : roundedTrendHours(elapsedHours),
    sample_count: ordered.length,
    first_checked_at: first?.checked_at || null,
    first_pending: first?.pending ?? null,
    last_checked_at: last?.checked_at || null,
    last_pending: last?.pending ?? null,
    pending_drained: pendingDrained ?? null,
    elapsed_hours: elapsedHours === null ? null : Number(elapsedHours.toFixed(2)),
    rate_per_hour: ratePerHour === null ? null : Number(ratePerHour.toFixed(1)),
    eta_hours: etaHours === null ? null : Number(etaHours.toFixed(1)),
    eta_days: etaHours === null ? null : Number((etaHours / 24).toFixed(1)),
    moving: Number(pendingDrained) > 0,
    source: 'status_history_launch_stoplight_snapshots_live_status',
    points: ordered.slice(-DRAIN_TREND_MAX_POINTS).map((point) => ({
      checked_at: point.checked_at,
      pending: point.pending,
      source: point.source,
      status: point.status,
      ...(point.phase ? { phase: point.phase } : {}),
    })),
  };
}

function liveDrainProgress({ db, drainLog }) {
  const pending = db.ok ? Number(db.chunks.pending || 0) : null;
  const latestPassPending = Number(drainLog?.latest_pass?.pending);
  const pendingDeltaSincePass = Number.isFinite(pending) && Number.isFinite(latestPassPending)
    ? Math.max(0, latestPassPending - pending)
    : null;
  const logAge = Number(drainLog?.mtime_age_ms);
  const logFresh = drainLog?.ok === true
    && Number.isFinite(logAge)
    && logAge <= MAX_DRAIN_LOG_AGE_MS;
  const latestProgress = Number(drainLog?.latest_progress?.embedded);
  const ratePerHour = Number(drainLog?.latest_pass?.rate_per_hour);
  const latestPassCompleted = Number(drainLog?.latest_pass?.completed);
  const latestPassTopic = drainLog?.latest_pass?.topic || null;
  const latestProgressTopic = drainLog?.latest_progress?.topic || null;
  const currentRunStartPending = Number(drainLog?.latest_run_start?.pending);
  const currentRunCompletedFromDb = Number.isFinite(pending) && Number.isFinite(currentRunStartPending)
    ? Math.max(0, currentRunStartPending - pending)
    : null;
  const inPassRatePerHour = Number(drainLog?.latest_drain_progress?.rate_per_hour);
  const inPassCompleted = Number(drainLog?.latest_drain_progress?.completed);
  const inPassTopic = drainLog?.latest_drain_progress?.topic || null;
  const inPassTopicMatchesCurrent = !latestProgressTopic || !inPassTopic || latestProgressTopic === inPassTopic;
  const inPassRateRepresentative = Number.isFinite(inPassRatePerHour)
    && inPassRatePerHour > 0
    && Number.isFinite(inPassCompleted)
    && inPassCompleted >= MIN_REPRESENTATIVE_ETA_COMPLETED
    && inPassTopicMatchesCurrent;
  const passTopicMatchesCurrent = !latestProgressTopic || !latestPassTopic || latestProgressTopic === latestPassTopic;
  const passRateRepresentative = Number.isFinite(ratePerHour)
    && ratePerHour > 0
    && Number.isFinite(latestPassCompleted)
    && latestPassCompleted >= MIN_REPRESENTATIVE_ETA_COMPLETED;
  const passRateSameTopicRepresentative = passRateRepresentative && passTopicMatchesCurrent;
  const passRateCrossTopicRepresentative = passRateRepresentative
    && !passTopicMatchesCurrent
    && Number.isFinite(currentRunCompletedFromDb)
    && currentRunCompletedFromDb >= MIN_REPRESENTATIVE_ETA_COMPLETED;
  const etaRateRepresentative = inPassRateRepresentative || passRateSameTopicRepresentative || passRateCrossTopicRepresentative;
  const etaRatePerHour = inPassRateRepresentative ? inPassRatePerHour : ratePerHour;
  const observedRateCompleted = Number.isFinite(inPassRatePerHour) && inPassRatePerHour > 0
    ? inPassCompleted
    : latestPassCompleted;
  const observedRateRepresentative = Number.isFinite(inPassRatePerHour) && inPassRatePerHour > 0
    ? inPassRateRepresentative
    : passRateRepresentative;
  const observedSampleRatePerHour = Number.isFinite(inPassRatePerHour) && inPassRatePerHour > 0
    ? inPassRatePerHour
    : ratePerHour;
  const observedRatePerHour = observedRateRepresentative ? observedSampleRatePerHour : null;
  const etaSource = inPassRateRepresentative
    ? 'in_pass_progress'
    : passRateSameTopicRepresentative
      ? 'latest_completed_pass'
      : passRateCrossTopicRepresentative
        ? 'latest_completed_pass_cross_topic'
        : null;
  const movingSincePass = Boolean(
    pendingDeltaSincePass > 0
      || currentRunCompletedFromDb > 0
      || (Number.isFinite(latestProgress) && latestProgress > 0)
  );
  const yielding = drainLog?.latest_pause?.current === true;
  const freshWarmupWithoutRate = logFresh
    && !yielding
    && !movingSincePass
    && (!Number.isFinite(inPassRatePerHour) || inPassRatePerHour <= 0)
    && (!Number.isFinite(ratePerHour) || ratePerHour <= 0);
  const etaUnavailableReason = etaRateRepresentative
    ? null
    : freshWarmupWithoutRate
      ? 'warmup_no_rate_sample_yet'
      : Number.isFinite(inPassCompleted) && inPassCompleted > 0 && inPassCompleted < MIN_REPRESENTATIVE_ETA_COMPLETED
        ? 'in_pass_too_small'
        : Number.isFinite(inPassCompleted) && inPassCompleted >= MIN_REPRESENTATIVE_ETA_COMPLETED && !inPassTopicMatchesCurrent
          ? 'in_pass_topic_differs_from_current_progress'
          : !Number.isFinite(ratePerHour) || ratePerHour <= 0
            ? 'latest_pass_rate_missing'
            : !Number.isFinite(latestPassCompleted) || latestPassCompleted < MIN_REPRESENTATIVE_ETA_COMPLETED
              ? 'latest_pass_too_small'
              : 'latest_pass_topic_differs_from_current_progress';
  const etaHours = etaRateRepresentative && Number.isFinite(pending)
    ? pending / etaRatePerHour
    : null;
  const observedSampleEtaHours = Number.isFinite(pending)
    && pending > 0
    && Number.isFinite(observedSampleRatePerHour)
    && observedSampleRatePerHour > 0
    ? pending / observedSampleRatePerHour
    : null;
  const requiredRateForTarget = Number.isFinite(pending) && TARGET_DRAIN_HOURS > 0
    ? pending / TARGET_DRAIN_HOURS
    : null;
  const rateGap = etaRateRepresentative && requiredRateForTarget !== null
    ? Math.max(0, requiredRateForTarget - etaRatePerHour)
    : null;
  const observedRateGap = Number.isFinite(observedRatePerHour) && requiredRateForTarget !== null
    ? Math.max(0, requiredRateForTarget - observedRatePerHour)
    : null;
  const rateGapPct = rateGap !== null && requiredRateForTarget > 0
    ? (rateGap / requiredRateForTarget) * 100
    : null;
  const observedRateGapPct = observedRateGap !== null && requiredRateForTarget > 0
    ? (observedRateGap / requiredRateForTarget) * 100
    : null;
  let state = 'unknown';
  if (pending === 0) state = 'complete';
  else if (!logFresh) state = 'stale';
  else if (yielding) state = 'yielding';
  else if (movingSincePass) state = 'moving';
  else if (logFresh) state = 'fresh_no_progress';
  return {
    ok: pending === 0 || logFresh,
    state,
    pending,
    log_fresh: logFresh,
    log_age_ms: Number.isFinite(logAge) ? logAge : null,
    max_log_age_ms: MAX_DRAIN_LOG_AGE_MS,
    pending_delta_since_latest_pass: pendingDeltaSincePass,
    latest_progress_embedded: Number.isFinite(latestProgress) ? latestProgress : null,
    current_run_start_pending: Number.isFinite(currentRunStartPending) ? currentRunStartPending : null,
    current_run_completed_from_db: currentRunCompletedFromDb,
    latest_pass_rate_per_hour: Number.isFinite(ratePerHour) ? ratePerHour : null,
    latest_pass_completed: Number.isFinite(latestPassCompleted) ? latestPassCompleted : null,
    latest_pass_topic: latestPassTopic,
    in_pass_rate_per_hour: Number.isFinite(inPassRatePerHour) ? inPassRatePerHour : null,
    in_pass_completed: Number.isFinite(inPassCompleted) ? inPassCompleted : null,
    in_pass_topic: inPassTopic,
    latest_progress_topic: latestProgressTopic,
    min_representative_eta_completed: MIN_REPRESENTATIVE_ETA_COMPLETED,
    eta_rate_representative: etaRateRepresentative,
    eta_rate_per_hour: Number.isFinite(etaRatePerHour) ? etaRatePerHour : null,
    observed_sample_rate_per_hour: Number.isFinite(observedSampleRatePerHour) ? observedSampleRatePerHour : null,
    observed_rate_per_hour: Number.isFinite(observedRatePerHour) ? observedRatePerHour : null,
    observed_rate_completed: Number.isFinite(observedRateCompleted) ? observedRateCompleted : null,
    observed_rate_representative: observedRateRepresentative,
    eta_cross_topic_basis: passRateCrossTopicRepresentative,
    eta_source: etaSource,
    eta_unavailable_reason: etaUnavailableReason,
    eta_hours_at_latest_pass_rate: etaHours === null ? null : Number(etaHours.toFixed(1)),
    eta_days_at_latest_pass_rate: etaHours === null ? null : Number((etaHours / 24).toFixed(1)),
    observed_sample_eta_hours: observedSampleEtaHours === null ? null : Number(observedSampleEtaHours.toFixed(1)),
    observed_sample_eta_days: observedSampleEtaHours === null ? null : Number((observedSampleEtaHours / 24).toFixed(1)),
    target_drain_hours: TARGET_DRAIN_HOURS,
    required_rate_per_hour_for_target: requiredRateForTarget === null ? null : Math.ceil(requiredRateForTarget),
    rate_gap_per_hour_for_target: rateGap === null ? null : Math.ceil(rateGap),
    rate_gap_pct_for_target: rateGapPct === null ? null : Number(rateGapPct.toFixed(1)),
    observed_rate_gap_per_hour_for_target: observedRateGap === null ? null : Math.ceil(observedRateGap),
    observed_rate_gap_pct_for_target: observedRateGapPct === null ? null : Number(observedRateGapPct.toFixed(1)),
    moving_since_latest_pass: movingSincePass,
    yielding_to_foreground: yielding,
  };
}

function effectiveEtaEvidence({ liveProgress, stoplight }) {
  const liveHours = Number(liveProgress?.eta_hours_at_latest_pass_rate);
  const liveUsable = liveProgress?.eta_rate_representative === true && Number.isFinite(liveHours);
  const stoplightHours = Number(
    stoplight?.progress?.conservative_eta_hours
      ?? stoplight?.progress?.eta_hours,
  );
  const sampleHoursRaw = liveProgress?.observed_sample_eta_hours;
  const sampleDaysRaw = liveProgress?.observed_sample_eta_days;
  const sampleRatePerHourRaw = liveProgress?.observed_sample_rate_per_hour;
  const sampleHours = Number(sampleHoursRaw);
  const sampleDays = Number(sampleDaysRaw);
  const sampleRatePerHour = Number(sampleRatePerHourRaw);
  const sampleUsable = sampleHoursRaw !== null
    && sampleHoursRaw !== undefined
    && Number.isFinite(sampleHours)
    && sampleHours > 0;
  const sampleDaysUsable = sampleDaysRaw !== null
    && sampleDaysRaw !== undefined
    && Number.isFinite(sampleDays)
    && sampleDays >= 0;
  const sampleRateUsable = sampleRatePerHourRaw !== null
    && sampleRatePerHourRaw !== undefined
    && Number.isFinite(sampleRatePerHour)
    && sampleRatePerHour > 0;
  const stoplightUsable = stoplight?.fresh === true && Number.isFinite(stoplightHours);
  const chosenHours = liveUsable ? liveHours : stoplightUsable ? stoplightHours : null;
  const authoritativeSource = liveUsable
    ? liveProgress.eta_source || 'live_drain_progress'
    : stoplightUsable
      ? `stoplight:${stoplight.progress_row_id || 'unknown'}`
      : null;
  const deltaHours = liveUsable && stoplightUsable
    ? Number((stoplightHours - liveHours).toFixed(1))
    : null;
  const ratio = liveUsable && stoplightUsable && liveHours > 0
    ? Number((stoplightHours / liveHours).toFixed(2))
    : null;
  const estimatedDoneAt = chosenHours === null
    ? null
    : new Date(Date.now() + (chosenHours * 60 * 60 * 1000)).toISOString();
  const sampleEstimatedDoneAt = sampleUsable
    ? new Date(Date.now() + (sampleHours * 60 * 60 * 1000)).toISOString()
    : null;
  return {
    hours: chosenHours === null ? null : Number(chosenHours.toFixed(1)),
    days: chosenHours === null ? null : Number((chosenHours / 24).toFixed(1)),
    estimated_done_at: estimatedDoneAt,
    authoritative_eta_source: authoritativeSource,
    live_eta_hours: liveUsable ? Number(liveHours.toFixed(1)) : null,
    live_eta_source: liveProgress?.eta_source || null,
    live_eta_representative: liveProgress?.eta_rate_representative === true,
    live_eta_unavailable_reason: liveProgress?.eta_unavailable_reason || null,
    non_authoritative_sample_hours: sampleUsable ? Number(sampleHours.toFixed(1)) : null,
    non_authoritative_sample_days: sampleDaysUsable
      ? sampleDays
      : sampleUsable
        ? Number((sampleHours / 24).toFixed(1))
        : null,
    non_authoritative_sample_estimated_done_at: sampleEstimatedDoneAt,
    non_authoritative_sample_rate_per_hour: sampleRateUsable ? sampleRatePerHour : null,
    non_authoritative_sample_representative: liveProgress?.observed_rate_representative === true,
    non_authoritative_sample_reason: sampleUsable
      ? liveProgress?.observed_rate_representative === true
        ? 'sample_rate_is_representative'
        : (liveProgress?.eta_unavailable_reason || 'sample_rate_not_representative')
      : null,
    stoplight_eta_hours: stoplightUsable ? Number(stoplightHours.toFixed(1)) : null,
    stoplight_progress_row_id: stoplight?.progress_row_id || null,
    stoplight_fresh: stoplight?.fresh === true,
    stoplight_delta_hours: deltaHours,
    stoplight_to_live_ratio: ratio,
  };
}

async function dbEvidence() {
  try {
    const { default: db } = await import(resolve(REPO_ROOT, 'lib/db.js'));
    const { computeWorkOrder } = await import(resolve(REPO_ROOT, 'lib/rag/work-order.js'));
    const readSnapshot = db.transaction(() => {
      const global = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN COALESCE(embedded, 0) = 1 THEN 1 ELSE 0 END) AS embedded,
          SUM(CASE WHEN COALESCE(embedded, 0) = 0 AND COALESCE(skip_embed, 0) = 0 THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN COALESCE(skip_embed, 0) = 1 THEN 1 ELSE 0 END) AS skipped
        FROM chunks
      `).get();
      const personal = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN COALESCE(embedded, 0) = 1 THEN 1 ELSE 0 END) AS embedded,
          SUM(CASE WHEN COALESCE(embedded, 0) = 0 AND COALESCE(skip_embed, 0) = 0 THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN COALESCE(skip_embed, 0) = 1 THEN 1 ELSE 0 END) AS skipped
        FROM chunks
        WHERE topic = 'personal'
      `).get();
      const needsRouting = db.prepare(`
        SELECT
          COUNT(*) AS chunks,
          SUM(CASE WHEN COALESCE(embedded, 0) = 0 AND COALESCE(skip_embed, 0) = 0 THEN 1 ELSE 0 END) AS pending
        FROM chunks
        WHERE topic = 'needs-routing'
      `).get();
      const needsRoutingMemory = db.prepare(`
        SELECT COUNT(*) AS n
        FROM memory_event_links
        WHERE target_type = 'topic' AND target_id = 'needs-routing'
      `).get();
      const needsRoutingCurrentMemory = db.prepare(`
        SELECT COUNT(*) AS n
        FROM memory_event_links
        WHERE target_type = 'topic'
          AND target_id = 'needs-routing'
          AND role IN ('needs-routing', 'scope')
      `).get();
      const needsRoutingAuditMemory = db.prepare(`
        SELECT COUNT(*) AS n
        FROM memory_event_links
        WHERE target_type = 'topic'
          AND target_id = 'needs-routing'
          AND role NOT IN ('needs-routing', 'scope')
      `).get();
      const pendingTopics = db.prepare(`
        SELECT COALESCE(NULLIF(topic, ''), '(blank)') AS topic,
               COUNT(*) AS pending
        FROM chunks
        WHERE COALESCE(embedded, 0) = 0
          AND COALESCE(skip_embed, 0) = 0
        GROUP BY COALESCE(NULLIF(topic, ''), '(blank)')
        ORDER BY pending DESC, topic
        LIMIT 12
      `).all();
      const nonPersonalPending = db.prepare(`
        SELECT COUNT(*) AS n
        FROM chunks
        WHERE COALESCE(embedded, 0) = 0
          AND COALESCE(skip_embed, 0) = 0
          AND COALESCE(topic, '') != 'personal'
      `).get();
      const topNonPersonalPendingTopics = db.prepare(`
        SELECT COALESCE(NULLIF(topic, ''), '(blank)') AS topic,
               COUNT(*) AS pending
        FROM chunks
        WHERE COALESCE(embedded, 0) = 0
          AND COALESCE(skip_embed, 0) = 0
          AND COALESCE(topic, '') != 'personal'
        GROUP BY COALESCE(NULLIF(topic, ''), '(blank)')
        ORDER BY pending DESC, topic
        LIMIT 8
      `).all();
      const workOrderEligibility = `
        COALESCE(topic, '') > ''
        AND (
          (
            COALESCE(value_rank, 0) > 0
            AND ((COALESCE(value_rank, 0) - 1) % 1000000) > 0
          )
          OR (
            COALESCE(value_rank, 0) = 0
            AND LENGTH(COALESCE(content, '')) > 0
          )
        )
      `;
      const workOrder = db.prepare(`
        SELECT
          SUM(CASE WHEN ${workOrderEligibility} THEN 1 ELSE 0 END) AS selectable_pending,
          SUM(CASE WHEN NOT (${workOrderEligibility}) THEN 1 ELSE 0 END) AS blocked_pending,
          SUM(CASE WHEN COALESCE(topic, '') = '' THEN 1 ELSE 0 END) AS blank_topic_pending,
          SUM(CASE WHEN LENGTH(COALESCE(content, '')) = 0 THEN 1 ELSE 0 END) AS empty_content_pending,
          SUM(CASE
                WHEN COALESCE(value_rank, 0) > 0
                 AND ((COALESCE(value_rank, 0) - 1) % 1000000) <= 0
                THEN 1 ELSE 0
              END) AS malformed_rank_pending
        FROM chunks
        WHERE COALESCE(embedded, 0) = 0
          AND COALESCE(skip_embed, 0) = 0
      `).get();
      const workOrderHeadStartedAt = Date.now();
      let workOrderHead = null;
      try {
        const order = computeWorkOrder(db, {
          longInputChars: EMBED_LONG_INPUT_CHARS,
          valueRankFloor: VALUE_RANK_ENTITY_FLOOR,
        });
        workOrderHead = {
          ok: true,
          elapsed_ms: Date.now() - workOrderHeadStartedAt,
          limit: WORK_ORDER_HEAD_LIMIT,
          topics: order.slice(0, WORK_ORDER_HEAD_LIMIT).map((entry) => ({
            topic: String(entry.topic || ''),
            pending: Number(entry.pending || 0),
            priority: Number(entry.priority || 0),
            email_share: Number(entry.emailShare || 0),
            long_share: Number(entry.longShare || 0),
            short_pending: Number(entry.shortPending || 0),
            long_pending: Number(entry.longPending || 0),
          })),
        };
      } catch (err) {
        workOrderHead = {
          ok: false,
          elapsed_ms: Date.now() - workOrderHeadStartedAt,
          error: err?.message || String(err),
          topics: [],
        };
      }
      const globalCounts = normalizeCounts(global);
      const personalCounts = normalizeCounts(personal);
      const nonPersonalPendingCount = Number(nonPersonalPending?.n || 0);
      return {
        globalCounts,
        personalCounts,
        nonPersonalPendingCount,
        pendingTopics,
        topNonPersonalPendingTopics,
        workOrder,
        workOrderHead,
        needsRouting,
        needsRoutingMemory,
        needsRoutingCurrentMemory,
        needsRoutingAuditMemory,
      };
    });
    const snapshot = readSnapshot();
    return {
      ok: true,
      snapshot_consistent: true,
      chunks: snapshot.globalCounts,
      personal: snapshot.personalCounts,
      non_personal_pending: snapshot.nonPersonalPendingCount,
      pending_reconciled: snapshot.globalCounts.pending === (snapshot.personalCounts.pending + snapshot.nonPersonalPendingCount),
      pending_topics: snapshot.pendingTopics.map((row) => ({
        topic: String(row.topic || '(blank)'),
        pending: Number(row.pending || 0),
      })),
      non_personal_pending_topics: snapshot.topNonPersonalPendingTopics.map((row) => ({
        topic: String(row.topic || '(blank)'),
        pending: Number(row.pending || 0),
      })),
      work_order: {
        selectable_pending: Number(snapshot.workOrder?.selectable_pending || 0),
        blocked_pending: Number(snapshot.workOrder?.blocked_pending || 0),
        blank_topic_pending: Number(snapshot.workOrder?.blank_topic_pending || 0),
        empty_content_pending: Number(snapshot.workOrder?.empty_content_pending || 0),
        malformed_rank_pending: Number(snapshot.workOrder?.malformed_rank_pending || 0),
        head: snapshot.workOrderHead,
      },
      needs_routing: {
        chunks: Number(snapshot.needsRouting?.chunks || 0),
        pending: Number(snapshot.needsRouting?.pending || 0),
        memory_links: Number(snapshot.needsRoutingMemory?.n || 0),
        current_memory_links: Number(snapshot.needsRoutingCurrentMemory?.n || 0),
        audit_memory_links: Number(snapshot.needsRoutingAuditMemory?.n || 0),
      },
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function staleVectorProjectionEvidence() {
  try {
    const { default: database } = await import(resolve(REPO_ROOT, 'lib/db.js'));
    const {
      openSplitVectorStore,
      pruneStaleVectorRows,
    } = await import(resolve(REPO_ROOT, 'lib/split-vector-store.js'));
    let embeddingsDb = null;
    try { embeddingsDb = openSplitVectorStore(); } catch {}
    const stores = [{ name: 'main', database }];
    if (embeddingsDb) stores.push({ name: 'embeddings', database: embeddingsDb });
    const projection = pruneStaleVectorRows(database, { stores, dryRun: true });
    return {
      ...projection,
      split_embeddings_open: Boolean(embeddingsDb),
    };
  } catch (err) {
    return {
      ok: false,
      dry_run: true,
      error: err?.message || String(err),
    };
  }
}

async function staleVectorShapeEvidence() {
  try {
    const { default: database } = await import(resolve(REPO_ROOT, 'lib/db.js'));
    const {
      openSplitVectorStore,
      vec0TableNames,
    } = await import(resolve(REPO_ROOT, 'lib/split-vector-store.js'));
    let embeddingsDb = null;
    try { embeddingsDb = openSplitVectorStore(); } catch {}
    const stores = [{ name: 'main', database }];
    if (embeddingsDb) stores.push({ name: 'embeddings', database: embeddingsDb });
    let malformedTables = 0;
    let tablesChecked = 0;
    const malformed = [];
    for (const store of stores) {
      for (const tableName of vec0TableNames(store.database)) {
        tablesChecked += 1;
        try {
          store.database.prepare(`SELECT chunk_id FROM ${tableName} LIMIT 1`).all();
        } catch (err) {
          malformedTables += 1;
          malformed.push({
            store: store.name,
            table: tableName,
            error: err?.message || String(err),
          });
        }
      }
    }
    return {
      ok: malformedTables === 0,
      dry_run: true,
      mode: 'shape_only',
      reason: 'active_drain_fast_summary',
      tables_checked: tablesChecked,
      stale_vectors: null,
      stale_vectors_skipped: true,
      malformed_tables: malformedTables,
      pruned: 0,
      malformed,
      split_embeddings_open: Boolean(embeddingsDb),
    };
  } catch (err) {
    return {
      ok: false,
      dry_run: true,
      mode: 'shape_only',
      reason: 'shape_check_failed',
      stale_vectors: null,
      stale_vectors_skipped: true,
      malformed_tables: null,
      pruned: 0,
      error: err?.message || String(err),
    };
  }
}

function normalizeCounts(row) {
  return {
    total: Number(row?.total || 0),
    embedded: Number(row?.embedded || 0),
    pending: Number(row?.pending || 0),
    skipped: Number(row?.skipped || 0),
  };
}

function globalAnnGrowthThreshold(builtFrom) {
  return Math.max(GLOBAL_ANN_MIN_NEW_CHUNKS, Math.ceil(Math.max(Number(builtFrom) || 1, 1) * GLOBAL_ANN_DRIFT));
}

function globalAnnSidecarIntegrity(sidecar) {
  if (!sidecar) return { ok: false, reason: 'missing_sidecar' };
  const hotSize = Number(sidecar.hot_size) || 0;
  const fullSize = Number(sidecar.full_size) || 0;
  const builtFrom = Number(sidecar.built_from_count) || 0;
  const sourceEmbedded = Number(sidecar.source_embedded_count) || 0;
  if (Number(sidecar.dim) !== GLOBAL_ANN_DIM) return { ok: false, reason: 'dim_mismatch' };
  if (fullSize <= 0 || builtFrom <= 0) return { ok: false, reason: 'empty_or_unbuilt_sidecar' };
  if (hotSize < 0 || hotSize > fullSize) return { ok: false, reason: 'hot_size_out_of_range' };
  if (fullSize !== builtFrom) return { ok: false, reason: 'full_size_built_from_mismatch' };
  if (sourceEmbedded !== builtFrom) return { ok: false, reason: 'source_embedded_count_mismatch' };
  return { ok: true, reason: 'ok' };
}

function globalAnnEvidence({ liveEmbedded }) {
  const sidecar = readJson(GLOBAL_ANN_SIDECAR_FILE);
  const hot = existsSync(GLOBAL_ANN_HOT_FILE);
  const full = existsSync(GLOBAL_ANN_FULL_FILE);
  const buildingLock = existsSync(GLOBAL_ANN_LOCK_FILE);
  const integrity = globalAnnSidecarIntegrity(sidecar);
  const hotRequired = (Number(sidecar?.hot_size) || 0) > 0;
  const compatible = Boolean(sidecar)
    && (!hotRequired || hot)
    && full
    && integrity.ok;
  const sidecarCount = Number(sidecar?.built_from_count) || 0;
  const liveCount = Number(liveEmbedded);
  const corpusDelta = Number.isFinite(liveCount) && sidecarCount > 0
    ? liveCount - sidecarCount
    : null;
  const newChunks = corpusDelta === null ? null : Math.max(0, corpusDelta);
  const removedChunks = corpusDelta === null ? null : Math.max(0, -corpusDelta);
  const absoluteDriftChunks = corpusDelta === null ? null : Math.abs(corpusDelta);
  const growthThreshold = sidecarCount > 0 ? globalAnnGrowthThreshold(sidecarCount) : null;
  const stale = !compatible
    || (newChunks !== null && growthThreshold !== null && newChunks >= growthThreshold)
    || (removedChunks !== null && removedChunks > 0);
  const state = compatible
    ? (stale ? (buildingLock ? 'repairing' : 'stale') : 'ready')
    : (buildingLock ? 'repairing' : sidecar ? 'invalid' : 'missing');
  const reason = compatible
    ? (stale ? 'artifact_stale' : 'global_index_artifact_ready')
    : sidecar
      ? `artifact_invalid:${integrity.reason}`
      : 'artifact_missing';
  return {
    ready: compatible && !stale,
    state,
    reason: buildingLock && stale ? `${reason}_repairing` : reason,
    ann_dir: ANN_DIR,
    files: {
      sidecar: Boolean(sidecar),
      hot,
      full,
      building_lock: buildingLock,
    },
    integrity,
    compatible,
    built_from_count: sidecarCount || null,
    source_embedded_count: Number(sidecar?.source_embedded_count || 0) || null,
    full_size: Number(sidecar?.full_size || 0) || null,
    hot_size: Number(sidecar?.hot_size || 0) || null,
    dim: Number(sidecar?.dim || 0) || null,
    live_embedded: Number.isFinite(liveCount) ? liveCount : null,
    freshness: {
      corpus_delta: corpusDelta,
      new_chunks: newChunks,
      removed_chunks: removedChunks,
      absolute_drift_chunks: absoluteDriftChunks,
      growth_threshold: growthThreshold,
      stale,
    },
  };
}

async function embedHoldEvidence() {
  try {
    const { readEmbedPauseHold } = await import(resolve(REPO_ROOT, 'lib/embed-pause-hold.js'));
    const hold = readEmbedPauseHold({ maxCacheMs: 0 });
    const raw = hold?.hold && typeof hold.hold === 'object' ? hold.hold : hold;
    return {
      ok: true,
      active: hold?.active === true,
      reason: hold?.reason || raw?.reason || null,
      pid: raw?.pid || null,
      process_alive: raw?.pid ? processAlive(raw.pid) : false,
      expires_at: raw?.expires_at || null,
      metadata: raw?.metadata || null,
      file: hold?.file || null,
    };
  } catch (err) {
    return { ok: false, active: false, error: err?.message || String(err) };
  }
}

function hasBasename(files, expected) {
  return Array.isArray(files) && files.some((file) => basename(String(file)) === expected);
}

function snapshotForBasename(snapshots, expected) {
  if (!Array.isArray(snapshots)) return null;
  return snapshots.find((entry) => basename(String(entry?.source || '')) === expected) || null;
}

function backupEvidenceFailures(evidence) {
  const failures = [];
  if (evidence?.strict_ok !== true || evidence?.db_synced !== true) failures.push('backup evidence is not strict/synced');
  if (evidence?.ok !== true) failures.push('backup ok flag is not true');
  if (evidence?.strict !== true) failures.push('backup was not strict');
  if (evidence?.db_only !== true) failures.push('backup was not db-only');
  if (evidence?.db_snapshot_enabled !== true && evidence?.snapshot_dbs !== true) {
    failures.push('backup did not use SQLite snapshots');
  }
  if (evidence?.db_snapshot_method !== 'clone') failures.push('backup did not use clone snapshots');
  if (Array.isArray(evidence?.db_missing_required) && evidence.db_missing_required.length > 0) {
    failures.push(`backup missing required db files: ${evidence.db_missing_required.join(', ')}`);
  }
  for (const required of [MAIN_DB_BASENAME, VECTOR_DB_BASENAME]) {
    const snapshot = snapshotForBasename(evidence?.db_snapshots_created, required);
    if (!snapshot) {
      failures.push(`backup did not snapshot ${required}`);
    } else {
      if (snapshot.method !== 'clone') failures.push(`backup snapshot for ${required} was not a clone`);
      if (snapshot.verification?.ok !== true || snapshot.verification?.mode !== 'open_schema') {
        failures.push(`backup snapshot for ${required} did not have open-schema verification`);
      }
    }
    if (!hasBasename(evidence?.db_files_uploaded, required)) failures.push(`backup did not upload ${required}`);
    if (!hasBasename(evidence?.db_files_verified, required)) failures.push(`backup did not verify ${required}`);
  }
  return failures;
}

function postDrainPreflightEvidenceFailures(evidence) {
  const failures = [];
  const projection = evidence?.global_ann_source_projection || {};
  const topicProjection = evidence?.topic_context_projection || {};
  const backupProjection = evidence?.backup_dispatcher_projection || {};
  const backupDryRun = backupProjection?.projection || {};
  const reclassifyProjection = evidence?.reclassify_projection || {};
  const reclassifyDryRun = reclassifyProjection?.projection || {};
  const memoryProjection = evidence?.memory_refocus_projection || {};
  const memoryDryRun = memoryProjection?.projection || {};
  const embedded = Number(projection.embedded_total);
  const readable = Number(projection.readable_vectors);
  const topicTotal = Number(topicProjection.total_topics);
  const topicCapacity = Number(topicProjection.capacity);
  const topicPending = Number(topicProjection.pending_now);
  const backupLockedCompatible = backupProjection.locked === true && backupProjection.lock_compatible === true;
  const reclassifyStatus = String(reclassifyDryRun.status || '');
  const memoryAfter = Number(memoryDryRun.after_current_needs_routing_links);
  const memoryThreshold = Number(memoryProjection.threshold);
  if (evidence?.ok !== true) failures.push('post-drain preflight evidence is not ok');
  if (evidence?.read_only !== true) failures.push('post-drain preflight evidence is not read-only');
  if (!Array.isArray(evidence?.failures) || evidence.failures.length > 0) {
    failures.push('post-drain preflight reported failures or did not report failure list');
  }
  if (projection.ok !== true) failures.push('post-drain preflight ANN source projection is not ok');
  if (!Number.isFinite(embedded) || embedded <= 0) {
    failures.push('post-drain preflight ANN source projection found no embedded chunks');
  }
  if (Number(projection.missing_vectors || 0) !== 0) {
    failures.push('post-drain preflight ANN source projection has missing vectors');
  }
  if (Number(projection.malformed_rows || 0) !== 0) {
    failures.push('post-drain preflight ANN source projection has malformed vectors');
  }
  if (Number.isFinite(embedded) && Number.isFinite(readable) && readable !== embedded) {
    failures.push('post-drain preflight ANN source readable count does not match embedded count');
  }
  if (topicProjection.ok !== true) failures.push('post-drain preflight topic context projection not ok');
  if (topicProjection.read_only !== true) failures.push('post-drain preflight topic context projection was not read-only');
  if (!Number.isFinite(topicTotal) || !Number.isFinite(topicCapacity) || topicCapacity < topicTotal) {
    failures.push('post-drain preflight topic context capacity cannot cover all topics');
  }
  if (!Number.isFinite(topicPending)) failures.push('post-drain preflight topic context projection did not report pending topics');
  if (backupProjection.ok !== true) failures.push('post-drain preflight backup dispatcher projection not ok');
  if (backupProjection.read_only !== true) failures.push('post-drain preflight backup dispatcher projection was not read-only');
  if (backupLockedCompatible) {
    if (backupProjection.lock_process_alive !== true) failures.push('post-drain preflight backup lock compatibility did not prove a live owner');
  } else {
    if (backupDryRun.action !== 'backup_to_gcp' || backupDryRun.dry_run !== true) {
      failures.push('post-drain preflight backup dispatcher projection was not a dry-run backup');
    }
    if (
      backupDryRun.db_only !== true
        || backupDryRun.snapshot_dbs !== true
        || backupDryRun.strict !== true
        || backupDryRun.strict_ok !== true
        || backupDryRun.db_snapshot_enabled !== true
        || backupDryRun.db_snapshot_method !== 'clone'
    ) {
      failures.push('post-drain preflight backup dispatcher projection did not enforce strict clone DB snapshots');
    }
    if (!Array.isArray(backupDryRun.db_missing_required) || backupDryRun.db_missing_required.length > 0) {
      failures.push('post-drain preflight backup dispatcher projection has missing required DBs');
    }
  }
  if (reclassifyProjection.ok !== true) failures.push('post-drain preflight reclassify projection not ok');
  if (reclassifyProjection.read_only !== true) failures.push('post-drain preflight reclassify projection was not read-only');
  if (reclassifyDryRun.ok !== true || reclassifyDryRun.dry_run !== true || reclassifyDryRun.skip_regen !== true) {
    failures.push('post-drain preflight reclassify projection did not run as dry-run no-regen');
  }
  if (!['partial_slice', 'complete'].includes(reclassifyStatus)) {
    failures.push('post-drain preflight reclassify projection reported invalid status');
  }
  if (!Array.isArray(reclassifyDryRun.passes) || reclassifyDryRun.passes.length === 0) {
    failures.push('post-drain preflight reclassify projection did not report pass evidence');
  }
  if (memoryProjection.ok !== true) failures.push('post-drain preflight memory refocus projection not ok');
  if (memoryProjection.read_only !== true) failures.push('post-drain preflight memory refocus projection was not read-only');
  if (memoryDryRun.ok !== true || memoryDryRun.applied !== false) {
    failures.push('post-drain preflight memory refocus projection did not run read-only');
  }
  if (memoryDryRun.partial !== false) failures.push('post-drain preflight memory refocus projection did not complete');
  if (!Number.isFinite(memoryAfter) || !Number.isFinite(memoryThreshold) || memoryAfter > memoryThreshold) {
    failures.push('post-drain preflight memory refocus projection does not clear unresolved links below threshold');
  }
  return failures;
}

function postDrainEmbedHoldEvidenceFailures(postDrain) {
  const failures = [];
  const hold = postDrain?.post_drain_embed_hold || {};
  const release = postDrain?.post_drain_embed_hold_release || {};
  if (hold?.ok !== true) failures.push('post-drain embed writer hold was not acquired');
  if (hold?.hold_reason !== 'post_drain_pipeline_sole_writer') {
    failures.push('post-drain embed writer hold reason is not post_drain_pipeline_sole_writer');
  }
  if (release?.ok !== true || release?.skipped === true) {
    failures.push('post-drain embed writer hold was not released by its owner');
  }
  return failures;
}

function globalHnswEvidenceFailures(evidence) {
  const failures = [];
  if (evidence?.ok !== true || evidence?.artifact_complete !== true) failures.push('global HNSW evidence is not complete');
  if (Number(evidence?.meta?.dim) !== 1024) failures.push('global HNSW dim is not 1024');
  const fullSize = Number(evidence?.meta?.full_size) || 0;
  const builtFrom = Number(evidence?.meta?.built_from_count) || 0;
  const sourceEmbedded = Number(evidence?.meta?.source_embedded_count || builtFrom) || 0;
  if (fullSize <= 0 || builtFrom <= 0) failures.push('global HNSW build counts are empty');
  if (fullSize !== builtFrom) failures.push('global HNSW full_size does not match built_from_count');
  if (sourceEmbedded !== builtFrom) failures.push('global HNSW source_embedded_count does not match built_from_count');
  return failures;
}

function reclassifyEvidenceFailures(evidence) {
  const failures = [];
  if (evidence?.ok !== true || evidence?.status !== 'complete') failures.push('reclassify evidence is not complete');
  if (evidence?.partial !== false) failures.push('reclassify final slice did not report complete');
  if (evidence?.skip_regen !== true) failures.push('reclassify did not defer context regeneration');
  if (!Array.isArray(evidence?.passes)) failures.push('reclassify did not report pass summaries');
  return failures;
}

function topicContextEvidenceFailures(evidence, label = 'topic context regeneration') {
  const failures = [];
  const initialPending = Number(evidence?.initial_pending);
  const finalPending = Number(evidence?.final_pending);
  const slices = Number(evidence?.slices);
  const startedMs = Date.parse(String(evidence?.started_at || ''));
  const completedMs = Date.parse(String(evidence?.completed_at || ''));
  const sliceResults = Array.isArray(evidence?.slice_results) ? evidence.slice_results : null;
  const noopStep = evidence?.noop_step || null;
  if (evidence?.ok !== true || finalPending !== 0) failures.push(`${label} evidence is not complete`);
  if (evidence?.dry_run === true || evidence?.pending_unmodified === true) failures.push(`${label} did not run in apply mode`);
  if (!Number.isFinite(initialPending)) failures.push(`${label} did not report initial pending count`);
  if (!Number.isFinite(slices)) failures.push(`${label} did not report slice count`);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    failures.push(`${label} has invalid timestamps`);
  }
  if (!sliceResults) failures.push(`${label} did not report slice results`);
  if (Number.isFinite(initialPending) && Number.isFinite(slices) && sliceResults) {
    if (initialPending <= 0) {
      if (slices !== 0) failures.push(`${label} reported slices despite no pending topics`);
      if (sliceResults.length !== 0) failures.push(`${label} reported slice results despite no pending topics`);
      if (noopStep?.ok !== true || noopStep?.noop !== true) failures.push(`${label} did not record noop evidence`);
    } else {
      if (slices <= 0) failures.push(`${label} did not run any slices despite pending topics`);
      if (sliceResults.length !== slices) failures.push(`${label} slice results do not match slice count`);
      sliceResults.forEach((row, index) => {
        const before = Number(row?.before_pending);
        const after = Number(row?.after_pending);
        const checkedMs = Date.parse(String(row?.checked_at || ''));
        if (Number(row?.slice) !== index + 1) failures.push(`${label} slice result order is invalid`);
        if (!Number.isFinite(before) || !Number.isFinite(after)) failures.push(`${label} slice result is missing pending counts`);
        if (Number.isFinite(before) && Number.isFinite(after) && after > before) {
          failures.push(`${label} pending count increased during regeneration`);
        }
        if (!Number.isFinite(checkedMs)) failures.push(`${label} slice result is missing checked_at`);
        if (index === 0 && Number.isFinite(before) && before !== initialPending) {
          failures.push(`${label} first slice does not start from initial pending count`);
        }
        if (index === sliceResults.length - 1 && Number.isFinite(after) && after !== finalPending) {
          failures.push(`${label} last slice does not end at final pending count`);
        }
      });
    }
  }
  return failures;
}

function splitVectorParityEvidenceFailures(evidence) {
  const failures = [];
  if (evidence?.ok !== true) failures.push('split-vector parity evidence is not ok');
  if (evidence?.reason !== 'split_vector_parity_ok') failures.push('split-vector parity did not check migrated topics');
  if (!Number.isFinite(Number(evidence?.migrated_topics)) || Number(evidence.migrated_topics) <= 0) {
    failures.push('split-vector parity did not report migrated topics');
  }
  if (Number(evidence?.missing_vectors || 0) !== 0) failures.push('split-vector parity has missing vectors');
  if (Number(evidence?.stale_vectors || 0) !== 0) failures.push('split-vector parity has stale vectors');
  if (Number(evidence?.malformed_tables || 0) !== 0) failures.push('split-vector parity has malformed vector tables');
  if (!Array.isArray(evidence?.by_topic) || evidence.by_topic.length === 0) {
    failures.push('split-vector parity did not report topic rows');
  }
  if (!evidence?.vector_table_audit || !Array.isArray(evidence.vector_table_audit.by_table)) {
    failures.push('split-vector parity did not audit vector table stale rows');
  }
  return failures;
}

function splitVectorRepairEvidenceFailures(evidence) {
  const failures = [];
  const copied = Number(evidence?.copied);
  const exactSource = Number(evidence?.exact_source);
  const ambientSource = Number(evidence?.ambient_source);
  const staleVectors = Number(evidence?.stale_vectors || 0);
  const stalePruned = Number(evidence?.stale_pruned || 0);
  const vectorRepair = evidence?.vector_table_repair || null;
  const vectorRepairStale = Number(vectorRepair?.stale_vectors);
  const vectorRepairPruned = Number(vectorRepair?.pruned);
  if (evidence?.ok !== true) failures.push('split-vector repair evidence is not ok');
  if (evidence?.dry_run !== false) failures.push('split-vector repair did not run in explicit apply mode');
  if (evidence?.reason !== 'split_vector_repair_ok') failures.push('split-vector repair did not report ok reason');
  if (!Number.isFinite(Number(evidence?.migrated_topics)) || Number(evidence.migrated_topics) <= 0) {
    failures.push('split-vector repair did not report migrated topics');
  }
  if (Number(evidence?.missing_source || 0) !== 0) failures.push('split-vector repair has missing source vectors');
  if (!Number.isFinite(copied) || !Number.isFinite(exactSource) || !Number.isFinite(ambientSource)) {
    failures.push('split-vector repair did not report source provenance counts');
  } else if (exactSource + ambientSource !== copied) {
    failures.push('split-vector repair source provenance counts do not match copied rows');
  }
  if (Number.isFinite(staleVectors) && Number.isFinite(stalePruned) && stalePruned !== staleVectors) {
    failures.push('split-vector repair pruned count does not equal stale vector count');
  }
  if (vectorRepair?.dry_run !== false) failures.push('split-vector vector-table repair did not run in explicit apply mode');
  if (Number.isFinite(vectorRepairStale) && vectorRepairStale !== staleVectors) {
    failures.push('split-vector repair stale vector count does not match vector-table audit');
  }
  if (Number.isFinite(vectorRepairPruned) && vectorRepairPruned !== stalePruned) {
    failures.push('split-vector repair pruned count does not match vector-table audit');
  }
  if (Number(evidence?.malformed_tables || 0) !== 0) failures.push('split-vector repair has malformed vector tables');
  if (!Array.isArray(evidence?.by_topic) || evidence.by_topic.length === 0) {
    failures.push('split-vector repair did not report topic rows');
  } else {
    for (const row of evidence.by_topic) {
      const copyable = Number(row?.copyable);
      const topicExact = Number(row?.exact_source);
      const topicAmbient = Number(row?.ambient_source);
      if (!Number.isFinite(copyable) || !Number.isFinite(topicExact) || !Number.isFinite(topicAmbient)) {
        failures.push(`split-vector repair topic row missing source provenance counts: ${row?.topic || 'unknown'}`);
        continue;
      }
      if (topicExact + topicAmbient !== copyable) {
        failures.push(`split-vector repair topic source counts do not match copyable rows: ${row?.topic || 'unknown'}`);
      }
    }
  }
  if (!vectorRepair || !Array.isArray(vectorRepair.by_table)) {
    failures.push('split-vector repair did not report vector table repair rows');
  } else {
    for (const row of vectorRepair.by_table) {
      const rowStale = Number(row?.stale_vectors || 0);
      const rowPruned = Number(row?.pruned || 0);
      if (Number.isFinite(rowStale) && Number.isFinite(rowPruned) && rowPruned !== rowStale) {
        failures.push(`split-vector repair vector-table pruned count does not equal stale count: ${row?.store || 'unknown'}:${row?.table || 'unknown'}`);
      }
    }
  }
  return failures;
}

function memoryRoutingRepairFailures(evidence) {
  const failures = [];
  if (evidence?.ok !== true || evidence?.mode !== 'apply') failures.push('memory routing repair evidence is not applied');
  const after = evidence?.after || {};
  if (Number(after.drop_folder_personal_learning || 0) !== 0) failures.push('memory routing repair did not clear drop-folder personal/learning rows');
  if (Number(after.memory_unknown_topic_alias_links || 0) !== 0) failures.push('memory routing repair did not clear unknown-topic memory aliases');
  if (Number(after.memory_import_tags_as_topics || 0) !== 0) failures.push('memory routing repair did not convert import tags');
  return failures;
}

function sourceTopicMetadataRepairFailures(evidence) {
  const failures = [];
  if (evidence?.ok !== true || evidence?.mode !== 'apply') failures.push('source topic metadata repair evidence is not applied');
  if (Number(evidence?.after?.drive_files?.personal || 0) !== 0) {
    failures.push('source topic metadata repair did not clear drive_files Personal rows');
  }
  if (Number(evidence?.after?.transcripts?.personal || 0) !== 0) {
    failures.push('source topic metadata repair did not clear transcripts Personal rows');
  }
  const remainingConversationPersonal = Number(
    evidence?.after?.conversations?.personal_non_user ?? evidence?.after?.conversations?.personal ?? 0,
  );
  if (remainingConversationPersonal !== 0) {
    failures.push('source topic metadata repair did not clear conversations Personal rows');
  }
  if (Number(evidence?.after?.conversations?.null_topic_non_user || 0) !== 0) {
    failures.push('source topic metadata repair did not clear conversations null-topic rows');
  }
  if (Number(evidence?.after?.resolvable_queue_metadata?.rows || 0) !== 0) {
    failures.push('source topic metadata repair left resolvable queue metadata rows');
  }
  return failures;
}

function routingResidueEvidenceFailures(evidence) {
  const failures = [];
  const thresholds = evidence?.thresholds || {};
  const maxPersonalPending = Number(thresholds.maxPersonalPending);
  const maxPersonalUnexplainedImports = Number(thresholds.maxPersonalUnexplainedImports);
  const maxPersonalSourceMetadataRows = Number(thresholds.maxPersonalSourceMetadataRows);
  const maxNeedsRoutingChunks = Number(thresholds.maxNeedsRoutingChunks);
  const maxNeedsRoutingMemory = Number(thresholds.maxNeedsRoutingMemory);
  if (evidence?.ok !== true) failures.push('routing residue audit evidence is not ok');
  if (evidence?.strict !== true) failures.push('routing residue audit did not run in strict mode');
  if (!Array.isArray(evidence?.failures) || evidence.failures.length > 0) {
    failures.push('routing residue audit reported failures or did not report failure list');
  }
  if (!Number.isFinite(maxPersonalPending) || maxPersonalPending !== 0) {
    failures.push('routing residue audit did not enforce zero Personal pending embeddings');
  }
  if (!Number.isFinite(maxPersonalUnexplainedImports) || maxPersonalUnexplainedImports > MAX_POST_DRAIN_PERSONAL_UNEXPLAINED_IMPORTS) {
    failures.push('routing residue Personal import threshold was missing or looser than configured');
  }
  if (!Number.isFinite(maxPersonalSourceMetadataRows) || maxPersonalSourceMetadataRows > MAX_POST_DRAIN_PERSONAL_SOURCE_METADATA_ROWS) {
    failures.push('routing residue Personal source metadata threshold was missing or looser than configured');
  }
  if (!Number.isFinite(maxNeedsRoutingChunks) || maxNeedsRoutingChunks > MAX_POST_DRAIN_NEEDS_ROUTING_CHUNKS) {
    failures.push('routing residue chunk threshold was missing or looser than configured');
  }
  if (!Number.isFinite(maxNeedsRoutingMemory) || maxNeedsRoutingMemory > MAX_POST_DRAIN_NEEDS_ROUTING_MEMORY) {
    failures.push('routing residue memory threshold was missing or looser than configured');
  }
  if (Number(evidence?.personal?.pending_embeddings || 0) !== 0) failures.push('Personal still has pending embeddings');
  if (Number(evidence?.personal?.scope_review?.unexplained_import_chunks || 0) > MAX_POST_DRAIN_PERSONAL_UNEXPLAINED_IMPORTS) {
    failures.push('Personal still has unexplained import/container chunks');
  }
  if (Number(evidence?.personal?.source_metadata_review?.personal_rows || 0) > MAX_POST_DRAIN_PERSONAL_SOURCE_METADATA_ROWS) {
    failures.push('Personal still has source metadata rows');
  }
  if (Number(evidence?.needs_routing?.chunks || 0) > MAX_POST_DRAIN_NEEDS_ROUTING_CHUNKS) {
    failures.push('needs-routing chunk residue is above launch threshold');
  }
  if (Number(evidence?.needs_routing?.memory_links?.current_unresolved || 0) > MAX_POST_DRAIN_NEEDS_ROUTING_MEMORY) {
    failures.push('needs-routing current memory residue is above launch threshold');
  }
  const resolutionReview = evidence?.needs_routing?.resolution_review || {};
  if (resolutionReview.required !== true) failures.push('needs-routing resolution review was not required');
  if (resolutionReview.ok !== true) failures.push('needs-routing resolution review did not pass');
  if (resolutionReview.complete !== true) failures.push('needs-routing resolution review did not scan every embedded chunk');
  if (Number(resolutionReview.missing_vectors || 0) !== 0) failures.push('needs-routing resolution review has missing vectors');
  if (Number(resolutionReview.resolvable_chunks || 0) !== 0) failures.push('needs-routing still has strongly classifiable chunks');
  if (!Array.isArray(evidence?.fallback_residue?.chunk_topics) || evidence.fallback_residue.chunk_topics.length > 0) {
    failures.push('forbidden fallback chunk topics remain or were not audited');
  }
  if (!Array.isArray(evidence?.fallback_residue?.memory_targets) || evidence.fallback_residue.memory_targets.length > 0) {
    failures.push('forbidden fallback memory targets remain or were not audited');
  }
  if (!Array.isArray(evidence?.fallback_residue?.source_topics) || evidence.fallback_residue.source_topics.length > 0) {
    failures.push('forbidden fallback source topics remain or were not audited');
  }
  return failures;
}

function memoryRefocusEvidenceFailures(evidence) {
  const failures = [];
  const before = Number(evidence?.before_current_needs_routing_links);
  const after = Number(evidence?.after_current_needs_routing_links);
  const movedEvents = Number(evidence?.moved_events);
  const suppressedEvents = Number(evidence?.suppressed_events);
  const skippedNoTopic = Number(evidence?.skipped_no_topic);
  if (evidence?.ok !== true || evidence?.partial !== false) failures.push('memory refocus evidence is not complete');
  if (evidence?.applied !== true) failures.push('memory refocus did not run in apply mode');
  if (!Number.isFinite(before)) {
    failures.push('memory refocus did not report before count');
  }
  if (!Number.isFinite(after)) {
    failures.push('memory refocus did not report after count');
  }
  if (Number.isFinite(before) && Number.isFinite(after) && after > before) {
    failures.push('memory refocus increased current needs-routing links');
  }
  if (!Number.isFinite(movedEvents)) failures.push('memory refocus did not report moved event count');
  if (!Number.isFinite(suppressedEvents)) failures.push('memory refocus did not report suppressed event count');
  if (!Number.isFinite(skippedNoTopic)) failures.push('memory refocus did not report skipped no-topic count');
  if (!Array.isArray(evidence?.moved_examples)) failures.push('memory refocus did not report moved examples');
  if (!Array.isArray(evidence?.suppressed_examples)) failures.push('memory refocus did not report suppressed examples');
  if (!Array.isArray(evidence?.skipped_examples)) failures.push('memory refocus did not report skipped examples');
  return failures;
}

function memoryRecalcEvidenceFailures(evidence) {
  const failures = [];
  if (evidence?.ok !== true || evidence?.scope !== 'all') failures.push('memory recalc evidence is not global');
  if (!Array.isArray(evidence?.generated_tiers) || evidence.generated_tiers.length === 0) {
    failures.push('memory recalc did not report generated tiers');
  }
  if (!Number.isFinite(Number(evidence?.count))) failures.push('memory recalc did not report workbench count');
  return failures;
}

function stepHistoryEvidenceFailures(postDrain) {
  const failures = [];
  const history = Array.isArray(postDrain?.step_history) ? postDrain.step_history : null;
  if (!history || history.length === 0) {
    return ['post-drain step history is missing'];
  }
  const requiredTail = [
    { label: 'post-drain preflight', match: (id) => id === 'post_drain_preflight' },
    { label: 'GCS backup', match: (id) => id === 'gcs_backup' },
    { label: 'chunk reclassification', match: (id) => /^reclassify_chunks_\d+$/.test(id) },
    { label: 'split-vector orphan repair', match: (id) => id === 'split_vec_orphan_repair_after_reclassify' },
    { label: 'split-vector parity check', match: (id) => id === 'vec_orphan_check_after_reclassify' },
    { label: 'source topic metadata repair', match: (id) => id === 'source_topic_metadata_repair' },
    { label: 'topic context regeneration', match: (id) => /^topic_context_(dry_run|noop|\d+)$/.test(id) },
    { label: 'global HNSW rebuild', match: (id) => id === 'global_hnsw_rebuild' },
    { label: 'memory routing repair', match: (id) => id === 'memory_routing_repair' },
    { label: 'memory refocus', match: (id) => /^memory_refocus_\d+$/.test(id) },
    { label: 'memory recalc', match: (id) => id === 'memory_recalc' },
    { label: 'post-memory topic context regeneration', match: (id) => /^post_memory_topic_context_(dry_run|noop|\d+)$/.test(id) },
    { label: 'routing residue audit', match: (id) => id === 'routing_residue_audit' },
    { label: 'final product proof', match: (id) => id === 'final_product_proof' },
  ];
  let cursor = -1;
  for (const required of requiredTail) {
    const index = history.findIndex((step, i) => (
      i > cursor
        && step?.ok === true
        && required.match(String(step?.id || ''))
    ));
    if (index === -1) {
      failures.push(`post-drain step history missing ordered passing ${required.label}`);
      continue;
    }
    const step = history[index];
    const startedMs = Date.parse(String(step.started_at || ''));
    const completedMs = Date.parse(String(step.completed_at || ''));
    if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
      failures.push(`post-drain step history has invalid timestamps for ${required.label}`);
    }
    cursor = index;
  }
  const lastHistory = history[history.length - 1] || null;
  if (postDrain?.last_step?.id !== lastHistory?.id || postDrain?.last_step?.ok !== lastHistory?.ok) {
    failures.push('post-drain last_step does not match step history tail');
  }
  return failures;
}

function postDrainRunnerStatusCodeFailures(postDrain) {
  const failures = [];
  const currentSha = fileSha256(POST_DRAIN_RUNNER_FILE);
  const reported = postDrain?.runner_code || {};
  if (!reported.sha256) failures.push('post-drain completion runner code version is not reported');
  if (!currentSha) failures.push('current post-drain runner code hash is unavailable');
  if (reported.path && resolve(String(reported.path)) !== POST_DRAIN_RUNNER_FILE) {
    failures.push('post-drain completion runner code path does not match current runner');
  }
  if (reported.sha256 && currentSha && reported.sha256 !== currentSha) {
    failures.push('post-drain completion was produced by stale runner code');
  }
  return failures;
}

function postDrainCompletionEvidence({ db, postDrain, handoff }) {
  const failures = [];
  const completionClaimed = postDrain?.status === 'complete' || handoff?.status === 'post_drain_complete';
  if (!completionClaimed) {
    return { claimed: false, ok: false, failures };
  }
  if (postDrain?.status !== 'complete') failures.push('post-drain status is not complete');
  if (handoff?.status !== 'post_drain_complete') failures.push('handoff is not marked post_drain_complete');
  if (handoff?.post_drain?.status_file !== POST_DRAIN_STATUS_FILE) failures.push('handoff completion did not reference this post-drain status file');
  if (handoff?.post_drain?.log_file !== LOG_PATH) failures.push('handoff completion did not reference this post-drain log file');
  if (handoff?.post_drain?.previous_status !== 'ready_for_reclassify') failures.push('handoff completion did not consume a ready handoff');
  const statusCompletedMs = Date.parse(String(postDrain?.completed_at || ''));
  const handoffCompletedMs = Date.parse(String(handoff?.post_drain?.completed_at || ''));
  if (!Number.isFinite(statusCompletedMs)) failures.push('post-drain status is missing a valid completed_at');
  if (!Number.isFinite(handoffCompletedMs)) failures.push('handoff completion is missing a valid completed_at');
  if (Number.isFinite(statusCompletedMs) && Number.isFinite(handoffCompletedMs) && handoffCompletedMs < statusCompletedMs) {
    failures.push('handoff completion timestamp predates post-drain completion status');
  }
  const consumedCheckedAt = handoff?.post_drain?.previous_checked_at || null;
  const readinessCheckedAt = postDrain?.readiness?.handoff_checked_at || null;
  if (!consumedCheckedAt || !readinessCheckedAt || consumedCheckedAt !== readinessCheckedAt) {
    failures.push('handoff completion does not match post-drain readiness handoff');
  }
  if (postDrain?.readiness?.handoff_required !== false && postDrain?.readiness?.handoff_launchd_clearance?.ok !== true) {
    failures.push('post-drain readiness did not prove temporary launchd drain was cleared');
  }
  if (db?.ok !== true || Number(db?.chunks?.pending || 0) !== 0) failures.push('embeddable backlog is not zero');
  if (postDrain?.pre_backup_backlog_check?.ok !== true || Number(postDrain?.pre_backup_backlog_check?.pending_embeddings || -1) !== 0) failures.push('pre-backup backlog check evidence is missing or not zero');
  if (postDrain?.pre_gcs_backup_backlog_check?.ok !== true || Number(postDrain?.pre_gcs_backup_backlog_check?.pending_embeddings || -1) !== 0) failures.push('pre-GCS-backup backlog check evidence is missing or not zero');
  if (postDrain?.pre_gcs_backup_source_quiescence?.ok !== true || Number(postDrain?.pre_gcs_backup_source_quiescence?.active_running || -1) !== 0) failures.push('pre-GCS-backup source quiescence proof is missing or not quiet');
  if (postDrain?.pre_reclassify_backlog_check?.ok !== true || Number(postDrain?.pre_reclassify_backlog_check?.pending_embeddings || -1) !== 0) failures.push('pre-reclassify backlog check evidence is missing or not zero');
  if (postDrain?.pre_reclassify_source_quiescence?.ok !== true || Number(postDrain?.pre_reclassify_source_quiescence?.active_running || -1) !== 0) failures.push('pre-reclassify source quiescence proof is missing or not quiet');
  if (postDrain?.pre_topic_context_backlog_check?.ok !== true || Number(postDrain?.pre_topic_context_backlog_check?.pending_embeddings || -1) !== 0) failures.push('pre-topic-context backlog check evidence is missing or not zero');
  if (postDrain?.pre_global_hnsw_backlog_check?.ok !== true || Number(postDrain?.pre_global_hnsw_backlog_check?.pending_embeddings || -1) !== 0) failures.push('pre-global-HNSW backlog check evidence is missing or not zero');
  if (postDrain?.pre_post_memory_topic_context_backlog_check?.ok !== true || Number(postDrain?.pre_post_memory_topic_context_backlog_check?.pending_embeddings || -1) !== 0) failures.push('pre-post-memory-topic-context backlog check evidence is missing or not zero');
  if (postDrain?.chunk_source_quiescence?.ok !== true || Number(postDrain?.chunk_source_quiescence?.active_running || -1) !== 0) failures.push('chunk source quiescence proof is missing or not quiet');
  if (postDrain?.pre_topic_context_source_quiescence?.ok !== true || Number(postDrain?.pre_topic_context_source_quiescence?.active_running || -1) !== 0) failures.push('pre-topic-context source quiescence proof is missing or not quiet');
  if (postDrain?.pre_global_hnsw_source_quiescence?.ok !== true || Number(postDrain?.pre_global_hnsw_source_quiescence?.active_running || -1) !== 0) failures.push('pre-global-HNSW source quiescence proof is missing or not quiet');
  if (postDrain?.pre_post_memory_topic_context_source_quiescence?.ok !== true || Number(postDrain?.pre_post_memory_topic_context_source_quiescence?.active_running || -1) !== 0) failures.push('pre-post-memory-topic-context source quiescence proof is missing or not quiet');
  if (postDrain?.pre_routing_audit_source_quiescence?.ok !== true || Number(postDrain?.pre_routing_audit_source_quiescence?.active_running || -1) !== 0) failures.push('pre-routing-audit source quiescence proof is missing or not quiet');
  if (postDrain?.pre_routing_audit_backlog_check?.ok !== true || Number(postDrain?.pre_routing_audit_backlog_check?.pending_embeddings || -1) !== 0) failures.push('pre-routing-audit backlog check evidence is missing or not zero');
  if (postDrain?.preflight_backup_slot?.ok !== true) failures.push('preflight backup slot clearance proof is missing');
  if (postDrain?.backup_slot?.ok !== true) failures.push('backup slot clearance proof is missing');
  failures.push(...postDrainRunnerStatusCodeFailures(postDrain));
  failures.push(...postDrainEmbedHoldEvidenceFailures(postDrain));
  failures.push(...postDrainPreflightEvidenceFailures(postDrain?.post_drain_preflight));
  failures.push(...backupEvidenceFailures(postDrain?.gcs_backup));
  failures.push(...reclassifyEvidenceFailures(postDrain?.reclassify?.last));
  failures.push(...splitVectorRepairEvidenceFailures(postDrain?.split_vec_orphan_repair_after_reclassify));
  failures.push(...splitVectorParityEvidenceFailures(postDrain?.vec_orphan_check_after_reclassify));
  failures.push(...topicContextEvidenceFailures(postDrain?.topic_contexts, 'topic context regeneration'));
  failures.push(...globalHnswEvidenceFailures(postDrain?.global_hnsw_rebuild));
  failures.push(...memoryRoutingRepairFailures(postDrain?.memory_routing_repair));
  failures.push(...sourceTopicMetadataRepairFailures(postDrain?.source_topic_metadata_repair));
  failures.push(...memoryRefocusEvidenceFailures(postDrain?.memory_refocus?.last));
  failures.push(...memoryRecalcEvidenceFailures(postDrain?.memory_recalc));
  failures.push(...topicContextEvidenceFailures(postDrain?.post_memory_topic_contexts, 'post-memory topic context'));
  failures.push(...routingResidueEvidenceFailures(postDrain?.routing_residue_audit));
  failures.push(...stepHistoryEvidenceFailures(postDrain));
  if (postDrain?.last_step?.id !== 'final_product_proof' || postDrain?.last_step?.ok !== true) failures.push('last post-drain step is not a passing final product proof');
  if (postDrain?.final_backlog_check?.ok !== true || Number(postDrain?.final_backlog_check?.pending_embeddings || -1) !== 0) failures.push('final backlog check evidence is missing or not zero');
  if (postDrain?.post_product_proof_source_quiescence?.ok !== true || Number(postDrain?.post_product_proof_source_quiescence?.active_running || -1) !== 0) failures.push('post-product-proof source quiescence proof is missing or not quiet');
  if (postDrain?.post_product_proof_backlog_check?.ok !== true || Number(postDrain?.post_product_proof_backlog_check?.pending_embeddings || -1) !== 0) failures.push('post-product-proof backlog check evidence is missing or not zero');
  return {
    claimed: true,
    ok: failures.length === 0,
    failures,
  };
}

function finalProductProofEvidence({ stoplight, postDrain }) {
  const failures = [];
  const checkedMs = Date.parse(String(stoplight?.checked_at || ''));
  const repairCompletedAt = postDrain?.repair_completed_at || postDrain?.completed_at || null;
  const repairCompletedMs = Date.parse(String(repairCompletedAt || ''));
  const durable = postDrain?.final_product_proof || null;
  const durableCheckedMs = Date.parse(String(durable?.checked_at || ''));
  const durableProofStepStartedMs = Date.parse(String(durable?.proof_step_started_at || ''));
  const durableProofStepCompletedMs = Date.parse(String(durable?.proof_step_completed_at || ''));
  const durableReportFileMatchesExpected = resolve(String(durable?.report_file || '')) === resolve(STOPLIGHT_LATEST)
    && durable?.report_file_matches_expected === true;
  const durableSnapshotInsideExpectedDir = pathWithinDir(durable?.snapshot_file, FINAL_PRODUCT_PROOF_SNAPSHOT_DIR)
    && durable?.snapshot_file_inside_expected_dir === true;
  const latestFresh = stoplight?.fresh === true;
  const latestAfterRepairCompletion = Number.isFinite(checkedMs)
    && Number.isFinite(repairCompletedMs)
    && checkedMs >= repairCompletedMs;
  const durableAfterRepairCompletion = Number.isFinite(durableCheckedMs)
    && Number.isFinite(repairCompletedMs)
    && durableCheckedMs >= repairCompletedMs;
  const durableSnapshotExists = Boolean(durable?.snapshot_file && existsSync(durable.snapshot_file));
  const durableSnapshot = durableSnapshotExists ? readJson(durable.snapshot_file) : null;
  const snapshotRows = Array.isArray(durableSnapshot?.rows) ? durableSnapshot.rows : [];
  const snapshotRowsById = Object.fromEntries(snapshotRows.map((row) => [row?.id, row]));
  const latestRows = stoplight?.final_product_rows || {};
  const rows = durable?.rows || latestRows;
  const deferredExactProofRows = [];
  const browserEntityCardFailures = [];
  let browserEntityCardProof = null;
  const dataPlaneProof = dataPlaneProofFromProductProof(durable, durable?.rows || {});
  const dataPlaneProofVerdict = dataPlaneProofVerdictFromProductProof(durable);
  const dataPlaneSnapshotProof = durableSnapshot ? dataPlaneProofFromProductProof(durableSnapshot, snapshotRowsById) : null;
  const dataPlaneLatestProof = latestFresh ? dataPlaneProofFromProductProof(stoplight, latestRows) : null;
  if (durable?.ok !== true) failures.push('post-drain status did not store passing final product proof evidence');
  if (durableAfterRepairCompletion !== true) failures.push('stored final product proof predates post-drain repair completion');
  if (durableSnapshotExists !== true) failures.push('stored final product proof snapshot file is missing');
  if (durableReportFileMatchesExpected !== true) {
    failures.push('stored final product proof report path was not the expected latest report file');
  }
  if (durableSnapshotInsideExpectedDir !== true) {
    failures.push('stored final product proof snapshot path was not inside the expected snapshot directory');
  }
  if (durable?.latest_report_file_exists !== true) {
    failures.push('stored final product proof latest report file did not exist when proof ran');
  }
  if (durable?.latest_report_matches_snapshot !== true) {
    failures.push('stored final product proof latest report did not match the stored snapshot when proof ran');
  }
  if (durable?.latest_report_hash_matches_snapshot !== true) {
    failures.push('stored final product proof latest report file was not byte-identical to the stored snapshot when proof ran');
  }
  if (durable?.proof_step_id !== 'final_product_proof' || durable?.proof_step_ok !== true) {
    failures.push('stored final product proof was not tied to a passing final_product_proof step');
  }
  if (durable?.proof_step_command_matches_expected !== true) {
    failures.push('stored final product proof command did not match expected row-mode invocation');
  }
  if (durable?.proof_report_row_mode_matches_expected !== true) {
    failures.push('stored final product proof did not request expected product proof rows');
  }
  if (durable?.proof_report_contains_expected_rows !== true) {
    failures.push('stored final product proof did not run expected dependency rows');
  }
  if (
    durable?.proof_checked_at_within_step !== true
      || !Number.isFinite(durableProofStepStartedMs)
      || !Number.isFinite(durableProofStepCompletedMs)
      || durableProofStepCompletedMs < durableProofStepStartedMs
      || (Number.isFinite(durableCheckedMs)
        && (durableCheckedMs < durableProofStepStartedMs || durableCheckedMs > durableProofStepCompletedMs))
  ) {
    failures.push('stored final product proof checked_at was not within the producing step window');
  }
  if (durableSnapshotExists && !durableSnapshot) failures.push('stored final product proof snapshot is unreadable or invalid');
  if (durableSnapshot && durableSnapshot.ok !== true) failures.push('stored final product proof snapshot report is not ok');
  if (durableSnapshot && durableSnapshot.snapshot_path !== durable?.snapshot_file) {
    failures.push('stored final product proof snapshot path does not match durable status');
  }
  if (durableSnapshot && durableSnapshot.checked_at !== durable?.checked_at) {
    failures.push('stored final product proof snapshot checked_at does not match durable status');
  }
  if (dataPlaneProof.ok !== true) {
    failures.push('stored final product proof missing live data-plane boundary proof');
  }
  if (dataPlaneProofVerdict.ok !== true) {
    failures.push('stored final product proof missing passing data-plane proof verdict');
  }
  if (dataPlaneSnapshotProof && dataPlaneSnapshotProof.ok !== true) {
    failures.push('stored final product proof snapshot missing live data-plane boundary proof');
  }
  if (dataPlaneLatestProof && dataPlaneLatestProof.ok !== true) {
    failures.push('fresh latest final product proof missing live data-plane boundary proof');
  }
  for (const id of FINAL_PRODUCT_PROOF_ROWS) {
    const durableRow = durable?.rows?.[id] || {};
    if (durableRow.status !== 'green') failures.push(`stored final product proof row is not green: ${id}`);
    if (rowDefersExactProof(durableRow)) {
      deferredExactProofRows.push(id);
      failures.push(`stored final product proof row deferred exact proof: ${id}`);
    }
    if (id === BROWSER_ENTITY_CARD_PROOF.row) {
      browserEntityCardProof = browserEntityCardProofFromRow(durableRow);
      if (browserEntityCardProof.ok !== true) {
        browserEntityCardFailures.push('stored final product proof browser row missing seeded entity-card proof');
      }
    }
    if (durableSnapshot) {
      const snapshotRow = snapshotRowsById[id] || {};
      if (!snapshotRow.status) failures.push(`stored final product proof snapshot row did not run: ${id}`);
      else if (snapshotRow.status !== 'green') failures.push(`stored final product proof snapshot row is not green: ${id}=${snapshotRow.status}`);
      else if (rowDefersExactProof(snapshotRow)) failures.push(`stored final product proof snapshot row deferred exact proof: ${id}`);
      else if (id === BROWSER_ENTITY_CARD_PROOF.row && browserEntityCardProofFromRow(snapshotRow).ok !== true) {
        browserEntityCardFailures.push('stored final product proof snapshot browser row missing seeded entity-card proof');
      }
      if (durable?.rows?.[id]?.status && snapshotRow.status && durable.rows[id].status !== snapshotRow.status) {
        failures.push(`stored final product proof row does not match snapshot: ${id}`);
      }
    }
    if (latestFresh) {
      const row = latestRows[id] || {};
      if (!row.status) failures.push(`fresh latest final product proof row did not run: ${id}`);
      else if (row.status !== 'green') failures.push(`fresh latest final product proof row is not green: ${id}=${row.status}`);
      else if (rowDefersExactProof(row)) failures.push(`fresh latest final product proof row deferred exact proof: ${id}`);
      else if (id === BROWSER_ENTITY_CARD_PROOF.row && browserEntityCardProofFromRow(row).ok !== true) {
        browserEntityCardFailures.push('fresh latest final product proof browser row missing seeded entity-card proof');
      }
    }
  }
  for (const failure of browserEntityCardFailures) failures.push(failure);
  if (!latestFresh) {
    failures.push(`latest launch stoplight proof is stale (${stoplight?.checked_age_ms ?? 'unknown'}ms)`);
  } else if (!latestAfterRepairCompletion) {
    failures.push('fresh latest launch stoplight proof predates post-drain repair completion');
  }
  return {
    ok: failures.length === 0,
    required_rows: [...FINAL_PRODUCT_PROOF_ROWS],
    rows,
    latest_rows: latestRows,
    stored: durable,
    checked_at: durable?.checked_at || null,
    latest_checked_at: stoplight?.checked_at || null,
    repair_completed_at: repairCompletedAt,
    expected_report_file: STOPLIGHT_LATEST,
    report_file_matches_expected: durableReportFileMatchesExpected,
    expected_snapshot_dir: FINAL_PRODUCT_PROOF_SNAPSHOT_DIR,
    snapshot_file_inside_expected_dir: durableSnapshotInsideExpectedDir,
    durable_snapshot_exists: durableSnapshotExists,
    durable_snapshot_checked_at: durableSnapshot?.checked_at || null,
    durable_snapshot_path_matches_status: durableSnapshot ? durableSnapshot.snapshot_path === durable?.snapshot_file : false,
    latest_report_file_exists_when_proven: durable?.latest_report_file_exists === true,
    latest_report_matches_stored_snapshot_when_proven: durable?.latest_report_matches_snapshot === true,
    latest_report_hash_matches_stored_snapshot_when_proven: durable?.latest_report_hash_matches_snapshot === true,
    latest_report_sha256: durable?.latest_report_sha256 || null,
    snapshot_file_sha256: durable?.snapshot_file_sha256 || null,
    proof_step_id: durable?.proof_step_id || null,
    proof_step_ok: durable?.proof_step_ok === true,
    proof_step_started_at: durable?.proof_step_started_at || null,
    proof_step_completed_at: durable?.proof_step_completed_at || null,
    proof_step_duration_ms: durable?.proof_step_duration_ms ?? null,
    proof_step_command: durable?.proof_step_command || null,
    proof_step_args: Array.isArray(durable?.proof_step_args) ? durable.proof_step_args : [],
    expected_proof_step_args: [...FINAL_PRODUCT_PROOF_COMMAND_ARGS],
    proof_step_command_matches_expected: durable?.proof_step_command_matches_expected === true,
    proof_report_requested_rows: Array.isArray(durable?.proof_report_requested_rows)
      ? durable.proof_report_requested_rows
      : [],
    proof_report_row_mode_matches_expected: durable?.proof_report_row_mode_matches_expected === true,
    proof_report_row_ids: Array.isArray(durable?.proof_report_row_ids)
      ? durable.proof_report_row_ids
      : [],
    expected_proof_report_row_ids: [...FINAL_PRODUCT_PROOF_EXPECTED_ROW_IDS],
    proof_report_contains_expected_rows: durable?.proof_report_contains_expected_rows === true,
    proof_report_missing_expected_rows: Array.isArray(durable?.proof_report_missing_expected_rows)
      ? durable.proof_report_missing_expected_rows
      : [...FINAL_PRODUCT_PROOF_EXPECTED_ROW_IDS],
    proof_checked_at_within_step: durable?.proof_checked_at_within_step === true,
    latest_fresh: latestFresh,
    latest_after_post_drain_repair_completion: latestAfterRepairCompletion,
    after_post_drain_repair_completion: durableAfterRepairCompletion,
    deferred_exact_proof_rows: deferredExactProofRows,
    browser_entity_card_proof: browserEntityCardProof,
    browser_entity_card_failures: browserEntityCardFailures,
    data_plane_proof: dataPlaneProof,
    data_plane_proof_verdict: dataPlaneProofVerdict,
    data_plane_snapshot_proof: dataPlaneSnapshotProof,
    data_plane_latest_proof: dataPlaneLatestProof,
    failures,
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

function dataPlaneProofFromProductProof(productProof, rows) {
  const candidates = [];
  if (productProof?.data_plane_proof && typeof productProof.data_plane_proof === 'object') {
    candidates.push({ source: 'final_product_proof.data_plane_proof', proof: productProof.data_plane_proof });
  }
  for (const [id, row] of Object.entries(rows || {})) {
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

function dataPlaneProofFromRows(rows) {
  return dataPlaneProofFromProductProof(null, rows);
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

function rowDefersExactProof(row) {
  if (row?.deferred_exact_proof === true) return true;
  const evidence = row?.evidence || {};
  if (evidence?.active_drain_block?.blocked_by_active_embedding_drain === true) return true;
  if (evidence?.active_drain_block?.exact_ann_proof_deferred === true) return true;
  if (evidence?.data_plane_proof?.active_drain_block?.blocked_by_active_embedding_drain === true) return true;
  if (evidence?.blocked_by_active_embedding_drain === true) return true;
  return /active embedding drain|proof n\/a|exact proof n\/a|exact_ann_proof_deferred/i.test(
    `${row?.detail || ''} ${evidence?.active_drain_block?.next_action || ''}`,
  );
}

function postDrainReadinessEvidence({ db, hold, postDrain, postDrainAge, handoff, handoffReady }) {
  const readiness = postDrain?.readiness || null;
  if (!readiness) return null;
  const watcherPending = Number(readiness.pending_embeddings);
  const livePending = db?.ok ? Number(db.chunks.pending || 0) : null;
  const pendingDelta = Number.isFinite(watcherPending) && Number.isFinite(livePending)
    ? Math.abs(watcherPending - livePending)
    : null;
  const watcherAnyHold = readiness.active_embed_hold || readiness.active_embed_drain_hold || null;
  const watcherDrainHold = readiness.active_embed_drain_hold || null;
  const watcherHoldPid = Number(watcherAnyHold?.pid || 0);
  const liveHoldPid = Number(hold?.pid || 0);
  const watcherHoldAlive = watcherHoldPid > 0 ? processAlive(watcherHoldPid) : false;
  const watcherHandoffStatus = readiness.handoff_status || null;
  const liveHandoffStatus = handoff?.status || null;
  const handoffStatus = liveHandoffStatus || watcherHandoffStatus;
  const draining = Number.isFinite(livePending) && livePending > 0;
  const stalePreviousHandoff = draining && handoffStatus !== null;
  const staleReadyHandoff = stalePreviousHandoff && handoffStatus === 'ready_for_reclassify';
  const handoffLaunchdClearance = readiness.handoff_launchd_clearance || null;
  return {
    ...readiness,
    handoff_status: handoffStatus,
    handoff_ready_evidence: handoffReady || null,
    watcher_handoff_status: watcherHandoffStatus,
    live_handoff_status: liveHandoffStatus,
    snapshot_age_ms: postDrainAge,
    watcher_pending_embeddings: Number.isFinite(watcherPending) ? watcherPending : null,
    live_pending_embeddings: Number.isFinite(livePending) ? livePending : null,
    pending_delta_from_live: pendingDelta,
    authoritative_pending_source: 'live_db',
    watcher_active_embed_hold: watcherAnyHold,
    watcher_active_embed_drain_hold: watcherDrainHold,
    watcher_hold_pid: watcherHoldPid || null,
    watcher_hold_process_alive: watcherHoldAlive,
    live_hold_pid: liveHoldPid || null,
    live_hold_active: hold?.active === true,
    hold_delta_from_live: watcherHoldPid > 0 && liveHoldPid > 0 ? watcherHoldPid !== liveHoldPid : null,
    authoritative_hold_source: 'live_hold',
    handoff_stale_previous_run: stalePreviousHandoff,
    handoff_stale_ready_marker: staleReadyHandoff,
    effective_handoff_status: stalePreviousHandoff ? 'ignored_while_draining' : handoffStatus,
    effective_handoff_launchd_clearance: stalePreviousHandoff
      ? { ok: true, ignored: true, reason: 'ignored_while_draining' }
      : handoffLaunchdClearance,
    authoritative_handoff_source: stalePreviousHandoff ? 'live_db_pending' : (liveHandoffStatus ? 'handoff_file' : 'watcher_snapshot'),
  };
}

function handoffReadyEvidence(handoff) {
  const failures = [];
  const checkedAge = ageMs(handoff?.checked_at);
  if (handoff?.ok !== true) failures.push('handoff ok flag is not true');
  if (handoff?.status !== 'ready_for_reclassify') failures.push('handoff status is not ready_for_reclassify');
  if (handoff?.child_ok !== true) failures.push('handoff child_ok flag is not true');
  if (Number(handoff?.pending_embeddings) !== 0) failures.push('handoff pending embeddings is not zero');
  if (handoff?.pending_count_error) failures.push(`handoff pending count error: ${handoff.pending_count_error}`);
  if (checkedAge === null) {
    failures.push('handoff checked_at is missing or invalid');
  } else if (checkedAge > MAX_READY_HANDOFF_AGE_MS) {
    failures.push(`handoff ready marker is stale (${checkedAge}ms > ${MAX_READY_HANDOFF_AGE_MS}ms)`);
  }
  return {
    ok: failures.length === 0,
    status: handoff?.status || null,
    checked_at: handoff?.checked_at || null,
    age_ms: checkedAge,
    max_age_ms: MAX_READY_HANDOFF_AGE_MS,
    failures,
  };
}

function postDrainLockEvidence({ watcher }) {
  const present = existsSync(POST_DRAIN_LOCK_FILE);
  const lock = readJson(POST_DRAIN_LOCK_FILE);
  const ownerPid = Number(lock?.pid || 0);
  const watcherPid = Number(watcher?.pid || 0);
  const ownerAlive = ownerPid > 0 ? processAlive(ownerPid) : false;
  const ownerMatchesWatcher = ownerPid > 0 && watcherPid > 0 ? ownerPid === watcherPid : null;
  return {
    path: POST_DRAIN_LOCK_FILE,
    present,
    owner_pid: ownerPid || null,
    owner_process_alive: ownerAlive,
    owner_started_at: lock?.started_at || null,
    watcher_pid: watcherPid || null,
    owner_matches_watcher: ownerMatchesWatcher,
  };
}

function postDrainRunnerCodeEvidence({ postDrain }) {
  const diskSha256 = fileSha256(POST_DRAIN_RUNNER_FILE);
  const reportedSha256 = postDrain?.runner_code?.sha256 || null;
  return {
    path: POST_DRAIN_RUNNER_FILE,
    reported_path: postDrain?.runner_code?.path || null,
    disk_sha256: diskSha256,
    reported_sha256: reportedSha256,
    reported: Boolean(reportedSha256),
    matches_disk: Boolean(diskSha256 && reportedSha256 && diskSha256 === reportedSha256),
  };
}

function postDrainCommandHashEvidence(commands, requiredRels = []) {
  const items = Array.isArray(commands) ? commands : [];
  const seen = new Set(items.map((item) => String(item?.rel || '')).filter(Boolean));
  const checked = items.map((item) => {
    const rel = String(item?.rel || '');
    const currentSha256 = rel ? fileSha256(resolve(REPO_ROOT, rel)) : null;
    const recordedSha256 = item?.sha256 || null;
    return {
      rel,
      exists: item?.exists === true,
      recorded_sha256: recordedSha256,
      current_sha256: currentSha256,
      matches_disk: Boolean(recordedSha256 && currentSha256 && recordedSha256 === currentSha256),
    };
  });
  const missingHashes = checked.filter((item) => item.exists && !item.recorded_sha256).map((item) => item.rel);
  const missingCurrent = checked.filter((item) => item.exists && !item.current_sha256).map((item) => item.rel);
  const mismatches = checked.filter((item) => item.recorded_sha256 && item.current_sha256 && item.recorded_sha256 !== item.current_sha256).map((item) => item.rel);
  const missingRequired = requiredRels.filter((rel) => !seen.has(rel));
  return {
    checked,
    ok: checked.length > 0
      && missingRequired.length === 0
      && missingHashes.length === 0
      && missingCurrent.length === 0
      && mismatches.length === 0,
    required: [...requiredRels],
    missing_required: missingRequired,
    missing_hashes: missingHashes,
    missing_current: missingCurrent,
    mismatches,
  };
}

function postDrainPreflightEvidence() {
  const evidence = readJson(POST_DRAIN_PREFLIGHT_FILE);
  const diskSha256 = fileSha256(POST_DRAIN_PREFLIGHT_SCRIPT);
  const reportedSha256 = evidence?.script?.sha256 || null;
  const checkedAge = ageMs(evidence?.checked_at);
  const present = evidence && typeof evidence === 'object';
  const commands = Array.isArray(evidence?.post_drain_commands) ? evidence.post_drain_commands : [];
  const dependencies = Array.isArray(evidence?.post_drain_dependencies) ? evidence.post_drain_dependencies : [];
  const commandHashes = postDrainCommandHashEvidence(commands, REQUIRED_POST_DRAIN_PREFLIGHT_COMMANDS);
  const dependencyHashes = postDrainCommandHashEvidence(dependencies, REQUIRED_POST_DRAIN_PREFLIGHT_DEPENDENCIES);
  return {
    path: POST_DRAIN_PREFLIGHT_FILE,
    present: Boolean(present),
    ok: present ? evidence.ok === true : false,
    read_only: present ? evidence.read_only === true : false,
    checked_at: evidence?.checked_at || null,
    age_ms: checkedAge,
    max_age_ms: MAX_PREFLIGHT_AGE_MS,
    fresh: checkedAge !== null && checkedAge <= MAX_PREFLIGHT_AGE_MS,
    script_sha256: reportedSha256,
    disk_sha256: diskSha256,
    script_matches_disk: reportedSha256 && diskSha256 ? reportedSha256 === diskSha256 : null,
    backup: evidence?.backup || null,
    gcloud: evidence?.gcloud || null,
    db_snapshots: Array.isArray(evidence?.db_snapshots) ? evidence.db_snapshots : [],
    post_drain_commands: commands,
    post_drain_dependencies: dependencies,
    global_ann_source_projection: evidence?.global_ann_source_projection || null,
    topic_context_projection: evidence?.topic_context_projection || null,
    backup_dispatcher_projection: evidence?.backup_dispatcher_projection || null,
    reclassify_projection: evidence?.reclassify_projection || null,
    memory_refocus_projection: evidence?.memory_refocus_projection || null,
    command_hashes: commandHashes,
    dependency_hashes: dependencyHashes,
    failures: Array.isArray(evidence?.failures) ? evidence.failures : [],
  };
}

const DEFERRABLE_PREFLIGHT_ANN_RACE_FAILURES = Object.freeze([
  'post-drain preflight ANN source projection is not ok',
  'post-drain preflight ANN source projection has missing vectors',
  'post-drain preflight ANN source readable count does not match embedded count',
]);
const DEFERRABLE_PREFLIGHT_MEMORY_PROJECTION_FAILURES = Object.freeze([
  'post-drain preflight memory refocus projection not ok',
  'post-drain preflight memory refocus projection does not clear unresolved links below threshold',
]);
const DEFERRABLE_PREFLIGHT_AGGREGATE_FAILURES = Object.freeze([
  'post-drain preflight evidence is not ok',
  'post-drain preflight reported failures or did not report failure list',
]);

function isDeferrablePreflightAnnRaceFailure(failure) {
  return DEFERRABLE_PREFLIGHT_ANN_RACE_FAILURES.includes(String(failure || ''));
}

function activeDrainCanDeferPreflightAnnRace(preflight) {
  if (!preflight?.present) return false;
  const rawFailures = Array.isArray(preflight.failures) ? preflight.failures : [];
  if (!rawFailures.some((failure) => /^global ANN source projection is missing \d+ vectors?$/.test(String(failure || '')))) return false;
  const projection = preflight.global_ann_source_projection || {};
  const missingVectors = Number(projection.missing_vectors || 0);
  const malformedRows = Number(projection.malformed_rows || 0);
  return missingVectors > 0
    && malformedRows === 0;
}

function activeDrainCanDeferPreflightMemoryProjection({ preflight, db }) {
  if (!preflight?.present || db?.ok !== true) return false;
  const rawFailures = Array.isArray(preflight.failures) ? preflight.failures : [];
  if (!rawFailures.some((failure) => /^memory refocus projection leaves \d+ unresolved links above threshold \d+$/.test(String(failure || '')))) return false;
  const memoryProjection = preflight.memory_refocus_projection || {};
  const memoryDryRun = memoryProjection.projection || {};
  const after = Number(memoryDryRun.after_current_needs_routing_links);
  const threshold = Number(memoryProjection.threshold);
  const liveCurrent = Number(db.needs_routing?.current_memory_links);
  return memoryProjection.read_only === true
    && memoryDryRun.ok === true
    && memoryDryRun.applied === false
    && memoryDryRun.partial === false
    && Number.isFinite(after)
    && Number.isFinite(threshold)
    && after > threshold
    && Number.isFinite(liveCurrent)
    && liveCurrent <= MAX_POST_DRAIN_NEEDS_ROUTING_MEMORY;
}

function activeDrainRawPreflightFailuresAreDeferrable({ preflight, annRace, memoryProjection }) {
  const rawFailures = Array.isArray(preflight?.failures) ? preflight.failures : [];
  if (rawFailures.length === 0) return false;
  return rawFailures.every((failure) => {
    const text = String(failure || '');
    if (annRace && /^global ANN source projection is missing \d+ vectors?$/.test(text)) return true;
    if (memoryProjection && /^memory refocus projection leaves \d+ unresolved links above threshold \d+$/.test(text)) return true;
    return false;
  });
}

function postDrainPreflightAnnSourceFreshness({ preflight, liveEmbedded }) {
  const projection = preflight?.global_ann_source_projection || null;
  const live = Number(liveEmbedded);
  const projected = Number(projection?.embedded_total);
  const lag = Number.isFinite(live) && Number.isFinite(projected)
    ? Math.max(0, live - projected)
    : null;
  return {
    present: preflight?.present === true && Boolean(projection),
    projection_ok: projection?.ok === true,
    live_embedded: Number.isFinite(live) ? live : null,
    preflight_embedded: Number.isFinite(projected) ? projected : null,
    lag_chunks: lag,
    max_lag_chunks: MAX_PREFLIGHT_ANN_SOURCE_LAG,
    within_lag: lag === null ? null : lag <= MAX_PREFLIGHT_ANN_SOURCE_LAG,
  };
}

function globalAnnSourceProjectionWarningDetail({ projection, freshness }) {
  if (!projection) return 'source projection is unavailable';
  const embedded = Number(projection.embedded_total);
  const missing = Number(projection.missing_vectors || 0);
  const malformed = Number(projection.malformed_rows || 0);
  const lag = Number(freshness?.lag_chunks);
  const details = [
    Number.isFinite(embedded) ? `embedded=${embedded}` : null,
    `missing=${missing}`,
    `malformed=${malformed}`,
    Number.isFinite(lag) ? `lag=${lag}` : null,
    projection.error ? `error=${projection.error}` : null,
  ].filter(Boolean).join(' ');
  const clean = projection.ok === true && missing === 0 && malformed === 0;
  if (clean) {
    return `source projection is clean (${details})`;
  }
  return `source projection is not clean (${details})`;
}

function processCodeFreshnessEvidence({ label, scriptPath, pid }) {
  const processStartedMs = processStartMs(pid);
  let scriptMtimeMs = null;
  try { scriptMtimeMs = statSync(scriptPath).mtimeMs; } catch {}
  const current = Number.isFinite(processStartedMs)
    && Number.isFinite(scriptMtimeMs)
    && processStartedMs >= scriptMtimeMs - 1000;
  return {
    label,
    path: scriptPath,
    pid: Number(pid) || null,
    process_started_at: Number.isFinite(processStartedMs) ? new Date(processStartedMs).toISOString() : null,
    script_mtime: Number.isFinite(scriptMtimeMs) ? new Date(scriptMtimeMs).toISOString() : null,
    current,
  };
}

function processDependencyFreshnessEvidence({ label, paths, pid }) {
  const processStartedMs = processStartMs(pid);
  const files = paths.map((path) => {
    let mtimeMs = null;
    try { mtimeMs = statSync(path).mtimeMs; } catch {}
    return {
      path,
      mtime: Number.isFinite(mtimeMs) ? new Date(mtimeMs).toISOString() : null,
      stale: Number.isFinite(processStartedMs) && Number.isFinite(mtimeMs)
        ? processStartedMs < mtimeMs - 1000
        : true,
    };
  });
  const staleFiles = files.filter((file) => file.stale).map((file) => file.path);
  return {
    label,
    pid: Number(pid) || null,
    process_started_at: Number.isFinite(processStartedMs) ? new Date(processStartedMs).toISOString() : null,
    current: staleFiles.length === 0,
    stale_files: staleFiles,
    files,
  };
}

function phaseFor({ db, postDrain, handoffReady, completionEvidence }) {
  if (completionEvidence?.claimed && completionEvidence.ok) return 'complete';
  if (completionEvidence?.claimed && !completionEvidence.ok) return 'failed';
  if (['failed', 'blocked_by_lock'].includes(postDrain?.status)) return 'failed';
  if (!db.ok) return 'unknown';
  if (db.chunks.pending > 0) return 'draining';
  if (postDrain?.status === 'running') return 'post_drain_running';
  if (handoffReady?.ok === true) return 'post_drain_ready';
  return 'post_drain_waiting';
}

function launchContractStep(id, label, status, detail, evidence = {}) {
  return { id, label, status, detail, evidence };
}

function postDrainStepContract({ id, label, evidence, failures, pendingDetail, okDetail, preconditions = [] }) {
  const evidenceAttempted = evidenceObjectPresent(evidence);
  const attempted = evidenceAttempted || preconditions.some((check) => check.present);
  const preconditionFailures = [];
  const missing = preconditions.filter((check) => !check.present).map((check) => check.missing);
  for (const check of preconditions) {
    if (check.present || evidenceAttempted) preconditionFailures.push(...check.failures);
  }
  if (preconditionFailures.length > 0) {
    return launchContractStep(id, label, 'blocked', preconditionFailures[0], {
      attempted,
      missing,
      failures: preconditionFailures,
    });
  }
  if (!evidenceAttempted) return launchContractStep(id, label, 'pending', pendingDetail, { attempted, missing });
  if (failures.length > 0) return launchContractStep(id, label, 'blocked', failures[0], { attempted: true, failures });
  return launchContractStep(id, label, 'ok', okDetail, { attempted: true });
}

function evidenceObjectPresent(evidence) {
  return evidence && typeof evidence === 'object' && Object.keys(evidence).length > 0;
}

function postDrainEmbedHoldAcquireFailures(postDrain) {
  const failures = [];
  const hold = postDrain?.post_drain_embed_hold || {};
  if (hold?.ok !== true) failures.push('post-drain embed writer hold was not acquired');
  if (hold?.hold_reason !== 'post_drain_pipeline_sole_writer') {
    failures.push('post-drain embed writer hold reason is not post_drain_pipeline_sole_writer');
  }
  return failures;
}

function backlogZeroCheck(evidence, label) {
  return {
    present: evidenceObjectPresent(evidence),
    failures: evidence?.ok === true && Number(evidence?.pending_embeddings || -1) === 0
      ? []
      : [`${label} evidence is missing or not zero`],
  };
}

function sourceQuiescenceCheck(evidence, label) {
  return {
    present: evidenceObjectPresent(evidence),
    failures: evidence?.ok === true && Number(evidence?.active_running || -1) === 0
      ? []
      : [`${label} proof is missing or not quiet`],
  };
}

function okCheck(evidence, label) {
  return {
    present: evidenceObjectPresent(evidence),
    failures: evidence?.ok === true ? [] : [`${label} proof is missing or not ok`],
  };
}

function groupedGateContract({ id, label, checks, completeClaimed, pendingDetail, okDetail }) {
  const attempted = checks.some((check) => check.present);
  const missing = checks.filter((check) => !check.present).map((check) => check.missing);
  const failures = [];
  for (const check of checks) {
    if (check.present || completeClaimed) failures.push(...check.failures);
  }
  if (failures.length > 0) {
    return launchContractStep(id, label, 'blocked', failures[0], { attempted, missing, failures });
  }
  if (missing.length > 0) {
    return launchContractStep(id, label, 'pending', pendingDetail, { attempted, missing });
  }
  return launchContractStep(id, label, 'ok', okDetail, { attempted: true });
}

function launchContractEvidence({
  db,
  postDrain,
  postDrainPreflight,
  postDrainPreflightBlockingFailures,
  postDrainPreflightDeferredAnnRace,
  postDrainPreflightDeferredMemoryProjection,
  postDrainPreflightAnnSource,
  globalAnn,
  finalProductProof,
  liveProgress,
  hold,
  services,
  activeEmbeddingDrain,
  drainRespawnGrace,
}) {
  const pending = Number(db?.chunks?.pending || 0);
  const completeClaimed = postDrain?.status === 'complete';
  const waitingForDrain = pending > 0
    ? `waiting for embedding drain to reach zero (${pending} pending)`
    : 'waiting for post-drain runner evidence';
  const steps = [];
  const workOrderBlocked = db?.ok === true && pending > 0 && Number(db.work_order?.selectable_pending || 0) !== pending;
  const workOrderHeadBlocked = db?.ok === true
    && Number(db.work_order?.selectable_pending || 0) > 0
    && (db.work_order?.head?.ok !== true || !db.work_order?.head?.topics?.length);
  const drainMissing = pending > 0 && (
    hold?.active !== true
      || hold?.reason !== 'drain_personal_embeddings_sole_writer'
      || hold?.process_alive !== true
      || services?.drain_wrapper?.process_alive !== true
      || liveProgress?.ok !== true
  ) && drainRespawnGrace?.ok !== true;
  const drainDetail = (() => {
    if (db?.ok !== true) return `database unreadable: ${db?.error || 'unknown'}`;
    if (workOrderBlocked) return `embedding work-order cannot select ${db.work_order?.blocked_pending ?? 'unknown'} pending chunks`;
    if (workOrderHeadBlocked) return 'embedding work-order has pending chunks but no ordered head';
    if (drainRespawnGrace?.ok === true) return 'guarded drain is in bounded respawn grace; waiting for sole-writer hold to reappear';
    if (drainMissing) return 'embedding drain supervision is incomplete';
    if (pending > 0) return `draining ${pending} pending chunks; work-order head is ${db.work_order?.head?.topics?.[0]?.topic || 'unknown'}`;
    return 'embedding backlog is zero';
  })();
  steps.push(launchContractStep(
    'drain_personal_backlog',
    'Drain Personal backlog',
    db?.ok !== true || workOrderBlocked || workOrderHeadBlocked || drainMissing ? 'blocked' : pending > 0 ? 'pending' : 'ok',
    drainDetail,
    {
      pending,
      personal_pending: db?.personal?.pending ?? null,
      non_personal_pending: db?.non_personal_pending ?? null,
      work_order_head: db?.work_order?.head?.topics?.[0]?.topic || null,
      yielding_to_foreground: liveProgress?.yielding_to_foreground === true,
    },
  ));
  steps.push(groupedGateContract({
    id: 'post_drain_writer_quiescence',
    label: 'Acquire writer hold and quiet sources',
    completeClaimed,
    pendingDetail: waitingForDrain,
    okDetail: 'post-drain writer hold is acquired, sources are quiet, and backlog stayed zero before backup',
    checks: [
      {
        present: evidenceObjectPresent(postDrain?.post_drain_embed_hold),
        missing: 'post-drain embed writer hold',
        failures: postDrainEmbedHoldAcquireFailures(postDrain),
      },
      {
        present: evidenceObjectPresent(postDrain?.chunk_source_quiescence),
        missing: 'chunk source quiescence proof',
        failures: postDrain?.chunk_source_quiescence?.ok === true && Number(postDrain?.chunk_source_quiescence?.active_running || -1) === 0
          ? []
          : ['chunk source quiescence proof is missing or not quiet'],
      },
      {
        ...backlogZeroCheck(postDrain?.pre_backup_backlog_check, 'pre-backup backlog check'),
        missing: 'pre-backup backlog zero check',
      },
    ],
  }));
  steps.push(groupedGateContract({
    id: 'backup_slot_clearance',
    label: 'Clear backup slots',
    completeClaimed,
    pendingDetail: waitingForDrain,
    okDetail: 'preflight and backup slots were clear before backup work ran',
    checks: [
      {
        ...okCheck(postDrain?.preflight_backup_slot, 'preflight backup slot clearance'),
        missing: 'preflight backup slot clearance',
      },
      {
        ...okCheck(postDrain?.backup_slot, 'backup slot clearance'),
        missing: 'backup slot clearance',
      },
    ],
  }));
  const preflightSourceLagging = postDrainPreflightAnnSource?.present === true
    && postDrainPreflightAnnSource.within_lag === false;
  const preflightStatus = postDrainPreflight?.present !== true
    ? 'pending'
    : postDrainPreflightBlockingFailures.length > 0
      ? 'blocked'
    : postDrainPreflightDeferredAnnRace
      ? 'pending'
    : postDrainPreflightDeferredMemoryProjection
      ? 'pending'
    : activeEmbeddingDrain
      ? 'pending'
      : preflightSourceLagging
        ? 'blocked'
          : 'ok';
  const preflightDetail = postDrainPreflight?.present !== true
    ? 'preflight evidence has not been recorded'
    : postDrainPreflightBlockingFailures[0]
      || (postDrainPreflightDeferredAnnRace
        ? 'preflight ANN-source projection has an active-drain vector race; rerun at zero'
        : null)
      || (postDrainPreflightDeferredMemoryProjection
        ? 'preflight memory-refocus projection is post-drain-only while active drain continues; rerun at zero'
        : null)
      || (preflightSourceLagging
        ? `preflight ANN-source projection lags live embedded chunks by ${postDrainPreflightAnnSource.lag_chunks ?? 'unknown'}; rerun at zero`
        : null)
      || (activeEmbeddingDrain
        ? 'preflight evidence is clean but drain is still active; rerun at zero'
        : 'preflight projections are valid');
  steps.push(launchContractStep(
    'post_drain_preflight',
    'Post-drain preflight',
    preflightStatus,
    preflightDetail,
    {
      present: postDrainPreflight?.present === true,
      failures: postDrainPreflightBlockingFailures,
      ann_source_freshness: postDrainPreflightAnnSource || null,
    },
  ));
  steps.push(postDrainStepContract({
    id: 'backup_live_dbs',
    label: 'Back up live DBs',
    evidence: postDrain?.gcs_backup,
    preconditions: [
      {
        ...sourceQuiescenceCheck(postDrain?.pre_gcs_backup_source_quiescence, 'pre-GCS-backup source quiescence'),
        missing: 'pre-GCS-backup source quiescence',
      },
      {
        ...backlogZeroCheck(postDrain?.pre_gcs_backup_backlog_check, 'pre-GCS-backup backlog check'),
        missing: 'pre-GCS-backup backlog zero check',
      },
    ],
    failures: backupEvidenceFailures(postDrain?.gcs_backup),
    pendingDetail: waitingForDrain,
    okDetail: 'strict clone-snapshot backup uploaded and verified',
  }));
  steps.push(postDrainStepContract({
    id: 'reclassify_chunks',
    label: 'Reclassify chunks',
    evidence: postDrain?.reclassify?.last,
    preconditions: [
      {
        ...sourceQuiescenceCheck(postDrain?.pre_reclassify_source_quiescence, 'pre-reclassify source quiescence'),
        missing: 'pre-reclassify source quiescence',
      },
      {
        ...backlogZeroCheck(postDrain?.pre_reclassify_backlog_check, 'pre-reclassify backlog check'),
        missing: 'pre-reclassify backlog zero check',
      },
    ],
    failures: reclassifyEvidenceFailures(postDrain?.reclassify?.last),
    pendingDetail: waitingForDrain,
    okDetail: 'global reclassification completed with context regeneration deferred',
  }));
  steps.push(postDrainStepContract({
    id: 'split_vector_repair',
    label: 'Repair split vectors',
    evidence: postDrain?.split_vec_orphan_repair_after_reclassify,
    failures: [
      ...splitVectorRepairEvidenceFailures(postDrain?.split_vec_orphan_repair_after_reclassify),
      ...splitVectorParityEvidenceFailures(postDrain?.vec_orphan_check_after_reclassify),
    ],
    pendingDetail: waitingForDrain,
    okDetail: 'moved chunks retain vectors and stale vector rows are pruned',
  }));
  steps.push(postDrainStepContract({
    id: 'source_topic_metadata_repair',
    label: 'Repair source topic metadata',
    evidence: postDrain?.source_topic_metadata_repair,
    failures: sourceTopicMetadataRepairFailures(postDrain?.source_topic_metadata_repair),
    pendingDetail: waitingForDrain,
    okDetail: 'source metadata no longer points resolvable rows at Personal',
  }));
  steps.push(postDrainStepContract({
    id: 'topic_context_regen',
    label: 'Regenerate topic contexts',
    evidence: postDrain?.topic_contexts,
    preconditions: [
      {
        ...sourceQuiescenceCheck(postDrain?.pre_topic_context_source_quiescence, 'pre-topic-context source quiescence'),
        missing: 'pre-topic-context source quiescence',
      },
      {
        ...backlogZeroCheck(postDrain?.pre_topic_context_backlog_check, 'pre-topic-context backlog check'),
        missing: 'pre-topic-context backlog zero check',
      },
    ],
    failures: topicContextEvidenceFailures(postDrain?.topic_contexts, 'topic context regeneration'),
    pendingDetail: waitingForDrain,
    okDetail: 'affected topic context files were regenerated',
  }));
  steps.push(postDrainStepContract({
    id: 'global_ann_rebuild',
    label: 'Rebuild global ANN',
    evidence: postDrain?.global_hnsw_rebuild,
    preconditions: [
      {
        ...sourceQuiescenceCheck(postDrain?.pre_global_hnsw_source_quiescence, 'pre-global-HNSW source quiescence'),
        missing: 'pre-global-HNSW source quiescence',
      },
      {
        ...backlogZeroCheck(postDrain?.pre_global_hnsw_backlog_check, 'pre-global-HNSW backlog check'),
        missing: 'pre-global-HNSW backlog zero check',
      },
    ],
    failures: globalHnswEvidenceFailures(postDrain?.global_hnsw_rebuild),
    pendingDetail: globalAnn?.ready === true
      ? 'current ANN is ready; post-drain rebuild evidence is still pending'
      : `retrieval is degraded (${globalAnn?.reason || globalAnn?.state || 'unknown'}); post-drain rebuild pending`,
    okDetail: 'global ANN rebuild completed with a valid sidecar',
  }));
  steps.push(postDrainStepContract({
    id: 'memory_routing_repair',
    label: 'Repair memory routing',
    evidence: postDrain?.memory_routing_repair,
    failures: memoryRoutingRepairFailures(postDrain?.memory_routing_repair),
    pendingDetail: waitingForDrain,
    okDetail: 'fallback memory routing residue was repaired',
  }));
  steps.push(postDrainStepContract({
    id: 'memory_refocus',
    label: 'Refocus needs-routing memory',
    evidence: postDrain?.memory_refocus?.last,
    failures: memoryRefocusEvidenceFailures(postDrain?.memory_refocus?.last),
    pendingDetail: waitingForDrain,
    okDetail: 'needs-routing memory links were refocused below threshold',
  }));
  steps.push(postDrainStepContract({
    id: 'memory_recalc',
    label: 'Recalculate memory projections',
    evidence: postDrain?.memory_recalc,
    failures: memoryRecalcEvidenceFailures(postDrain?.memory_recalc),
    pendingDetail: waitingForDrain,
    okDetail: 'memory projections were regenerated globally',
  }));
  steps.push(postDrainStepContract({
    id: 'post_memory_topic_context_regen',
    label: 'Regenerate post-memory contexts',
    evidence: postDrain?.post_memory_topic_contexts,
    preconditions: [
      {
        ...sourceQuiescenceCheck(postDrain?.pre_post_memory_topic_context_source_quiescence, 'pre-post-memory-topic-context source quiescence'),
        missing: 'pre-post-memory-topic-context source quiescence',
      },
      {
        ...backlogZeroCheck(postDrain?.pre_post_memory_topic_context_backlog_check, 'pre-post-memory-topic-context backlog check'),
        missing: 'pre-post-memory-topic-context backlog zero check',
      },
    ],
    failures: topicContextEvidenceFailures(postDrain?.post_memory_topic_contexts, 'post-memory topic context'),
    pendingDetail: waitingForDrain,
    okDetail: 'topic contexts reflect post-memory projection changes',
  }));
  steps.push(postDrainStepContract({
    id: 'routing_residue_audit',
    label: 'Audit Personal and needs-routing residue',
    evidence: postDrain?.routing_residue_audit,
    preconditions: [
      {
        ...sourceQuiescenceCheck(postDrain?.pre_routing_audit_source_quiescence, 'pre-routing-audit source quiescence'),
        missing: 'pre-routing-audit source quiescence',
      },
      {
        ...backlogZeroCheck(postDrain?.pre_routing_audit_backlog_check, 'pre-routing-audit backlog check'),
        missing: 'pre-routing-audit backlog zero check',
      },
    ],
    failures: routingResidueEvidenceFailures(postDrain?.routing_residue_audit),
    pendingDetail: waitingForDrain,
    okDetail: 'Personal and needs-routing residue are within launch thresholds',
  }));
  steps.push(groupedGateContract({
    id: 'final_writer_release_and_backlog',
    label: 'Release writer hold and prove final backlog',
    completeClaimed,
    pendingDetail: waitingForDrain,
    okDetail: 'post-drain writer hold was released and backlog stayed zero after final proof',
    checks: [
      {
        present: evidenceObjectPresent(postDrain?.post_drain_embed_hold_release),
        missing: 'post-drain embed writer hold release',
        failures: postDrain?.post_drain_embed_hold_release?.ok === true && postDrain?.post_drain_embed_hold_release?.skipped !== true
          ? []
          : ['post-drain embed writer hold was not released by its owner'],
      },
      {
        ...backlogZeroCheck(postDrain?.final_backlog_check, 'final backlog check'),
        missing: 'final backlog zero check',
      },
      {
        ...sourceQuiescenceCheck(postDrain?.post_product_proof_source_quiescence, 'post-product-proof source quiescence'),
        missing: 'post-product-proof source quiescence',
      },
      {
        ...backlogZeroCheck(postDrain?.post_product_proof_backlog_check, 'post-product-proof backlog check'),
        missing: 'post-product-proof backlog zero check',
      },
    ],
  }));
  steps.push(launchContractStep(
    'final_product_proof',
    'Final product retrieval proof',
    finalProductProof?.ok === true
      ? 'ok'
      : postDrain?.final_product_proof
        ? 'blocked'
        : 'pending',
    finalProductProof?.ok === true
      ? 'launch stoplight proof rows are green and durable'
      : postDrain?.final_product_proof
        ? finalProductProof?.failures?.[0] || 'final product proof failed'
        : waitingForDrain,
    {
      required_rows: finalProductProof?.required_rows || FINAL_PRODUCT_PROOF_ROWS,
      failures: finalProductProof?.failures || [],
    },
  ));
  const counts = steps.reduce((acc, step) => {
    acc[step.status] = (acc[step.status] || 0) + 1;
    return acc;
  }, { ok: 0, pending: 0, blocked: 0 });
  const status = counts.blocked > 0 ? 'blocked' : counts.pending > 0 ? 'pending' : 'ok';
  const next = steps.find((step) => step.status === 'blocked') || steps.find((step) => step.status === 'pending') || null;
  return {
    status,
    ok: status === 'ok',
    counts,
    next_step: next ? {
      id: next.id,
      label: next.label,
      status: next.status,
      detail: next.detail,
    } : null,
    steps,
  };
}

async function buildReport({ fastSummary = false } = {}) {
  const launchd = launchdRows();
  const db = await dbEvidence();
  const globalAnn = globalAnnEvidence({ liveEmbedded: db?.chunks?.embedded });
  const hold = await embedHoldEvidence();
  const postDrain = readJson(POST_DRAIN_STATUS_FILE);
  const handoff = readJson(HANDOFF_FILE);
  const stoplight = stoplightEvidence();
  const disk = diskEvidence();
  const drainLog = drainLogEvidence();
  const liveProgress = liveDrainProgress({ db, drainLog });
  const effectiveEta = effectiveEtaEvidence({ liveProgress, stoplight });
  const drainTrend = drainTrendEvidence({ db });
  const systemMemory = systemMemoryEvidence();
  const drainIntensity = drainIntensityEvidence({ hold, disk, systemMemory, liveProgress });
  const drainRequestedLanes = drainRequestedLanesEvidence({ drainLog });
  const services = {
    drain_wrapper: launchdEvidence(launchd, DRAIN_LABEL),
    post_drain_watcher: launchdEvidence(launchd, POST_DRAIN_LABEL),
    embed_daemon: launchdEvidence(launchd, DAEMON_LABEL),
  };
  const postDrainLock = postDrainLockEvidence({ watcher: services.post_drain_watcher });
  const postDrainRunnerCode = postDrainRunnerCodeEvidence({ postDrain });
  const postDrainPreflight = postDrainPreflightEvidence();
  const drainCodeFreshness = {
    wrapper: processCodeFreshnessEvidence({
      label: 'embedding drain wrapper',
      scriptPath: DRAIN_WRAPPER_FILE,
      pid: services.drain_wrapper.pid,
    }),
    worker: processCodeFreshnessEvidence({
      label: 'embedding drain worker',
      scriptPath: DRAIN_WORKER_FILE,
      pid: hold.pid,
    }),
  };
  const embedDaemonCodeFreshness = processDependencyFreshnessEvidence({
    label: 'resident embed daemon',
    paths: EMBED_DAEMON_FILES,
    pid: services.embed_daemon.pid,
  });
  const postDrainAge = ageMs(postDrain?.updated_at);
  const watcherStatusFresh = postDrainAge !== null && postDrainAge <= MAX_WATCHER_STATUS_AGE_MS;
  const handoffReady = handoffReadyEvidence(handoff);
  const postDrainReadiness = postDrainReadinessEvidence({ db, hold, postDrain, postDrainAge, handoff, handoffReady });
  const completionEvidence = postDrainCompletionEvidence({ db, postDrain, handoff });
  const phase = phaseFor({ db, postDrain, handoffReady, completionEvidence });
  const completionCandidate = phase === 'complete';
  const finalProductProof = finalProductProofEvidence({ stoplight, postDrain });
  const activeEmbeddingDrain = phase === 'draining';
  const requestedDrainLanes = Number(drainRequestedLanes?.count);
  const liveDrainLaneCount = Number(drainIntensity?.lane_count);
  const effectiveDrainCapacity = effectiveDrainCapacityEvidence({
    activeEmbeddingDrain,
    requestedLanes: requestedDrainLanes,
    drainIntensity,
    hold,
    liveProgress,
  });
  const drainRespawnGrace = guardedDrainRespawnGraceEvidence({
    activeEmbeddingDrain,
    db,
    hold,
    services,
    liveProgress,
    drainLog,
  });
  const drainCapacityBelowRequested = activeEmbeddingDrain
    && liveProgress?.yielding_to_foreground !== true
    && effectiveDrainCapacity.ok === false;
  const staleVectorProjection = fastSummary && activeEmbeddingDrain
    ? await staleVectorShapeEvidence()
    : await staleVectorProjectionEvidence();
  const splitVectorRepairEvidencePresent = postDrain?.split_vec_orphan_repair_after_reclassify
    && typeof postDrain.split_vec_orphan_repair_after_reclassify === 'object';
  const splitVectorRepairAlreadyRan = splitVectorRepairEvidencePresent
    || (Array.isArray(postDrain?.step_history)
      && postDrain.step_history.some((step) => step?.id === 'split_vec_orphan_repair_after_reclassify'));
  const staleVectorsShouldBlock = Number(staleVectorProjection?.stale_vectors || 0) > 0
    && !activeEmbeddingDrain
    && (completionCandidate || splitVectorRepairAlreadyRan);
  const postDrainPreflightAnnSource = postDrainPreflightAnnSourceFreshness({
    preflight: postDrainPreflight,
    liveEmbedded: db?.chunks?.embedded,
  });
  const postDrainPreflightDurableFailures = postDrainPreflight.present
    ? postDrainPreflightEvidenceFailures(postDrainPreflight)
    : [];
  const postDrainPreflightDeferredAnnRace = activeEmbeddingDrain
    && activeDrainCanDeferPreflightAnnRace(postDrainPreflight);
  const postDrainPreflightDeferredMemoryProjection = activeEmbeddingDrain
    && activeDrainCanDeferPreflightMemoryProjection({ preflight: postDrainPreflight, db });
  const postDrainPreflightDeferredRawFailures = activeEmbeddingDrain
    && activeDrainRawPreflightFailuresAreDeferrable({
      preflight: postDrainPreflight,
      annRace: postDrainPreflightDeferredAnnRace,
      memoryProjection: postDrainPreflightDeferredMemoryProjection,
    });
  const postDrainPreflightBlockingFailures = postDrainPreflightDurableFailures.filter((failure) => {
    if (postDrainPreflightDeferredRawFailures && DEFERRABLE_PREFLIGHT_AGGREGATE_FAILURES.includes(String(failure || ''))) return false;
    if (postDrainPreflightDeferredAnnRace && isDeferrablePreflightAnnRaceFailure(failure)) return false;
    if (postDrainPreflightDeferredMemoryProjection && DEFERRABLE_PREFLIGHT_MEMORY_PROJECTION_FAILURES.includes(String(failure || ''))) return false;
    return true;
  });
  const memoryProjection = postDrainPreflight.memory_refocus_projection || null;
  const memoryProjectionDryRun = memoryProjection?.projection || null;
  const memoryProjectionAfter = Number(memoryProjectionDryRun?.after_current_needs_routing_links);
  const memoryProjectionThreshold = Number(memoryProjection?.threshold);
  const memoryProjectionProvesThreshold = memoryProjection?.ok === true
    && memoryProjection?.read_only === true
    && memoryProjectionDryRun?.ok === true
    && memoryProjectionDryRun?.applied === false
    && memoryProjectionDryRun?.partial === false
    && Number.isFinite(memoryProjectionAfter)
    && Number.isFinite(memoryProjectionThreshold)
    && memoryProjectionAfter <= memoryProjectionThreshold;
  const blockers = [];
  const warnings = [];

  if (!db.ok) blockers.push(`database unreadable: ${db.error}`);
  if (db.ok && db.snapshot_consistent !== true) blockers.push('database status evidence was not collected from one read snapshot');
  if (db.ok && db.pending_reconciled !== true) blockers.push('database pending counts do not reconcile');
  if (db.ok && db.chunks.pending > 0 && Number(db.work_order?.selectable_pending || 0) !== Number(db.chunks.pending || 0)) {
    blockers.push(`embedding work-order cannot select ${db.work_order?.blocked_pending ?? 'unknown'} pending chunks (blank_topic=${db.work_order?.blank_topic_pending ?? 'unknown'} empty_content=${db.work_order?.empty_content_pending ?? 'unknown'} malformed_rank=${db.work_order?.malformed_rank_pending ?? 'unknown'})`);
  }
  if (db.ok && db.chunks.pending > 0 && db.work_order?.head?.ok !== true) {
    blockers.push(`embedding work-order head cannot be derived: ${db.work_order?.head?.error || 'unknown'}`);
  }
  if (db.ok && Number(db.work_order?.selectable_pending || 0) > 0 && !db.work_order?.head?.topics?.length) {
    blockers.push('embedding work-order has selectable pending chunks but no ordered head');
  }
  if (!disk.ok || !disk.above_floor) blockers.push(`disk free below floor (${disk.free_gb ?? 'unknown'}GB < ${MIN_FREE_GB}GB)`);
  if (['failed', 'blocked_by_lock'].includes(postDrain?.status)) blockers.push(`post-drain runner status is ${postDrain.status}`);
  if (completionEvidence.claimed && !completionEvidence.ok) {
    blockers.push(`post-drain completion evidence is incomplete: ${completionEvidence.failures[0] || 'unknown'}`);
  }
  if (completionCandidate && globalAnn.ready !== true) {
    blockers.push(`global ANN artifact is not ready after post-drain completion (${globalAnn.reason || globalAnn.state || 'unknown'})`);
  }
  if (completionCandidate && db.ok && db.chunks.pending > 0) {
    blockers.push(`live embeddable backlog is not zero after post-drain completion (${db.chunks.pending})`);
  }
  if (completionCandidate && db.ok && db.needs_routing.chunks > MAX_POST_DRAIN_NEEDS_ROUTING_CHUNKS) {
    blockers.push(`live needs-routing chunk residue is above launch threshold (${db.needs_routing.chunks} > ${MAX_POST_DRAIN_NEEDS_ROUTING_CHUNKS})`);
  }
  if (completionCandidate && db.ok && db.needs_routing.current_memory_links > MAX_POST_DRAIN_NEEDS_ROUTING_MEMORY) {
    blockers.push(`live needs-routing current memory residue is above launch threshold (${db.needs_routing.current_memory_links} > ${MAX_POST_DRAIN_NEEDS_ROUTING_MEMORY})`);
  }
  if (completionCandidate && finalProductProof.ok !== true) {
    blockers.push(`final product retrieval proof is missing or invalid after post-drain completion: ${finalProductProof.failures[0] || 'unknown'}`);
  }
  if (Number(staleVectorProjection?.malformed_tables || 0) > 0) {
    blockers.push(`vector table audit found malformed vec0 tables (${staleVectorProjection.malformed_tables})`);
  }
  if (staleVectorProjection?.mode === 'shape_only' && staleVectorProjection.ok !== true) {
    blockers.push(`vector table shape audit failed (${staleVectorProjection.error || staleVectorProjection.reason || 'unknown'})`);
  }
  if (staleVectorsShouldBlock) {
    blockers.push(`stale vector rows remain after split-vector repair (${staleVectorProjection.stale_vectors}); rerun post-drain vector repair`);
  }
  if (!services.embed_daemon.present || !services.embed_daemon.process_alive) blockers.push('resident embed daemon is not alive');
  if (services.post_drain_watcher.process_alive && !postDrainRunnerCode.reported) blockers.push('post-drain watcher code version is not reported');
  if (services.post_drain_watcher.process_alive && postDrainRunnerCode.reported && !postDrainRunnerCode.matches_disk) blockers.push('post-drain watcher is running stale code; restart it before the handoff');
  if (services.drain_wrapper.process_alive && drainCodeFreshness.wrapper.current === false) blockers.push('embedding drain wrapper is running stale code; restart it before continuing the drain');
  if (hold.active && hold.process_alive && drainCodeFreshness.worker.current === false) blockers.push('embedding drain worker is running stale code; restart it before continuing the drain');
  if (services.embed_daemon.process_alive && embedDaemonCodeFreshness.current === false) blockers.push('resident embed daemon is running stale code; restart it before post-drain resume');
  if (postDrainPreflight.present && postDrainPreflightBlockingFailures.length > 0) {
    blockers.push(`post-drain preflight failed: ${postDrainPreflightBlockingFailures[0] || 'unknown'}`);
  }
  if (postDrainPreflight.present && postDrainPreflight.command_hashes?.ok === false) {
    const drift = postDrainPreflight.command_hashes.missing_required[0]
      || postDrainPreflight.command_hashes.mismatches[0]
      || postDrainPreflight.command_hashes.missing_hashes[0]
      || postDrainPreflight.command_hashes.missing_current[0]
      || 'unknown';
    blockers.push(`post-drain preflight command hash proof is stale or incomplete: ${drift}`);
  }
  if (postDrainPreflight.present && postDrainPreflight.dependency_hashes?.ok === false) {
    const drift = postDrainPreflight.dependency_hashes.missing_required[0]
      || postDrainPreflight.dependency_hashes.mismatches[0]
      || postDrainPreflight.dependency_hashes.missing_hashes[0]
      || postDrainPreflight.dependency_hashes.missing_current[0]
      || 'unknown';
    blockers.push(`post-drain preflight dependency hash proof is stale or incomplete: ${drift}`);
  }
  if (db.ok && db.chunks.pending > 0) {
    const drainHoldMissing = !hold.active || hold.reason !== 'drain_personal_embeddings_sole_writer';
    const drainHoldOwnerDead = hold.active && !hold.process_alive;
    if ((drainHoldMissing || drainHoldOwnerDead) && drainRespawnGrace.ok) {
      warnings.push(`embedding drain wrapper is in bounded respawn grace (${drainRespawnGrace.log_age_ms ?? 'unknown'}ms <= ${drainRespawnGrace.max_grace_ms}ms); waiting for the sole-writer hold to reappear`);
    } else {
      if (drainHoldMissing) blockers.push('embedding drain hold is not active');
      if (drainHoldOwnerDead) blockers.push('embedding drain hold owner process is not alive');
    }
    if (!services.drain_wrapper.present || !services.drain_wrapper.process_alive) blockers.push('embedding drain launchd wrapper is not alive');
    if (!services.post_drain_watcher.present || !services.post_drain_watcher.process_alive) blockers.push('post-drain watcher is not alive');
    if (postDrainLock.owner_matches_watcher === false && postDrainLock.owner_process_alive === true) blockers.push(`post-drain lock is owned by a different live pid (${postDrainLock.owner_pid})`);
    if (!watcherStatusFresh) blockers.push(`post-drain watcher status is stale (${postDrainAge ?? 'unknown'}ms)`);
    if (!liveProgress.ok) blockers.push(`embedding drain log is stale (${liveProgress.log_age_ms ?? 'unknown'}ms)`);
  }
  if (db.ok && db.chunks.pending === 0 && !completionCandidate) {
    if (handoff?.status !== 'ready_for_reclassify' && postDrain?.status !== 'running') blockers.push('embedding drain is empty but handoff is not ready');
    if (handoff?.status === 'ready_for_reclassify' && handoffReady.ok !== true) {
      blockers.push(`post-drain handoff is not acceptable: ${handoffReady.failures[0] || 'unknown'}`);
    }
    if (
      handoff?.status === 'ready_for_reclassify'
      && handoffReady.ok === true
      && postDrain?.status !== 'running'
      && postDrainReadiness?.handoff_required !== false
      && postDrainReadiness?.handoff_launchd_clearance?.ok !== true
    ) {
      blockers.push(`post-drain handoff is ready but temporary drain launchd label is not cleared (${postDrainReadiness?.handoff_launchd_clearance?.reason || 'unknown'})`);
    }
    if (!services.post_drain_watcher.present || !services.post_drain_watcher.process_alive) blockers.push('post-drain watcher is missing after drain completion');
    if (!watcherStatusFresh) blockers.push(`post-drain watcher status is stale after drain completion (${postDrainAge ?? 'unknown'}ms)`);
    if (!postDrainLock.present) blockers.push('post-drain watcher lock is missing after drain completion');
    if (postDrainLock.present && postDrainLock.owner_matches_watcher !== true) blockers.push(`post-drain watcher lock is not owned by watcher after drain completion (${postDrainLock.owner_pid || 'unknown'})`);
    if (postDrainLock.owner_matches_watcher === false && postDrainLock.owner_process_alive === true) blockers.push(`post-drain lock is owned by a different live pid after drain completion (${postDrainLock.owner_pid})`);
    if (phase === 'post_drain_running' && !watcherStatusFresh) blockers.push(`post-drain runner heartbeat is stale (${postDrainAge ?? 'unknown'}ms)`);
  }
  if (phase === 'post_drain_running') {
    if (postDrain?.post_drain_embed_hold?.ok !== true) {
      blockers.push('post-drain runner has not acquired the embed writer hold');
    }
    if (hold.active !== true || hold.reason !== 'post_drain_pipeline_sole_writer') {
      blockers.push(`post-drain embed writer hold is not active (${hold.reason || 'missing'})`);
    } else if (hold.process_alive !== true) {
      blockers.push('post-drain embed writer hold owner process is not alive');
    }
  }
  if (stoplight.ok && stoplight.fresh === false) {
    warnings.push(activeEmbeddingDrain
      ? `latest stoplight is stale (${stoplight.checked_age_ms}ms); live drain status is authoritative until the drain finishes`
      : `latest stoplight is stale (${stoplight.checked_age_ms}ms)`);
  }
  if (!postDrainPreflight.present) warnings.push('post-drain preflight evidence is missing; run scripts/qa/post-drain-preflight.js before the handoff');
  if (postDrainPreflight.present && postDrainPreflight.fresh === false) warnings.push(`post-drain preflight evidence is stale (${postDrainPreflight.age_ms ?? 'unknown'}ms)`);
  if (postDrainPreflight.present && postDrainPreflight.read_only !== true) warnings.push('post-drain preflight evidence was not marked read-only');
  if (postDrainPreflight.present && postDrainPreflight.script_matches_disk === false) warnings.push('post-drain preflight script changed after the last preflight run');
  if (postDrainPreflightDeferredAnnRace) {
    warnings.push('post-drain ANN-source preflight has an active-drain vector race; runner will rerun strict preflight at zero before backup');
  }
  if (postDrainPreflightDeferredMemoryProjection) {
    warnings.push(`post-drain memory-refocus preflight projects ${memoryProjectionAfter} unresolved links above threshold ${memoryProjectionThreshold}; live needs-routing memory is within threshold and runner will rerun strict preflight at zero`);
  }
  if (postDrainPreflightAnnSource.present && postDrainPreflightAnnSource.within_lag === false) {
    const lag = postDrainPreflightAnnSource.lag_chunks ?? 'unknown';
    if (activeEmbeddingDrain) {
      warnings.push(`post-drain ANN-source preflight lags live embedded chunks by ${lag}; runner will rerun it at zero before backup`);
    } else {
      blockers.push(`post-drain ANN-source preflight does not cover live embedded chunks (lag=${lag}); rerun preflight before trusting the handoff`);
    }
  }
  if (Number(liveProgress.eta_hours_at_latest_pass_rate) > MAX_DRAIN_ETA_HOURS) {
    warnings.push(`live representative drain ETA exceeds ${MAX_DRAIN_ETA_HOURS}h at selected ETA rate (${liveProgress.eta_hours_at_latest_pass_rate}h); observed=${liveProgress.observed_rate_per_hour || 'unknown'}/h eta_rate=${liveProgress.eta_rate_per_hour || 'unknown'}/h required=${liveProgress.required_rate_per_hour_for_target || 'unknown'}/h observed_gap=${liveProgress.observed_rate_gap_per_hour_for_target || 'unknown'}/h eta_gap=${liveProgress.rate_gap_per_hour_for_target || 'unknown'}/h`);
  } else if (liveProgress.eta_rate_representative === true) {
    // Live representative progress is stronger than an older stoplight baseline.
  } else if (liveProgress.eta_rate_representative === false && stoplight.progress?.full_drain_eta_exceeds_48h) {
    warnings.push(`conservative stoplight drain ETA exceeds 48h (${stoplight.progress.conservative_eta_hours ?? 'unknown'}h); live ETA is pending a representative pass (${liveProgress.eta_unavailable_reason || 'unknown'})`);
  } else if (stoplight.progress?.full_drain_eta_exceeds_48h) {
    warnings.push('drain ETA exceeds 48h at latest measured rate');
  }
  if (liveProgress.state === 'yielding') warnings.push('embedding drain is currently yielding to foreground activity; use data-pipeline-status for monitoring and avoid invasive stoplight probes until the drain finishes');
  if (liveProgress.state === 'fresh_no_progress' && effectiveDrainCapacity.active_in_process_writer !== true && drainRespawnGrace.ok !== true) warnings.push('embedding drain has fresh logs but no observed movement in the current pass');
  if (drainCapacityBelowRequested && drainRespawnGrace.ok !== true) warnings.push(`embedding drain lane capacity is below requested width (${liveDrainLaneCount}/${requestedDrainLanes}); watch for lane respawn or falling ETA`);
  if (Number(drainIntensity?.rss_headroom_mb) < MIN_DRAIN_RSS_HEADROOM_MB) {
    warnings.push(`drain RSS headroom is narrow (${drainIntensity.rss_headroom_mb}MB < ${MIN_DRAIN_RSS_HEADROOM_MB}MB); self-stop guard remains active`);
  }
  if (postDrainReadiness?.hold_delta_from_live === true && postDrainReadiness.live_hold_active === true) {
    warnings.push('post-drain watcher readiness snapshot predates the current drain hold; live hold is authoritative');
  }
  if (postDrainReadiness?.handoff_stale_ready_marker === true) {
    warnings.push(`stale ready handoff marker is ignored while live embeddings are still draining; it must be fresh at zero`);
  }
  if (Number(staleVectorProjection?.stale_vectors || 0) > 0 && !staleVectorsShouldBlock) {
    warnings.push(`stale vector rows remain (${staleVectorProjection.stale_vectors}); post-drain repair will prune them after the embedding writer is quiet`);
  }
  if (staleVectorProjection?.mode === 'shape_only' && staleVectorProjection.stale_vectors_skipped === true) {
    warnings.push('stale vector row count skipped during active-drain summary; full status and post-drain repair will run the complete vector audit');
  }
  if (staleVectorProjection?.ok === false && staleVectorProjection?.error && activeEmbeddingDrain) {
    warnings.push(`stale vector projection unavailable during active drain: ${staleVectorProjection.error}`);
  }
  if (services.post_drain_watcher.process_alive && !postDrainLock.present) warnings.push('post-drain watcher is alive but its lock file is missing');
  if (postDrainLock.present && postDrainLock.owner_pid && postDrainLock.owner_process_alive === false) warnings.push(`post-drain lock owner pid ${postDrainLock.owner_pid} is not alive; watcher should reclaim it on next start`);
  if (!completionCandidate && db.ok && db.needs_routing.current_memory_links > MAX_POST_DRAIN_NEEDS_ROUTING_MEMORY) {
    warnings.push(memoryProjectionProvesThreshold
      ? `needs-routing current memory links remain high (${db.needs_routing.current_memory_links}); preflight projects refocus to ${memoryProjectionAfter} <= ${memoryProjectionThreshold} after post-drain repair`
      : `needs-routing current memory links remain high (${db.needs_routing.current_memory_links}) until memory refocus/recalc`);
  }
  if (!completionCandidate && globalAnn.ready !== true) {
    const sourceDetail = globalAnnSourceProjectionWarningDetail({
      projection: postDrainPreflight.global_ann_source_projection,
      freshness: postDrainPreflightAnnSource,
    });
    warnings.push(`global ANN artifact is ${globalAnn.state} (${globalAnn.reason}); ${sourceDetail}; retrieval can fall back, and post-drain rebuild must repair it`);
  }
  const warningDetailsList = warningDetails(warnings);
  const warningSummaryReport = warningSummary(warningDetailsList);
  const blockerDetailsList = blockerDetails(blockers);
  const blockerSummaryReport = blockerSummary(blockerDetailsList);

  const ok = blockers.length === 0;
  const complete = completionCandidate && ok;
  const reportedPhase = completionCandidate && !complete ? 'post_drain_unverified' : phase;
  const statusActionReport = statusAction({
    ok,
    complete,
    phase: reportedPhase,
    blockerSummary: blockerSummaryReport,
    warningSummary: warningSummaryReport,
  });
  const launchContract = launchContractEvidence({
    db,
    postDrain,
    postDrainPreflight,
    postDrainPreflightBlockingFailures,
    postDrainPreflightDeferredAnnRace,
    postDrainPreflightDeferredMemoryProjection,
    postDrainPreflightAnnSource,
    globalAnn,
    finalProductProof,
    liveProgress,
    hold,
    services,
    activeEmbeddingDrain,
    drainRespawnGrace,
  });
  return {
    ok,
    complete,
    phase: reportedPhase,
    completion_candidate: completionCandidate,
    checked_at: new Date().toISOString(),
    next_action: nextAction({ ok, complete, phase: reportedPhase, blockers }),
    status_action: statusActionReport,
    blockers,
    blocker_details: blockerDetailsList,
    blocker_summary: blockerSummaryReport,
    warnings,
    warning_details: warningDetailsList,
    warning_summary: warningSummaryReport,
    launch_contract: launchContract,
    db,
    stale_vector_projection: staleVectorProjection,
    global_ann: globalAnn,
    hold,
    services,
    drain_code: drainCodeFreshness,
    embed_daemon_code: embedDaemonCodeFreshness,
    post_drain: {
      path: POST_DRAIN_STATUS_FILE,
      status: postDrain?.status || null,
      updated_at: postDrain?.updated_at || null,
      age_ms: postDrainAge,
      max_age_ms: MAX_WATCHER_STATUS_AGE_MS,
      fresh: watcherStatusFresh,
      current_step: postDrain?.current_step || null,
      current_step_pid: postDrain?.current_step_pid || null,
      current_step_started_at: postDrain?.current_step_started_at || null,
      current_step_heartbeat_at: postDrain?.current_step_heartbeat_at || null,
      current_step_attempt: postDrain?.current_step_attempt || null,
      current_step_attempts: postDrain?.current_step_attempts || null,
      last_step: postDrain?.last_step || null,
      chunk_source_quiescence: postDrain?.chunk_source_quiescence || null,
      embed_hold: postDrain?.post_drain_embed_hold || null,
      embed_hold_release: postDrain?.post_drain_embed_hold_release || null,
      split_vec_orphan_repair_after_reclassify: postDrain?.split_vec_orphan_repair_after_reclassify || null,
      final_product_proof: postDrain?.final_product_proof || null,
      pre_gcs_backup_source_quiescence: postDrain?.pre_gcs_backup_source_quiescence || null,
      pre_gcs_backup_backlog_check: postDrain?.pre_gcs_backup_backlog_check || null,
      pre_reclassify_source_quiescence: postDrain?.pre_reclassify_source_quiescence || null,
      pre_reclassify_backlog_check: postDrain?.pre_reclassify_backlog_check || null,
      pre_topic_context_source_quiescence: postDrain?.pre_topic_context_source_quiescence || null,
      pre_topic_context_backlog_check: postDrain?.pre_topic_context_backlog_check || null,
      pre_global_hnsw_source_quiescence: postDrain?.pre_global_hnsw_source_quiescence || null,
      pre_global_hnsw_backlog_check: postDrain?.pre_global_hnsw_backlog_check || null,
      pre_post_memory_topic_context_source_quiescence: postDrain?.pre_post_memory_topic_context_source_quiescence || null,
      pre_post_memory_topic_context_backlog_check: postDrain?.pre_post_memory_topic_context_backlog_check || null,
      pre_routing_audit_source_quiescence: postDrain?.pre_routing_audit_source_quiescence || null,
      pre_routing_audit_backlog_check: postDrain?.pre_routing_audit_backlog_check || null,
      post_product_proof_source_quiescence: postDrain?.post_product_proof_source_quiescence || null,
      post_product_proof_backlog_check: postDrain?.post_product_proof_backlog_check || null,
      lock: postDrainLock,
      runner_code: postDrainRunnerCode,
      preflight: postDrainPreflight,
      preflight_ann_source_freshness: postDrainPreflightAnnSource,
      readiness: postDrainReadiness,
      completion_evidence: completionEvidence,
    },
    handoff: {
      path: HANDOFF_FILE,
      status: handoff?.status || null,
      checked_at: handoff?.checked_at || null,
      ready: handoffReady,
      post_drain: handoff?.post_drain || null,
    },
    stoplight,
    final_product_proof: finalProductProof,
    disk,
    effective_eta: effectiveEta,
    drain_trend: drainTrend,
    system_memory: systemMemory,
    drain_intensity: drainIntensity,
    drain_requested_lanes: drainRequestedLanes,
    drain_effective_capacity: effectiveDrainCapacity,
    drain_respawn_grace: drainRespawnGrace,
    drain_log: drainLog,
    logs: {
      drain: drainLog.path,
      post_drain: postDrain?.log_file || POST_DRAIN_LOG_FILE,
      post_drain_launchd: POST_DRAIN_LAUNCHD_LOG_FILE,
    },
    live_drain_progress: liveProgress,
  };
}

function nextAction({ ok, complete, phase, blockers }) {
  if (!ok) return `fix blocker: ${blockers[0]}`;
  if (complete) return 'final data-plane and product proof passed; close the goal';
  if (phase === 'draining') return 'wait for embedding drain; watcher will start post-drain chain at zero';
  if (phase === 'post_drain_ready') return 'post-drain watcher should begin backup and reclassification';
  if (phase === 'post_drain_running') return 'monitor current post-drain step until final residue audit passes';
  return 'inspect handoff and post-drain status';
}

function actionWithCadence(payload, recheckAfterMs) {
  const ms = Number(recheckAfterMs);
  const safeMs = Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : 0;
  return {
    ...payload,
    recommended_command: AGENT_LOOP_COMMAND,
    live_refresh_command: LIVE_REFRESH_COMMAND,
    recheck_after_ms: safeMs,
    recheck_after: safeMs > 0 ? new Date(Date.now() + safeMs).toISOString() : null,
    cadence: safeMs > 0 ? 'defer_until_recheck' : 'act_now',
  };
}

function statusAction({ ok, complete, phase, blockerSummary = null, warningSummary = null }) {
  const blockerActions = Array.isArray(blockerSummary?.operator_actions)
    ? blockerSummary.operator_actions
    : [];
  const warningActions = Array.isArray(warningSummary?.operator_actions)
    ? warningSummary.operator_actions
    : [];
  if (!ok) {
    return actionWithCadence({
      kind: 'fix_blocker',
      action: blockerActions[0] || 'inspect_blocker',
      operator_action_required: true,
      reason: 'blocker_present',
      blocker_actions: blockerActions,
    }, ACTION_REQUIRED_RECHECK_MS);
  }
  if (complete) {
    return actionWithCadence({
      kind: 'close_goal',
      action: 'close_data_pipeline_goal',
      operator_action_required: true,
      reason: 'pipeline_complete',
      blocker_actions: [],
    }, ACTION_REQUIRED_RECHECK_MS);
  }
  if (warningSummary?.operator_action_required === true) {
    return actionWithCadence({
      kind: 'inspect_warning',
      action: warningActions[0] || 'inspect_warning',
      operator_action_required: true,
      reason: 'actionable_warning_present',
      warning_actions: warningActions,
    }, ACTION_REQUIRED_RECHECK_MS);
  }
  if (phase === 'draining') {
    return actionWithCadence({
      kind: 'wait',
      action: 'wait_for_embedding_drain',
      operator_action_required: false,
      reason: 'healthy_active_drain',
    }, HEALTHY_DRAIN_RECHECK_MS);
  }
  if (phase === 'post_drain_ready') {
    return actionWithCadence({
      kind: 'watch',
      action: 'watch_post_drain_watcher_start',
      operator_action_required: false,
      reason: 'post_drain_ready',
    }, POST_DRAIN_RECHECK_MS);
  }
  if (phase === 'post_drain_running') {
    return actionWithCadence({
      kind: 'monitor',
      action: 'monitor_post_drain_step',
      operator_action_required: false,
      reason: 'post_drain_running',
    }, POST_DRAIN_RECHECK_MS);
  }
  return actionWithCadence({
    kind: 'inspect',
    action: 'inspect_handoff_and_post_drain_status',
    operator_action_required: true,
    reason: 'unknown_phase',
  }, ACTION_REQUIRED_RECHECK_MS);
}

function blockerDetail(message) {
  const text = String(message || '');
  if (text.startsWith('database unreadable')) {
    return { code: 'database_unreadable', severity: 'blocker', action: 'fix_database_access' };
  }
  if (text.startsWith('database status evidence was not collected')) {
    return { code: 'database_snapshot_inconsistent', severity: 'blocker', action: 'rerun_status_probe' };
  }
  if (text.startsWith('database pending counts do not reconcile')) {
    return { code: 'database_pending_counts_unreconciled', severity: 'blocker', action: 'inspect_embedding_counts' };
  }
  if (text.startsWith('embedding work-order cannot select')) {
    return { code: 'embedding_work_order_blocked', severity: 'blocker', action: 'repair_embedding_work_order_inputs' };
  }
  if (text.startsWith('embedding work-order head cannot be derived')) {
    return { code: 'embedding_work_order_head_failed', severity: 'blocker', action: 'inspect_embedding_work_order_head' };
  }
  if (text.startsWith('disk free below floor')) {
    return { code: 'disk_free_below_floor', severity: 'blocker', action: 'free_disk_space' };
  }
  if (text.startsWith('post-drain runner status is')) {
    return { code: 'post_drain_runner_failed', severity: 'blocker', action: 'inspect_post_drain_log' };
  }
  if (text.startsWith('post-drain completion evidence is incomplete')) {
    return { code: 'post_drain_completion_evidence_incomplete', severity: 'blocker', action: 'inspect_post_drain_completion_evidence' };
  }
  if (text.startsWith('global ANN artifact is not ready after post-drain completion')) {
    return { code: 'global_ann_missing_after_completion', severity: 'blocker', action: 'rerun_global_ann_rebuild' };
  }
  if (text.startsWith('live embeddable backlog is not zero after post-drain completion')) {
    return { code: 'live_backlog_nonzero_after_completion', severity: 'blocker', action: 'rerun_embedding_drain' };
  }
  if (text.startsWith('live needs-routing chunk residue is above launch threshold')) {
    return { code: 'needs_routing_chunk_residue_above_threshold', severity: 'blocker', action: 'run_routing_residue_repair' };
  }
  if (text.startsWith('live needs-routing current memory residue is above launch threshold')) {
    return { code: 'needs_routing_memory_residue_above_threshold', severity: 'blocker', action: 'run_memory_refocus' };
  }
  if (text.startsWith('final product retrieval proof is missing or invalid')) {
    return { code: 'final_product_proof_invalid', severity: 'blocker', action: 'rerun_final_product_proof' };
  }
  if (text.startsWith('vector table audit found malformed vec0 tables')) {
    return { code: 'vector_table_malformed', severity: 'blocker', action: 'repair_vector_tables' };
  }
  if (text.startsWith('vector table shape audit failed')) {
    return { code: 'vector_table_shape_audit_failed', severity: 'blocker', action: 'inspect_vector_table_audit' };
  }
  if (text.startsWith('stale vector rows remain after split-vector repair')) {
    return { code: 'stale_vectors_after_repair', severity: 'blocker', action: 'rerun_split_vector_repair' };
  }
  if (text.startsWith('resident embed daemon is not alive')) {
    return { code: 'embed_daemon_not_alive', severity: 'blocker', action: 'restart_embed_daemon' };
  }
  if (text.startsWith('post-drain watcher code version is not reported') || text.startsWith('post-drain watcher is running stale code')) {
    return { code: 'post_drain_watcher_stale_or_unreported_code', severity: 'blocker', action: 'restart_post_drain_watcher' };
  }
  if (text.startsWith('embedding drain wrapper is running stale code')) {
    return { code: 'embedding_drain_wrapper_stale_code', severity: 'blocker', action: 'restart_embedding_drain_wrapper' };
  }
  if (text.startsWith('embedding drain worker is running stale code')) {
    return { code: 'embedding_drain_worker_stale_code', severity: 'blocker', action: 'restart_embedding_drain_worker' };
  }
  if (text.startsWith('resident embed daemon is running stale code')) {
    return { code: 'embed_daemon_stale_code', severity: 'blocker', action: 'restart_embed_daemon' };
  }
  if (text.startsWith('post-drain preflight failed')) {
    return { code: 'post_drain_preflight_failed', severity: 'blocker', action: 'rerun_or_fix_post_drain_preflight' };
  }
  if (text.startsWith('post-drain preflight command hash proof is stale or incomplete')) {
    return { code: 'post_drain_preflight_command_hash_stale', severity: 'blocker', action: 'rerun_post_drain_preflight' };
  }
  if (text.startsWith('post-drain preflight dependency hash proof is stale or incomplete')) {
    return { code: 'post_drain_preflight_dependency_hash_stale', severity: 'blocker', action: 'rerun_post_drain_preflight' };
  }
  if (text.startsWith('embedding drain hold is not active')) {
    return { code: 'embedding_drain_hold_missing', severity: 'blocker', action: 'restart_embedding_drain' };
  }
  if (text.startsWith('embedding drain hold owner process is not alive')) {
    return { code: 'embedding_drain_hold_owner_dead', severity: 'blocker', action: 'restart_embedding_drain' };
  }
  if (text.startsWith('embedding drain launchd wrapper is not alive')) {
    return { code: 'embedding_drain_wrapper_not_alive', severity: 'blocker', action: 'restart_embedding_drain_wrapper' };
  }
  if (text.startsWith('post-drain watcher is not alive') || text.startsWith('post-drain watcher is missing after drain completion')) {
    return { code: 'post_drain_watcher_not_alive', severity: 'blocker', action: 'restart_post_drain_watcher' };
  }
  if (text.startsWith('post-drain lock is owned by a different live pid')) {
    return { code: 'post_drain_lock_owned_by_other_pid', severity: 'blocker', action: 'inspect_post_drain_lock_owner' };
  }
  if (text.startsWith('post-drain watcher status is stale') || text.startsWith('post-drain runner heartbeat is stale')) {
    return { code: 'post_drain_watcher_status_stale', severity: 'blocker', action: 'restart_post_drain_watcher' };
  }
  if (text.startsWith('embedding drain log is stale')) {
    return { code: 'embedding_drain_log_stale', severity: 'blocker', action: 'inspect_embedding_drain_process' };
  }
  if (text.startsWith('embedding drain is empty but handoff is not ready')) {
    return { code: 'embedding_drain_empty_handoff_not_ready', severity: 'blocker', action: 'inspect_embedding_drain_handoff' };
  }
  if (text.startsWith('post-drain handoff is not acceptable')) {
    return { code: 'post_drain_handoff_not_acceptable', severity: 'blocker', action: 'inspect_embedding_drain_handoff' };
  }
  if (text.startsWith('post-drain handoff is ready but temporary drain launchd label is not cleared')) {
    return { code: 'post_drain_handoff_launchd_not_cleared', severity: 'blocker', action: 'clear_temporary_drain_launchd_label' };
  }
  if (text.startsWith('post-drain watcher lock is')) {
    return { code: 'post_drain_watcher_lock_invalid', severity: 'blocker', action: 'restart_post_drain_watcher' };
  }
  if (text.startsWith('post-drain runner has not acquired the embed writer hold') || text.startsWith('post-drain embed writer hold is not active')) {
    return { code: 'post_drain_embed_writer_hold_missing', severity: 'blocker', action: 'restart_post_drain_runner' };
  }
  if (text.startsWith('post-drain embed writer hold owner process is not alive')) {
    return { code: 'post_drain_embed_writer_hold_owner_dead', severity: 'blocker', action: 'restart_post_drain_runner' };
  }
  if (text.startsWith('post-drain ANN-source preflight does not cover live embedded chunks')) {
    return { code: 'post_drain_preflight_ann_source_lag_after_drain', severity: 'blocker', action: 'rerun_post_drain_preflight' };
  }
  if (text.startsWith('no cached summary at')) {
    return { code: 'cached_status_missing', severity: 'blocker', action: 'refresh_data_pipeline_status_cache' };
  }
  if (text.startsWith('cached summary is stale')) {
    return { code: 'cached_status_stale', severity: 'blocker', action: 'refresh_data_pipeline_status_cache' };
  }
  if (text.startsWith('cached summary was produced by stale status code')) {
    return { code: 'cached_status_code_stale', severity: 'blocker', action: 'refresh_data_pipeline_status_cache' };
  }
  return { code: 'unclassified_blocker', severity: 'blocker', action: 'inspect_blocker' };
}

function blockerDetails(blockers) {
  return (blockers || []).map((message) => ({
    message,
    ...blockerDetail(message),
  }));
}

function blockerSummary(details) {
  const list = Array.isArray(details) ? details : [];
  return {
    total: list.length,
    unclassified: list.filter((detail) => detail.code === 'unclassified_blocker').length,
    operator_action_required: list.length > 0,
    operator_actions: [...new Set(list.map((detail) => detail.action).filter(Boolean))],
  };
}

function warningDetail(message) {
  const text = String(message || '');
  if (text.startsWith('latest stoplight is stale') && text.includes('live drain status is authoritative')) {
    return { code: 'stoplight_stale_active_drain', severity: 'info', action: 'use_live_drain_status', expected_while_draining: true };
  }
  if (text.startsWith('latest stoplight is stale')) {
    return { code: 'stoplight_stale', severity: 'warning', action: 'refresh_launch_stoplight', expected_while_draining: false };
  }
  if (text.startsWith('post-drain preflight evidence is missing')) {
    return { code: 'post_drain_preflight_missing', severity: 'warning', action: 'run_post_drain_preflight', expected_while_draining: false };
  }
  if (text.startsWith('post-drain preflight evidence is stale')) {
    return { code: 'post_drain_preflight_stale', severity: 'warning', action: 'refresh_post_drain_preflight', expected_while_draining: false };
  }
  if (text.startsWith('post-drain preflight evidence was not marked read-only')) {
    return { code: 'post_drain_preflight_not_read_only', severity: 'warning', action: 'rerun_post_drain_preflight_read_only', expected_while_draining: false };
  }
  if (text.startsWith('post-drain preflight script changed after the last preflight run')) {
    return { code: 'post_drain_preflight_script_changed', severity: 'warning', action: 'rerun_post_drain_preflight', expected_while_draining: false };
  }
  if (text.startsWith('post-drain ANN-source preflight has an active-drain vector race')) {
    return { code: 'post_drain_ann_source_active_race', severity: 'info', action: 'wait_for_zero_backlog_strict_preflight', expected_while_draining: true };
  }
  if (text.startsWith('post-drain ANN-source preflight lags live embedded chunks')) {
    return { code: 'post_drain_ann_source_lag_active_drain', severity: 'info', action: 'wait_for_zero_backlog_strict_preflight', expected_while_draining: true };
  }
  if (text.startsWith('post-drain memory-refocus preflight projects')) {
    return { code: 'post_drain_memory_refocus_projection_active_drain', severity: 'info', action: 'wait_for_zero_backlog_strict_preflight', expected_while_draining: true };
  }
  if (text.startsWith('live representative drain ETA exceeds')) {
    return { code: 'drain_eta_above_target', severity: 'warning', action: 'inspect_drain_rate_and_load', expected_while_draining: false };
  }
  if (text.startsWith('conservative stoplight drain ETA exceeds')) {
    return { code: 'stoplight_eta_above_target_pending_live_eta', severity: 'info', action: 'wait_for_representative_live_eta', expected_while_draining: true };
  }
  if (text.startsWith('drain ETA exceeds')) {
    return { code: 'drain_eta_above_target', severity: 'warning', action: 'inspect_drain_rate_and_load', expected_while_draining: false };
  }
  if (text.startsWith('embedding drain is currently yielding to foreground activity')) {
    return { code: 'live_progress_yielding_to_foreground', severity: 'info', action: 'wait_for_foreground_quiet', expected_while_draining: true };
  }
  if (text.startsWith('embedding drain wrapper is in bounded respawn grace')) {
    return { code: 'guarded_drain_respawn_grace', severity: 'info', action: 'wait_for_guarded_drain_respawn', expected_while_draining: true };
  }
  if (text.startsWith('embedding drain has fresh logs but no observed movement')) {
    return { code: 'live_progress_fresh_no_progress', severity: 'warning', action: 'inspect_drain_progress', expected_while_draining: false };
  }
  if (text.startsWith('embedding drain lane capacity is below requested width')) {
    return { code: 'drain_capacity_below_requested', severity: 'warning', action: 'watch_lane_respawn_or_restart_drain', expected_while_draining: false };
  }
  if (text.startsWith('drain RSS headroom is narrow')) {
    return { code: 'drain_rss_headroom_narrow', severity: 'info', action: 'keep_self_stop_guard_active', expected_while_draining: true };
  }
  if (text.startsWith('post-drain watcher readiness snapshot predates the current drain hold')) {
    return { code: 'post_drain_readiness_stale_hold_snapshot', severity: 'info', action: 'trust_live_hold', expected_while_draining: true };
  }
  if (text.startsWith('stale ready handoff marker is ignored while live embeddings are still draining')) {
    return { code: 'stale_ready_handoff_ignored_active_drain', severity: 'info', action: 'wait_for_fresh_zero_backlog_handoff', expected_while_draining: true };
  }
  if (text.startsWith('stale vector rows remain')) {
    return { code: 'stale_vectors_pending_repair', severity: 'info', action: 'wait_for_post_drain_vector_repair', expected_while_draining: true };
  }
  if (text.startsWith('stale vector row count skipped during active-drain summary')) {
    return { code: 'active_drain_vector_audit_deferred', severity: 'info', action: 'wait_for_post_drain_vector_audit', expected_while_draining: true };
  }
  if (text.startsWith('stale vector projection unavailable during active drain')) {
    return { code: 'active_drain_vector_projection_unavailable', severity: 'info', action: 'wait_for_post_drain_vector_audit', expected_while_draining: true };
  }
  if (text.startsWith('post-drain watcher is alive but its lock file is missing')) {
    return { code: 'post_drain_watcher_lock_missing', severity: 'warning', action: 'restart_or_inspect_post_drain_watcher', expected_while_draining: false };
  }
  if (text.startsWith('post-drain lock owner pid')) {
    return { code: 'post_drain_lock_dead_owner', severity: 'warning', action: 'restart_or_inspect_post_drain_watcher', expected_while_draining: false };
  }
  if (text.startsWith('needs-routing current memory links remain high') && text.includes('preflight projects refocus to')) {
    return { code: 'needs_routing_memory_pending_refocus', severity: 'info', action: 'wait_for_post_drain_memory_refocus', expected_while_draining: true };
  }
  if (text.startsWith('needs-routing current memory links remain high')) {
    return { code: 'needs_routing_memory_refocus_unproven', severity: 'warning', action: 'run_memory_refocus_projection', expected_while_draining: false };
  }
  if (text.startsWith('global ANN artifact is')) {
    return { code: 'global_ann_rebuild_pending', severity: 'info', action: 'wait_for_post_drain_global_ann_rebuild', expected_while_draining: true };
  }
  return { code: 'unclassified_warning', severity: 'warning', action: 'inspect_warning', expected_while_draining: false };
}

function warningDetails(warnings) {
  return (warnings || []).map((message) => ({
    message,
    ...warningDetail(message),
  }));
}

function warningSummary(details) {
  const list = Array.isArray(details) ? details : [];
  const actionRequired = list.filter((detail) => detail.severity !== 'info' || detail.expected_while_draining !== true);
  return {
    total: list.length,
    info: list.filter((detail) => detail.severity === 'info').length,
    warning: list.filter((detail) => detail.severity === 'warning').length,
    unclassified: list.filter((detail) => detail.code === 'unclassified_warning').length,
    all_expected_while_draining: list.every((detail) => detail.expected_while_draining === true),
    operator_action_required: actionRequired.length > 0,
    operator_actions: [...new Set(actionRequired.map((detail) => detail.action).filter(Boolean))],
  };
}

function compactAnnSourceProjection(projection, freshness) {
  if (!projection) return null;
  return {
    ok: projection.ok === true,
    embedded_total: projection.embedded_total ?? null,
    readable_vectors: projection.readable_vectors ?? null,
    missing_vectors: projection.missing_vectors ?? null,
    malformed_rows: projection.malformed_rows ?? null,
    hnsw_dims: projection.hnsw_dims ?? null,
    live_embedded: freshness?.live_embedded ?? null,
    lag_chunks: freshness?.lag_chunks ?? null,
    within_lag: freshness?.within_lag ?? null,
  };
}

function compactMemoryHeadroom(report) {
  const systemMemory = report.system_memory || null;
  const drainIntensity = report.drain_intensity || null;
  const respawnGrace = report.drain_respawn_grace || null;
  const drainProcessVisible = drainIntensity?.parent !== null && drainIntensity?.parent !== undefined;
  if (!systemMemory && !drainIntensity) return null;
  return {
    ok: systemMemory?.ok === true && (drainIntensity?.ok === true || respawnGrace?.ok === true),
    pressure: systemMemory?.pressure || 'unknown',
    physical_gb: systemMemory?.physical_gb ?? null,
    available_gb: systemMemory?.available_gb ?? null,
    compressor_gb: systemMemory?.compressor_gb ?? null,
    compressor_ratio: systemMemory?.compressor_ratio ?? null,
    drain_process_visible: drainProcessVisible,
    respawn_grace: respawnGrace?.ok === true,
    drain_rss_mb: drainIntensity?.total_rss_mb ?? null,
    drain_rss_ceiling_mb: drainIntensity?.rss_ceiling_mb ?? null,
    drain_rss_headroom_mb: drainIntensity?.rss_headroom_mb ?? null,
    estimated_next_lane_rss_mb: drainIntensity?.estimated_next_lane_rss_mb ?? null,
    projected_rss_with_one_more_lane_mb: drainIntensity?.projected_rss_with_one_more_lane_mb ?? null,
    can_add_lane_by_rss: drainIntensity?.can_add_lane_by_rss ?? null,
    recommendation: drainIntensity?.recommendation || null,
  };
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compactSpeedPosture(report, statusActionReport, memoryHeadroom = compactMemoryHeadroom(report)) {
  const pending = finiteNumberOrNull(report.db?.chunks?.pending);
  const trendRate = finiteNumberOrNull(report.drain_trend?.rate_per_hour);
  const trendEta = finiteNumberOrNull(report.drain_trend?.eta_hours);
  const sampleRate = finiteNumberOrNull(report.live_drain_progress?.observed_sample_rate_per_hour);
  const sampleEta = finiteNumberOrNull(report.effective_eta?.non_authoritative_sample_hours);
  const canAddLane = memoryHeadroom?.can_add_lane_by_rss === true;
  const waitOnly = statusActionReport?.kind === 'wait'
    && statusActionReport?.operator_action_required === false;
  const actionName = String(statusActionReport?.action || '');
  const accelerationAction = /retune_lanes|add_embedding_lane|increase_embedding_lanes|restart_temporary_drain_with_lanes/.test(actionName);
  const accelerationAllowed = Boolean(statusActionReport?.operator_action_required === true && canAddLane && accelerationAction);
  const mode = Number.isFinite(pending) && pending > 0 && report.phase === 'draining'
    ? 'historical_repair'
    : report.phase === 'complete'
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
    status_kind: statusActionReport?.kind || null,
    wait_only: waitOnly,
    pending_embeddings: Number.isFinite(pending) ? pending : null,
    trend_rate_per_hour: Number.isFinite(trendRate) ? trendRate : null,
    trend_eta_hours: Number.isFinite(trendEta) ? trendEta : null,
    sample_rate_per_hour: Number.isFinite(sampleRate) ? sampleRate : null,
    sample_eta_hours: Number.isFinite(sampleEta) ? sampleEta : null,
    memory_pressure: memoryHeadroom?.pressure || null,
    memory_ok: memoryHeadroom?.ok === true,
    can_add_lane_by_rss: canAddLane,
    acceleration_allowed: accelerationAllowed,
    reason,
  };
}

function compactWorkOrderOrdering(topics, limit) {
  const rows = Array.isArray(topics) ? topics : [];
  const failures = [];
  for (let i = 1; i < rows.length; i += 1) {
    const previous = rows[i - 1] || {};
    const current = rows[i] || {};
    const previousPriority = Number(previous.priority);
    const currentPriority = Number(current.priority);
    const previousEmailShare = Number(previous.email_share);
    const currentEmailShare = Number(current.email_share);
    const previousPending = Number(previous.pending);
    const currentPending = Number(current.pending);
    if (Number.isFinite(previousPriority) && Number.isFinite(currentPriority)
      && previousPriority < currentPriority) {
      failures.push(`${previous.topic || i - 1}->${current.topic || i}:priority`);
      continue;
    }
    if (previousPriority === currentPriority
      && Number.isFinite(previousEmailShare)
      && Number.isFinite(currentEmailShare)
      && previousEmailShare > currentEmailShare) {
      failures.push(`${previous.topic || i - 1}->${current.topic || i}:email_share`);
      continue;
    }
    if (previousPriority === currentPriority
      && previousEmailShare === currentEmailShare
      && Number.isFinite(previousPending)
      && Number.isFinite(currentPending)
      && previousPending > currentPending) {
      failures.push(`${previous.topic || i - 1}->${current.topic || i}:pending`);
    }
  }
  return {
    ok: failures.length === 0,
    rule: 'priority_desc_email_share_asc_pending_asc',
    limit: Number(limit || WORK_ORDER_HEAD_LIMIT),
    observed_topics: rows.length,
    head_topic: rows[0]?.topic || null,
    failures,
  };
}

function compactStatusSummary(report) {
  const head = report.db?.work_order?.head?.topics?.[0] || null;
  const workOrderTopics = Array.isArray(report.db?.work_order?.head?.topics)
    ? report.db.work_order.head.topics
    : [];
  const pass = report.drain_log?.latest_pass || null;
  const progress = report.drain_log?.latest_drain_progress || null;
  const statusActionReport = report.status_action || statusAction({
    ok: report.ok,
    complete: report.complete,
    phase: report.phase,
    blockerSummary: report.blocker_summary,
    warningSummary: report.warning_summary,
  });
  const memoryHeadroom = compactMemoryHeadroom(report);
  return {
    ok: report.ok,
    complete: report.complete,
    phase: report.phase,
    checked_at: report.checked_at,
    next_action: report.next_action,
    status_action: statusActionReport,
    blockers: report.blockers,
    blocker_details: report.blocker_details || blockerDetails(report.blockers || []),
    blocker_summary: report.blocker_summary || blockerSummary(report.blocker_details || blockerDetails(report.blockers || [])),
    warnings: report.warnings,
    warning_details: report.warning_details || warningDetails(report.warnings || []),
    warning_summary: report.warning_summary || warningSummary(report.warning_details || warningDetails(report.warnings || [])),
    db: report.db?.ok ? {
      pending_embeddings: report.db.chunks.pending,
      personal_pending: report.db.personal.pending,
      non_personal_pending: report.db.non_personal_pending,
      work_order_selectable_pending: report.db.work_order.selectable_pending,
      work_order_blocked_pending: report.db.work_order.blocked_pending,
      work_order_head: head ? {
        topic: head.topic,
        pending: head.pending,
        priority: head.priority,
        short_pending: head.short_pending,
        long_pending: head.long_pending,
      } : null,
      work_order_topics: workOrderTopics.map((topic) => ({
        topic: topic.topic,
        pending: topic.pending,
        priority: topic.priority,
        email_share: topic.email_share,
        long_share: topic.long_share,
        short_pending: topic.short_pending,
        long_pending: topic.long_pending,
      })),
      work_order_ordering: compactWorkOrderOrdering(
        workOrderTopics,
        report.db.work_order.head?.limit || WORK_ORDER_HEAD_LIMIT,
      ),
      needs_routing_chunks: report.db.needs_routing.chunks,
      needs_routing_pending: report.db.needs_routing.pending,
      needs_routing_current_memory_links: report.db.needs_routing.current_memory_links,
    } : { ok: false, error: report.db?.error || 'unknown' },
    launch_contract: report.launch_contract ? {
      status: report.launch_contract.status,
      ok: report.launch_contract.ok,
      counts: report.launch_contract.counts,
      next_step: report.launch_contract.next_step,
      steps: report.launch_contract.steps.map((step) => ({
        id: step.id,
        status: step.status,
        detail: step.detail,
      })),
    } : null,
    retrieval: {
      global_ann_ready: report.global_ann?.ready === true,
      global_ann_state: report.global_ann?.state || null,
      global_ann_reason: report.global_ann?.reason || null,
      live_embedded: report.global_ann?.live_embedded ?? null,
      built_from_count: report.global_ann?.built_from_count ?? null,
      vector_projection_mode: report.stale_vector_projection?.mode || 'full',
      stale_vectors_skipped: report.stale_vector_projection?.stale_vectors_skipped === true,
      stale_vectors: report.stale_vector_projection?.stale_vectors ?? null,
      malformed_vector_tables: report.stale_vector_projection?.malformed_tables ?? null,
      source_projection: compactAnnSourceProjection(
        report.post_drain?.preflight?.global_ann_source_projection,
        report.post_drain?.preflight_ann_source_freshness,
      ),
    },
    effective_eta: report.effective_eta || null,
    eta: report.effective_eta || null,
    trend: report.drain_trend || null,
    memory_headroom: memoryHeadroom,
    speed_posture: compactSpeedPosture(report, statusActionReport, memoryHeadroom),
    live_progress: report.live_drain_progress ? {
      state: report.live_drain_progress.state,
      pending: report.live_drain_progress.pending,
      log_fresh: report.live_drain_progress.log_fresh,
      log_age_ms: report.live_drain_progress.log_age_ms,
      pending_delta_since_latest_pass: report.live_drain_progress.pending_delta_since_latest_pass,
      latest_progress_embedded: report.live_drain_progress.latest_progress_embedded,
      current_run_start_pending: report.live_drain_progress.current_run_start_pending,
      current_run_completed_from_db: report.live_drain_progress.current_run_completed_from_db,
      latest_pass_rate_per_hour: report.live_drain_progress.latest_pass_rate_per_hour,
      latest_pass_completed: report.live_drain_progress.latest_pass_completed,
      in_pass_rate_per_hour: report.live_drain_progress.in_pass_rate_per_hour,
      in_pass_completed: report.live_drain_progress.in_pass_completed,
      eta_rate_per_hour: report.live_drain_progress.eta_rate_per_hour,
      eta_rate_representative: report.live_drain_progress.eta_rate_representative,
      observed_sample_rate_per_hour: report.live_drain_progress.observed_sample_rate_per_hour,
      observed_rate_per_hour: report.live_drain_progress.observed_rate_per_hour,
      observed_sample_eta_hours: report.live_drain_progress.observed_sample_eta_hours,
      observed_sample_eta_days: report.live_drain_progress.observed_sample_eta_days,
      observed_rate_completed: report.live_drain_progress.observed_rate_completed,
      observed_rate_representative: report.live_drain_progress.observed_rate_representative,
      required_rate_per_hour_for_target: report.live_drain_progress.required_rate_per_hour_for_target,
      rate_gap_per_hour_for_target: report.live_drain_progress.rate_gap_per_hour_for_target,
      observed_rate_gap_per_hour_for_target: report.live_drain_progress.observed_rate_gap_per_hour_for_target,
      observed_rate_gap_pct_for_target: report.live_drain_progress.observed_rate_gap_pct_for_target,
      eta_source: report.live_drain_progress.eta_source,
      eta_unavailable_reason: report.live_drain_progress.eta_unavailable_reason,
      yielding_to_foreground: report.live_drain_progress.yielding_to_foreground,
    } : null,
    drain: {
      latest_pass: pass ? {
        pass: pass.pass,
        topic: pass.topic,
        pending: pass.pending,
        rate_per_hour: pass.rate_per_hour,
        aborted: pass.aborted,
      } : null,
      latest_progress: progress ? {
        pass: progress.pass,
        topic: progress.topic,
        completed: progress.completed,
        pending_estimate: progress.pending_estimate,
        rate_per_hour: progress.rate_per_hour,
      } : null,
      lanes: report.drain_intensity ? {
        count: report.drain_intensity.lane_count,
        effective_count: report.drain_effective_capacity?.effective_count ?? null,
        effective_mode: report.drain_effective_capacity?.mode || null,
        requested: report.drain_requested_lanes?.count ?? null,
        requested_source: report.drain_requested_lanes?.source || null,
        max: report.drain_intensity.max_lane_count,
        capacity_ok: report.drain_effective_capacity?.ok ?? (
          Number(report.drain_intensity.lane_count) >= Number(report.drain_requested_lanes?.count || 0)
        ),
        rss_mb: report.drain_intensity.total_rss_mb,
        recommendation: report.drain_intensity.recommendation,
      } : null,
      hold: report.hold?.active ? {
        reason: report.hold.reason,
        pid: report.hold.pid,
        process_alive: report.hold.process_alive,
      } : { active: false },
      respawn_grace: report.drain_respawn_grace ? {
        ok: report.drain_respawn_grace.ok,
        log_age_ms: report.drain_respawn_grace.log_age_ms,
        max_grace_ms: report.drain_respawn_grace.max_grace_ms,
      } : null,
    },
    services: {
      drain_wrapper_alive: report.services?.drain_wrapper?.process_alive === true,
      embed_daemon_alive: report.services?.embed_daemon?.process_alive === true,
      post_drain_watcher_alive: report.services?.post_drain_watcher?.process_alive === true,
      post_drain_watcher_pid: report.services?.post_drain_watcher?.pid ?? null,
      post_drain_watcher_launchd_status: report.services?.post_drain_watcher?.status ?? null,
      post_drain_watcher_status: report.post_drain?.status || null,
    },
    code_freshness: {
      drain_wrapper_current: report.drain_code?.wrapper?.current ?? null,
      drain_worker_current: report.drain_code?.worker?.current ?? null,
      embed_daemon_current: report.embed_daemon_code?.current ?? null,
      embed_daemon_stale_files: Array.isArray(report.embed_daemon_code?.stale_files)
        ? report.embed_daemon_code.stale_files
        : [],
      post_drain_runner_current: report.post_drain?.runner_code?.matches_disk ?? null,
      all_current: [
        report.drain_code?.wrapper?.current,
        report.drain_code?.worker?.current,
        report.embed_daemon_code?.current,
        report.post_drain?.runner_code?.matches_disk,
      ].every((current) => current === true),
    },
    post_drain: {
      status: report.post_drain?.status || null,
      fresh: report.post_drain?.fresh === true,
      current_step: report.post_drain?.current_step || null,
      current_step_heartbeat_at: report.post_drain?.current_step_heartbeat_at || null,
      lock_present: report.post_drain?.lock?.present === true,
      lock_owner_pid: report.post_drain?.lock?.owner_pid ?? null,
      lock_owner_alive: report.post_drain?.lock?.owner_process_alive ?? null,
      lock_watcher_pid: report.post_drain?.lock?.watcher_pid ?? null,
      lock_owner_matches_watcher: report.post_drain?.lock?.owner_matches_watcher ?? null,
      preflight_present: report.post_drain?.preflight?.present === true,
      preflight_ok: report.post_drain?.preflight?.ok === true,
      preflight_age_ms: report.post_drain?.preflight?.age_ms ?? null,
      preflight_read_only: report.post_drain?.preflight?.read_only === true,
      preflight_script_matches_disk: report.post_drain?.preflight?.script_matches_disk ?? null,
      preflight_command_hashes_ok: report.post_drain?.preflight?.command_hashes?.ok ?? null,
      preflight_dependency_hashes_ok: report.post_drain?.preflight?.dependency_hashes?.ok ?? null,
      preflight_first_command_drift: report.post_drain?.preflight?.command_hashes?.missing_required?.[0]
        || report.post_drain?.preflight?.command_hashes?.mismatches?.[0]
        || report.post_drain?.preflight?.command_hashes?.missing_hashes?.[0]
        || report.post_drain?.preflight?.command_hashes?.missing_current?.[0]
        || null,
      preflight_first_dependency_drift: report.post_drain?.preflight?.dependency_hashes?.missing_required?.[0]
        || report.post_drain?.preflight?.dependency_hashes?.mismatches?.[0]
        || report.post_drain?.preflight?.dependency_hashes?.missing_hashes?.[0]
        || report.post_drain?.preflight?.dependency_hashes?.missing_current?.[0]
        || null,
      preflight_ann_source_freshness: report.post_drain?.preflight_ann_source_freshness || null,
      memory_refocus_projection: report.post_drain?.preflight?.memory_refocus_projection ? {
        ok: report.post_drain.preflight.memory_refocus_projection.ok === true,
        threshold: report.post_drain.preflight.memory_refocus_projection.threshold ?? null,
        before: report.post_drain.preflight.memory_refocus_projection.projection?.before_current_needs_routing_links ?? null,
        after: report.post_drain.preflight.memory_refocus_projection.projection?.after_current_needs_routing_links ?? null,
        moved: report.post_drain.preflight.memory_refocus_projection.projection?.moved_events ?? null,
        suppressed: report.post_drain.preflight.memory_refocus_projection.projection?.suppressed_events ?? null,
        skipped_no_topic: report.post_drain.preflight.memory_refocus_projection.projection?.skipped_no_topic ?? null,
      } : null,
    },
    logs: report.logs,
  };
}

function writeCompactStatusSnapshot(summary) {
  const statusScriptSha256 = fileSha256(STATUS_SCRIPT_FILE);
  const payload = {
    ...summary,
    snapshot: {
      path: STATUS_SUMMARY_FILE,
      written_at: new Date().toISOString(),
      max_age_ms: MAX_STATUS_SUMMARY_AGE_MS,
      fresh: true,
      source: 'live_status_probe',
      status_script_path: STATUS_SCRIPT_FILE,
      status_script_sha256: statusScriptSha256,
    },
  };
  const tmp = `${STATUS_SUMMARY_FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(STATUS_SUMMARY_FILE), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tmp, STATUS_SUMMARY_FILE);
  } catch (err) {
    console.error(`[data-pipeline-status] summary snapshot write failed: ${err?.message || err}`);
  }
  return payload;
}

function writeStatusHistorySnapshot(summary) {
  const pending = Number(summary?.db?.pending_embeddings);
  const checkedMs = Date.parse(String(summary?.checked_at || ''));
  if (!Number.isFinite(pending) || pending < 0 || !Number.isFinite(checkedMs)) return;
  const cutoffMs = Date.now() - MAX_STATUS_HISTORY_AGE_MS;
  const existing = readJson(STATUS_HISTORY_FILE);
  const points = Array.isArray(existing?.points) ? existing.points : [];
  const nextPoint = {
    checked_at: new Date(checkedMs).toISOString(),
    pending,
    phase: summary.phase || null,
    ok: summary.ok === true,
    complete: summary.complete === true,
    action: summary.status_action?.action || null,
    action_kind: summary.status_action?.kind || null,
    operator_action_required: summary.status_action?.operator_action_required === true,
    source: 'status_history',
  };
  const bounded = [...points, nextPoint]
    .map((point) => {
      const pointMs = Date.parse(String(point?.checked_at || ''));
      const pointPending = Number(point?.pending);
      if (!Number.isFinite(pointMs) || !Number.isFinite(pointPending) || pointPending < 0) return null;
      return {
        ...point,
        checked_at: new Date(pointMs).toISOString(),
        pending: pointPending,
        checked_ms: pointMs,
      };
    })
    .filter(Boolean)
    .filter((point) => point.checked_ms >= cutoffMs)
    .sort((a, b) => a.checked_ms - b.checked_ms)
    .filter((point, index, list) => index === 0
      || point.checked_ms !== list[index - 1].checked_ms
      || point.pending !== list[index - 1].pending
      || point.source !== list[index - 1].source)
    .slice(-MAX_STATUS_HISTORY_POINTS)
    .map(({ checked_ms, ...point }) => point);
  const payload = {
    path: STATUS_HISTORY_FILE,
    written_at: new Date().toISOString(),
    max_age_ms: MAX_STATUS_HISTORY_AGE_MS,
    max_points: MAX_STATUS_HISTORY_POINTS,
    points: bounded,
  };
  const tmp = `${STATUS_HISTORY_FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(STATUS_HISTORY_FILE), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tmp, STATUS_HISTORY_FILE);
  } catch (err) {
    console.error(`[data-pipeline-status] history snapshot write failed: ${err?.message || err}`);
  }
}

function cachedSummaryPayload(cached) {
  if (!cached) {
    const missingBlockers = [`no cached summary at ${STATUS_SUMMARY_FILE}`];
    const missingBlockerDetails = blockerDetails(missingBlockers);
    const missingBlockerSummary = blockerSummary(missingBlockerDetails);
    return {
      ok: false,
      complete: false,
      phase: 'unknown',
      checked_at: null,
      next_action: 'run data-pipeline-status.js --summary-json to refresh the cached status',
      status_action: statusAction({
        ok: false,
        complete: false,
        phase: 'unknown',
        blockerSummary: missingBlockerSummary,
        warningSummary: warningSummary([]),
      }),
      blockers: missingBlockers,
      blocker_details: missingBlockerDetails,
      blocker_summary: missingBlockerSummary,
      warnings: [],
      warning_details: [],
      warning_summary: warningSummary([]),
      snapshot: {
        path: STATUS_SUMMARY_FILE,
        present: false,
        fresh: false,
        age_ms: null,
        max_age_ms: MAX_STATUS_SUMMARY_AGE_MS,
        reason: 'missing',
      },
    };
  }
  const snapshot = cached.snapshot && typeof cached.snapshot === 'object' ? cached.snapshot : {};
  const age = ageMs(snapshot.written_at);
  const fresh = age !== null && age <= MAX_STATUS_SUMMARY_AGE_MS;
  const cachedStatusScriptSha256 = snapshot.status_script_sha256 || null;
  const currentStatusScriptSha256 = fileSha256(STATUS_SCRIPT_FILE);
  const statusCodeCurrent = Boolean(
    cachedStatusScriptSha256
      && currentStatusScriptSha256
      && cachedStatusScriptSha256 === currentStatusScriptSha256,
  );
  const cacheBlockers = [];
  if (!fresh) {
    cacheBlockers.push(`cached summary is stale (${age ?? 'unknown'}ms > ${MAX_STATUS_SUMMARY_AGE_MS}ms); run --summary-json`);
  }
  if (!statusCodeCurrent) {
    cacheBlockers.push('cached summary was produced by stale status code; run --summary-json');
  }
  const cachedBlockers = [...cacheBlockers, ...(cached.blockers || [])];
  const cachedBlockerDetails = blockerDetails(cachedBlockers);
  const cachedBlockerSummary = blockerSummary(cachedBlockerDetails);
  const cachedWarningDetails = cached.warning_details || warningDetails(cached.warnings || []);
  const cachedWarningSummary = cached.warning_summary || warningSummary(cachedWarningDetails);
  const cachedOk = cached.ok === true && fresh && statusCodeCurrent;
  const cachedStatusAction = cacheBlockers.length === 0 && cached.status_action
    ? cached.status_action
    : statusAction({
      ok: cachedOk,
      complete: cached.complete === true,
      phase: cached.phase || 'unknown',
      blockerSummary: cachedBlockerSummary,
      warningSummary: cachedWarningSummary,
    });
  return {
    ...cached,
    ok: cachedOk,
    cached_ok: cached.ok === true,
    blockers: cachedBlockers,
    blocker_details: cachedBlockerDetails,
    blocker_summary: cachedBlockerSummary,
    warning_details: cachedWarningDetails,
    warning_summary: cachedWarningSummary,
    status_action: cachedStatusAction,
    snapshot: {
      ...snapshot,
      path: snapshot.path || STATUS_SUMMARY_FILE,
      present: true,
      age_ms: age,
      max_age_ms: MAX_STATUS_SUMMARY_AGE_MS,
      fresh,
      current_status_script_sha256: currentStatusScriptSha256,
      status_code_current: statusCodeCurrent,
    },
  };
}

function cadenceDeferEvidence(payload) {
  const action = payload?.status_action || {};
  const recheckMs = Date.parse(String(action.recheck_after || ''));
  const remainingMs = Number.isFinite(recheckMs) ? Math.max(0, recheckMs - Date.now()) : null;
  const defer = payload?.ok === true
    && payload?.complete !== true
    && action.cadence === 'defer_until_recheck'
    && action.operator_action_required === false
    && Number.isFinite(remainingMs)
    && remainingMs > 0;
  return {
    defer,
    reason: defer ? 'cached_status_within_recheck_window' : 'live_probe_required',
    remaining_ms: remainingMs,
    recheck_after: action.recheck_after || null,
  };
}

function cadenceCachedPayload(payload, evidence) {
  return {
    ...payload,
    cadence_cache: {
      served_from_cache: true,
      reason: evidence.reason,
      remaining_ms: evidence.remaining_ms,
      recheck_after: evidence.recheck_after,
    },
    snapshot: {
      ...(payload.snapshot || {}),
      served_from_cache_by_cadence: true,
      cadence_remaining_ms: evidence.remaining_ms,
    },
  };
}

function printText(report) {
  console.log(`data_pipeline: ${report.ok ? 'healthy' : 'blocked'} (${report.phase})`);
  console.log(`complete: ${report.complete}`);
  if (report.db.ok) {
    console.log(`pending_embeddings: ${report.db.chunks.pending}`);
    console.log(`personal_pending: ${report.db.personal.pending}`);
    console.log(`non_personal_pending: ${report.db.non_personal_pending}`);
    console.log(`work_order_selectable_pending: ${report.db.work_order.selectable_pending}`);
    console.log(`work_order_blocked_pending: ${report.db.work_order.blocked_pending}`);
    if (report.db.work_order.head?.ok) {
      const head = report.db.work_order.head.topics
        .map((row) => `${row.topic}=${row.pending}/p${row.priority}/short${row.short_pending}/long${row.long_pending}`)
        .join(', ');
      console.log(`work_order_head: ${head || '(empty)'} elapsed_ms=${report.db.work_order.head.elapsed_ms}`);
    } else if (report.db.work_order.head) {
      console.log(`work_order_head: failed error=${report.db.work_order.head.error || 'unknown'} elapsed_ms=${report.db.work_order.head.elapsed_ms ?? 'unknown'}`);
    }
    if (report.db.work_order.blocked_pending > 0) {
      console.log(`work_order_blocked_breakdown: blank_topic=${report.db.work_order.blank_topic_pending} empty_content=${report.db.work_order.empty_content_pending} malformed_rank=${report.db.work_order.malformed_rank_pending}`);
    }
    if (report.db.non_personal_pending_topics?.length) {
      console.log(`non_personal_pending_topics: ${report.db.non_personal_pending_topics.map((row) => `${row.topic}=${row.pending}`).join(', ')}`);
    }
    console.log(`needs_routing_chunks: ${report.db.needs_routing.chunks}`);
    console.log(`needs_routing_pending: ${report.db.needs_routing.pending}`);
    console.log(`needs_routing_current_memory_links: ${report.db.needs_routing.current_memory_links}`);
    console.log(`needs_routing_audit_memory_links: ${report.db.needs_routing.audit_memory_links}`);
  }
  if (report.global_ann) {
    console.log(`global_ann: ${report.global_ann.ready ? 'ready' : report.global_ann.state} reason=${report.global_ann.reason} live_embedded=${report.global_ann.live_embedded ?? 'unknown'} built_from=${report.global_ann.built_from_count ?? 'missing'}`);
  }
  if (report.stale_vector_projection) {
    console.log(
      `stale_vector_projection: ${report.stale_vector_projection.ok ? 'ok' : 'pending'}` +
      ` stale=${report.stale_vector_projection.stale_vectors ?? 'unknown'}` +
      ` tables=${report.stale_vector_projection.tables_checked ?? 'unknown'}` +
      ` malformed=${report.stale_vector_projection.malformed_tables ?? 'unknown'}`
    );
  }
  if (report.launch_contract) {
    const counts = report.launch_contract.counts || {};
    console.log(`launch_contract: ${report.launch_contract.status} ok=${counts.ok || 0} pending=${counts.pending || 0} blocked=${counts.blocked || 0}`);
    if (report.launch_contract.next_step) {
      const step = report.launch_contract.next_step;
      console.log(`launch_contract_next: ${step.id} ${step.status} - ${step.detail}`);
    }
  }
  const eta = report.effective_eta?.hours
    ?? report.live_drain_progress?.eta_hours_at_latest_pass_rate
    ?? null;
  if (eta !== null) console.log(`eta_hours: ${eta}`);
  if (report.effective_eta?.days !== null && report.effective_eta?.days !== undefined) {
    console.log(`eta_days: ${report.effective_eta.days}`);
  }
  if (report.effective_eta?.estimated_done_at) {
    console.log(`eta_done_at: ${report.effective_eta.estimated_done_at}`);
  }
  if (report.effective_eta?.authoritative_eta_source) {
    console.log(`eta_source: ${report.effective_eta.authoritative_eta_source}`);
  }
  if (report.effective_eta?.non_authoritative_sample_hours !== null && report.effective_eta?.non_authoritative_sample_hours !== undefined) {
    console.log(`sample_eta_hours: ${report.effective_eta.non_authoritative_sample_hours}`);
    console.log(`sample_eta_days: ${report.effective_eta.non_authoritative_sample_days}`);
    console.log(`sample_eta_done_at: ${report.effective_eta.non_authoritative_sample_estimated_done_at}`);
    console.log(`sample_eta_rate_per_hour: ${report.effective_eta.non_authoritative_sample_rate_per_hour}`);
    console.log(`sample_eta_representative: ${report.effective_eta.non_authoritative_sample_representative}`);
    console.log(`sample_eta_reason: ${report.effective_eta.non_authoritative_sample_reason}`);
  }
  if (report.drain_trend) {
    console.log(
      `drain_trend: basis=${report.drain_trend.basis || 'unknown'}` +
      ` requested_window_hours=${report.drain_trend.requested_window_hours ?? 'unknown'}` +
      ` window_hours=${report.drain_trend.window_hours}` +
      ` samples=${report.drain_trend.sample_count}` +
      ` pending_drained=${report.drain_trend.pending_drained ?? 'unknown'}` +
      ` rate_per_hour=${report.drain_trend.rate_per_hour ?? 'unknown'}` +
      ` eta_hours=${report.drain_trend.eta_hours ?? 'unknown'}` +
      ` representative=${report.drain_trend.representative === true}` +
      ` reason=${report.drain_trend.representative_reason || 'none'}` +
      ` moving=${report.drain_trend.moving === true}`,
    );
  }
  const speedPosture = compactSpeedPosture(
    report,
    report.status_action || statusAction({
      ok: report.ok,
      complete: report.complete,
      phase: report.phase,
      blockerSummary: report.blocker_summary,
      warningSummary: report.warning_summary,
    }),
  );
  console.log(
    `speed_posture: mode=${speedPosture.mode}` +
    ` user_speed_goal=${speedPosture.user_speed_goal}` +
    ` backfill_speed_goal=${speedPosture.backfill_speed_goal}` +
    ` normal_user_path=${speedPosture.normal_user_path}` +
    ` raw_throughput_launch_metric=${speedPosture.raw_throughput_launch_metric}` +
    ` wait_only=${speedPosture.wait_only}` +
    ` pending=${speedPosture.pending_embeddings ?? 'unknown'}` +
    ` trend_rate_per_hour=${speedPosture.trend_rate_per_hour ?? 'unknown'}` +
    ` trend_eta_hours=${speedPosture.trend_eta_hours ?? 'unknown'}` +
    ` sample_rate_per_hour=${speedPosture.sample_rate_per_hour ?? 'unknown'}` +
    ` sample_eta_hours=${speedPosture.sample_eta_hours ?? 'unknown'}` +
    ` memory_pressure=${speedPosture.memory_pressure || 'unknown'}` +
    ` can_add_lane_by_rss=${speedPosture.can_add_lane_by_rss}` +
    ` acceleration_allowed=${speedPosture.acceleration_allowed}` +
    ` reason=${speedPosture.reason}`,
  );
  if (report.live_drain_progress) {
    console.log(`live_progress_state: ${report.live_drain_progress.state}`);
    console.log(`live_progress_delta_since_pass: ${report.live_drain_progress.pending_delta_since_latest_pass ?? 'unknown'}`);
    console.log(`live_progress_current_run_completed: ${report.live_drain_progress.current_run_completed_from_db ?? 'unknown'}`);
    console.log(`live_progress_observed_rate_per_hour: ${report.live_drain_progress.observed_rate_per_hour ?? 'unknown'}`);
    console.log(`live_progress_observed_sample_rate_per_hour: ${report.live_drain_progress.observed_sample_rate_per_hour ?? 'unknown'}`);
    console.log(`live_progress_observed_sample_eta_hours: ${report.live_drain_progress.observed_sample_eta_hours ?? 'unknown'}`);
    console.log(`live_progress_observed_rate_completed: ${report.live_drain_progress.observed_rate_completed ?? 'unknown'}`);
    console.log(`live_progress_observed_rate_representative: ${report.live_drain_progress.observed_rate_representative}`);
    console.log(`live_progress_eta_rate_per_hour: ${report.live_drain_progress.eta_rate_per_hour ?? 'unknown'}`);
    console.log(`live_progress_required_rate_per_hour: ${report.live_drain_progress.required_rate_per_hour_for_target ?? 'unknown'}`);
    console.log(`live_progress_observed_rate_gap_per_hour: ${report.live_drain_progress.observed_rate_gap_per_hour_for_target ?? 'unknown'}`);
    console.log(`live_progress_eta_rate_gap_per_hour: ${report.live_drain_progress.rate_gap_per_hour_for_target ?? 'unknown'}`);
    console.log(`live_progress_yielding_to_foreground: ${report.live_drain_progress.yielding_to_foreground}`);
    console.log(`live_progress_log_age_ms: ${report.live_drain_progress.log_age_ms ?? 'unknown'}`);
  }
  if (report.logs) {
    console.log(`drain_log: ${report.logs.drain || 'unknown'}`);
    console.log(`post_drain_log: ${report.logs.post_drain || 'unknown'}`);
    console.log(`post_drain_launchd_log: ${report.logs.post_drain_launchd || 'unknown'}`);
  }
  if (report.drain_log?.latest_pass) {
    const pass = report.drain_log.latest_pass;
    console.log(`drain_latest_pass: pass=${pass.pass ?? 'unknown'} topic=${pass.topic || 'unknown'} pending=${pass.pending ?? 'unknown'} rate_per_hour=${pass.rate_per_hour ?? 'unknown'} aborted=${pass.aborted || 'unknown'}`);
  }
  if (report.drain_log?.latest_drain_progress) {
    const progress = report.drain_log.latest_drain_progress;
    console.log(`drain_latest_progress: pass=${progress.pass ?? 'unknown'} topic=${progress.topic || 'unknown'} completed=${progress.completed ?? 'unknown'} pending_estimate=${progress.pending_estimate ?? 'unknown'} rate_per_hour=${progress.rate_per_hour ?? 'unknown'}`);
  }
  if (report.drain_intensity) {
    const effective = report.drain_effective_capacity || {};
    console.log(`drain_lanes: child=${report.drain_intensity.lane_count}/${report.drain_intensity.max_lane_count} effective=${effective.effective_count ?? 'unknown'} requested=${effective.requested ?? 'unknown'} mode=${effective.mode || 'unknown'}`);
    console.log(`drain_rss_mb: ${report.drain_intensity.total_rss_mb}`);
    console.log(`drain_acceleration: ${report.drain_intensity.recommendation}`);
  }
  console.log(`drain_hold: ${report.hold.active ? `${report.hold.reason} pid=${report.hold.pid}` : 'inactive'}`);
  console.log(`drain_wrapper: ${report.services.drain_wrapper.process_alive ? `alive pid=${report.services.drain_wrapper.pid}` : 'not_alive'}`);
  if (report.drain_code) {
    const wrapper = report.drain_code.wrapper?.current === true ? 'current' : 'stale_or_unknown';
    const worker = report.drain_code.worker?.current === true ? 'current' : 'stale_or_unknown';
    console.log(`drain_code: wrapper=${wrapper} worker=${worker}`);
  }
  console.log(`embed_daemon: ${report.services.embed_daemon.process_alive ? `alive pid=${report.services.embed_daemon.pid}` : 'not_alive'}`);
  if (report.embed_daemon_code) {
    console.log(`embed_daemon_code: ${report.embed_daemon_code.current ? 'current' : 'stale_or_unknown'}`);
  }
  console.log(`post_drain_watcher: ${report.services.post_drain_watcher.process_alive ? `alive pid=${report.services.post_drain_watcher.pid}` : 'not_alive'} status=${report.post_drain.status || 'missing'}`);
  if (report.post_drain.current_step) {
    console.log(`post_drain_step: ${report.post_drain.current_step}`);
    console.log(`post_drain_step_pid: ${report.post_drain.current_step_pid || 'unknown'}`);
    console.log(`post_drain_step_attempt: ${report.post_drain.current_step_attempt || 'unknown'}/${report.post_drain.current_step_attempts || 'unknown'}`);
    console.log(`post_drain_step_heartbeat_at: ${report.post_drain.current_step_heartbeat_at || 'unknown'}`);
  }
  console.log(`post_drain_lock: ${report.post_drain.lock.present ? `owner pid=${report.post_drain.lock.owner_pid || 'unknown'} matches_watcher=${report.post_drain.lock.owner_matches_watcher}` : 'missing'}`);
  if (report.post_drain.chunk_source_quiescence) {
    console.log(`post_drain_chunk_source_quiescence: ${report.post_drain.chunk_source_quiescence.ok ? 'ok' : 'waiting'} active_running=${report.post_drain.chunk_source_quiescence.active_running ?? 'unknown'} waited_ms=${report.post_drain.chunk_source_quiescence.waited_ms ?? 'unknown'}`);
  }
  if (report.post_drain.embed_hold) {
    console.log(`post_drain_embed_hold: ${report.post_drain.embed_hold.ok ? 'ok' : 'failed'} reason=${report.post_drain.embed_hold.hold_reason || report.post_drain.embed_hold.reason || 'unknown'} pid=${report.post_drain.embed_hold.pid || 'unknown'}`);
  }
  if (report.post_drain.embed_hold_release) {
    console.log(`post_drain_embed_hold_release: ${report.post_drain.embed_hold_release.ok ? 'ok' : 'failed'} reason=${report.post_drain.embed_hold_release.reason || 'unknown'}`);
  }
  if (report.post_drain.split_vec_orphan_repair_after_reclassify) {
    const repair = report.post_drain.split_vec_orphan_repair_after_reclassify;
    console.log(`split_vec_repair: ${repair.ok ? 'ok' : 'failed'} stale_pruned=${repair.stale_pruned ?? 'unknown'} split_pruned=${repair.split_pruned ?? 'unknown'} exact_source=${repair.exact_source ?? 'unknown'} ambient_source=${repair.ambient_source ?? 'unknown'} missing_source=${repair.missing_source ?? 'unknown'}`);
  }
  if (report.post_drain.runner_code) {
    console.log(`post_drain_code: ${report.post_drain.runner_code.matches_disk ? 'current' : 'stale_or_missing'}`);
  }
  if (report.post_drain.preflight) {
    const status = report.post_drain.preflight.present
      ? `${report.post_drain.preflight.ok ? 'ok' : 'failed'} age_ms=${report.post_drain.preflight.age_ms ?? 'unknown'}`
      : 'missing';
    console.log(`post_drain_preflight: ${status}`);
    const annProjection = report.post_drain.preflight.global_ann_source_projection;
    if (annProjection) {
      const annFreshness = report.post_drain.preflight_ann_source_freshness || {};
      console.log(`global_ann_source_projection: ${annProjection.ok ? 'ok' : 'failed'} embedded=${annProjection.embedded_total ?? 'unknown'} live=${annFreshness.live_embedded ?? 'unknown'} lag=${annFreshness.lag_chunks ?? 'unknown'} readable=${annProjection.readable_vectors ?? 'unknown'} missing=${annProjection.missing_vectors ?? 'unknown'} dim=${annProjection.hnsw_dims ?? 'unknown'}`);
    }
    const topicProjection = report.post_drain.preflight.topic_context_projection;
    if (topicProjection) {
      console.log(`topic_context_projection: ${topicProjection.ok ? 'ok' : 'failed'} pending=${topicProjection.pending_now ?? 'unknown'} total=${topicProjection.total_topics ?? 'unknown'} capacity=${topicProjection.capacity ?? 'unknown'}`);
    }
    const backupProjection = report.post_drain.preflight.backup_dispatcher_projection;
    if (backupProjection) {
      const projection = backupProjection.projection || {};
      console.log(`backup_projection: ${backupProjection.ok ? 'ok' : 'failed'} snapshot=${projection.db_snapshot_method || 'unknown'} missing_required=${Array.isArray(projection.db_missing_required) ? projection.db_missing_required.length : 'unknown'}`);
    }
    const reclassifyProjection = report.post_drain.preflight.reclassify_projection;
    if (reclassifyProjection) {
      const projection = reclassifyProjection.projection || {};
      console.log(`reclassify_projection: ${reclassifyProjection.ok ? 'ok' : 'failed'} status=${projection.status || 'unknown'} changed=${reclassifyProjection.projected_changed ?? 'unknown'} passes=${Array.isArray(projection.passes) ? projection.passes.length : 'unknown'}`);
    }
    const memoryProjection = report.post_drain.preflight.memory_refocus_projection;
    if (memoryProjection) {
      const projection = memoryProjection.projection || {};
      console.log(`memory_refocus_projection: ${memoryProjection.ok ? 'ok' : 'failed'} before=${projection.before_current_needs_routing_links ?? 'unknown'} after=${projection.after_current_needs_routing_links ?? 'unknown'} threshold=${memoryProjection.threshold ?? 'unknown'}`);
    }
  }
  console.log(`handoff_status: ${report.handoff.status || 'missing'}`);
  if (report.post_drain.readiness?.effective_handoff_status) {
    console.log(`handoff_effective: ${report.post_drain.readiness.effective_handoff_status}`);
  }
  if (report.post_drain.readiness?.effective_handoff_launchd_clearance) {
    const clearance = report.post_drain.readiness.effective_handoff_launchd_clearance;
    console.log(`handoff_launchd_clearance: ${clearance.ok ? 'ok' : 'blocked'} reason=${clearance.reason || 'unknown'}`);
  }
  if (report.complete && report.final_product_proof) {
    const rows = report.final_product_proof.required_rows
      .map((id) => `${id}=${report.final_product_proof.rows?.[id]?.status || 'missing'}`)
      .join(', ');
    console.log(`final_product_proof: ${report.final_product_proof.ok ? 'ok' : 'blocked'} rows=${rows}`);
    if (report.post_drain.post_product_proof_backlog_check) {
      console.log(`post_product_proof_backlog_check: ${report.post_drain.post_product_proof_backlog_check.ok ? 'ok' : 'failed'} pending=${report.post_drain.post_product_proof_backlog_check.pending_embeddings ?? 'unknown'}`);
    }
  }
  if (report.blockers.length) {
    console.log('blockers:');
    for (const blocker of report.blockers) console.log(`- ${blocker}`);
  } else {
    console.log('blockers: none');
  }
  if (report.blocker_summary) {
    console.log(`blocker_summary: total=${report.blocker_summary.total} unclassified=${report.blocker_summary.unclassified} operator_action_required=${report.blocker_summary.operator_action_required}`);
  }
  if (report.status_action) {
    console.log(`status_action: kind=${report.status_action.kind} action=${report.status_action.action} operator_action_required=${report.status_action.operator_action_required} recheck_after_ms=${report.status_action.recheck_after_ms ?? 'unknown'}`);
  }
  if (report.warnings.length) {
    console.log('warnings:');
    for (const warning of report.warnings) console.log(`- ${warning}`);
  }
  if (report.warning_summary) {
    console.log(`warning_summary: total=${report.warning_summary.total} info=${report.warning_summary.info} warning=${report.warning_summary.warning} operator_action_required=${report.warning_summary.operator_action_required}`);
  }
  console.log(`next: ${report.next_action}`);
}

if (latestSummaryJsonMode) {
  const cached = cachedSummaryPayload(readJson(STATUS_SUMMARY_FILE));
  emitJson(cached);
  if (strictMode && !cached.ok) process.exit(1);
  process.exit(0);
}

if (summaryJsonMode && respectCadenceMode) {
  const cached = cachedSummaryPayload(readJson(STATUS_SUMMARY_FILE));
  const cadence = cadenceDeferEvidence(cached);
  if (cadence.defer) {
    const payload = cadenceCachedPayload(cached, cadence);
    emitJson(payload);
    if (strictMode && !payload.ok) process.exit(1);
    process.exit(0);
  }
}

const report = await buildReport({ fastSummary: summaryJsonMode });
const compactSummary = writeCompactStatusSnapshot(compactStatusSummary(report));
writeStatusHistorySnapshot(compactSummary);
if (summaryJsonMode) {
  emitJson(compactSummary);
} else if (jsonMode) {
  emitJson(report);
} else {
  printText(report);
}
if (strictMode && !report.ok) process.exit(1);
