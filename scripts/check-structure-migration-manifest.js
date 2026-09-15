#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import {
  RETIRED_PRIVATE_ROOTS,
  failOrPass,
  fileExists,
  parseArgs,
  readJson,
} from './check-final-structure-lib.js';

const { repoRoot, story } = parseArgs();
const errors = [];
const storyId = story || 'st_608fe3ed';
const relPath = `user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/${storyId}/migration-manifest.json`;

if (!fileExists(repoRoot, relPath)) {
  errors.push(`missing migration manifest: ${relPath}`);
  failOrPass('check-structure-migration-manifest', errors);
}

const manifest = readJson(repoRoot, relPath, errors);

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([root, data]) => ({ root, ...data }));
  }
  return [];
}

function entryKey(entry) {
  return entry.root || entry.path || entry.source || entry.from || entry.target || entry.to || '';
}

function hasEvidence(entry) {
  return Number.isFinite(entry.files)
    || Number.isFinite(entry.dirs)
    || Number.isFinite(entry.bytes)
    || typeof entry.sha256 === 'string'
    || typeof entry.hash === 'string'
    || entry.verified === true
    || entry.matches === true;
}

if (manifest) {
  if (manifest.story_id && manifest.story_id !== storyId) {
    errors.push(`manifest story_id is ${manifest.story_id}, expected ${storyId}`);
  }
  if (!/rollback|recover|non-?destructive|no deletion/i.test(String(manifest.policy || ''))) {
    errors.push('manifest policy must state non-destructive rollback/recovery intent');
  }

  const before = asArray(manifest.before);
  const after = asArray(manifest.after || manifest.verification?.after);
  const moves = asArray(manifest.moves);

  for (const root of ['identity', 'skills', ...RETIRED_PRIVATE_ROOTS, 'user']) {
    if (!before.some((entry) => entryKey(entry) === root && hasEvidence(entry))) {
      errors.push(`manifest before evidence missing for ${root}`);
    }
  }

  for (const root of [
    'agents',
    'agents/personas',
    'agents/skills',
    'agents/dist',
    'user',
    'user/inbox',
    'user/imports',
    'user/files',
    'user/contexts',
    'user/workbenches',
    'user/transcripts',
    'user/memory',
    'user/databases',
  ]) {
    const inAfter = after.some((entry) => entryKey(entry) === root && hasEvidence(entry));
    const inMoves = moves.some((entry) => entryKey(entry).includes(root) || String(entry.target || entry.to || '').includes(root));
    if (!inAfter && !inMoves) errors.push(`manifest after/move evidence missing for ${root}`);
  }

  if (moves.length === 0) {
    errors.push('manifest moves[] must record source -> target movement evidence');
  }
  if (!moves.some((entry) => entry.verified === true || entry.matches === true || entry.counts_match === true || entry.hashes_match === true)) {
    errors.push('manifest moves[] must include verified count/hash evidence');
  }

  const audit = manifest.persisted_path_audit || manifest.verification?.persisted_path_audit || {};
  const auditText = JSON.stringify(audit);
  if (!auditText || auditText === '{}') {
    errors.push('manifest persisted_path_audit is missing');
  } else if (!/(remaining|legacy|old|retired)/i.test(auditText)) {
    errors.push('manifest persisted_path_audit must explicitly report legacy/retired path counts');
  } else if (!/0/.test(auditText)) {
    errors.push('manifest persisted_path_audit must prove zero remaining legacy runtime references');
  }
}

failOrPass('check-structure-migration-manifest', errors, `ok - ${relPath} has before/after migration evidence`);

