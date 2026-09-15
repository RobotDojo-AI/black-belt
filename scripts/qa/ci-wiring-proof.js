#!/usr/bin/env node
/**
 * ci-wiring-proof.js — AC17 (st_dd0e19d8 Phase 6).
 *
 * AC17: "Continuous integration catches what it can without the owner's private
 * data ever leaving his machine. It runs the checks that need no copy of his
 * information … It does not claim to run the owner-data check, which on a fresh
 * runner would find nothing and report clean."
 *
 * So this proof has two halves and the second one is the unusual one:
 *
 *   PRESENT — the four corpus-free checks are wired, unconditionally, on push to
 *   the default branch. "Wired" is not "present in a file": a step behind an
 *   `if:`, a job behind an `if:`, a `continue-on-error: true`, or a `|| true` in
 *   the run body is a check that can be arranged not to fail. Each of those is
 *   asserted absent.
 *
 *   ABSENT — the owner-data check is NOT wired. A GitHub runner has no corpus,
 *   so scripts/check-first-user-clean.js would report clean there having scanned
 *   nothing against nothing. Adding it would produce a green tick that means
 *   less than no tick at all, and this proof FAILS if anyone adds one.
 *
 * WHY THE PARSER IS DELIBERATELY BLUNT. Workflow YAML is parsed here by lines
 * rather than by a YAML library, because this repository declares no YAML
 * dependency and a proof that requires one to run is a proof that stops running.
 * The blunt parser is made safe by biasing every ambiguity toward FAILURE: an
 * unrecognised structure, an unlocatable command, or a forbidden token anywhere
 * in the workflow that carries these checks is a refusal, never a shrug. A
 * parser that could be wrong in the passing direction would be the vacuous check
 * this story exists to close.
 *
 * MODES:
 *   (none)    report the wiring and fail only if a required check is missing
 *   --strict  assert every property above; this is the mode the criteria run
 *
 * Exit 0 = the wiring holds.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

/**
 * The four checks AC17 calls corpus-free, each with the plain-English statement
 * of what it protects. The command string is matched as a substring of a run
 * body, so a step that adds flags still matches — but a step that DROPS a flag
 * (say `--schema`) does not, which is the direction that matters.
 */
const REQUIRED = [
  {
    what: 'owner domains, workspace gids, calendar ids and stored credential values',
    cmd: 'node scripts/check-public-config-clean.js',
  },
  {
    what: 'the deploy ignore-list still excludes the private data roots',
    cmd: 'node scripts/check-vercelignore-private-data.js',
  },
  {
    what: 'every permitted entry has a name, a file, a class and a stated reason',
    cmd: 'node scripts/check-publication-permitted.js --schema',
  },
  {
    what: 'the published file set still matches its lock',
    cmd: 'node scripts/publication-manifest.js --check-lock',
  },
];

/** The check that must NOT be in CI, and the flags that would make it a claim. */
const FORBIDDEN_CHECK = 'check-first-user-clean.js';

/** Ways a step can be made not to fail. Each is matched inside a run body. */
const SUPPRESSIONS = [
  { re: /\|\|\s*true\b/, what: '`|| true`' },
  { re: /\|\|\s*:\s*(?:$|\n)/m, what: '`|| :`' },
  { re: /\|\|\s*exit\s+0\b/, what: '`|| exit 0`' },
  { re: /\bset\s+\+e\b/, what: '`set +e`' },
  { re: /;\s*true\s*$/m, what: 'a trailing `; true`' },
  { re: /2>\s*\/dev\/null\s*(?:$|\n)/m, what: 'a discarded stderr with no failure path' },
];

function defaultBranch() {
  const r = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const raw = (r.stdout || '').trim();
  // origin/main -> main. A fresh clone with no remote HEAD falls back to `main`,
  // which is this repository's default branch; the fallback is stated rather than
  // silently assumed.
  return raw ? raw.replace(/^[^/]+\//, '') : 'main';
}

/** Every workflow file, read once. */
function workflows() {
  if (!existsSync(WORKFLOW_DIR)) return [];
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => ({ file: `.github/workflows/${f}`, text: readFileSync(join(WORKFLOW_DIR, f), 'utf8') }));
}

/** Strip full-line comments so a token quoted in prose is never mistaken for wiring. */
function code(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/**
 * Split a workflow into its jobs. Jobs are the keys indented exactly two spaces
 * under a top-level `jobs:`; anything else is not a job and this returns nothing
 * for it, which surfaces as an unlocatable command rather than as a pass.
 */
function jobsOf(text) {
  const lines = code(text).split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim()) break; // back to top level — jobs are over
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) jobs.push(current);
      current = { name: header[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) jobs.push(current);
  return jobs.map((j) => ({ name: j.name, text: j.lines.join('\n') }));
}

/**
 * Split a job into its steps. A step begins at a list item indented six spaces
 * under `steps:` and runs to the next one.
 */
function stepsOf(jobText) {
  const lines = jobText.split('\n');
  const start = lines.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  if (start < 0) return [];
  const steps = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^ {0,3}\S/.test(line) && line.trim()) break;
    if (/^ {6}- /.test(line)) {
      if (current) steps.push(current);
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) steps.push(current);
  return steps.map((s) => s.join('\n'));
}

/** The `on:` trigger block of a workflow, as text. */
function triggerBlock(text) {
  const lines = code(text).split('\n');
  const start = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]) && lines[i].trim()) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** Does this workflow run on a push to `branch`? */
function runsOnPushTo(text, branch) {
  const block = triggerBlock(text);
  const push = /(^|\n)\s{2}push:\s*\n([\s\S]*?)(?=\n\s{2}\S|$)/.exec(block);
  if (!push) return false;
  const body = push[2];
  // `push:` with no branch filter runs on every branch, which includes the
  // default one.
  if (!/branches/.test(body)) return true;
  return new RegExp(`(^|\\n)\\s*-\\s*['"]?${branch}['"]?\\s*$`, 'm').test(body);
}

/** The `run:` body of a step, block scalar or inline. */
function runBody(stepText) {
  const inline = /^\s*-?\s*run:\s*(?!\||>)(.+)$/m.exec(stepText);
  if (inline) return inline[1].trim();
  const block = /run:\s*[|>][-+]?\s*\n([\s\S]*)$/.exec(stepText);
  return block ? block[1] : '';
}

function main() {
  const strict = process.argv.slice(2).includes('--strict');
  const branch = defaultBranch();
  const files = workflows();

  process.stdout.write(
    `ci-wiring-proof: ${files.length} workflow file(s); default branch "${branch}"`
      + `${strict ? '; strict' : '; report only'}\n\n`
  );

  if (files.length === 0) {
    check('there is at least one workflow to inspect', false, 'no .github/workflows');
    return 1;
  }

  process.stdout.write('AC17 present — the four corpus-free checks\n');
  for (const req of REQUIRED) {
    let found = null;
    for (const wf of files) {
      for (const job of jobsOf(wf.text)) {
        for (const step of stepsOf(job.text)) {
          if (runBody(step).includes(req.cmd)) found = { wf, job, step };
        }
      }
    }
    if (!found) {
      check(`CI checks ${req.what}`, false, `no unconditional step runs \`${req.cmd}\``);
      continue;
    }
    check(`CI checks ${req.what}`, true, `${found.wf.file} → ${found.job.name}`);
    if (!strict) continue;

    check(
      `  …on a push to ${branch}`,
      runsOnPushTo(found.wf.text, branch),
      'a check that only runs on pull requests misses a direct push'
    );
    check(
      '  …with no job condition',
      !/^ {4}if:/m.test(found.job.text),
      'a conditional job is a job that can be arranged not to run'
    );
    check(
      '  …with no step condition and no continue-on-error',
      !/^ {8}if:/m.test(found.step) && !/continue-on-error:/.test(found.step),
      'either one turns a failure into a pass'
    );
    const body = runBody(found.step);
    const suppressed = SUPPRESSIONS.filter((s) => s.re.test(body));
    check(
      '  …and no failure suppression in the run body',
      suppressed.length === 0,
      suppressed.length === 0 ? 'exit status reaches the runner' : suppressed.map((s) => s.what).join(', ')
    );
  }

  if (strict) {
    process.stdout.write('\nAC17 absent — what CI must NOT claim\n');
    const claiming = [];
    for (const wf of files) {
      for (const job of jobsOf(wf.text)) {
        for (const step of stepsOf(job.text)) {
          if (runBody(step).includes(FORBIDDEN_CHECK)) claiming.push(`${wf.file} → ${job.name}`);
        }
      }
    }
    check(
      'CI does not run the owner-data check, which would report clean having scanned nothing',
      claiming.length === 0,
      claiming.length === 0 ? 'the limitation is stated in the artifact instead' : claiming.join(', ')
    );

    // The blunt-parser safety net: if the workflow carrying these checks holds a
    // condition or a suppression ANYWHERE, refuse — even if the per-step
    // assertions above found nothing. A parser biased toward passing is worth
    // less than no parser.
    const carriers = [
      ...new Set(
        REQUIRED.flatMap((req) =>
          files
            .filter((wf) => jobsOf(wf.text).some((j) => stepsOf(j.text).some((s) => runBody(s).includes(req.cmd))))
            .map((wf) => wf.file)
        )
      ),
    ];
    for (const file of carriers) {
      const wf = files.find((f) => f.file === file);
      const body = code(wf.text);
      const tokens = [];
      if (/^\s*if:/m.test(body)) tokens.push('a condition');
      if (/continue-on-error:/.test(body)) tokens.push('continue-on-error');
      for (const s of SUPPRESSIONS) if (s.re.test(body)) tokens.push(s.what);
      check(
        `${file} carries no condition or suppression anywhere`,
        tokens.length === 0,
        tokens.length === 0 ? 'nothing to arrange around' : tokens.join(', ')
      );
    }
  }

  const failures = results.filter((r) => !r.ok);
  process.stdout.write(`\nci-wiring-proof: ${results.length - failures.length}/${results.length} PASS\n`);
  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
