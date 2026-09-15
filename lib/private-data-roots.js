import { join } from 'node:path';

// Whole-directory GCP backup roots. Each directory is fully GCP-owned: no
// git-tracked source may live under it (a bare `.gitignore` housekeeping marker
// is the only exception). `config/` and `docs/` were removed here (st_e0776b46) —
// they hold git-tracked repo source, so whole-directory syncing them mixed
// GitHub-owned and GCP-owned content in one tree. `config/`'s 5 untracked secrets
// are backed up individually via PRIVATE_DATA_FILES below instead; `docs/`'s
// untracked rebuild-report-*.md are regenerable build output, dropped entirely.
// `dotbackup`/`quarantine` were removed too: both pointed at local directories
// that don't exist on disk, so every run just logged "does not exist — skipping".
export const PRIVATE_DATA_ROOTS = Object.freeze([
  { key: 'repo-dotclaude', local: '.claude', remote: 'repo-dotclaude/' },
  { key: 'user', local: 'user', remote: 'user/' },
  { key: 'pipeline', local: 'pipeline', remote: 'pipeline/' },
  { key: 'code', local: 'code', remote: 'code/' },
]);

export const PRIVATE_DATA_FILES = Object.freeze([
  { key: 'env', local: '.env', remote: 'repo-local/.env' },
  { key: 'env-local', local: '.env.local', remote: 'repo-local/.env.local' },
  { key: 'identity-json', local: 'identity.json', remote: 'repo-local/identity.json' },
  { key: 'identity-local-json', local: 'identity.local.json', remote: 'repo-local/identity.local.json' },
  // config/ secrets: kept physically in place (7+ hardcoded readers across the
  // family/taxonomy/company-matching pipeline depend on these paths — st_e0776b46),
  // backed up as individually-named files rather than whole-directory synced.
  { key: 'config-company-aliases', local: 'config/company-aliases.user.json', remote: 'repo-local/config/company-aliases.user.json' },
  { key: 'config-family', local: 'config/family.json', remote: 'repo-local/config/family.json' },
  { key: 'config-identity', local: 'config/identity.json', remote: 'repo-local/config/identity.json' },
  { key: 'config-private', local: 'config/private.json', remote: 'repo-local/config/private.json' },
  { key: 'config-taxonomy-user', local: 'config/taxonomy.user.json', remote: 'repo-local/config/taxonomy.user.json' },
  { key: 'config-source-topic-routing-user', local: 'config/source-topic-routing.user.json', remote: 'repo-local/config/source-topic-routing.user.json' },
  { key: 'migration-024-topic-hierarchy', local: 'lib/migrations/024_topic_hierarchy.sql', remote: 'repo-local/lib/migrations/024_topic_hierarchy.sql' },
  { key: 'migration-025-topic-sort-order', local: 'lib/migrations/025_topic_sort_order.sql', remote: 'repo-local/lib/migrations/025_topic_sort_order.sql' },
  { key: 'asana-sync-script', local: 'scripts/asana-sync.py', remote: 'repo-local/scripts/asana-sync.py' },
  { key: 'oura-import-script', local: 'scripts/import-oura-json.js', remote: 'repo-local/scripts/import-oura-json.js' },
  { key: 'pdf-labs-batch-script', local: 'scripts/import-pdf-labs-batch.js', remote: 'repo-local/scripts/import-pdf-labs-batch.js' },
  { key: 'live-chat-diagnostic', local: 'scripts/qa/diag-chat-live.mjs', remote: 'repo-local/scripts/qa/diag-chat-live.mjs' },
  { key: 'gateway-terraform-vars', local: 'gateway/infra/terraform.tfvars', remote: 'repo-local/gateway/infra/terraform.tfvars' },
  { key: 'gateway-terraform-plan', local: 'gateway/infra/tfplan', remote: 'repo-local/gateway/infra/tfplan' },
  { key: 'gateway-terraform-state', local: 'gateway/infra/.terraform/terraform.tfstate', remote: 'repo-local/gateway/infra/.terraform/terraform.tfstate' },
  // The gitignored config/*.user.json overrides (st_dd0e19d8). Every one of these
  // is the owner's half of a rule whose tracked half is deliberately generic —
  // his affiliation terms, his vendor and sender-domain classification entries,
  // his bucket names, his permitted-list entries. Losing one does not surface as
  // an error: the readers all treat an absent override as "no overrides", so the
  // rule silently degrades to the generic default and his own mail, topics and
  // backups start classifying differently. That is precisely the class this
  // registry exists for, and the recoverability audit was already flagging the
  // three that predate this story.
  { key: 'config-asana-routing-user', local: 'config/asana-routing.user.json', remote: 'repo-local/config/asana-routing.user.json' },
  { key: 'config-viewer-topic-lens-user', local: 'config/viewer-topic-lens.user.json', remote: 'repo-local/config/viewer-topic-lens.user.json' },
  { key: 'config-qa-proof-fixtures-user', local: 'config/qa-proof-fixtures.user.json', remote: 'repo-local/config/qa-proof-fixtures.user.json' },
  { key: 'config-owner-corpus-allowlist-user', local: 'config/owner-corpus-allowlist.user.json', remote: 'repo-local/config/owner-corpus-allowlist.user.json' },
  { key: 'config-service-vendor-keywords-user', local: 'config/service-vendor-keywords.user.json', remote: 'repo-local/config/service-vendor-keywords.user.json' },
  { key: 'config-publication-permitted-user', local: 'config/publication-permitted.user.json', remote: 'repo-local/config/publication-permitted.user.json' },
  { key: 'config-backup-buckets-user', local: 'config/backup-buckets.user.json', remote: 'repo-local/config/backup-buckets.user.json' },
  { key: 'config-email-allowlist-domains-user', local: 'config/email-allowlist-domains.user.json', remote: 'repo-local/config/email-allowlist-domains.user.json' },
  { key: 'config-monarch-user', local: 'config/monarch.user.json', remote: 'repo-local/config/monarch.user.json' },
]);

// ── ~/.robotdojo/ — coverage flips from opt-in to opt-out (df_3df1f108) ──────
//
// Before this, the config dir was covered by NAMING each member: the backup
// reached `tls/`, the key file, and the databases, and nothing else. A new file
// there was silently uncovered until someone remembered to add it — which is
// how eleven irreplaceable files (owner approval records, restore-critical
// entitlement metadata, pre-mutation rollback snapshots) and a live Cloudflare
// tunnel token ended up outside the backup with nobody noticing.
//
// Now the whole directory is a backup root and only an explicit, justified
// exclusion drops a path. Adding a file there covers it by default; losing one
// requires a deliberate edit below. Each exclusion carries its own reason —
// per-path classification, never a whole-directory verdict.
//
// Matched as a Python `re.match` against the path RELATIVE to the root
// (verified against the gcloud SDK's regex_util.Patterns.match), so every
// alternative below is anchored at the start of the relative path.
export const DOTDIR_EXCLUSIONS = Object.freeze([
  // Correctness, not size: the databases are copied separately as consistent
  // SQLite snapshots. A whole-directory rsync of a live 28 GB database uploads
  // a torn file.
  { pattern: String.raw`robotdojo\.db.*`, reason: 'copied separately as a consistent snapshot' },
  { pattern: String.raw`embeddings\.db.*`, reason: 'copied separately as a consistent snapshot' },
  // Re-downloadable from source (3.7 G of embedding weights).
  { pattern: String.raw`models(/.*|$)`, reason: 'redownloadable model weights' },
  // Named producers re-derive both members: scripts/promote-workbench-corpus.js
  // and the lib/markdown-documents.js disk render cache.
  { pattern: String.raw`cache(/.*|$)`, reason: 'regenerable by named producers' },
  // The installer writes this launcher and it hardcodes THIS machine's paths,
  // so restoring it onto a new machine would write wrong values.
  { pattern: String.raw`bin(/.*|$)`, reason: 'installer-generated, machine-specific paths' },
  // Rebuildable index (12 M) and a corpus cache (4.3 M).
  { pattern: String.raw`state/story-retrieval-index\.json`, reason: 'rebuildable index' },
  { pattern: String.raw`owner-corpus\.cache\.json`, reason: 'regenerable owner-corpus cache' },
  // Live locks and a port number — meaningless off this machine.
  { pattern: String.raw`supervisor-maintenance\.lock`, reason: 'live lock' },
  { pattern: String.raw`external-db-writer\.lock`, reason: 'live lock' },
  { pattern: String.raw`\.http-port`, reason: 'live port number' },
  // Dangling symlink to a path that does not exist.
  { pattern: String.raw`plans(/.*|$)`, reason: 'broken symlink' },
]);

export function dotdirExcludePattern() {
  return DOTDIR_EXCLUSIONS.map((entry) => entry.pattern).join('|');
}

export function privateBackupDirs(home, bucket) {
  return PRIVATE_DATA_ROOTS.map(root => ({
    key: root.key,
    local: join(home, 'robotdojo', root.local),
    remote: `${bucket}/${root.remote}`,
  }));
}

export function privateBackupFiles(home, bucket) {
  return PRIVATE_DATA_FILES.map(file => ({
    key: file.key,
    local: join(home, 'robotdojo', file.local),
    remote: `${bucket}/${file.remote}`,
  }));
}
