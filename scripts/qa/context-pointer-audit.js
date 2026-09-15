#!/usr/bin/env node
/**
 * context-pointer-audit.js — st_2cd1af73 Phase 5 (AC-6).
 *
 * INTELLIGENCE_TIER: extraction (read-only diagnosis — no LLM, no writes).
 *
 * Audits the context_file_path pointer gap. The research found ~114,750 entity
 * context files on disk but only ~33,821 DB pointers — active entities with a
 * real context file that chat can't reach because no pointer wires them. This
 * probe resolves each ACTIVE entity's canonical context path through the SAME
 * function the writer uses (entityPackageNameFromDisplay in lib/context-paths.js)
 * and flags an ORPHAN when that file exists on disk but the entity's
 * context_file_path is NULL (or points somewhere else). Symmetric resolution is
 * the contract from the failure manifest — the audit must check the path the
 * writer produced, not a guessed one.
 *
 * Read-only. Pin the live DB:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/qa/context-pointer-audit.js --max-orphans 1000
 *
 * Options:
 *   --max-orphans N   fail if active-entity orphans exceed N (default 1000).
 *   --json            machine-readable result.
 *
 * Exit 0 = orphan count ≤ --max-orphans. Exit 1 = the pointer gap is still open
 * (orphans above the threshold). The backfill
 * (scripts/backfill-context-pointers.js) is what closes it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import db from '../../lib/db.js';
import { REPO_ROOT, USER_CONTEXTS_REL } from '../../lib/robotdojo-paths.js';
import { entityPackageNameFromDisplay } from '../../lib/context-paths.js';

export const INTELLIGENCE_TIER = 'extraction';

function argNum(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
const MAX_ORPHANS = argNum('--max-orphans', 1000);
const JSON_MODE = process.argv.includes('--json');

// Resolve a stored/derived context path (repo-relative or ~/) to an absolute
// path on disk — mirrors lib/chat-context.js resolveContextFilePath so the audit
// agrees with what chat would actually read.
function toAbsolute(p) {
  const raw = String(p || '').trim();
  if (!raw) return null;
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  if (raw.startsWith('/')) return raw;
  return join(REPO_ROOT, raw);
}

// The canonical repo-relative path the writer (07-context.js repoContextPath)
// produces for an entity, via the same package-name function.
function canonicalRepoPath(typeDir, id, displayName) {
  return `~/robotdojo/${USER_CONTEXTS_REL}/${typeDir}/${entityPackageNameFromDisplay(id, displayName || id)}/context.md`;
}

function auditType(table, typeDir, nameCol) {
  const rows = db.prepare(
    `SELECT id, ${nameCol} AS name, context_file_path FROM ${table} WHERE COALESCE(archived,0)=0`,
  ).all();
  let onDisk = 0;       // canonical file exists on disk
  let withPointer = 0;  // pointer set AND resolves to an existing file
  let orphans = 0;      // canonical file on disk but no matching pointer
  const orphanSamples = [];
  for (const r of rows) {
    const canonical = canonicalRepoPath(typeDir, r.id, r.name);
    const canonicalAbs = toAbsolute(canonical);
    const fileExists = canonicalAbs ? existsSync(canonicalAbs) : false;
    if (fileExists) onDisk++;

    const ptrAbs = toAbsolute(r.context_file_path);
    const ptrOk = ptrAbs ? existsSync(ptrAbs) : false;
    if (ptrOk) withPointer++;

    // Orphan: there IS a canonical file for this active entity, but its pointer
    // does not resolve to an existing file (NULL or stale).
    if (fileExists && !ptrOk) {
      orphans++;
      if (orphanSamples.length < 5) orphanSamples.push({ id: r.id, name: r.name, canonical });
    }
  }
  return { table, total: rows.length, onDisk, withPointer, orphans, orphanSamples };
}

const results = [
  auditType('people', 'people', 'display_name'),
  auditType('companies', 'companies', 'name'),
  auditType('places', 'places', 'name'),
];

const totalOrphans = results.reduce((a, r) => a + r.orphans, 0);

const out = {
  max_orphans: MAX_ORPHANS,
  total_orphans: totalOrphans,
  by_type: results.map(({ orphanSamples, ...r }) => r),
  orphan_samples: results.flatMap(r => r.orphanSamples).slice(0, 10),
};

if (JSON_MODE) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  console.log(`context-pointer-audit: max-orphans=${MAX_ORPHANS}`);
  for (const r of results) {
    console.log(`  ${r.table}: active=${r.total} canonical-on-disk=${r.onDisk} with-valid-pointer=${r.withPointer} orphans=${r.orphans}`);
  }
  console.log(`  total orphans (file on disk, no valid pointer): ${totalOrphans}`);
}

if (totalOrphans > MAX_ORPHANS) {
  console.error(`context-pointer-audit: FAIL — ${totalOrphans} active-entity orphans exceed max ${MAX_ORPHANS} (run scripts/backfill-context-pointers.js)`);
  process.exit(1);
}
// In --json mode keep stdout pure JSON (already printed above); status to stderr.
if (JSON_MODE) console.error(`context-pointer-audit: PASS — ${totalOrphans} orphans ≤ ${MAX_ORPHANS}`);
else console.log(`context-pointer-audit: PASS — ${totalOrphans} orphans ≤ ${MAX_ORPHANS}`);
process.exit(0);
