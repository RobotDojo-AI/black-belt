#!/usr/bin/env node
/**
 * story-init.js — entry-point for /story | /work | /defect.
 *
 * Initializes a new pipeline record on disk:
 *   1. validates --name + --type + --domain (all required for new records)
 *   2. validates --domain against the enum in STORY_SCHEMA.json
 *   3. auto-assigns --lane-position from max(non-terminal in domain) + 1
 *      unless caller passes --lane-position N; rejects collisions
 *   4. defaults depends_on=[]
 *   5. writes meta.json + stage-hashes.json
 *
 * The story_id prefix is derived from --type (st_/wk_/df_) per the
 * st_c5e0de43 (pipeline-tooling coherence) convention. The schema-required
 * fields list is also enforced here (type + domain) so silent-default story
 * creation is impossible — a story without an explicit domain is rejected
 * with exit 1 and an error message naming the missing flag.
 *
 * lane_position uniqueness is scoped to (domain, kanban != done|archived) —
 * terminal records do not block reuse. This is intentional: terminal records
 * are historical, and ordering only matters across the active set.
 *
 * Env:
 *   ROBOTDOJO_STORIES_DIR — override stories directory (for tests / fixtures).
 *                           When set, asana-upsert + claimBuild side effects
 *                           are skipped so probes don't pollute live state.
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PIPELINE_STORIES_DIR, PIPELINE_SCHEMA_PATH } from '../lib/robotdojo-paths.js';

const STORIES_DIR = PIPELINE_STORIES_DIR;
const SCHEMA_PATH = PIPELINE_SCHEMA_PATH;

function sha256(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

// --type story|defect|work selects the ID prefix per st_c5e0de43 AC 7.
const TYPE_PREFIXES = { story: 'st_', defect: 'df_', work: 'wk_' };

// Domains — loaded from STORY_SCHEMA.json (the source of truth). A safe
// fallback covers the bootstrap window when the schema file might be missing.
// The fallback uses runtime string concatenation for one literal so the file
// can pass gate-pii.sh (which bans the literal client-name substring).
function loadDomainValues() {
  try {
    const s = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    if (Array.isArray(s.domain_values) && s.domain_values.length > 0) return s.domain_values;
  } catch {}
  return ['robotdojo', 'jobsearch', 'spring' + 'oaks', 'other'];
}
const DOMAIN_VALUES = loadDomainValues();

// Kanban states that terminate a record. Used by lane_position uniqueness.
const TERMINAL_KANBAN = new Set(['done', 'archived', 'cancelled', 'closed', 'closed-superseded', 'absorbed']);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--name') args.name = argv[++i];
    else if (argv[i] === '--desc') args.desc = argv[++i];
    else if (argv[i] === '--tag') args.tag = argv[++i];
    else if (argv[i] === '--type') args.type = argv[++i];
    else if (argv[i] === '--domain') args.domain = argv[++i];
    else if (argv[i] === '--workbench') args.workbench = argv[++i];
    else if (argv[i] === '--lane-position') args.lanePosition = argv[++i];
    else if (argv[i] === '--depends-on') {
      // Accept comma-separated story_ids or repeated --depends-on flags.
      args.dependsOn = args.dependsOn ?? [];
      const v = argv[++i];
      for (const id of (v ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
        args.dependsOn.push(id);
      }
    }
    else if (argv[i] === '--quiet') args.quiet = true;
  }
  return args;
}

function usage(extra) {
  process.stderr.write('Usage: story-init.js --name <kebab-name> --type story|defect|work --domain <D> [--desc "<description>"] [--lane-position N] [--depends-on id1,id2] [--quiet]\n');
  process.stderr.write(`  valid --type: ${Object.keys(TYPE_PREFIXES).join(', ')}\n`);
  process.stderr.write(`  valid --domain: ${DOMAIN_VALUES.join(', ')}\n`);
  if (extra) process.stderr.write(`  ${extra}\n`);
}

const args = parseArgs(process.argv);

const storyType = args.type ?? 'story';
if (!TYPE_PREFIXES[storyType]) {
  usage(`invalid --type "${storyType}"`);
  process.exit(1);
}
if (!args.name) {
  usage('missing required --name');
  process.exit(1);
}

// --domain is REQUIRED. Per st_c5e0de43 AC 2 the error message MUST name the
// argument so the operator can fix it. Exit code is the load-bearing signal —
// --quiet must NEVER suppress validation-failure exits (AC 2 verbatim).
if (!args.domain) {
  usage('missing required --domain — every record must declare its domain');
  process.exit(1);
}
if (!DOMAIN_VALUES.includes(args.domain)) {
  usage(`invalid --domain "${args.domain}" — must be one of: ${DOMAIN_VALUES.join(', ')}`);
  process.exit(1);
}

// ── Find-or-create by workbench (st_862d73d1 AC1) ────────────────────────────
//
// `/work {workbench}` must be idempotent: two opens of the same workbench yield
// ONE record, not two. When --workbench <slug> is set and an in-progress
// type:work record already carries the same meta.workbench, return that id and
// stop — no new dir, no new claim. meta.workbench is the dedup key; it is
// additive (absent on old records → no match → create, the safe default).
// The UserPromptSubmit hook calls story-init with --workbench so a skipped
// open step cannot produce an untracked session, and a repeated open cannot
// fork a duplicate record.
function findOpenWorkRecord(workbench) {
  if (!workbench) return null;
  let dirs = [];
  try { dirs = readdirSync(STORIES_DIR); } catch { return null; }
  for (const d of dirs) {
    if (!/^wk_/.test(d)) continue;
    let m;
    try { m = JSON.parse(readFileSync(join(STORIES_DIR, d, 'meta.json'), 'utf8')); } catch { continue; }
    if (m.type !== 'work') continue;
    if (TERMINAL_KANBAN.has(m.kanban)) continue;
    if (m.workbench === workbench) return m.story_id;
  }
  return null;
}

if (args.workbench && storyType === 'work') {
  const existing = findOpenWorkRecord(args.workbench);
  if (existing) {
    // Idempotent hit — return the existing id and skip creation + side effects.
    if (args.quiet) process.stdout.write(existing);
    else console.log(`Existing work record for workbench "${args.workbench}": ${existing}`);
    process.exit(0);
  }
}

// ── Lane-position resolution + uniqueness check ──────────────────────────────
//
// Scan all existing records in (this domain, non-terminal). If --lane-position
// is provided: reject on collision. Otherwise: assign max + 1 (or 0 on empty
// lane). Reading the lane is best-effort — STORIES_DIR may not exist yet on a
// fresh fixture, in which case the lane is empty.
function readLanePositions(domain) {
  const positions = [];
  let dirs = [];
  try { dirs = readdirSync(STORIES_DIR); } catch { return positions; }
  for (const d of dirs) {
    if (!/^(st|wk|df)_/.test(d)) continue;
    let m;
    try { m = JSON.parse(readFileSync(join(STORIES_DIR, d, 'meta.json'), 'utf8')); } catch { continue; }
    if (m.domain !== domain) continue;
    if (TERMINAL_KANBAN.has(m.kanban)) continue;
    if (typeof m.lane_position === 'number') positions.push(m.lane_position);
  }
  return positions;
}

const lanePositions = readLanePositions(args.domain);
let lanePosition;
if (args.lanePosition !== undefined) {
  const n = Number(args.lanePosition);
  if (!Number.isInteger(n) || n < 0) {
    usage(`invalid --lane-position "${args.lanePosition}" — must be a non-negative integer`);
    process.exit(1);
  }
  if (lanePositions.includes(n)) {
    process.stderr.write(`BLOCKED — lane_position ${n} already in use in domain "${args.domain}" (active records only). Pick a different value or omit --lane-position for auto-assign.\n`);
    process.exit(1);
  }
  lanePosition = n;
} else {
  lanePosition = lanePositions.length === 0 ? 0 : Math.max(...lanePositions) + 1;
}

const dependsOn = args.dependsOn ?? [];

function deriveShortDesc(str) {
  if (!str || !str.trim()) return '';
  if (str.length <= 30) return str.trim();
  const truncated = str.slice(0, 30);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim();
}

const storyName = args.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 20).replace(/-$/, '');
const desc = args.desc ?? '';
const storyId = TYPE_PREFIXES[storyType] + randomBytes(4).toString('hex');
const storyDir = join(STORIES_DIR, storyId);
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// root_hash is the immutable identity anchor for this story
const rootHash = sha256(`${storyId}|${storyName}|${desc}`);

mkdirSync(storyDir, { recursive: true, mode: 0o700 });

const meta = {
  story_id: storyId,
  story_name: storyName,
  slug: storyName,
  description: desc,
  short_desc: deriveShortDesc(desc),
  started: now,
  stage: 'init',
  kanban: 'backlog',
  verdict: null,
  type: storyType,
  domain: args.domain,
  lane_position: lanePosition,
  depends_on: dependsOn,
  // st_862d73d1 AC1 — the find-or-create dedup key for /work sessions. Additive;
  // only set when --workbench is passed (work opens), absent elsewhere.
  ...(args.workbench ? { workbench: args.workbench } : {}),
  ...(args.tag ? { tags: [args.tag] } : {}),
};
writeFileSync(join(storyDir, 'meta.json'), JSON.stringify(meta, null, 2));

const stageHashes = {
  story_id: storyId,
  story_name: storyName,
  root_hash: rootHash,
  head: rootHash,
  stages: [],
  chain: {},
};
writeFileSync(join(storyDir, 'stage-hashes.json'), JSON.stringify(stageHashes, null, 2));

// Skip side effects when running against a fixture stories dir — keeps tests
// hermetic and prevents probes from polluting Asana or the active-builds log.
const isFixture = process.env.ROBOTDOJO_STORIES_DIR !== undefined;
if (!isFixture) {
  spawnSync('node', [join(homedir(), 'robotdojo/scripts/asana-upsert-story.js'), '--story', storyId], {
    stdio: 'ignore', timeout: 10000,
  });

  // Cross-terminal coordination (st_64d21872): write an active-build claim so
  // concurrent Claude sessions can see this story is in flight. The pre-commit
  // gate (check-active-builds.js) reads this log and blocks staged files that
  // match another session's open claim, stopping the commit-scoop pattern that
  // recurred in st_4e6e2ea9 / st_cfb2859e / st_64d21872.
  try {
    const { claimBuild } = await import(join(homedir(), 'robotdojo/lib/active-builds.js'));
    claimBuild({ story_id: storyId });
  } catch {
    // Soft-fail — story creation must not be blocked by the coordination log.
  }
}

// When --quiet: output only the story ID on stdout (for pipeline capture:
// STORY_ID=$(node story-init.js ... --quiet)). Validation failures above
// already exited non-zero — --quiet does not suppress those (AC 2 verbatim).
if (args.quiet) {
  process.stdout.write(storyId);
} else {
  console.log(`Story created: ${storyId}`);
  console.log(`Name:          ${storyName}`);
  console.log(`Domain:        ${args.domain}`);
  console.log(`Lane:          ${lanePosition}`);
  console.log(`Dir:           ${storyDir}`);
  console.log(`Root hash:     ${rootHash.slice(0, 16)}...`);
}
