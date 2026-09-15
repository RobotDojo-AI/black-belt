#!/usr/bin/env node
/**
 * context-split-probe.js — st_2cd1af73 Phase 5 (AC-6).
 *
 * INTELLIGENCE_TIER: extraction (read-only diagnosis — no LLM, no writes).
 *
 * Proves context files carry the Summary/History split: a sampled set of topic
 * AND entity context files each contain `## Summary` and `## History` (and none
 * still use the pre-split `## Chat Summary` heading). Chat injects only the
 * `## Summary` section; the split is the structural contract that makes that
 * possible, so this probe is the works-proof that the split is on disk.
 *
 * Read-only: opens the live DB via lib/db.js for nothing but path discovery, and
 * reads context.md files from disk. It never writes. Pin the live DB so it sees
 * the real files:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/qa/context-split-probe.js --min-sampled 20
 *
 * Options:
 *   --min-sampled N   require at least N files sampled+passing (default 20).
 *   --json            machine-readable result.
 *
 * Exit 0 = every sampled file carries the split AND at least --min-sampled were
 * sampled. Exit 1 = a sampled file lacks the split, still uses `## Chat Summary`,
 * or too few files exist to sample.
 *
 * WHY sample, not scan-all: the corpus is ~114k entity files; the split is a
 * uniform property, so a random sample across all entity types + topics is a
 * sound, cheap proof. A failing sample means the regen did not run.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { USER_CONTEXTS_DIR } from '../../lib/robotdojo-paths.js';

export const INTELLIGENCE_TIER = 'extraction';

// Default: the live per-user contexts tree. Overridable for tests / scoped
// proofs against a fixture tree (the live DB path stays pinned for everything
// else). Read-only either way.
const CONTEXTS_DIR = process.env.ROBOTDOJO_CONTEXTS_DIR_OVERRIDE
  ? resolve(process.env.ROBOTDOJO_CONTEXTS_DIR_OVERRIDE)
  : USER_CONTEXTS_DIR;

const SUMMARY_HEADING_RE = /^[ \t]*##[ \t]+Summary[ \t]*$/im;
const HISTORY_HEADING_RE = /^[ \t]*##[ \t]+History[ \t]*$/im;
const LEGACY_HEADING_RE = /^[ \t]*##[ \t]+Chat[ \t]+Summary[ \t]*$/im;

function argNum(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const MIN_SAMPLED = argNum('--min-sampled', 20);
const JSON_MODE = process.argv.includes('--json');

/**
 * Collect up to `cap` context.md file paths under a contexts subtree. Entity
 * subtrees are one level deep (`{type}/{package}/context.md`); the topics
 * subtree nests one extra level (`topics/{parent}/{slug}/context.md`), so we
 * walk recursively but bounded.
 */
function collectContextFiles(rootDir, cap) {
  const out = [];
  if (!existsSync(rootDir)) return out;
  const stack = [rootDir];
  while (stack.length && out.length < cap) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= cap) break;
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === 'context.md') out.push(full);
    }
  }
  return out;
}

function checkFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (err) { return { path, ok: false, reason: `unreadable: ${err.message}` }; }
  if (LEGACY_HEADING_RE.test(text)) return { path, ok: false, reason: 'still uses legacy "## Chat Summary" (not regenerated)' };
  const hasSummary = SUMMARY_HEADING_RE.test(text);
  const hasHistory = HISTORY_HEADING_RE.test(text);
  if (!hasSummary) return { path, ok: false, reason: 'missing "## Summary"' };
  if (!hasHistory) return { path, ok: false, reason: 'missing "## History"' };
  return { path, ok: true };
}

// Sample a balanced spread: topics + each entity type. Per-type caps sum to
// well above MIN_SAMPLED so we still reach the floor when one type is sparse.
const perTypeCap = Math.max(8, Math.ceil(MIN_SAMPLED / 2));
const groups = {
  topics: collectContextFiles(join(CONTEXTS_DIR, 'topics'), perTypeCap),
  people: collectContextFiles(join(CONTEXTS_DIR, 'people'), perTypeCap),
  companies: collectContextFiles(join(CONTEXTS_DIR, 'companies'), perTypeCap),
  places: collectContextFiles(join(CONTEXTS_DIR, 'places'), perTypeCap),
};

const sampled = [];
for (const files of Object.values(groups)) {
  for (const f of files) sampled.push(checkFile(f));
}

const passed = sampled.filter(r => r.ok);
const failed = sampled.filter(r => !r.ok);

const result = {
  contexts_dir: CONTEXTS_DIR,
  min_sampled: MIN_SAMPLED,
  sampled: sampled.length,
  passed: passed.length,
  failed: failed.length,
  by_group: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
  failures: failed.slice(0, 10).map(f => ({ path: f.path, reason: f.reason })),
};

if (JSON_MODE) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  console.log(`context-split-probe: sampled ${result.sampled} files (topics=${groups.topics.length} people=${groups.people.length} companies=${groups.companies.length} places=${groups.places.length})`);
  console.log(`  passed=${passed.length} failed=${failed.length} min-sampled=${MIN_SAMPLED}`);
  for (const f of result.failures) console.log(`  FAIL ${f.path} — ${f.reason}`);
}

if (failed.length > 0) {
  console.error(`context-split-probe: FAIL — ${failed.length} sampled file(s) lack the Summary/History split`);
  process.exit(1);
}
if (passed.length < MIN_SAMPLED) {
  console.error(`context-split-probe: FAIL — only ${passed.length} files sampled+passing, need ${MIN_SAMPLED}`);
  process.exit(1);
}
if (JSON_MODE) console.error(`context-split-probe: PASS — ${passed.length} sampled files carry ## Summary + ## History`);
else console.log(`context-split-probe: PASS — ${passed.length} sampled files carry ## Summary + ## History`);
process.exit(0);
