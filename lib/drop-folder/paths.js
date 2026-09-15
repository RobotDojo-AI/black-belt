/**
 * Drop-folder path helpers. Single source of truth for the folder layout.
 *   ~/robotdojo/user/inbox/        ← drop zone (INBOX = DROP_ROOT, files go here directly)
 *   ~/robotdojo/user/imports/.index/
 *   ~/robotdojo/user/files/{work,family,personal,education,newsletters,uncategorized}/ ← user documents
 *
 * GCS permanent archive: gs://{gcsBucket}/imports/YYYY-MM-DD-{slug}.ext
 * There is no local Archive/ — GCS is the only archive.
 *
 * Honour ROBOTDOJO_DROP_ROOT, ROBOTDOJO_USER_IMPORTS_ROOT, and
 * ROBOTDOJO_FILES_ROOT env vars so tests can run against tmpdirs.
 */

import { join } from 'node:path';
import { USER_FILES_DIR, USER_IMPORTS_DIR, USER_INBOX_DIR } from '../robotdojo-paths.js';
import { UNKNOWN_TOPIC_PAIR } from '../topic-routing-policy.js';

export const DROP_ROOT = USER_INBOX_DIR;

export const USERFILES_ROOT = USER_FILES_DIR;

export const DOCS_ROOT = USERFILES_ROOT;

export const INBOX     = DROP_ROOT; // user/inbox/ is the raw drop zone
export const INDEX_DIR = join(USER_IMPORTS_DIR, '.index');

export const ALLOWED_T1 = new Set(['work', 'family', 'personal', 'education', 'newsletters', 'uncategorized']);

/**
 * Build the destination path under the user-facing document tree.
 * Unknown t1 falls back to the childless `uncategorized` bucket.
 */
export function ontologyPath({ t1, t2, filename }) {
  const tier1 = ALLOWED_T1.has(t1) ? t1 : UNKNOWN_TOPIC_PAIR.t1;
  const tier2 = t2 || UNKNOWN_TOPIC_PAIR.t2;
  return tier2
    ? join(USERFILES_ROOT, tier1, sanitize(tier2), filename)
    : join(USERFILES_ROOT, tier1, filename);
}

/**
 * Compute the GCS object key for a processed file.
 * Format: YYYY-MM-DD-{slugified-name}.ext
 *
 * WHY: date-prefixed slug gives a readable, chronologically sortable key.
 * Slug capped at 60 chars to stay well under GCS key limits.
 * The date prefix uses the upload date (new Date() at call time).
 */
export function gcsKey(originalName) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const ext = originalName.match(/(\.[^.]+)$/)?.[1] ?? '';
  const base = originalName
    .replace(/(\.[^.]+)$/, '')          // strip extension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')       // slugify
    .replace(/^-+|-+$/g, '')           // trim dashes
    .slice(0, 60);                      // cap length
  return `${date}-${base}${ext}`;
}

/**
 * Parse T1 and T2 from an absolute path under USERFILES_ROOT.
 * Path may be user/files/{t1}/filename or user/files/{t1}/{t2}/filename.
 * Returns { t1, t2 } or nulls if the path is outside USERFILES_ROOT or malformed.
 * This is the single source of truth: tags always derive from the path.
 */
export function topicFromPath(absPath) {
  const rel = absPath.startsWith(USERFILES_ROOT + '/')
    ? absPath.slice(USERFILES_ROOT.length + 1)
    : null;
  if (!rel) return { t1: null, t2: null };
  const parts = rel.split('/');
  const t1 = ALLOWED_T1.has(parts[0]) ? parts[0] : null;
  const t2 = parts.length >= 3 && parts[1] ? parts[1] : null;
  return { t1, t2 };
}

function sanitize(segment) {
  // Strip path-separator chars AND dot-segments to prevent traversal.
  return String(segment)
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/^\.+$/, '_')
    .trim() || '_';
}
