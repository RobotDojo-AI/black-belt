#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { getBackupOptions } from '../lib/backup-options.js';
import { writeAttemptMarker, writeTerminalRecord, currentBootSeconds } from '../lib/backup-evidence.js';

export const IDLE_GATED = true;

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const status = getBackupOptions();
const strict = args.includes('--strict');
const noSnapshotDbs = args.includes('--no-snapshot-db') || process.env.ROBOTDOJO_BACKUP_SNAPSHOT_DB === '0';
const snapshotDbs = !noSnapshotDbs && (strict || args.includes('--snapshot-db') || process.env.ROBOTDOJO_BACKUP_SNAPSHOT_DB === '1');
const snapshotMethodArg = args.find((arg) => arg.startsWith('--snapshot-method='));
const snapshotMethod = snapshotMethodArg
  ? snapshotMethodArg.split('=').slice(1).join('=')
  : (args.includes('--snapshot-method') ? args[args.indexOf('--snapshot-method') + 1] : process.env.ROBOTDOJO_BACKUP_SNAPSHOT_METHOD || null);
const resultFileArg = args.find((arg) => arg.startsWith('--result-file='));
const resultFile = resultFileArg
  ? resultFileArg.split('=').slice(1).join('=')
  : (args.includes('--result-file') ? args[args.indexOf('--result-file') + 1] : process.env.ROBOTDOJO_BACKUP_RESULT_FILE);
const TOOL_PATH_DIRS = Object.freeze([
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]);

function childEnv(extra = {}) {
  const existing = String(process.env.PATH || '').split(':').filter(Boolean);
  const path = [...new Set([...TOOL_PATH_DIRS, ...existing])].join(':');
  return {
    ...process.env,
    PATH: path,
    ...extra,
  };
}

function atomicWriteJson(path, payload) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, path);
}

function noop(reason) {
  const payload = {
    ok: true,
    action: 'backup_noop',
    checked_at: new Date().toISOString(),
    reason,
    provider: status.provider,
    configured: status.configured,
    skipped: status.skipped,
    strict,
  };
  if (strict) payload.ok = false;
  atomicWriteJson(resultFile, payload);
  // df_3df1f108 AC5: a dispatcher noop is the `skipped` outcome and it must
  // leave evidence. Until now the payload went ONLY to --result-file, which the
  // LaunchAgent never passes — so a scheduled skip left nothing at all behind
  // and was indistinguishable from a run that never happened. Marker first,
  // terminal second, same order as a real attempt, so the pair is well-formed.
  try {
    const marker = writeAttemptMarker({ trigger: 'dispatcher-noop', bootSec: currentBootSeconds() });
    writeTerminalRecord({ attemptId: marker.attempt_id, outcome: 'skipped', reason, detail: { provider: status.provider, configured: status.configured } });
  } catch { /* evidence must never break the dispatcher's exit contract */ }
  console.log(JSON.stringify(payload));
}

if (status.skipped) {
  noop('skipped');
  process.exit(strict ? 1 : 0);
}

if (!status.configured) {
  noop('unconfigured');
  process.exit(strict ? 1 : 0);
}

if (status.provider !== 'gcp') {
  noop('manual_provider');
  process.exit(strict ? 1 : 0);
}

const child = spawnSync(process.execPath, [
  resolve(here, 'backup-to-gcp.js'),
  ...(args.includes('--force-scheduled') ? ['--force'] : []),
  ...(args.includes('--dry-run') ? ['--dry-run'] : []),
  ...(args.includes('--db-only') ? ['--db-only'] : []),
  ...(snapshotDbs ? ['--snapshot-db'] : []),
  ...(snapshotMethod ? ['--snapshot-method', snapshotMethod] : []),
  ...(strict ? ['--strict'] : []),
  ...(resultFile ? ['--result-file', resultFile] : []),
  // Pass the trigger label through so the attempt marker records WHY this run
  // happened — a scheduled slot, a boot catch-up, or a due-ness catch-up.
  ...(args.filter((arg) => arg.startsWith('--trigger='))),
], {
  stdio: 'inherit',
  env: childEnv(),
});

if (child.error) {
  const payload = {
    ok: false,
    action: 'backup_dispatch_failed',
    checked_at: new Date().toISOString(),
    provider: status.provider,
    error: child.error.message,
    strict,
  };
  atomicWriteJson(resultFile, payload);
  // The child never started, so it wrote no marker of its own. Record the
  // failure here or a spawn error is indistinguishable from a missed schedule.
  try {
    const marker = writeAttemptMarker({ trigger: 'dispatcher-spawn', bootSec: currentBootSeconds() });
    writeTerminalRecord({ attemptId: marker.attempt_id, outcome: 'failure', reason: 'dispatch_failed', error: child.error.message });
  } catch { /* see above */ }
  console.error(JSON.stringify(payload));
  process.exit(1);
}

process.exit(child.status ?? 1);
