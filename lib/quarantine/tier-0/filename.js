/**
 * tier-0/filename.js — match basename + extension against the canonical-paths
 * registry.
 *
 * WHY: filename uniqueness is a high-signal heuristic. If a file's basename
 * matches a canonical_paths entry exactly, that's our first guess. Combined
 * with another agreeing signal (header, codebase-ref, package-json), Tier 0
 * short-circuits to a decision without ever calling Haiku.
 */

import { basename, extname } from 'node:path';
import { findByFilename, findByRenameSource, isStrayDotdirDb } from '../registry.js';

export function detectByFilename(absPath, relPath, registry) {
  const name = basename(absPath);

  // Direct filename match against canonical_paths.
  const direct = findByFilename(name, registry);
  if (direct) {
    return {
      signal_name: 'filename',
      destination: direct.path,
      confidence: 0.85,
      reason: `filename matches registry entry: ${name} → ${direct.path}`,
      action: 'move-to-canonical',
    };
  }

  // Rename-source match (e.g. config/taxonomy.json → config/taxonomy.user.json).
  const rename = findByRenameSource(relPath, registry);
  if (rename) {
    return {
      signal_name: 'filename',
      destination: rename.path,
      confidence: 0.9,
      reason: `${relPath} should be renamed to ${rename.path} (registry rename_from)`,
      action: 'move-to-canonical',
    };
  }

  // Stray dotdir DB pattern.
  const stray = isStrayDotdirDb(name, registry);
  if (stray) {
    return {
      signal_name: 'filename',
      destination: stray.destination,
      confidence: 0.8,
      reason: `stray dotdir DB pattern: ${name}`,
      action: 'move-to-canonical',
    };
  }

  return null;
}
