#!/usr/bin/env node
/**
 * vault-manifest.js
 *
 * Reads all drop_folder_files rows and writes ~/.robotdojo/vault-manifest.json.
 * Run on demand to rebuild after manual DB changes.
 *
 * CLI:
 *   node scripts/vault-manifest.js
 *
 * Output format (one entry per file):
 *   { name, localPath, gcsPath, docType, t1, t2, t3,
 *     sizeBytes, hash, status, processedAt }
 *
 * gcsPath is derived from localPath by replacing the drop folder prefix
 * with the configured GCS vault path. For gcs-only entries the path column
 * already contains the gs:// URI.
 *
 * Configuration:
 *   GCS_BUCKET env var or Keychain entry 'GCS_BUCKET' (e.g. gs://my-bucket)
 */

import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { writeFileSync } from 'node:fs';
import { DROP_ROOT } from '../lib/drop-folder/paths.js';
import config from '../lib/config.js';

const HOME = homedir();
const GCS_VAULT  = `${config.gcsBucket}/vault`;

process.env.ROBOTDOJO_DB = process.env.ROBOTDOJO_DB || join(HOME, 'robotdojo', 'databases', 'robotdojo.db');

const { default: db } = await import('../lib/db.js');

function localToGcs(localPath) {
  if (localPath.startsWith('gs://')) return localPath;
  if (localPath.startsWith(DROP_ROOT)) {
    const rel = localPath.slice(DROP_ROOT.length).replace(/^\//, '');
    return `${GCS_VAULT}/${rel}`;
  }
  // Files outside the drop root (e.g. imported-memories) — use their relative path
  const rel = localPath.startsWith(HOME)
    ? localPath.slice(HOME.length + 1)
    : basename(localPath);
  return `${GCS_VAULT}/_external/${rel}`;
}

const rows = db.prepare(
  `SELECT path, original_name, topic_t1, topic_t2, topic_t3, doc_type,
          hash_sha256, size_bytes, status, processed_at, source
   FROM drop_folder_files
   ORDER BY processed_at DESC`
).all();

const manifest = rows.map(r => ({
  name:        r.original_name || basename(r.path),
  localPath:   r.source === 'gcs' ? null : r.path,
  gcsPath:     localToGcs(r.path),
  docType:     r.doc_type,
  t1:          r.topic_t1,
  t2:          r.topic_t2,
  t3:          r.topic_t3,
  sizeBytes:   r.size_bytes,
  hash:        r.hash_sha256,
  status:      r.status,
  processedAt: r.processed_at,
}));

const out = join(HOME, '.robotdojo', 'vault-manifest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(`vault-manifest: ${manifest.length} entries → ${out}`);
