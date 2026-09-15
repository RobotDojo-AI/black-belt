// lib/memory-verify-phase.js — MEMORY_VERIFY maintenance phase body.
//
// Story st_b9ec1b7c. The maint_memory_verify routine fires this against the
// canonical chain daily so a
// future fork surfaces as a phase failure (and downstream Asana task) the
// next morning, instead of going silent for weeks (the exact regression this
// story remediated).
//
// Living in lib/ (not inline in scripts/maintenance-phases.js) so it can be
// invoked by tests against a deliberately corrupted fixture chain without
// triggering the phase runner's top-level withLaunchDbWriterGuard.

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const _here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VERIFY_SCRIPT = resolve(_here, '..', 'user', 'memory', 'bin', 'memory-verify.js');

/**
 * Run the memory-verify subprocess.
 *
 * @param {object} [opts]
 * @param {string} [opts.verifyScript] absolute path to the verify CLI
 *                                     (defaults to the canonical one)
 * @param {number} [opts.timeoutMs]    spawn timeout (default 60s, same as the phase runner)
 * @returns {{ ok, exitCode, stdout, stderr, summary }}
 *
 * Caller contract: a non-zero `exitCode` is a phase failure. The maintenance
 * orchestrator throws on it, which runPhase records and which fires an
 * Asana task. The same contract applies to test callers — a corrupted
 * fixture chain must produce ok=false.
 */
export function runMemoryVerifyPhase(opts = {}) {
  const verifyScript = opts.verifyScript || DEFAULT_VERIFY_SCRIPT;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const r = spawnSync(process.execPath, [verifyScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  return {
    ok: r.status === 0,
    exitCode: r.status,
    stdout,
    stderr,
    summary: stdout.split('\n')[0] || '',
  };
}
