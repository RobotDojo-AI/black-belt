/**
 * tier-0/content-header.js — read shebangs, frontmatter, first comment for
 * "canonical location" hints.
 *
 * WHY: many files self-describe. model-train.yaml has `# Usage: ~/.robotdojo/model-train.yaml`
 * in its header; bash scripts shebang to invoke patterns; markdown frontmatter
 * sometimes declares `path:` keys. These are cheap, deterministic signals.
 *
 * Patterns matched (within first 30 lines):
 *   # Usage: <path>
 *   # Canonical: <path>
 *   Usage: <path>
 *   path: <path>            (frontmatter)
 *   ~/.robotdojo/<filename> in body of header (cross-ref to file's own basename)
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const PATTERNS = [
  /^[#\s]*Usage:\s*([^\s]+)/im,
  /^[#\s]*Canonical:\s*([^\s]+)/im,
  /^[#\s]*Source of truth:\s*([^\s]+)/im,
  /^path:\s*([^\s]+)/im,  // YAML frontmatter
];

export function detectContentHeader(absPath) {
  if (!existsSync(absPath)) return null;
  try {
    if (!statSync(absPath).isFile()) return null;
  } catch {
    return null;
  }

  let head;
  try {
    head = readFileSync(absPath, 'utf8').split('\n').slice(0, 30).join('\n');
  } catch {
    return null;
  }

  const name = basename(absPath);

  // First, look for explicit Usage:/Canonical: that mention the same file's
  // basename (proves the directive is about THIS file, not some referenced one).
  for (const re of PATTERNS) {
    const m = head.match(re);
    if (!m) continue;
    const declared = m[1];
    // Sanity: the declared path should mention the file's own basename. This
    // avoids false matches where a doc's frontmatter says "path: /api/foo".
    if (declared.includes(name)) {
      // Strip ~/ to make registry-comparable.
      const dest = declared.replace(/^~\//, '').replace(/^\//, '');
      return {
        signal_name: 'content-header',
        destination: dest,
        confidence: 0.85,
        reason: `header declares Usage/Canonical/path → ${declared}`,
        action: 'move-to-canonical',
      };
    }
  }

  return null;
}
