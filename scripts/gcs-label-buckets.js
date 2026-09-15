#!/usr/bin/env node
/**
 * Labels the two surviving backup buckets and drops a short README at the bucket
 * root and at every top-level prefix — so identifying what a bucket or folder is
 * for never again requires the multi-hour forensic session this story took.
 *
 * For each bucket:
 *   - sets GCS bucket labels purpose / status / owner
 *     (label values are lowercased [a-z0-9_-], a GCS constraint)
 *   - uploads README.md to the bucket root
 *   - uploads README.md to each live top-level prefix (enumerated from
 *     `gcloud storage ls`, described from the code structure where the prefix is
 *     an active backup target, or marked legacy otherwise)
 *
 * Re-runnable: labels are set via --update-labels (upsert) and READMEs are
 * overwritten, so adding a new backup root later and re-running keeps everything
 * current instead of letting directory-purpose knowledge go stale.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVATE_DATA_ROOTS, PRIVATE_DATA_FILES } from '../lib/private-data-roots.js';
import { requireBuckets } from '../lib/backup-buckets.js';

export const INTELLIGENCE_TIER = 'extraction';

// Active-backup prefix descriptions, derived from the code structure so they stay
// accurate as roots are added or removed. The top-level of each remote path is the
// bucket prefix; PRIVATE_DATA_FILES all live under repo-local/.
const ACTIVE_PREFIX_DESCRIPTIONS = {
  ...Object.fromEntries(PRIVATE_DATA_ROOTS.map((r) => [r.remote.split('/')[0], null])),
  ...Object.fromEntries(PRIVATE_DATA_FILES.map((f) => [f.remote.split('/')[0], null])),
  'repo-dotclaude': 'Backup of the repo .claude/ directory (Claude Code Agent OS sources).',
  'user': 'Backup of ~/robotdojo/user — workbenches, memory log, local databases, user files.',
  'pipeline': 'Backup of ~/robotdojo/pipeline — ingest/rebuild pipeline working state.',
  'code': 'Backup of ~/robotdojo/code — additional code trees. The Black Belt build key is excluded.',
  'repo-local': 'Individually-backed local repo files: .env(.local), identity.json, config/ secrets, migration SQL, gateway terraform, local-only scripts.',
  'dotdir': 'Backup of ~/.robotdojo — TLS certs and the DB encryption key.',
  'dotclaude': 'Backup of ~/.claude — Claude memory, projects, and sessions.',
  'databases': 'SQLite database snapshots (robotdojo.db, embeddings.db) plus WAL/SHM.',
};

const HISTORICAL_NOTE =
  'Legacy prefix from an earlier backup layout. Current backups no longer write here; retained read-only for recovery. See the bucket-root README.';

/**
 * The bucket names are operator-specific and arrive at runtime from the
 * gitignored config/backup-buckets.user.json (st_dd0e19d8 AC5, owner decision:
 * move, not replace). They were hardcoded here; a placeholder would not redact
 * them, it would point `gcloud storage buckets update` at a bucket belonging to
 * whoever registered that name. Built as a function rather than a module
 * constant so the refusal happens inside main(), where it can exit non-zero.
 */
function bucketPlan(files, db) {
  return {
  [files]: {
    labels: { purpose: 'private-data-and-repo-local-backup', status: 'live', owner: 'robotdojo' },
    rootReadme: [
      `# ${files}`,
      '',
      'Status: LIVE. This is the active Robot Dojo backup bucket for private/local data',
      'not covered by GitHub.',
      '',
      'What it holds: whole-directory mirrors of the GCP-owned roots (repo .claude,',
      'user/, pipeline/, code/), individually-backed local repo files under repo-local/',
      '(.env, identity.json, the 5 config/ secrets, migration SQL, gateway terraform),',
      'the ~/.robotdojo and ~/.claude dot-directories, and SQLite snapshots under',
      'databases/.',
      '',
      'Ownership is MECE: every directory here is fully GCP-owned. GitHub-tracked repo',
      'source is NOT backed up here. Prefixes without an active description below are',
      'legacy from an earlier backup layout and are retained read-only.',
      '',
      'Do not run raw `gcloud storage rm` against this bucket. The only sanctioned',
      'destructive path is scripts/gcs-destroy-bucket.js, which forces you to type the',
      'exact bucket name back. Soft delete (7-day retention) is enabled.',
      '',
    ].join('\n'),
    prefixDescriptions: {},
  },
  [db]: {
    labels: { purpose: 'database-snapshot-backup', status: 'live', owner: 'robotdojo' },
    rootReadme: [
      `# ${db}`,
      '',
      'Status: LIVE. This bucket holds SQLite database snapshots for Robot Dojo.',
      '',
      'Root objects: robotdojo.db (+ -wal/-shm), embeddings/bunshin-corpus.db, the HNSW',
      'vector index files (hnsw.index, hnsw-topics.bin, hnsw-meta.json), and metrics',
      'JSON. These are point-in-time snapshots of the live database plane.',
      '',
      'Prefixes: gcloud/ (gcloud CLI state) and health/ (backup-health artifacts).',
      '',
      'Kept per owner decision (scope OOS #1). Soft delete (7-day retention) is enabled.',
      'The only sanctioned destructive path is scripts/gcs-destroy-bucket.js.',
      '',
    ].join('\n'),
    prefixDescriptions: {
      gcloud: 'Backup of gcloud CLI configuration/state (including tmp/).',
      health: 'Backup-health artifacts: dashboard, source, output, and archive of backup heartbeat/status.',
    },
  },
  };
}

function run(args) {
  return spawnSync('gcloud', args, { encoding: 'utf8' });
}

function setLabels(bucket, labels) {
  const kv = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
  const r = run(['storage', 'buckets', 'update', `gs://${bucket}`, `--update-labels=${kv}`]);
  if (r.status !== 0) throw new Error(r.stderr?.trim() || `label update failed for gs://${bucket}`);
  console.log(`[label] gs://${bucket}: labels set → ${kv}`);
}

function listPrefixes(bucket) {
  const r = run(['storage', 'ls', `gs://${bucket}/`]);
  if (r.status !== 0) throw new Error(r.stderr?.trim() || `ls failed for gs://${bucket}`);
  return (r.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((l) => l.endsWith('/') && l !== `gs://${bucket}/`)
    .map((l) => l.replace(`gs://${bucket}/`, '').replace(/\/$/, ''));
}

function describePrefix(bucket, prefix, overrides) {
  return overrides[prefix] || ACTIVE_PREFIX_DESCRIPTIONS[prefix] || HISTORICAL_NOTE;
}

function uploadReadme(gcsPath, content, workDir) {
  const tmp = join(workDir, 'README.md');
  writeFileSync(tmp, content.endsWith('\n') ? content : `${content}\n`);
  const r = run(['storage', 'cp', tmp, gcsPath]);
  if (r.status !== 0) throw new Error(r.stderr?.trim() || `README upload failed for ${gcsPath}`);
  console.log(`[readme] ${gcsPath}`);
}

function main() {
  const gate = requireBuckets(['files', 'db']);
  if (!gate.ok) {
    console.error(`[label] ${gate.message}`);
    process.exit(2);
  }
  const BUCKETS = bucketPlan(gate.buckets.files, gate.buckets.db);
  const workDir = mkdtempSync(join(tmpdir(), 'gcs-label-'));
  let failed = false;
  try {
    for (const [bucket, cfg] of Object.entries(BUCKETS)) {
      try {
        setLabels(bucket, cfg.labels);
        uploadReadme(`gs://${bucket}/README.md`, cfg.rootReadme, workDir);
        for (const prefix of listPrefixes(bucket)) {
          const desc = describePrefix(bucket, prefix, cfg.prefixDescriptions);
          const body = `# ${bucket}/${prefix}\n\n${desc}\n`;
          uploadReadme(`gs://${bucket}/${prefix}/README.md`, body, workDir);
        }
      } catch (error) {
        console.error(`[label] gs://${bucket}: ERROR — ${error?.message || error}`);
        failed = true;
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
