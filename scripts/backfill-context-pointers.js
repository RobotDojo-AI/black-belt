#!/usr/bin/env node
/**
 * backfill-context-pointers.js — st_2cd1af73 Phase 5 (AC-6).
 *
 * INTELLIGENCE_TIER: extraction (deterministic — no LLM; writes only the
 * deterministic context_file_path pointer + consolidated context.md files).
 *
 * Two jobs, both deterministic:
 *
 *   1. POINTER BACKFILL. The research found ~114,750 entity context files on
 *      disk but only ~33,821 DB pointers. For every ACTIVE entity, resolve its
 *      canonical context path through the SAME function the writer uses
 *      (entityPackageNameFromDisplay, lib/context-paths.js). If that file exists
 *      on disk and the entity's context_file_path does not already point to it,
 *      set the pointer. Symmetric resolution is the failure-manifest contract —
 *      the pointer must match exactly what 07-context.js wrote.
 *
 *   2. CONSOLIDATION. When one entity resolves to MULTIPLE historical context
 *      files (display_name changed between writes → two package dirs sharing the
 *      stable `--{shortId}` suffix), merge them into ONE file at the canonical
 *      path: the newest file's `## Summary` on top, every older file's body
 *      appended chronologically under `## History`, then remove the extra dirs.
 *      Topics likewise end with one file per topic.
 *
 * SAFETY:
 *   - DRY RUN BY DEFAULT. Nothing is written or deleted unless --execute is
 *     passed. --dry-run is also accepted (explicit no-op) and overrides
 *     --execute. Deletion is destructive, so writes are opt-in.
 *   - SHORT TRANSACTIONS. Pointer updates commit in small batches because the
 *     embed daemon holds the single WAL writer concurrently; a long transaction
 *     would contend. Default batch 200, override --batch N.
 *   - --limit N bounds how many active entities are processed (per type) so a
 *     small real sample can be proven before any mass run.
 *
 * Usage (small real-sample proof — read-only):
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/backfill-context-pointers.js --limit 25
 *
 * Usage (apply, mass run — sequenced by Miyagi, NOT run by the builder):
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/backfill-context-pointers.js --execute
 *
 * Options:
 *   --execute        apply changes (default: dry run, no writes).
 *   --dry-run        force dry run even if --execute is present.
 *   --limit N        process at most N active entities per type (default: all).
 *   --batch N        pointer-update transaction batch size (default 200).
 *   --types t,t,t    restrict to a subset of {people,companies,places,topics}.
 *   --json           machine-readable summary.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import db from '../lib/db.js';
import { REPO_ROOT, USER_CONTEXTS_DIR, USER_CONTEXTS_REL } from '../lib/robotdojo-paths.js';
import { entityPackageNameFromDisplay } from '../lib/context-paths.js';

export const INTELLIGENCE_TIER = 'extraction';

// ── args ─────────────────────────────────────────────────────────────────────
function argNum(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function argStr(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
}
const FORCE_DRY = process.argv.includes('--dry-run');
const EXECUTE = process.argv.includes('--execute') && !FORCE_DRY;
const LIMIT = argNum('--limit', 0); // 0 = no limit
const BATCH = argNum('--batch', 200);
const JSON_MODE = process.argv.includes('--json');
const TYPES = new Set(
  argStr('--types', 'people,companies,places,topics').split(',').map(s => s.trim()).filter(Boolean),
);

const log = (...a) => { if (!JSON_MODE) console.log(...a); };

// ── path helpers (writer-symmetric) ───────────────────────────────────────────
const TYPE_DIR = { people: 'people', companies: 'companies', places: 'places' };

function toAbsolute(p) {
  const raw = String(p || '').trim();
  if (!raw) return null;
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  if (raw.startsWith('/')) return raw;
  return join(REPO_ROOT, raw);
}

// The exact repo-relative pointer string 07-context.js writes.
function canonicalRepoPath(type, id, displayName) {
  return `~/robotdojo/${USER_CONTEXTS_REL}/${TYPE_DIR[type]}/${entityPackageNameFromDisplay(id, displayName || id)}/context.md`;
}

function shortIdOf(dirName) {
  const idx = dirName.lastIndexOf('--');
  return idx >= 0 ? dirName.slice(idx + 2) : null;
}

// Newest-first ordering signal for consolidation: prefer the `generated_at`
// frontmatter timestamp; fall back to file mtime. Returns ms epoch.
function fileRecency(absPath) {
  try {
    const text = readFileSync(absPath, 'utf8');
    const m = text.match(/^generated_at:\s*(.+)$/m);
    if (m) {
      const t = Date.parse(m[1].trim());
      if (Number.isFinite(t)) return t;
    }
  } catch { /* fall through to mtime */ }
  try { return statSync(absPath).mtimeMs || 0; } catch { return 0; }
}

// Strip frontmatter + a leading "# Title"/subtitle, returning the body from the
// first "## " heading onward (so merged History blocks stay clean).
function bodyForHistory(text) {
  let body = String(text || '').trim();
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) body = body.slice(end + 4).trim();
  }
  const firstHeading = body.indexOf('\n## ');
  if (firstHeading !== -1) return body.slice(firstHeading + 1).trim();
  return body;
}

// ── stats accumulator ─────────────────────────────────────────────────────────
const stats = {
  execute: EXECUTE,
  limit: LIMIT || null,
  pointers_set: 0,
  pointers_already_ok: 0,
  no_file_on_disk: 0,
  consolidated_entities: 0,
  files_removed: 0,
  by_type: {},
};

// ── pointer backfill + consolidation per entity type ──────────────────────────
function processEntityType(type) {
  const table = type;
  const nameCol = type === 'people' ? 'display_name' : 'name';
  const rows = db.prepare(
    `SELECT id, ${nameCol} AS name, context_file_path FROM ${table} WHERE COALESCE(archived,0)=0${LIMIT ? ' LIMIT ' + LIMIT : ''}`,
  ).all();

  const typeStats = { active: rows.length, pointers_set: 0, already_ok: 0, no_file: 0, consolidated: 0, files_removed: 0 };

  // Build short-id → on-disk package dirs map (for consolidation) once.
  const typeRoot = join(USER_CONTEXTS_DIR, TYPE_DIR[type]);
  const shortIdDirs = new Map(); // shortId → [dirName,...] that contain context.md
  if (existsSync(typeRoot)) {
    let entries = [];
    try { entries = readdirSync(typeRoot, { withFileTypes: true }); } catch { entries = []; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!existsSync(join(typeRoot, e.name, 'context.md'))) continue;
      const sid = shortIdOf(e.name);
      if (!sid) continue;
      if (!shortIdDirs.has(sid)) shortIdDirs.set(sid, []);
      shortIdDirs.get(sid).push(e.name);
    }
  }

  // Pointer updates buffered then committed in short transactions.
  const updates = []; // { id, pointer }
  const updateStmt = db.prepare(`UPDATE ${table} SET context_file_path=? WHERE id=?`);
  const flush = () => {
    if (!updates.length) return;
    if (EXECUTE) {
      const tx = db.transaction((batch) => { for (const u of batch) updateStmt.run(u.pointer, u.id); });
      tx(updates);
    }
    updates.length = 0;
  };

  for (const r of rows) {
    const sid = shortIdOf(entityPackageNameFromDisplay(r.id, r.name || r.id));
    const canonicalRepo = canonicalRepoPath(type, r.id, r.name);
    const canonicalAbs = toAbsolute(canonicalRepo);

    // ── Consolidation: this entity owns >1 live package dir (slug drift). ──
    const dirs = (sid && shortIdDirs.get(sid)) || [];
    if (dirs.length > 1) {
      const absFiles = dirs.map(d => join(typeRoot, d, 'context.md'));
      // Newest by recency wins as the Summary source; others go to History.
      absFiles.sort((a, b) => fileRecency(b) - fileRecency(a));
      const [newest, ...older] = absFiles;
      const newestText = (() => { try { return readFileSync(newest, 'utf8'); } catch { return ''; } })();
      const olderBlocks = older
        .map(f => { try { return bodyForHistory(readFileSync(f, 'utf8')); } catch { return ''; } })
        .filter(Boolean);

      // Merge: keep newest verbatim, append older bodies under its History.
      let merged = newestText.trimEnd();
      if (olderBlocks.length) {
        const hasHistory = /^[ \t]*##[ \t]+History[ \t]*$/m.test(merged);
        if (!hasHistory) merged += `\n\n---\n\n## History`;
        merged += `\n\n${olderBlocks.join('\n\n')}\n`;
      } else {
        merged += '\n';
      }

      if (EXECUTE) {
        writeFileSync(canonicalAbs, merged, 'utf8');
        // Remove every package dir that is NOT the canonical one.
        const canonicalDir = dirname(canonicalAbs);
        for (const d of dirs) {
          const dAbs = join(typeRoot, d);
          if (dAbs !== canonicalDir) {
            try { rmSync(dAbs, { recursive: true, force: true }); typeStats.files_removed++; } catch { /* best-effort */ }
          }
        }
      } else {
        typeStats.files_removed += Math.max(0, dirs.length - 1);
      }
      typeStats.consolidated++;
      // Mark this short-id done so a second row with the same id isn't re-merged.
      shortIdDirs.set(sid, [dirname(canonicalRepo).split('/').pop()]);
    }

    // ── Pointer backfill: point at the canonical file when it exists. ──
    const onDisk = canonicalAbs ? existsSync(canonicalAbs) : false;
    if (!onDisk) { typeStats.no_file++; continue; }
    const ptrAbs = toAbsolute(r.context_file_path);
    const ptrMatches = ptrAbs && ptrAbs === canonicalAbs && existsSync(ptrAbs);
    if (ptrMatches) { typeStats.already_ok++; continue; }
    updates.push({ id: r.id, pointer: canonicalRepo });
    typeStats.pointers_set++;
    if (updates.length >= BATCH) flush();
  }
  flush();

  stats.pointers_set += typeStats.pointers_set;
  stats.pointers_already_ok += typeStats.already_ok;
  stats.no_file_on_disk += typeStats.no_file;
  stats.consolidated_entities += typeStats.consolidated;
  stats.files_removed += typeStats.files_removed;
  stats.by_type[type] = typeStats;
  log(`  ${type}: active=${typeStats.active} pointers_set=${typeStats.pointers_set} already_ok=${typeStats.already_ok} no_file=${typeStats.no_file} consolidated=${typeStats.consolidated} files_removed=${typeStats.files_removed}`);
}

// ── topics: one file per topic ────────────────────────────────────────────────
function processTopics() {
  const root = join(USER_CONTEXTS_DIR, 'topics');
  const slugToFiles = new Map();
  let liveFiles = 0;
  if (existsSync(root)) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === 'context.md') {
          liveFiles++;
          const slug = dir.split('/').pop();
          if (!slugToFiles.has(slug)) slugToFiles.set(slug, []);
          slugToFiles.get(slug).push(full);
        }
      }
    }
  }
  let consolidated = 0, removed = 0;
  for (const [slug, files] of slugToFiles) {
    if (files.length <= 1) continue;
    files.sort((a, b) => fileRecency(b) - fileRecency(a));
    const [newest, ...older] = files;
    const newestText = (() => { try { return readFileSync(newest, 'utf8'); } catch { return ''; } })();
    const olderBlocks = older.map(f => { try { return bodyForHistory(readFileSync(f, 'utf8')); } catch { return ''; } }).filter(Boolean);
    let merged = newestText.trimEnd();
    if (olderBlocks.length) {
      if (!/^[ \t]*##[ \t]+History[ \t]*$/m.test(merged)) merged += `\n\n---\n\n## History`;
      merged += `\n\n${olderBlocks.join('\n\n')}\n`;
    } else merged += '\n';
    if (EXECUTE) {
      writeFileSync(newest, merged, 'utf8');
      for (const f of older) { try { rmSync(dirname(f), { recursive: true, force: true }); removed++; } catch { /* best-effort */ } }
    } else removed += older.length;
    consolidated++;
    void slug;
  }
  stats.consolidated_entities += consolidated;
  stats.files_removed += removed;
  stats.by_type.topics = { live_files: liveFiles, distinct_slugs: slugToFiles.size, consolidated, files_removed: removed };
  log(`  topics: live_files=${liveFiles} distinct_slugs=${slugToFiles.size} consolidated=${consolidated} files_removed=${removed}`);
}

// ── run ───────────────────────────────────────────────────────────────────────
log(`backfill-context-pointers: ${EXECUTE ? 'EXECUTE (writing)' : 'DRY RUN (no writes)'}${LIMIT ? `  limit=${LIMIT}/type` : ''}  batch=${BATCH}`);
for (const t of ['people', 'companies', 'places']) if (TYPES.has(t)) processEntityType(t);
if (TYPES.has('topics')) processTopics();

if (JSON_MODE) process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
else {
  log('──');
  log(`  pointers set: ${stats.pointers_set}  already-ok: ${stats.pointers_already_ok}  no-file: ${stats.no_file_on_disk}`);
  log(`  consolidated entities/topics: ${stats.consolidated_entities}  extra files removed: ${stats.files_removed}`);
  log(EXECUTE ? '  (changes applied)' : '  (dry run — re-run with --execute to apply)');
}
process.exit(0);
