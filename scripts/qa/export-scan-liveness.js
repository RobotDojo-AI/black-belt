#!/usr/bin/env node
/**
 * export-scan-liveness.js — AC13 and AC14, proven by detection rather than by
 * execution (st_dd0e19d8 Phase 4).
 *
 * THE DEFECT THIS CLOSES, AND WHY "IT RAN" WAS NEVER EVIDENCE. The publication
 * audit composes two scans. Inside the exported copy, one of them loaded ZERO
 * patterns (its list lives in `.git/info/`, which `git archive` never emits) and
 * the other cross-checked ZERO owner domains (its list lives in gitignored
 * `config/*.user.json` files, which are not tracked). Both exited 0. Both
 * printed a clean verdict. The publication audit therefore rested on one
 * mechanism while appearing to rest on three — and every run "passed".
 *
 * So a probe that asserts the scans exit 0 inside an export would have passed
 * before the fix and after it, which makes it worthless. This one PLANTS
 * something each scan must catch and asserts a REFUSAL. The third check is the
 * one that proves the bridge is load-bearing rather than decorative:
 *
 *   1. a planted owner identity term in a real export tree is REFUSED, with the
 *      bridge in place;
 *   2. a planted owner domain in the same tree is REFUSED;
 *   3. the SAME planted tree, with the bridge removed, is reported CLEAN by both
 *      — the live defect, reproduced, so the fix is measured against it;
 *   4. with the bridge removed AND the non-vacuity flags set, both REFUSE
 *      instead of reporting clean — the flags are what turn a blind scan into a
 *      failure;
 *   5. the pattern count and the domain count inside the export are non-zero,
 *      which is the design's stated gate for this phase;
 *   6. (--credential) a planted stored credential value is REFUSED, naming the
 *      key and never the value.
 *
 * NOTHING PLANTED IS EVER PRINTED. The seeds are the owner's real patterns,
 * domains and secrets — that is what makes the proof real — so every message
 * refers to them by shape and length. A probe that proves a leak detector works
 * by printing the leak has failed the story it belongs to.
 *
 * Everything is written INSIDE a throwaway export directory, never into the
 * working tree, and the directory is removed in a `finally` regardless of
 * outcome.
 *
 * EACH ARM IS INDEPENDENT, AND SAYS SO. The arms once shared one export tree,
 * which made `--all` disagree with `--planted` and `--credential` run separately
 * — the planted arm commits a fixture carrying an owner domain, and the domain
 * arm of check-public-config-clean runs unconditionally, so every later scan of
 * that tree refused on the leftover. A probe whose verdict depends on the order
 * it was invoked in proves nothing, which is the same defect class this file
 * exists to catch. So every arm builds its own tree from the same immutable
 * snapshot, and opens by asserting two observable traces of a leaked tree —
 * no other arm's fixture on disk, and exactly the one commit the builder made —
 * and closes by asserting it left the process environment untouched. Those two
 * assertions are what make `--all` exactly the union of the parts: if a future
 * change reintroduces sharing, the arm that inherits it fails on entry and names
 * what it inherited, instead of failing somewhere downstream for a reason that
 * looks unrelated.
 *
 * Exit 0 = every asserted property holds.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExportTree, composedBridgeEnv } from '../../lib/publication-step.js';
import { loadManifest, resolveManifest } from '../../lib/publication-manifest.js';
import { credentialArm } from '../../lib/credential-scan.js';
import { readKeychainSecret } from '../../lib/keychain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const CONFIG_DIR = join(REPO_ROOT, 'config');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}
function gitIn(dir, args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}
function filesAtCommit(commit) {
  const r = git(['ls-tree', '-r', '-z', '--name-only', commit]);
  if (r.status !== 0) return null;
  const paths = r.stdout.split('\0').filter(Boolean);
  return paths.length > 0 ? paths : null;
}
function archive(sha, paths, exportDir) {
  const quoted = paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
  return spawnSync('bash', ['-c', `set -o pipefail; git archive ${sha} -- ${quoted} | tar -x -C '${exportDir}'`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

const deps = { repoRoot: REPO_ROOT, configDir: CONFIG_DIR, git, gitIn, archive, filesAtCommit };

/**
 * A commit object for the CURRENT working tree, built through a throwaway index.
 *
 * WHY THE PROBE NEEDS THIS AND THE PUBLICATION STEP FORBIDS IT. The step refuses
 * to publish anything but a named commit, and it is right to: publishing
 * working-tree state is the defect it exists to close. But this probe is testing
 * the scanners *as they are being changed*, and an export built from HEAD
 * contains the versions from before the change — which is exactly what happened
 * on the first run here: every liveness assertion failed because the export
 * carried the old, blind copies of both scans. Proving the fix works requires
 * exporting the fix.
 *
 * Nothing is committed to a branch, staged, or written to the working tree:
 * GIT_INDEX_FILE redirects `git add` to a temp file that is deleted immediately,
 * and `commit-tree` produces a dangling object git will garbage-collect. The
 * repository is in exactly the state it was in before this ran.
 */
function workingTreeCommit() {
  const indexFile = join(tmpdir(), `robotdojo-liveness-index.${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    git(['read-tree', 'HEAD'], { env });
    git(['add', '-A'], { env });
    const tree = git(['write-tree'], { env }).stdout.trim();
    if (!tree) return null;
    const commit = git(['commit-tree', tree, '-p', 'HEAD', '-m', 'liveness probe: working-tree snapshot'], { env })
      .stdout.trim();
    return commit || null;
  } finally {
    rmSync(indexFile, { force: true });
  }
}

// ── seeds, chosen from the owner's real configuration ────────────────────────

/**
 * A pattern from the private list that can be planted VERBATIM: one made only of
 * letters, digits and spaces, so the literal equals what the regex matches.
 * Planting a regex source would prove the file was read, not that the matcher
 * works.
 */
function literalPatternSeed() {
  const path = join(REPO_ROOT, '.git', 'info', 'private-identity-patterns');
  if (!existsSync(path)) return null;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[A-Za-z0-9][A-Za-z0-9 ]{3,}$/.test(line)) return line;
  }
  return null;
}

/** An owner domain from the gitignored local overrides — the same read the guard does. */
function ownerDomainSeed() {
  let files = [];
  try {
    files = readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.user.json'));
  } catch {
    return null;
  }
  for (const f of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(CONFIG_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    const raw = parsed && parsed.domains;
    const candidates = Array.isArray(raw) ? raw : Object.keys(raw || {});
    for (const c of candidates) {
      const d = String(c || '').trim().toLowerCase();
      if (d.includes('.')) return d;
    }
  }
  return null;
}

/** Describe a secret by shape only. */
function redact(s) {
  return `${String(s).length} chars, starts "${String(s).slice(0, 1)}…"`;
}

// ── the scans, run against the export ────────────────────────────────────────

function runPii(exportDir, { bridge = true, require: req = false, files = null } = {}) {
  // `--files` consumes every remaining argument (a filename may look like a
  // flag), so every flag goes BEFORE it.
  const args = ['scripts/gate-pii.sh'];
  if (req) args.push('--require-patterns');
  if (files) args.push('--files', ...files);
  else args.push('--all');
  const env = { ...process.env };
  // Remove any inherited configuration so "no bridge" genuinely means none.
  delete env.ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS;
  delete env.ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS_FILE;
  delete env.ROBOTDOJO_OWNER_CONFIG_DIR;
  const r = spawnSync('bash', args, {
    cwd: exportDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: bridge ? { ...env, ...composedBridgeEnv(deps) } : env,
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

function runConfigClean(exportDir, { bridge = true, requireDomains = false, requireCredentials = false } = {}) {
  const args = ['scripts/check-public-config-clean.js'];
  if (requireDomains) args.push('--require-domains');
  if (requireCredentials) args.push('--require-credentials');
  const env = { ...process.env };
  delete env.ROBOTDOJO_OWNER_CONFIG_DIR;
  const r = spawnSync(process.execPath, args, {
    cwd: exportDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: bridge ? { ...env, ...composedBridgeEnv(deps) } : env,
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

// ── arm isolation ────────────────────────────────────────────────────────────

/**
 * Every file an arm plants. Named in one place so an arm can assert, at entry,
 * that no OTHER arm's fixture is present in the tree it is about to scan.
 */
const FIXTURES = Object.freeze(['docs/liveness-planted-fixture.md', 'docs/liveness-planted-credential.md']);

/** The whole environment as a comparable string, so a mutation anywhere shows up. */
function envSnapshot() {
  return Object.keys(process.env).sort().map((k) => `${k}=${process.env[k]}`).join('\n');
}

/**
 * Run one arm against an export tree BUILT FOR THAT ARM, and destroy it after.
 *
 * WHY EVERY ARM BUILDS ITS OWN TREE. The arms used to share a single export
 * built once per process, and that made the probe's verdict depend on the order
 * it was invoked in. The planted arm writes a fixture carrying an owner domain
 * and COMMITS it into the tree; the domain arm of check-public-config-clean runs
 * unconditionally — `--require-domains` governs only the non-vacuity refusal, not
 * whether the arm looks. So once the planted arm had run, every later scan of
 * that tree refused on the leftover fixture, and the credential arm's two
 * "this tree is otherwise clean" assertions failed under `--all` while passing
 * under `--credential` alone.
 *
 * That is precisely the defect class this file exists to catch: a check whose
 * result comes from something other than the thing it claims to measure. A proof
 * that only holds in one invocation order is not a proof. So each arm gets a
 * fresh tree, asserts at entry that it is pristine, asserts at exit that it left
 * the process environment as it found it, and `--all` is exactly the union of
 * the parts.
 *
 * `run` returns null to continue, or an exit code to abort the whole probe.
 */
async function withArmExport(label, { sha, paths }, run) {
  const exportDir = mkdtempSync(join(tmpdir(), 'robotdojo-liveness.'));
  const envBefore = envSnapshot();
  try {
    process.stdout.write(`\n${label}\n`);
    const built = buildExportTree(deps, { sha, paths, exportDir });
    if (!built.ok) {
      process.stderr.write(`export-scan-liveness: cannot build the export —\n  ${built.errors.join('\n  ')}\n`);
      return 1;
    }

    // Isolation asserted, not assumed. A pristine tree carries no fixture from
    // another arm and exactly the one commit buildExportTree just made — the
    // two observable traces a leaked tree would leave.
    const strays = FIXTURES.filter((f) => existsSync(join(exportDir, f)));
    const commits = String(gitIn(exportDir, ['rev-list', '--count', 'HEAD']).stdout || '').trim();
    check(
      'the arm starts from a tree no other arm has touched',
      strays.length === 0 && commits === '1',
      `${built.files} files, ${commits} commit(s)`
        + (strays.length > 0 ? `, leaked fixture(s): ${strays.join(', ')}` : '')
    );

    const abort = await run(exportDir);

    // The bridge is passed per-spawn, never exported into this process. If an
    // arm ever sets or deletes a variable globally, the next arm inherits it and
    // the same order-dependence returns through a different door.
    check(
      'the arm left the process environment exactly as it found it',
      envSnapshot() === envBefore,
      envSnapshot() === envBefore ? 'unchanged' : 'the arm mutated process.env'
    );
    return abort ?? null;
  } finally {
    rmSync(exportDir, { recursive: true, force: true });
  }
}

// ── the probe ────────────────────────────────────────────────────────────────

/** AC13 — the composed scans detect inside the export. */
async function plantedArm(exportDir) {
  const term = literalPatternSeed();
  const domain = ownerDomainSeed();
  if (!term) return check('an owner identity pattern is available to plant', false, 'no literal pattern in the private list') ? 0 : 1;
  if (!domain) return check('an owner domain is available to plant', false, 'no domain in the local overrides') ? 0 : 1;

  // The configuration counts are read from a CLEAN run, before anything is
  // planted: a failing run reports violations and never prints its summary
  // line, so reading the count off the refusal would read zero and call it
  // evidence. This is the design's stated Phase-4 gate — a non-zero pattern
  // count and a non-zero domain count inside the export.
  const cleanPii = runPii(exportDir, { bridge: true, require: true, files: ['README.md'] });
  const cleanConfig = runConfigClean(exportDir, { bridge: true, requireDomains: true });
  const patternCount = Number((cleanPii.output.match(/loaded (\d+) private-identity pattern/) || [])[1] || 0);
  const domainCount = Number((cleanConfig.output.match(/cross-checked (\d+) owner domain/) || [])[1] || 0);
  check(
    'inside the export both scans load a non-zero owner configuration',
    patternCount > 0 && domainCount > 0 && cleanPii.status === 0 && cleanConfig.status === 0,
    `${patternCount} pattern(s), ${domainCount} domain(s); exits ${cleanPii.status}/${cleanConfig.status}`
  );

  const plantedRel = 'docs/liveness-planted-fixture.md';
  writeFileSync(join(exportDir, plantedRel), `planted identity line: ${term}\nplanted domain line: ${domain}\n`);
  // Track it so `git ls-files`-driven scans see it, exactly as a real leak
  // in a published file would be seen.
  gitIn(exportDir, ['add', plantedRel]);
  gitIn(exportDir, ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '-m', 'planted']);

  const piiBridged = runPii(exportDir, { bridge: true, require: true, files: [plantedRel] });
  check(
    'a planted owner identity term inside the export is REFUSED',
    piiBridged.status !== 0 && piiBridged.output.includes(plantedRel),
    `exit ${piiBridged.status}, seed ${redact(term)}`
  );

  const configBridged = runConfigClean(exportDir, { bridge: true, requireDomains: true });
  check(
    'a planted owner domain inside the export is REFUSED',
    configBridged.status !== 0 && configBridged.output.includes(plantedRel),
    `exit ${configBridged.status}, seed ${redact(domain)}`
  );

  // The reproduction of the defect. Same tree, same plants, no bridge.
  const piiBlind = runPii(exportDir, { bridge: false, files: [plantedRel] });
  const configBlind = runConfigClean(exportDir, { bridge: false });
  check(
    'without the bridge the SAME planted tree is reported clean by both — the defect, reproduced',
    piiBlind.status === 0 && configBlind.status === 0,
    `gate-pii exit ${piiBlind.status}, check-public-config-clean exit ${configBlind.status}`
  );

  const piiBlindRequired = runPii(exportDir, { bridge: false, require: true, files: [plantedRel] });
  const configBlindRequired = runConfigClean(exportDir, { bridge: false, requireDomains: true });
  check(
    'without the bridge but WITH the non-vacuity flags, both refuse instead of reporting clean',
    piiBlindRequired.status !== 0 && configBlindRequired.status !== 0,
    `gate-pii exit ${piiBlindRequired.status}, check-public-config-clean exit ${configBlindRequired.status}`
  );
  return null;
}

/** AC14 — a planted credential inside the export. */
async function plantedCredentialArm(exportDir, paths) {
  // Enumerate against the EXPORT'S contents, not this repo's: the claim is
  // about what the published copy declares it stores.
  const readText = (file) => {
    try {
      const buf = readFileSync(join(exportDir, file));
      return buf.length <= 5_000_000 ? buf.toString('utf8') : null;
    } catch {
      return null;
    }
  };
  const enumerated = await credentialArm(
    { repoRoot: exportDir, configDir: join(exportDir, 'config'), readText, readSecret: (k) => readKeychainSecret(k) },
    paths
  );
  check(
    'the credential list is derived from the product, not hand-written',
    enumerated.keys.length > 0 && enumerated.sources.registry > 0 && enumerated.sources.service_literals > 0,
    `${enumerated.keys.length} key(s): registry ${enumerated.sources.registry}, service literals `
      + `${enumerated.sources.service_literals}, secret() calls ${enumerated.sources.secret_calls}`
  );
  check(
    'stored credential values are actually readable and compared',
    enumerated.scanned > 0,
    `${enumerated.scanned} compared, ${enumerated.absent.length} not stored, ${enumerated.tooShort.length} below the ${enumerated.min}-char floor`
  );

  const cleanRun = runConfigClean(exportDir, { bridge: true, requireCredentials: true });
  check('the unplanted export passes the credential arm', cleanRun.status === 0, `exit ${cleanRun.status}`);

  // Plant a REAL stored credential value. Nothing about it is printed.
  const secretValue = await (async () => {
    const { readStoredCredentials } = await import('../../lib/credential-scan.js');
    const { values } = readStoredCredentials((k) => readKeychainSecret(k), enumerated.keys, { min: enumerated.min });
    return values[0] || null;
  })();
  if (!secretValue) return check('a stored credential is available to plant', false, 'no readable credential') ? 0 : 1;

  const credRel = 'docs/liveness-planted-credential.md';
  writeFileSync(join(exportDir, credRel), `deploy note\n\ntoken: ${secretValue.value}\n`);
  gitIn(exportDir, ['add', credRel]);
  gitIn(exportDir, ['-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', 'commit', '-q', '-m', 'planted credential']);

  const credRun = runConfigClean(exportDir, { bridge: true, requireCredentials: true });
  const named = credRun.output.includes(secretValue.key) && credRun.output.includes(credRel);
  const leaked = credRun.output.includes(secretValue.value);
  check(
    'a planted credential value inside the export is REFUSED',
    credRun.status !== 0 && named,
    `exit ${credRun.status}, key ${secretValue.key}, value ${redact(secretValue.value)}`
  );
  check('the refusal names the key and never prints the value', named && !leaked);

  // Without the flag the arm does not run at all — pre-commit pays nothing.
  const credOff = runConfigClean(exportDir, { bridge: true, requireCredentials: false });
  check(
    'the credential arm is off unless asked for, so the commit path pays nothing',
    credOff.status === 0,
    `exit ${credOff.status} on the same planted tree`
  );
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const wantPlanted = args.includes('--planted') || args.includes('--all');
  const wantCredential = args.includes('--credential') || args.includes('--all');
  if (!wantPlanted && !wantCredential) {
    process.stderr.write('export-scan-liveness: usage — --planted | --credential | --all\n');
    return 2;
  }

  const sha = workingTreeCommit();
  if (!sha) {
    process.stderr.write('export-scan-liveness: could not snapshot the working tree.\n');
    return 1;
  }
  // The manifest is resolved WITHOUT its lock here. The lock asserts that the
  // published set has not drifted from what the owner approved, which is a
  // different property and one that is deliberately false mid-build: this run
  // exists precisely because the tree has changed. Locking is proven by
  // publication-refusals.js.
  const manifest = loadManifest(CONFIG_DIR);
  const atCommit = filesAtCommit(sha);
  const set = resolveManifest({ trackedFiles: () => atCommit }, manifest);
  // The snapshot commit is immutable and shared on purpose: every arm exports
  // the SAME source state, so the arms differ only in what they plant. What is
  // never shared is the materialised tree — see withArmExport.
  const source = { sha, paths: set.paths };

  if (wantPlanted) {
    const abort = await withArmExport(
      'AC13 — the composed scans detect inside the export', source, (dir) => plantedArm(dir));
    if (abort !== null) return abort;
  }
  if (wantCredential) {
    const abort = await withArmExport(
      'AC14 — a planted credential inside the export', source, (dir) => plantedCredentialArm(dir, set.paths));
    if (abort !== null) return abort;
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\nexport-scan-liveness: ${results.length - failed.length}/${results.length} PASS\n`);
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`export-scan-liveness: ${err.stack || err.message}\n`);
    process.exit(2);
  });
