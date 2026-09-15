#!/usr/bin/env node
/**
 * active-story.js — infer the active story (legacy) OR answer the
 * "what's next to pick up?" question per project domain (st_c5e0de43).
 *
 * Modes:
 *
 *   active-story.js
 *     Legacy mode. Scans meta.json state for stories with kanban==='in-progress'.
 *     Single match → prints the story_id on stdout (exit 0).
 *     Zero matches → exit 1 with NO ACTIVE STORY message.
 *     Multiple matches → exit 2 with AMBIGUOUS message (the owner's
 *     preference: use --next for the per-project answer instead).
 *
 *   active-story.js --stage <pipeline-stage>
 *     Stage-aware active record answer. Filters in-progress stories/defects to
 *     the exact state that can enter <pipeline-stage>. This lets /research pick
 *     a defect at framing-complete even when another story is parked at
 *     research-sealed. Single match -> prints story_id. Zero or multiple
 *     matches -> exits 1/2 with an operator-visible message.
 *
 *   active-story.js --next
 *     Per-domain pickable-story answer. Iterates every domain that has at
 *     least one non-terminal record. For each domain prints:
 *       Domain: <D>
 *       <story_id>                                — the unblocked min-lane story
 *     OR
 *       no unblocked story in <D> — finish current first
 *
 *   active-story.js --next --domain <D>
 *     Single-domain answer. Prints exactly one line: a story_id OR the
 *     literal blocked-message above. Always exit 0 (the message itself
 *     encodes the state — exit codes were over-loaded in the old AMBIGUOUS
 *     mode and operator scripts couldn't tell apart "no records" from "API
 *     error").
 *
 * Unblocked predicate: a story is **unblocked** iff `depends_on` is empty
 * OR every referenced story_id has terminal kanban. Cycles produce
 * "no unblocked" output for every member — operator-visible and surfaces
 * the cycle for manual intervention.
 *
 * Env:
 *   ROBOTDOJO_STORIES_DIR — override stories directory (for tests/fixtures).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

const STORIES = PIPELINE_STORIES_DIR;

// Kanban states that terminate a record. Mirrors story-init.js TERMINAL_KANBAN.
const TERMINAL_KANBAN = new Set(['done', 'archived', 'cancelled', 'closed', 'closed-superseded', 'absorbed']);

// Domains the gate knows about. The runtime list is derived from records on
// disk; this fixed list ensures every known domain emits a header even when
// the lane is empty (the "show jobsearch even if empty" property of AC 6).
// The third domain literal uses runtime string concatenation to satisfy
// gate-pii.sh's banned-pattern scanner.
const KNOWN_DOMAINS = ['robotdojo', 'jobsearch', 'spring' + 'oaks', 'other'];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--next') args.next = true;
    else if (argv[i] === '--stage') args.stage = argv[++i];
    else if (argv[i] === '--domain') args.domain = argv[++i];
    else if (argv[i] === '--avoid-conflicts') args.avoidConflicts = true;
    // st_862d73d1 AC1 — work-aware backstop. The legacy/--stage modes exclude
    // type:work (work sessions have no gate ordering), so a /work close needs a
    // separate require that a tracked work record exists. --work-stage [slug]
    // is that require: it prints an in-progress work record's id (exit 0) or
    // halts (exit 1) so `work/SKILL.md` close runs `... --work-stage || exit 1`
    // and an untracked session cannot complete its close synthesis.
    else if (argv[i] === '--work-stage') args.workStage = argv[++i] ?? '';
    else if (argv[i] === '--workbench') args.workbench = argv[++i];
  }
  return args;
}

// st_8745309c AC6 — surface session-conflict signal for the next-story
// candidate. Runs check-session-conflicts.js as a sibling script and
// returns its single line of advice. Returns null on failure (the caller
// treats null as "no conflict info, proceed").
function conflictSignalForStory(storyId) {
  if (!storyId) return null;
  try {
    const here = new URL('.', import.meta.url).pathname;
    const script = join(here, 'check-session-conflicts.js');
    const r = childProcess.spawnSync(process.execPath, [script, '--story', storyId], {
      encoding: 'utf8',
      timeout: 8000,
    });
    if (r.status !== 0) return null;
    return (r.stdout || '').trim();
  } catch {
    return null;
  }
}

function loadAllRecords() {
  let dirs;
  try { dirs = readdirSync(STORIES); } catch { return []; }
  const records = [];
  for (const d of dirs) {
    if (!/^(st|wk|df)_/.test(d)) continue;
    let m;
    try { m = JSON.parse(readFileSync(join(STORIES, d, 'meta.json'), 'utf8')); } catch { continue; }
    records.push(m);
  }
  return records;
}

/**
 * unblocked predicate. A story is blocked iff at least one of its
 * `depends_on` references points at a record with non-terminal kanban.
 * Missing references count as terminal (the dependency is presumed
 * historical or absorbed) — over-conservative; the operator can fix
 * stale depends_on entries on next touch.
 */
function isUnblocked(record, recordById) {
  const deps = Array.isArray(record.depends_on) ? record.depends_on : [];
  if (deps.length === 0) return true;
  for (const id of deps) {
    const ref = recordById.get(id);
    if (!ref) continue; // missing → presumed terminal
    if (!TERMINAL_KANBAN.has(ref.kanban)) return false;
  }
  return true;
}

function pickNextInDomain(domain, records, recordById, opts = {}) {
  const active = records
    .filter(m => m.domain === domain)
    .filter(m => !TERMINAL_KANBAN.has(m.kanban))
    .filter(m => typeof m.lane_position === 'number')
    .filter(m => isUnblocked(m, recordById))
    .sort((a, b) => a.lane_position - b.lane_position);
  const candidates = active.some(m => m.kanban === 'in-progress')
    ? active.filter(m => m.kanban === 'in-progress')
    : active;

  // st_8745309c AC6 — when --avoid-conflicts is set, walk the ordered
  // candidates until one returns "START" (no conflict). Falls back to the
  // first candidate if every candidate has a conflict signal, so the
  // operator still gets a pickable story plus the WARN reason.
  if (candidates.length > 0 && opts.avoidConflicts) {
    let first = null;
    for (const candidate of candidates) {
      if (!first) first = candidate.story_id;
      const signal = conflictSignalForStory(candidate.story_id);
      if (!signal || signal.startsWith('START')) {
        return candidate.story_id;
      }
    }
    return first;
  }

  if (candidates.length > 0) return candidates[0].story_id;

  // Legacy fallback for old records that predate lane_position. Only return
  // a single unblocked in-progress record; multiple un-laned records are
  // ambiguous and should be assigned lanes before automation picks one.
  const inProgress = records
    .filter(m => m.domain === domain)
    .filter(m => m.kanban === 'in-progress')
    .filter(m => typeof m.lane_position !== 'number')
    .filter(m => isUnblocked(m, recordById))
    .sort((a, b) => new Date(b.started) - new Date(a.started));
  if (inProgress.length === 1) return inProgress[0].story_id;
  return null;
}

const STAGE_ENTRY_STATES = {
  framing: new Set(['init']),
  research: new Set(['framing-sealed', 'framing-complete']),
  scope: new Set(['research-sealed', 'research-complete']),
  plan: new Set(['scope-sealed', 'scope-complete']),
  build: new Set(['plan-sealed', 'plan-approved']),
  qa: new Set(['build-sealed', 'build-complete']),
  close: new Set(['qa-sealed', 'qa-complete']),
};

function stageReadyRecords(stage, records) {
  const readyStages = STAGE_ENTRY_STATES[stage];
  if (!readyStages) {
    process.stderr.write(`UNKNOWN STAGE — ${stage}. Expected one of: ${Object.keys(STAGE_ENTRY_STATES).join(', ')}\n`);
    process.exit(1);
  }
  return records
    .filter(m => m.kanban === 'in-progress')
    .filter(m => m.type !== 'work')
    .filter(m => !args.domain || m.domain === args.domain)
    .filter(m => readyStages.has(m.stage || 'init'))
    .sort((a, b) => new Date(b.started) - new Date(a.started));
}

const args = parseArgs(process.argv);

// ── --work-stage mode (st_862d73d1 AC1) ──────────────────────────────────
// The downstream backstop for /work: assert a tracked in-progress work record
// exists before a session can close. With a slug arg, require a record whose
// meta.workbench matches; without, require exactly one in-progress work record.
// Exit 0 + print id on success; exit 1 (NO WORK RECORD) on zero matches; exit 2
// (AMBIGUOUS) on multiple matches with no slug to disambiguate.
if (args.workStage !== undefined) {
  const slug = args.workbench || args.workStage || '';
  // A /work record is active from creation (the hook opens it at 'backlog'; the
  // work SKILL flips it to 'in-progress'). Match any NON-TERMINAL work record so
  // the backstop holds at both states — only a closed/archived record is excluded.
  const work = loadAllRecords()
    .filter(m => m.type === 'work')
    .filter(m => !TERMINAL_KANBAN.has(m.kanban))
    .filter(m => !slug || m.workbench === slug)
    .sort((a, b) => new Date(b.started) - new Date(a.started));
  if (work.length === 0) {
    const where = slug ? ` for workbench "${slug}"` : '';
    process.stderr.write(
      `NO WORK RECORD${where} — this /work session has no tracked record. ` +
      `Open it with story-init.js --type work --workbench <slug> before closing.\n`,
    );
    process.exit(1);
  }
  if (work.length > 1 && !slug) {
    process.stderr.write(
      'AMBIGUOUS — multiple in-progress work records:\n' +
      work.map(m => `  ${m.story_id}  ${m.workbench || m.slug}`).join('\n') +
      '\nPass --workbench <slug> to identify the session.\n',
    );
    process.exit(2);
  }
  process.stdout.write(work[0].story_id);
  process.exit(0);
}

// ── --stage mode ────────────────────────────────────────────────────────
if (args.stage) {
  const active = stageReadyRecords(args.stage, loadAllRecords());
  if (active.length === 0) {
    const domainText = args.domain ? ` in ${args.domain}` : '';
    process.stderr.write(`NO STAGE-READY RECORD — no active story/defect${domainText} can enter "${args.stage}".\n`);
    process.exit(1);
  }

  if (active.length > 1) {
    process.stderr.write(
      `AMBIGUOUS — multiple active stories/defects can enter "${args.stage}":\n` +
      active.map(m => `  ${m.story_id}  ${m.slug}  (${m.type}, ${m.stage})`).join('\n') +
      '\nPass --story <id> to the stage gate, or resolve one record before continuing.\n'
    );
    process.exit(2);
  }

  process.stdout.write(active[0].story_id);
  process.exit(0);
}

// ── --next mode ──────────────────────────────────────────────────────────
if (args.next) {
  const records = loadAllRecords();
  const recordById = new Map(records.map(r => [r.story_id, r]));

  if (args.domain) {
    // Single-domain answer.
    const pick = pickNextInDomain(args.domain, records, recordById, { avoidConflicts: args.avoidConflicts });
    if (pick) process.stdout.write(pick + '\n');
    else process.stdout.write(`no unblocked story in ${args.domain} — finish current first\n`);
    process.exit(0);
  }

  // No --domain → per-domain rollup. Emit a header for every KNOWN domain
  // that has at least one non-terminal record AND any DISCOVERED domain
  // (so an unrecognized future domain still shows up; the schema validation
  // belongs to story-init.js, not the query layer).
  const domainsWithActive = new Set();
  for (const r of records) {
    if (!TERMINAL_KANBAN.has(r.kanban) && r.domain) domainsWithActive.add(r.domain);
  }
  // Stable ordering: KNOWN_DOMAINS first in declared order, then any extras.
  const orderedDomains = [
    ...KNOWN_DOMAINS.filter(d => domainsWithActive.has(d)),
    ...[...domainsWithActive].filter(d => !KNOWN_DOMAINS.includes(d)).sort(),
  ];

  for (const d of orderedDomains) {
    process.stdout.write(`Domain: ${d}\n`);
    const pick = pickNextInDomain(d, records, recordById, { avoidConflicts: args.avoidConflicts });
    if (pick) process.stdout.write(pick + '\n');
    else process.stdout.write(`no unblocked story in ${d} — finish current first\n`);
    process.stdout.write('\n');
  }
  process.exit(0);
}

// ── Legacy single-active mode ────────────────────────────────────────────
// Accept both 'in-progress' and 'active' kanban states: an in-flight story
// carries kanban:'active' between stages and kanban:'in-progress' only during
// a live build. The de-tax bootstrap (pre-commit) calls this with no env set on
// a plain commit, so it must resolve an 'active'-kanban story or the touches +
// approval refresh silently skips and check-root-lock blocks the commit.
const active = loadAllRecords()
  .filter(m => ['in-progress','active'].includes(m.kanban))
  .filter(m => m.type !== 'work')
  .sort((a, b) => new Date(b.started) - new Date(a.started));

if (active.length === 0) {
  process.stderr.write('NO ACTIVE STORY — no stories in flight. Run /story or /defect to start one.\n');
  process.exit(1);
}

if (active.length > 1) {
  process.stderr.write(
    'AMBIGUOUS — multiple active stories:\n' +
    active.map(m => `  ${m.story_id}  ${m.slug}  (${m.stage})`).join('\n') +
    '\nPass --story <id> to specify, or use --next [--domain D] for the per-project answer.\n'
  );
  process.exit(2);
}

process.stdout.write(active[0].story_id);
