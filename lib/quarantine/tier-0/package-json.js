/**
 * tier-0/package-json.js — check package.json bin/scripts for a path reference.
 *
 * WHY: any file that's an entry point (declared in `bin` or `scripts`) is, by
 * definition, in the right place — package.json is the canonical declaration.
 * If a file is referenced as a script entry, its location is canonical.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

export function detectPackageJson(absPath, opts = {}) {
  const repoRoot = opts.repoRoot;
  if (!repoRoot) return null;
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }

  const rel = relative(repoRoot, absPath);
  const name = basename(absPath);

  const hits = [];

  // bin field
  if (pkg.bin) {
    if (typeof pkg.bin === 'string' && (pkg.bin === rel || pkg.bin.endsWith('/' + name))) {
      hits.push({ where: 'bin', value: pkg.bin });
    } else if (typeof pkg.bin === 'object') {
      for (const [k, v] of Object.entries(pkg.bin)) {
        if (v === rel || v.endsWith('/' + name)) hits.push({ where: `bin.${k}`, value: v });
      }
    }
  }

  // scripts field — npm scripts can invoke files by path
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const [k, v] of Object.entries(pkg.scripts)) {
      if (typeof v === 'string' && (v.includes(rel) || v.includes(name))) {
        hits.push({ where: `scripts.${k}`, value: v });
      }
    }
  }

  if (hits.length === 0) return null;

  return {
    signal_name: 'package-json',
    destination: rel,  // file is at its canonical home; no move
    confidence: 0.9,
    reason: `referenced in package.json: ${hits.map(h => h.where).join(', ')}`,
    action: null,  // advisory: no move needed
    hits,
  };
}
