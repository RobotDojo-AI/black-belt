/**
 * tier-0/codebase-ref.js — grep the repo for the file's basename as a literal,
 * see if any source code references it.
 *
 * WHY: a file with NO consumer (no source code mentions its basename) is
 * either dead config OR misplaced. A file WITH consumers reveals its writer
 * and reader, which is the strongest signal we have for "where does this
 * belong" (the consumer code declares the canonical path explicitly).
 *
 * Returns a "advisory" signal — the codebase reference set, not a directive
 * to move/fix. Source-finder uses the same grep at execute time.
 */

import { execSync } from 'node:child_process';
import { basename } from 'node:path';

export function detectCodebaseRef(absPath, opts = {}) {
  const repoRoot = opts.repoRoot || (process.env.ROBOTDOJO_REPO_ROOT || '');
  const name = basename(absPath);

  // Grep against tracked files only — avoid scanning node_modules, etc.
  // Limit search to lib/, scripts/, routes/, api/, apps/, tests/.
  const dirs = ['lib', 'scripts', 'routes', 'api', 'apps', 'tests'];
  let matches = [];
  for (const d of dirs) {
    let raw;
    try {
      raw = execSync(`grep -rn -F ${JSON.stringify(name)} ${d}/ 2>/dev/null || true`, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    if (!raw) continue;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const file = line.slice(0, colon);
      const rest = line.slice(colon + 1);
      const colon2 = rest.indexOf(':');
      const lineNo = colon2 >= 0 ? Number(rest.slice(0, colon2)) : null;
      const text = colon2 >= 0 ? rest.slice(colon2 + 1) : rest;
      // Skip the file itself if it appears in matches.
      if (file === absPath) continue;
      matches.push({ file, line: lineNo, text });
    }
  }

  if (matches.length === 0) {
    return {
      signal_name: 'codebase-ref',
      destination: null,
      confidence: 0.6,
      reason: `no consumer found for ${name} — likely dead config or misplaced legacy`,
      action: null,  // advisory only, not a destination directive
      matches: [],
    };
  }

  return {
    signal_name: 'codebase-ref',
    destination: null,
    confidence: 0.5,
    reason: `${matches.length} consumer reference(s) for ${name} — see source-finder for canonical path`,
    action: null,
    matches,
  };
}
