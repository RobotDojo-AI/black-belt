#!/usr/bin/env node
/**
 * context-consolidation-audit.js — st_2cd1af73 Phase 5 (AC-6).
 *
 * INTELLIGENCE_TIER: extraction (read-only diagnosis — no LLM, no writes).
 *
 * Proves consolidation holds: NO entity resolves to multiple live context files,
 * and there is one context file per topic. The research found multiple
 * historical context files per entity that were never consolidated. The package
 * directory name is `{slugify(display_name)}--{entityShortId(id)}`; the short-id
 * is derived from the stable entity id, so an entity whose display_name changed
 * between writes leaves TWO directories sharing one short-id — the duplicate the
 * consolidation step must merge into one. This audit groups every on-disk entity
 * package by its short-id and flags any short-id owning more than one live
 * context.md. For topics it flags any topic slug owning more than one file.
 *
 * Read-only — disk + DB reads, no writes. Pin the live DB:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/qa/context-consolidation-audit.js
 *
 * Options:
 *   --json   machine-readable result.
 *
 * Exit 0 = every entity short-id and every topic slug owns at most one context
 * file. Exit 1 = a duplicate remains (consolidation has not run / regressed).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { USER_CONTEXTS_DIR } from '../../lib/robotdojo-paths.js';

export const INTELLIGENCE_TIER = 'extraction';

const JSON_MODE = process.argv.includes('--json');

// Package dir name → trailing short-id after the final `--`. The slug part is
// everything before it; the short-id is the stable per-entity key.
function shortIdOf(dirName) {
  const idx = dirName.lastIndexOf('--');
  return idx >= 0 ? dirName.slice(idx + 2) : null;
}

/**
 * For an entity type subtree (people/companies/places), group package dirs that
 * contain a context.md by their short-id. Returns short-ids with >1 live file.
 */
function auditEntityType(typeDir) {
  const root = join(USER_CONTEXTS_DIR, typeDir);
  const byShortId = new Map(); // shortId → [dirName, ...]
  let liveFiles = 0;
  if (existsSync(root)) {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { entries = []; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!existsSync(join(root, e.name, 'context.md'))) continue;
      liveFiles++;
      const sid = shortIdOf(e.name);
      if (!sid) continue;
      if (!byShortId.has(sid)) byShortId.set(sid, []);
      byShortId.get(sid).push(e.name);
    }
  }
  const dups = [...byShortId.entries()].filter(([, dirs]) => dirs.length > 1);
  return {
    type: typeDir,
    live_files: liveFiles,
    distinct_short_ids: byShortId.size,
    duplicate_short_ids: dups.length,
    duplicates: dups.slice(0, 5).map(([sid, dirs]) => ({ short_id: sid, dirs })),
  };
}

/**
 * Topics: a topic owns one context.md. Group every context.md under topics/ by
 * its immediate parent directory (the topic slug dir) and flag any slug dir with
 * more than one file (shouldn't happen structurally, but proves one-per-topic).
 * Also flags the same topic slug appearing under two different parents.
 */
function auditTopics() {
  const root = join(USER_CONTEXTS_DIR, 'topics');
  const slugToFiles = new Map(); // leaf slug dir → [fullPath, ...]
  let liveFiles = 0;
  if (existsSync(root)) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
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
  const dups = [...slugToFiles.entries()].filter(([, files]) => files.length > 1);
  return {
    type: 'topics',
    live_files: liveFiles,
    distinct_slugs: slugToFiles.size,
    duplicate_slugs: dups.length,
    duplicates: dups.slice(0, 5).map(([slug, files]) => ({ slug, files })),
  };
}

const results = [
  auditEntityType('people'),
  auditEntityType('companies'),
  auditEntityType('places'),
  auditTopics(),
];

const totalDup = results.reduce((a, r) => a + (r.duplicate_short_ids ?? r.duplicate_slugs ?? 0), 0);

const out = { total_duplicates: totalDup, by_type: results };

if (JSON_MODE) {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  for (const r of results) {
    const dupCount = r.duplicate_short_ids ?? r.duplicate_slugs ?? 0;
    const distinct = r.distinct_short_ids ?? r.distinct_slugs ?? 0;
    console.log(`  ${r.type}: live_files=${r.live_files} distinct=${distinct} duplicates=${dupCount}`);
    for (const d of r.duplicates) console.log(`    DUP ${JSON.stringify(d)}`);
  }
  console.log(`  total duplicate keys (entity or topic resolving to >1 live file): ${totalDup}`);
}

if (totalDup > 0) {
  console.error(`context-consolidation-audit: FAIL — ${totalDup} key(s) own more than one live context file (consolidation needed)`);
  process.exit(1);
}
if (JSON_MODE) console.error('context-consolidation-audit: PASS — one context file per entity and per topic');
else console.log('context-consolidation-audit: PASS — one context file per entity and per topic');
process.exit(0);
