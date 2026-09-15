/**
 * scripts/qa/scratch-gate.js — a throwaway copy of the completeness gate, for
 * proofs that must plant real owner values and watch the gate refuse
 * (st_dd0e19d8 Phase 6/7).
 *
 * WHY A COPY RATHER THAN THE REAL TREE. Two reasons, both measured:
 *
 *   1. COST. A full-tree publication run takes 1m54s on this repository — the
 *      literal name class alone compiles 24,253 patterns. A proof that plants one
 *      seed per corpus class, per source, needs a dozen runs; against the real
 *      tree that is half an hour and nobody runs it. The scratch tree holds only
 *      the gate and its imports, so a run costs about a second and the assertion
 *      is unchanged: same gate, same corpus, same scan.
 *
 *   2. SAFETY. The mutation proofs must delete the gate's blocking behaviour and
 *      watch the test go red. Doing that in the working tree leaves a window
 *      where an interrupted run abandons a repository whose leak detector is
 *      disabled. Here the mutation lives in a temp directory that is removed in a
 *      `finally`.
 *
 * WHAT MAKES IT A REAL PROOF AND NOT A SIMULATION. The gate source is copied
 * byte-for-byte, `config/` and `node_modules/` are symlinked to the real ones,
 * and the corpus cache is the owner's real cache — it is resolved from an
 * absolute home-directory path, which is the same property that lets the
 * publication audit read it from inside an export. Nothing is stubbed.
 *
 * THE COMPOSED SCANS ARE NEUTRALISED, DELIBERATELY. `--all` also runs
 * gate-pii.sh and check-public-config-clean.js, which have their own liveness
 * proof. Letting them fire here would make the exit code ambiguous. They are
 * pointed at empty configuration, so every exit code a caller sees belongs to
 * the corpus gate alone.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * The transitive import closure of the gate plus the two composed scans. A
 * wholesale copy of lib/ would drag the repository's own pre-existing findings
 * into the scratch tree and make its baseline untrue for reasons unrelated to
 * any proof built on it.
 */
export const GATE_FILES = [
  'scripts/check-first-user-clean.js',
  'scripts/check-public-config-clean.js',
  'scripts/gate-pii.sh',
  'lib/owner-corpus.js',
  'lib/owner-corpus-sources.js',
  'lib/corpus-scan.js',
  'lib/publication-posture.js',
  'lib/credential-scan.js',
  'lib/keychain.js',
  'lib/integration-registry.js',
  'lib/apple-store-paths.js',
  'package.json',
];

/**
 * Build the scratch repository. Returns `{ dir, emptyConfig }`; the caller
 * removes both with `destroyScratch`.
 */
export function buildScratch() {
  // realpathSync is not tidiness. On macOS $TMPDIR sits under /var, a symlink to
  // /private/var; node resolves a module's own URL through that link but leaves
  // process.argv[1] as given, so the gate's `invokedDirectly` guard compares two
  // spellings of the same file, decides it was imported rather than run, and
  // EXITS 0 HAVING SCANNED NOTHING. Measured: every assertion built on this
  // harness passed vacuously until this line existed.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'robotdojo-scratch-gate.')));
  for (const rel of GATE_FILES) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(REPO_ROOT, rel), dest);
  }
  // Symlinked, not copied: the gate reads config through the filesystem (so the
  // link is transparent) while `git grep` sees one symlink entry rather than the
  // owner's gitignored overrides. No owner data is ever written to the temp dir.
  symlinkSync(join(REPO_ROOT, 'config'), join(dir, 'config'));
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'));
  const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  g(['init', '-q']);
  g(['add', '-A']);
  g(['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '-m', 'scratch gate copy']);
  const emptyConfig = realpathSync(mkdtempSync(join(tmpdir(), 'robotdojo-scratch-empty.')));
  return { dir, emptyConfig };
}

export function destroyScratch({ dir, emptyConfig }) {
  rmSync(dir, { recursive: true, force: true });
  rmSync(emptyConfig, { recursive: true, force: true });
}

/** Run the scratch gate over its whole tree. */
export function runScratchGate({ dir, emptyConfig }) {
  const env = {
    ...process.env,
    ROBOTDOJO_OWNER_CONFIG_DIR: emptyConfig,
    ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS_FILE: join(emptyConfig, 'no-such-pattern-file'),
    ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS: '',
  };
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'check-first-user-clean.js'), '--all'], {
    cwd: dir,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const summary = /posture "publish" — (\d+) blocking, (\d+) reported/.exec(output);
  return {
    status: r.status,
    output,
    blocking: summary ? Number(summary[1]) : null,
    reported: summary ? Number(summary[2]) : null,
  };
}

/** Plant a value in a fixture file. Returns the repo-relative fixture path. */
export function plantValue({ dir }, label, value) {
  const rel = `docs/${label}-fixture.md`;
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, rel), `planted fixture line: ${value}\n`);
  return rel;
}

/** Plant a value in a FILENAME rather than in file contents. */
export function plantPath({ dir }, value) {
  const rel = `docs/${String(value).replace(/\s+/g, '-')}-fixture.md`;
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, rel), 'planted fixture: the corpus term is in the FILENAME, not here.\n');
  return rel;
}

export function unplant({ dir }) {
  rmSync(join(dir, 'docs'), { recursive: true, force: true });
}

/** Regex-escape a literal so a fixture path can be matched exactly. */
export function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Did the run BLOCK on this fixture, attributed to this class? The reported
 * section prefixes each line with `~`, so the anchored form cannot match it —
 * a finding that merely reported is not a finding that blocked.
 */
export function blockedOn(run, { rel, cls, isPath = false }) {
  const line = isPath
    ? new RegExp(`^\\s+${esc(rel)}: ${cls} "`, 'm')
    : new RegExp(`^\\s+${esc(rel)}:\\d+: ${cls} "`, 'm');
  return line.test(run.output);
}

/** Describe a value by shape only — never by value. */
export function shapeOf(value) {
  const tokens = String(value).trim().split(/\s+/).length;
  return `${String(value).length} chars, ${tokens} token${tokens === 1 ? '' : 's'}`;
}
