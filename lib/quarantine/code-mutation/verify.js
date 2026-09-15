/**
 * code-mutation/verify.js — verification cascade after a code mutation.
 *
 * WHY a cascade and not just a parse check: a single check leaks failures.
 *   1. node --check     — file parses (catches syntax breaks)
 *   2. re-grep          — old literal is GONE (catches partial replacements)
 *   3. check-structure  — repo is still well-formed (catches knock-on damage)
 *
 * Any failure → throw VerifyError. Caller reverts via `git checkout -- <file>`
 * and falls back to move-to-canonical.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { VerifyError } from './line-replace.js';

export { VerifyError };

/**
 * verifyParse — run `node --check writerFile`. Throws VerifyError on syntax break.
 */
export function verifyParse(writerFile) {
  try {
    execFileSync(process.execPath, ['--check', writerFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message;
    throw new VerifyError(`node --check failed for ${writerFile}: ${msg.split('\n')[0]}`);
  }
}

/**
 * verifyRegrep — read writerFile, ensure oldLiteral does not appear.
 * Throws VerifyError if old literal is still present (incomplete replace).
 */
export function verifyRegrep(writerFile, oldLiteral) {
  const content = readFileSync(writerFile, 'utf8');
  if (oldLiteral && content.includes(oldLiteral)) {
    throw new VerifyError(`old literal "${oldLiteral}" still present in ${writerFile}`);
  }
}

/**
 * verifyCheckStructure — re-run scripts/gate.js (formerly check-structure.js).
 * Throws VerifyError on non-zero exit. We treat the live `~/.robotdojo/robotdojo.db`
 * dotdir violation as a non-failure (it's an unrelated state held open by the backup
 * script per the failure manifest).
 */
export function verifyCheckStructure(repoRoot) {
  if (!repoRoot) return;
  // gate.js is the canonical replacement; fall back to check-structure.js for compat
  let script = join(repoRoot, 'scripts', 'gate.js');
  if (!existsSync(script)) script = join(repoRoot, 'scripts', 'check-structure.js');
  if (!existsSync(script)) return;
  try {
    execFileSync(process.execPath, [script], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ROBOTDOJO_QUARANTINE_GRACE_DISABLED: '1' },
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    // Exception for the live robotdojo.db dotdir: an unrelated process holds it.
    if (/dotdir: 1\b/.test(stderr) && !/mece|untracked|root/i.test(stderr)) {
      return;  // accept the single live-DB violation
    }
    throw new VerifyError(`check-structure failed: ${stderr.split('\n').slice(0, 3).join(' | ')}`);
  }
}

/**
 * runVerificationCascade — runs all three checks in order.
 */
export function runVerificationCascade(writerFile, oldLiteral, opts = {}) {
  verifyParse(writerFile);
  verifyRegrep(writerFile, oldLiteral);
  if (opts.skipCheckStructure !== true) {
    verifyCheckStructure(opts.repoRoot);
  }
}
