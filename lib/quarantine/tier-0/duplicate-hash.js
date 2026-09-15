/**
 * tier-0/duplicate-hash.js — sha256 the file, check for byte-identical duplicates
 * elsewhere in the tree.
 *
 * WHY: a byte-identical duplicate is unambiguously safe to route to
 * quarantine/duplicates/<sha>-<basename>. NEVER delete — both copies
 * preserved per the never-delete rule. The hash + basename naming makes
 * dedup auditable (the owner can see why each file was retained).
 *
 * Only fires when an identical file is found in the tracked codebase.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename, relative } from 'node:path';
import crypto from 'node:crypto';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function detectDuplicateHash(absPath, opts = {}) {
  const repoRoot = opts.repoRoot;
  if (!repoRoot || !existsSync(absPath)) return null;
  try {
    if (!statSync(absPath).isFile()) return null;
  } catch {
    return null;
  }

  let buf;
  try {
    buf = readFileSync(absPath);
  } catch {
    return null;
  }
  // Skip very large files (>5MB) — duplicate detection on huge blobs is
  // expensive and unlikely to be useful.
  if (buf.byteLength > 5 * 1024 * 1024) return null;

  const fileHash = sha256(buf);
  const fileName = basename(absPath);

  // Walk tracked files of the same basename and compare.
  let raw;
  try {
    raw = execSync(`git ls-files 2>/dev/null | grep -F ${JSON.stringify(fileName)} 2>/dev/null || true`, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
  if (!raw) return null;

  for (const candidateRel of raw.split('\n').filter(Boolean)) {
    const candidate = join(repoRoot, candidateRel);
    if (candidate === absPath) continue;
    try {
      const cBuf = readFileSync(candidate);
      if (cBuf.byteLength !== buf.byteLength) continue;
      if (sha256(cBuf) === fileHash) {
        return {
          signal_name: 'duplicate-hash',
          destination: `quarantine/duplicates/${fileHash}-${fileName}`,
          confidence: 0.95,
          reason: `byte-identical duplicate of ${candidateRel}`,
          action: 'move-to-canonical',
          duplicate_of: candidateRel,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}
