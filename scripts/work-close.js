#!/usr/bin/env node
/**
 * work-close.js — close an exploratory `type: work` record in one clean pass.
 *
 * WHY this exists (st_97fc7e48): a /work session is exploratory — it never ran
 * the research→...→qa pipeline, so the generic /close report (which points at
 * 03-build.md / 04-qa.md and narrates merge/deploy stages) is false for it. This
 * helper owns the entire work-close path so the close skill stays thin (one lean
 * call, well under its char budget) and the work-close logic is testable.
 *
 * Behavior:
 *   1. Resolve WORK_ID: --story <id> if given, else `active-story.js --work-stage`
 *      (BARE flag → requires exactly one in-progress work record). Empty → exit 3.
 *   2. Load meta.json. Missing, unreadable, or `meta.type !== 'work'` → exit 3.
 *      Exit 3 is the "not handled" signal: the close skill falls through to its
 *      existing story/defect steps unchanged.
 *   3. For a work record: write an artifact-true 05-close.md (delimited by
 *      work-close-report markers, no 03-build/04-qa pointers), seal + approve
 *      close, mark meta done, refresh the kanban (non-fatal), print, exit 0.
 *
 * Contract: this is deterministic orchestration over existing scripts. It makes
 * no LLM client calls, so no tier declaration applies here.
 */
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';

const HOME = process.env.HOME;
const SCRIPTS = `${HOME}/robotdojo/scripts`;
const STORIES = `${HOME}/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories`;

// Exit 3 = "not a work record / unresolved" → the close skill falls through to
// its existing story/defect steps. Any other non-zero is a real failure.
const NOT_HANDLED = 3;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--story') args.story = argv[++i];
  }
  return args;
}

// Resolve the work record id. Prefer an explicit --story; otherwise ask
// active-story.js for the single in-progress work record (BARE --work-stage:
// the resolver reads the value as a workbench slug, so passing one would scope
// the match — bare means "the one open work session"). Failure → empty.
function resolveWorkId(args) {
  if (args.story) return args.story.trim();
  try {
    const out = execSync(`node ${SCRIPTS}/active-story.js --work-stage`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return out.trim();
  } catch {
    return '';
  }
}

// ISO-8601 to second precision (matches the close skill's existing meta stamps).
function nowStamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Build the artifact-true close report. The body lives between the literal
// work-close-report markers and MUST contain no 03-build / 04-qa substrings —
// a work session never had those stages. Evidence lists only the synthesis/memo
// artifacts a work record actually produces: 01-*.md / 02-*.md plus 00-scope.md.
function buildReport(workId, dir) {
  let evidence = [];
  try {
    evidence = readdirSync(dir)
      .filter((f) => /^0[12]-.*\.md$/.test(f) || f === '00-scope.md')
      .sort();
  } catch {
    evidence = [];
  }
  const evidenceLines = evidence.length
    ? evidence.map((f) => `- \`${f}\``).join('\n')
    : '- (no synthesis artifacts on disk)';

  return [
    '# Close Report',
    '',
    `Work session: ${workId}`,
    '',
    '<!-- work-close-report:start -->',
    '',
    '## Shipped',
    '',
    '- {what this work session produced — see the synthesis below}',
    '',
    '## Evidence',
    '',
    evidenceLines,
    '',
    '## Notes',
    '',
    'Work session, not a pipeline story: no build/QA/merge/deploy stages apply. ' +
      'QA gate advisory-skipped by design.',
    '',
    '<!-- work-close-report:end -->',
    '',
    'VERDICT: PASS',
    '',
  ].join('\n');
}

const args = parseArgs(process.argv);
const workId = resolveWorkId(args);

// Unresolved → not handled; the close skill resolves a story/defect itself.
if (!workId) process.exit(NOT_HANDLED);

const dir = `${STORIES}/${workId}`;
const metaPath = `${dir}/meta.json`;

if (!existsSync(metaPath)) process.exit(NOT_HANDLED);

let meta;
try {
  meta = JSON.parse(readFileSync(metaPath, 'utf8'));
} catch {
  process.exit(NOT_HANDLED);
}

// Only this helper closes work records. Anything else falls through unchanged.
if (meta.type !== 'work') process.exit(NOT_HANDLED);

try {
  execFileSync('node', [`${SCRIPTS}/topic-session-close.js`, dir], {
    stdio: 'inherit',
    env: { ...process.env, ROBOTDOJO_ALLOW_PLAINTEXT: '1' },
  });
} catch {
  process.stdout.write('topic-session-close: skipped (continuing).\n');
}

const closePath = `${dir}/05-close.md`;
writeFileSync(closePath, buildReport(workId, dir));

// Seal + approve close. close is not a Bunshin-required stage, so the seal needs
// no recorded verdict. Inherit stdio so any gate output is operator-visible.
execFileSync('node', [`${SCRIPTS}/story-gate.js`, '--seal', 'close', '--file', closePath, '--story', workId], {
  stdio: 'inherit',
});
execFileSync('node', [`${SCRIPTS}/story-gate.js`, '--approve', 'close', '--story', workId], {
  stdio: 'inherit',
});

// Mark the record done.
const now = nowStamp();
meta.stage = 'close-complete';
meta.kanban = 'done';
meta.closed_at = now;
meta.updated_at = now;
writeFileSync(metaPath, JSON.stringify(meta, null, 2));

// Refresh the kanban (Queue lanes + stamp + one Recent-History line). kanban.md
// is gitignored — LOCAL only, never staged. Non-fatal: the seal is independent.
try {
  execFileSync('node', [`${SCRIPTS}/kanban-refresh.js`, '--story', workId], { stdio: 'inherit' });
} catch {
  process.stdout.write('kanban-refresh: skipped (continuing).\n');
}

process.stdout.write(`Closed ${workId}. Marked done on the kanban.\n`);
process.exit(0);
