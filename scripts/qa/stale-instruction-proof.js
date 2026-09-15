#!/usr/bin/env node
/**
 * stale-instruction-proof.js — AC18's first half (st_dd0e19d8 Phase 7).
 *
 * AC18: "No standing instruction in the build conventions, the agent skills, or
 * tracked code points at something that is not there."
 *
 * WHAT COUNTS AS A STANDING INSTRUCTION, AND WHY THE SCOPE IS NOT WIDER. An
 * instruction is a sentence a future agent will act on. Three surfaces carry
 * those: the build conventions, the agent skills, and the Claude Code adapter.
 * Two surfaces deliberately do NOT, and each exclusion is measured rather than
 * assumed:
 *
 *   THE MEMORY LOG IS HISTORY, NOT INSTRUCTION. It is append-only and
 *   Merkle-chained: an entry cannot be edited without breaking the chain, which
 *   is the property that makes it trustworthy. Measured 2026-07-26: 87 distinct
 *   module and script paths named across 1,098 entries no longer exist —
 *   because the log records what was true when it was written. Requiring every
 *   historical entry to name a file that exists today would require rewriting
 *   history to satisfy a cleanliness check. So the log is checked the only way
 *   its own design allows: a standing instruction inside it is corrected by
 *   appending a later entry under the same name, and this proof asserts that
 *   supersession for the one entry AC18 names.
 *
 *   THE PERSONAS ARE EXCLUDED FOR ONE MEASURED REASON. Hakase's body twice
 *   illustrates reading a third-party library's error handling in a file called
 *   `lib/connection.js`. That is a worked example about someone else's
 *   repository, not an instruction about this one, and no regex distinguishes
 *   the two. Including personas would mean either a false failure or an
 *   allowlist, and an allowlist is where a check like this rots.
 *
 * THE PART THAT IS NOT SCOPED AWAY. Beyond those surfaces this proof still
 * COUNTS and PRINTS every scanner-shaped reference in the tracked tree that does
 * not resolve, without asserting on it. AC18 bounds the class it fixes to where
 * research measured it; a number printed on every run is how the rest stays
 * visible instead of becoming invisible by being out of scope.
 *
 * Exit 0 = no standing instruction points at a file that is not there.
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

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

/** A reference to a runnable file in THIS repository. */
const REF = /\b((?:scripts|lib)\/[A-Za-z0-9._/-]*\.(?:js|sh|mjs))\b/g;

/** The scanner that has never existed — the specific defect AC18 names. */
const PHANTOM_SCANNER = 'check-pii.sh';

/** The memory entry that is a standing instruction rather than a record. */
const SUPERSEDED_ENTRY = 'no-pii-on-github';

function git(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function trackedFiles() {
  const r = git(['ls-files', '-z']);
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : [];
}

function readText(rel) {
  try {
    return readFileSync(join(REPO_ROOT, rel), 'utf8');
  } catch {
    return null;
  }
}

/** Every .md under a directory, recursively. */
function markdownUnder(rel) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(REPO_ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const next = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(next);
      else if (e.name.endsWith('.md')) out.push(next);
    }
  };
  walk(rel);
  return out.sort();
}

/** The instruction surfaces, in AC18's own order. */
function instructionSurfaces() {
  return ['agents/build-conventions.md', ...markdownUnder('agents/skills'), 'CLAUDE.md'];
}

/** Every unresolvable reference in a file, as {ref, line}. */
function danglingRefs(rel) {
  const text = readText(rel);
  if (text === null) return [];
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    REF.lastIndex = 0;
    for (const m of lines[i].matchAll(REF)) {
      if (!existsSync(join(REPO_ROOT, m[1]))) out.push({ ref: m[1], line: i + 1 });
    }
  }
  return out;
}

/** The newest memory entry carrying `name:` in its front matter. */
function newestMemoryEntry(name) {
  let dir;
  try {
    dir = readdirSync(join(REPO_ROOT, 'user', 'memory', 'log')).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return null;
  }
  for (let i = dir.length - 1; i >= 0; i -= 1) {
    const rel = `user/memory/log/${dir[i]}`;
    const text = readText(rel);
    if (text && new RegExp(`^name:\\s*${name}\\s*$`, 'm').test(text)) return { rel, text };
  }
  return null;
}

function main() {
  process.stdout.write('stale-instruction-proof: AC18 — no standing instruction points at a missing file\n\n');

  // ── the instruction surfaces ───────────────────────────────────────────────
  process.stdout.write('The surfaces AC18 names\n');
  const surfaces = instructionSurfaces();
  let totalDangling = 0;
  for (const rel of surfaces) {
    const dangling = danglingRefs(rel);
    totalDangling += dangling.length;
    if (dangling.length > 0) {
      check(
        `${rel} names only files that exist`,
        false,
        dangling.map((d) => `${d.ref} (line ${d.line})`).join(', ')
      );
    }
  }
  check(
    `all ${surfaces.length} instruction surfaces name only files that exist`,
    totalDangling === 0,
    totalDangling === 0 ? 'build conventions, every agent skill, and the Claude Code adapter' : `${totalDangling} dangling`
  );

  // ── the phantom scanner, anywhere in tracked code ──────────────────────────
  process.stdout.write('\nThe scanner that has never existed\n');
  // SELF-EXCLUDED, for the same reason the gate excludes its own source: a
  // detector must name the thing it hunts, so it will always match itself. The
  // exclusion is one file and it is stated here rather than being a silent
  // filter — and the assertion below keeps it honest by requiring that this file
  // is the ONLY tracked file naming it, so the exclusion can never grow into a
  // place where a real reference could hide.
  const SELF = 'scripts/qa/stale-instruction-proof.js';
  const namesPhantom = trackedFiles().filter((f) => {
    if (f === SELF) return false;
    const text = readText(f);
    return text !== null && text.includes(PHANTOM_SCANNER);
  });
  check(
    `no tracked file treats ${PHANTOM_SCANNER} as live`,
    namesPhantom.length === 0,
    namesPhantom.length === 0
      ? `the two comment sites now name gate-pii.sh; ${SELF} is self-excluded, as the detector that hunts it`
      : namesPhantom.join(', ')
  );
  check(
    'and the scanner that DOES exist is there to be named',
    existsSync(join(REPO_ROOT, 'scripts', 'gate-pii.sh')),
    'scripts/gate-pii.sh'
  );

  // ── the prescribed-but-missing helper ──────────────────────────────────────
  process.stdout.write('\nThe helper that was prescribed and never built\n');
  const entry = newestMemoryEntry(SUPERSEDED_ENTRY);
  check(
    `the standing "${SUPERSEDED_ENTRY}" instruction has a current entry`,
    !!entry,
    entry ? entry.rel : 'no entry found'
  );
  if (entry) {
    // A supersession entry MUST name the thing it supersedes — that is what
    // makes it readable as a correction rather than as a second, competing
    // instruction. So a missing path is excused only on a line that says it is
    // gone: the reference is then a statement about the past, not a step to
    // follow. Any missing path on a line without that marking is a live
    // prescription and fails. The instruction surfaces above get no such
    // latitude, because they carry no history.
    const RETIRED = /supersede|never (?:built|existed)|must not be built|no longer|does not exist/i;
    const lines = entry.text.split('\n');
    const dangling = [];
    const excused = [];
    for (const line of lines) {
      REF.lastIndex = 0;
      for (const m of line.matchAll(REF)) {
        if (existsSync(join(REPO_ROOT, m[1]))) continue;
        (RETIRED.test(line) ? excused : dangling).push(m[1]);
      }
    }
    check(
      '  …and every mechanism it PRESCRIBES exists',
      dangling.length === 0,
      dangling.length === 0
        ? `the gitignored overrides and the corpus gate; ${excused.length} reference(s) named only as retired`
        : dangling.join(', ')
    );
    check(
      '  …and it says so explicitly rather than leaving the old prescription standing',
      /supersede/i.test(entry.text),
      'an append-only log corrects by supersession, never by edit'
    );
  }

  // ── the detector can say no ────────────────────────────────────────────────
  process.stdout.write('\nThe detector itself\n');
  const control = 'scripts/a-scanner-that-does-not-exist.js';
  check(
    'a control reference to a missing file is detected as missing',
    !existsSync(join(REPO_ROOT, control)) && REF.test(` ${control} `),
    'a check that cannot fail proves nothing'
  );

  // ── what remains, counted rather than hidden ───────────────────────────────
  const SCANNER_SHAPE = /\b(scripts\/(?:[A-Za-z0-9._/-]*\/)?(?:check-[A-Za-z0-9._-]+\.js|gate-[A-Za-z0-9._-]+\.(?:js|sh)|[A-Za-z0-9._-]+\.sh))\b/g;
  const outside = new Map();
  for (const f of trackedFiles()) {
    if (f.startsWith('gateway/') || f.startsWith('user/memory/') || surfaces.includes(f)) continue;
    if (!/\.(md|js|sh|mjs|json|yml|yaml)$/.test(f)) continue;
    const text = readText(f);
    if (!text) continue;
    SCANNER_SHAPE.lastIndex = 0;
    for (const m of text.matchAll(SCANNER_SHAPE)) {
      if (!existsSync(join(REPO_ROOT, m[1]))) {
        if (!outside.has(m[1])) outside.set(m[1], new Set());
        outside.get(m[1]).add(f);
      }
    }
  }
  process.stdout.write(
    `\n  MEASURED  ${outside.size} scanner-shaped reference(s) elsewhere in the tracked tree do not resolve —\n`
      + '            outside the class AC18 bounds, disclosed rather than asserted on:\n'
  );
  for (const [ref, files] of [...outside].sort()) {
    process.stdout.write(`            ${ref} <- ${[...files].sort().join(', ')}\n`);
  }

  const failures = results.filter((r) => !r.ok);
  process.stdout.write(`\nstale-instruction-proof: ${results.length - failures.length}/${results.length} PASS\n`);
  return failures.length === 0 ? 0 : 1;
}

process.exit(main());
