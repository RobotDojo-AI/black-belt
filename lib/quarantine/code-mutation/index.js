/**
 * code-mutation/index.js — fix-code orchestrator.
 *
 * WHY a single entry point: callers need a clean "mutate, verify, revert on
 * failure" abstraction. The mutation engine and the verification cascade
 * share a revert path; this module owns that contract.
 *
 * On any verification failure: `git checkout -- <writerFile>` to restore from
 * HEAD, throw VerifyError. The caller (orchestrator) catches and falls back
 * to move-to-canonical, recording the fallback reason in the manifest.
 */

import { execFileSync } from 'node:child_process';
import { lineReplace, VerifyError } from './line-replace.js';
import { runVerificationCascade } from './verify.js';

export { VerifyError };

/**
 * gitCheckout — revert a file to HEAD. Used when the verification cascade fails.
 * If the file isn't tracked, this throws — caller handles best-effort revert.
 */
function gitCheckout(repoRoot, file) {
  try {
    execFileSync('git', ['checkout', '--', file], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    // best effort — log but don't throw
  }
}

/**
 * fixCode — perform the code mutation + verification cascade.
 *
 * Args: { writerFile, oldLiteral, newLiteral, repoRoot, skipCheckStructure }
 *
 * Returns { ok: true, mutated, replacedCount } on success.
 * Throws VerifyError on any failure (caller is expected to revert + fall back).
 */
export function fixCode({ writerFile, oldLiteral, newLiteral, repoRoot, skipCheckStructure }) {
  if (!writerFile || !oldLiteral) {
    throw new VerifyError('fixCode: writerFile and oldLiteral required');
  }
  // Mutate
  const result = lineReplace(writerFile, oldLiteral, newLiteral);

  // Verification cascade — any throw triggers revert below
  try {
    runVerificationCascade(writerFile, oldLiteral, { repoRoot, skipCheckStructure });
  } catch (err) {
    if (repoRoot) gitCheckout(repoRoot, writerFile);
    throw err;
  }

  return { ok: true, ...result };
}
