#!/usr/bin/env node
/**
 * scripts/backup-status.js — which outcome the last backup attempt had.
 *
 * Before df_3df1f108 a failed run and a run that never happened left the same
 * evidence: none. This reads the attempt marker and the terminal record and
 * reports one of exactly five outcomes — succeeded, failed, skipped,
 * never_started, killed — plus whether a run is in flight right now.
 *
 * `outcome` always describes the last RESOLVED attempt. A run currently in
 * flight appears under `in_flight` and does not overwrite the outcome, because
 * "a run is happening" is not an answer to "what happened last time".
 *
 * Compute tier 0 — two small JSON reads and a `sysctl`. No LLM call.
 *
 *   node scripts/backup-status.js          # human summary
 *   node scripts/backup-status.js --json   # machine-readable
 */
export const INTELLIGENCE_TIER = 'extraction';

import {
  currentBootSeconds,
  deriveOutcome,
  evidencePaths,
  readEvidence,
  scheduledSlotMissed,
} from '../lib/backup-evidence.js';

export function backupStatus({ configDir, now = new Date() } = {}) {
  const { marker, terminal, poweron } = readEvidence(configDir);
  const bootSec = currentBootSeconds();
  const derived = deriveOutcome(marker, terminal, { bootSec });

  const lastSuccessAt = terminal?.outcome === 'success' ? terminal.finished_at : null;
  const missed = scheduledSlotMissed({
    now,
    lastSuccessAt,
    lastAttemptAt: marker?.started_at || null,
  });

  return {
    outcome: derived.outcome,
    attempt_id: derived.attempt_id,
    resolved_from: derived.resolved_from,
    in_flight: derived.in_flight
      ? { attempt_id: derived.in_flight.attempt_id, started_at: derived.in_flight.started_at, pid: derived.in_flight.pid, trigger: derived.in_flight.trigger }
      : null,
    last_attempt_at: marker?.started_at || null,
    last_terminal_at: terminal?.finished_at || null,
    last_success_at: lastSuccessAt,
    reason: terminal?.reason || null,
    error: terminal?.error || null,
    scheduled_slot_missed: missed,
    poweron_seconds: poweron?.poweron_seconds ?? null,
    boot_sec: bootSec,
    evidence_paths: evidencePaths(configDir),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const status = backupStatus();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(status)}\n`);
  } else {
    process.stdout.write(`backup outcome: ${status.outcome}\n`);
    process.stdout.write(`  last attempt:  ${status.last_attempt_at || '(none)'}\n`);
    process.stdout.write(`  last success:  ${status.last_success_at || '(none)'}\n`);
    process.stdout.write(`  in flight:     ${status.in_flight ? `${status.in_flight.attempt_id} since ${status.in_flight.started_at}` : 'no'}\n`);
    process.stdout.write(`  missed slot:   ${status.scheduled_slot_missed ? 'yes' : 'no'}\n`);
    if (status.reason) process.stdout.write(`  reason:        ${status.reason}\n`);
    if (status.error) process.stdout.write(`  error:         ${status.error}\n`);
  }
}
