/**
 * lib/backup-buckets.js — the names of the operator's own object-storage backup
 * buckets, resolved at runtime from a gitignored override (st_dd0e19d8 AC5).
 *
 * WHY THIS EXISTS. The two bucket names were hardcoded across six tracked files.
 * One of them is in the owner's corpus, which makes it an AC5 candidate; and the
 * owner's decision on that class is MOVE, not REPLACE. The distinction is
 * load-bearing: `gcs-enable-soft-delete.js` and `gcs-label-buckets.js` call
 * `gcloud` against these exact strings, so swapping in a placeholder does not
 * redact a name — it points a live operational script at a bucket that does not
 * exist. The name therefore leaves the tracked tree and arrives at runtime, the
 * same shape config/taxonomy.user.json and config/service-vendor-keywords.user.json
 * already use.
 *
 * MODULE-RELATIVE, NOT CWD-RELATIVE. These scripts are run from LaunchAgents and
 * from arbitrary shells; a `process.cwd()`-relative override would resolve
 * differently depending on where the process started, and the failure mode is a
 * destructive operation aimed at the wrong (or an empty) bucket name.
 *
 * ABSENT OVERRIDE IS A REFUSAL, NOT A DEFAULT. On a fresh clone, in a published
 * copy, and on anyone else's machine this file is not there. `backupBuckets()`
 * then returns nulls and each caller refuses with a message naming the config
 * file. A tracked placeholder name would be worse than nothing: it would let a
 * bucket-mutating script run to the point of calling gcloud with a name that
 * belongs to nobody, or — the real hazard — to somebody else.
 *
 * NO OWNER DATA LIVES IN THIS FILE. It names a config key and nothing else.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 */

import { readFileSync } from 'node:fs';

/** The gitignored override. Shape: `{ "files": "<name>", "db": "<name>" }`. */
export const BUCKETS_CONFIG_URL = new URL('../config/backup-buckets.user.json', import.meta.url);

/**
 * Resolve both bucket names. `deps.read` is injected so the tests can drive this
 * without a file on disk (build-conventions: `(deps, ...params)` in lib/).
 *
 * Returns `{ files, db }`, each a non-empty string or null. Never throws: a
 * malformed override is the same as an absent one, because a backup script that
 * crashes on config parse is a backup script that stops running.
 */
export function backupBuckets(deps = {}) {
  const read = deps.read || (() => readFileSync(BUCKETS_CONFIG_URL, 'utf8'));
  let parsed = null;
  try {
    parsed = JSON.parse(read());
  } catch {
    return { files: null, db: null };
  }
  const name = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { files: name(parsed && parsed.files), db: name(parsed && parsed.db) };
}

/**
 * The guard every bucket-mutating caller runs first. Returns the names when all
 * of `required` resolved, otherwise a message naming what is missing and where
 * to put it. Callers exit non-zero on `ok === false`.
 */
export function requireBuckets(required, resolved = backupBuckets()) {
  const missing = required.filter((k) => !resolved[k]);
  if (missing.length === 0) return { ok: true, buckets: resolved, message: '' };
  return {
    ok: false,
    buckets: resolved,
    message:
      `backup bucket name(s) not configured: ${missing.join(', ')}. These are operator-specific and are `
      + 'deliberately not tracked. Create config/backup-buckets.user.json with '
      + '{"files":"<bucket>","db":"<bucket>"} and re-run.',
  };
}
