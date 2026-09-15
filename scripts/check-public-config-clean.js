#!/usr/bin/env node
/**
 * check-public-config-clean.js — catches the leak class the name/email/secret
 * scanners miss: bare owner-org DOMAINS, real Asana workspace/project/board/
 * section GIDs, and calendar-import ids committed to TRACKED files. gate-pii.sh
 * matches the owner's full email addresses and names; it does NOT match a bare
 * domain (`client-a.example`), a bare 16-digit gid, or a calendar-import token —
 * those are exactly what routing config, product code, and tooling leak. This
 * guard closes that gap across the WHOLE tracked tree.
 *
 * Scope (all three run over every tracked working-tree file — `git ls-files`):
 *   1. Asana gid literals — any `\b1[0-9]{15}\b` in any tracked TEXT file, with
 *      a small documented allowlist of synthetic placeholders. Binary files
 *      (fonts, images) are skipped so a font blob's byte run never false-flags.
 *   2. Calendar-import tokens — `@import.calendar.google.com` anywhere tracked.
 *   3. Owner domains — the domain LIST read from the local gitignored
 *      config/*.user.json overrides, cross-checked against every tracked file.
 *
 * Tier 0, no LLM (no INTELLIGENCE_TIER: this is a deterministic structural gate,
 * like every sibling scripts/check-*.js).
 *
 *   4. Owner credentials — the VALUES of every credential the product stores,
 *      read from the OS keychain at scan time and searched for as literals.
 *      Enumerated from the product itself (lib/credential-scan.js), never from a
 *      hand-written list. Publication-path only: it is off unless
 *      --require-credentials asks for it, so pre-commit pays nothing.
 *
 * THIS GUARD CONTAINS NO OWNER DATA. The gid/calendar patterns are generic; the
 * owner-domain knowledge lives only in the local gitignored config/*.user.json
 * overrides and is read at runtime. On a fresh clone with no overrides the
 * owner-domain cross-check is a no-op (same model as gate-pii.sh's
 * private-identity-patterns).
 *
 * ── WHY THE OWNER CONFIG DIRECTORY IS OVERRIDABLE (AC13) ────────────────────
 *
 * `config/*.user.json` is gitignored, so `git archive` never emits it and the
 * exported copy of this guard cross-checked ZERO owner domains while printing
 * "clean" — a structural no-op that read as a verdict. The fix is one env
 * override, ROBOTDOJO_OWNER_CONFIG_DIR, which the publication step points at the
 * REAL repository's config directory. The overrides are read from there and
 * never copied into the export, so the published artifact still carries none of
 * them. Same shape as gate-pii.sh's ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS_FILE,
 * deliberately: two bridges that behave differently are two bridges someone will
 * get wrong.
 *
 * Flags:
 *   --require-domains      refuse (exit 3) when zero owner domains were
 *                          cross-checked. A scan that compared nothing must not
 *                          report clean.
 *   --require-credentials  run the credential arm and refuse (exit 3) when zero
 *                          stored credentials were compared.
 *
 * Both are set ONLY by the publication step. Pre-commit and fresh clones pass
 * neither and behave exactly as they do today — a fresh clone's no-op is a
 * designed property (sealed scope AC6), not a bug to be flagged.
 *
 * Runnable as `node scripts/check-public-config-clean.js` from ~/robotdojo.
 * Exit 0 = clean, exit 1 = leak(s) listed as file:line, exit 3 = the scan could
 * not see what it was asked to compare against.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { credentialArm } from '../lib/credential-scan.js';
import { readKeychainSecret } from '../lib/keychain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
// The tree being scanned. Always this script's own repo — inside an export that
// is the export directory, which is the point.
const CONFIG_DIR = join(REPO_ROOT, 'config');
// Where the OWNER'S gitignored overrides live. Defaults to the scanned tree's
// own config dir (today's behaviour); the publication step points it elsewhere.
const OWNER_CONFIG_DIR = process.env.ROBOTDOJO_OWNER_CONFIG_DIR || CONFIG_DIR;

const ARGS = process.argv.slice(2);
const REQUIRE_DOMAINS = ARGS.includes('--require-domains');
const REQUIRE_CREDENTIALS = ARGS.includes('--require-credentials');

// The guard necessarily contains the literal patterns it hunts for, so it must
// never flag itself. Path is repo-relative to match `git grep` / `git ls-files`.
const SELF = 'scripts/check-public-config-clean.js';

// Structural pattern: any calendar-import id ends with this host. Generic — the
// owner's specific token is not written here.
const CALENDAR_IMPORT_HOST = '@import.calendar.google.com';

// Structural pattern: an Asana workspace/project/section gid is a 16-digit id
// that starts with 1 (all live Asana gids share this shape). The `g` flag lets a
// single line report every gid it carries.
const ASANA_GID_RE = /\b1[0-9]{15}\b/g;

// Documented synthetic placeholders that legitimately appear in TRACKED files
// and are NOT owner data. Kept deliberately small. Text placeholders
// (REPLACE_WITH_*, REDACTED_HISTORICAL_GID, and the like) are not listed here
// because they are non-numeric and never match ASANA_GID_RE in the first place.
const SYNTHETIC_GID_EXACT = new Set([
  '0000000000000000', // all-zero placeholder (does not match the 1-prefixed pattern; kept for intent)
  '1111111111111111', // synthetic workspace gid in the granola routing tests
]);
// Synthetic entity ids used by the hermetic viewer test fixtures live in the
// reserved 1700000000000000–1700000000000099 range — obviously fake, never a
// real Asana gid or entity id.
const SYNTHETIC_GID_RANGE = /^17000000000000\d{2}$/;

function isSyntheticGid(gid) {
  return SYNTHETIC_GID_EXACT.has(gid) || SYNTHETIC_GID_RANGE.test(gid);
}

/**
 * `git grep -F -n <literal>` over TRACKED working-tree files only (gitignored
 * overrides are untracked, so an owner domain listed in an override never
 * self-matches). Returns "path:line:content" rows, self-excluded. Exit 1 from
 * git grep means "no match" (clean), not an error.
 */
function gitGrepLiteral(literal) {
  const r = spawnSync('git', ['grep', '-F', '-n', '--no-color', '-e', literal], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // A pathological literal (a single character, say) matches the whole tree.
    // Without a raised ceiling the child is killed and `status` comes back
    // null, which reads as "grep failed" and takes the commit hook down with a
    // stack trace instead of a finding. Measured cause, st_dd0e19d8.
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status === 1) return [];
  if (r.status !== 0) {
    throw new Error(`git grep failed (status ${r.status}) for "${literal}": ${r.stderr || ''}`);
  }
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .filter((row) => !row.startsWith(`${SELF}:`));
}

/** Every tracked working-tree file (NUL-delimited so paths with spaces are safe). */
function trackedFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr || ''}`);
  return r.stdout.split('\0').filter(Boolean);
}

/** A NUL byte in the head of the buffer marks a binary blob (font/image/etc.). */
function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Owner domains = top-level `.domains` keys across every gitignored config/*.user.json override. */
function ownerDomainsFromOverrides() {
  const domains = new Set();
  let files = [];
  try {
    files = readdirSync(OWNER_CONFIG_DIR).filter((f) => f.endsWith('.user.json'));
  } catch {
    return domains; // no config dir → nothing to cross-check
  }
  for (const f of files) {
    const path = join(OWNER_CONFIG_DIR, f);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue; // an unparseable local override is not this guard's concern
    }
    // `domains` is a MAP in the routing overrides (domain → topic) and a LIST in
    // the ingest-allowlist override. Both are legitimate shapes for the same
    // meaning, and the map-only reading was a live defect, not a style choice:
    // Object.keys() on an array yields the INDICES, so a list override fed this
    // guard the literal "0" and `git grep -F 0` matched the whole tree and
    // aborted the run. Read both shapes; take values from a list, keys from a
    // map (st_dd0e19d8).
    const raw = parsed && parsed.domains;
    const candidates = Array.isArray(raw) ? raw : Object.keys(raw || {});
    for (const key of candidates) {
      const d = String(key || '').trim().toLowerCase();
      // A routing key with no dot is a TLD rule (e.g. "ae"), not an owner
      // domain. Scanning the tree for that literal matches the whole repo.
      if (d && d.includes('.')) domains.add(d);
    }
  }
  return domains;
}

const violations = [];
const scanned = trackedFiles().filter((f) => f !== SELF);

/**
 * Text of a tracked file, or null when it is binary, oversized, or gone.
 * Memoised because two arms read the same files and re-reading 2,000 files a
 * second time is pure cost. Bounded by the tracked tree, which is the set this
 * process was going to hold anyway.
 */
const textCache = new Map();
function readText(file) {
  if (textCache.has(file)) return textCache.get(file);
  let text = null;
  try {
    const buf = readFileSync(join(REPO_ROOT, file));
    if (buf.length <= 5_000_000 && !isBinary(buf)) text = buf.toString('utf8');
  } catch {
    text = null; // vanished between ls-files and read — not this guard's concern
  }
  textCache.set(file, text);
  return text;
}

// ── 1. Real Asana gids in ANY tracked TEXT file ───────────────────────────────
for (const file of scanned) {
  const text = readText(file);
  if (text === null) continue;
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(ASANA_GID_RE)) {
      if (isSyntheticGid(m[0])) continue;
      violations.push(`${file}:${i + 1}: 16-digit Asana gid literal in a tracked file (use a placeholder + the gitignored config/*.user.json override)`);
    }
  });
}

// ── 2. Calendar-import tokens in any tracked file ─────────────────────────────
for (const row of gitGrepLiteral(CALENDAR_IMPORT_HOST)) {
  const [file, line] = row.split(':', 2);
  violations.push(`${file}:${line}: calendar-import id committed to a tracked file`);
}

// ── 3. Owner domains (from the gitignored overrides) leaking into tracked files ─
const ownerDomains = ownerDomainsFromOverrides();
for (const domain of ownerDomains) {
  for (const row of gitGrepLiteral(domain)) {
    const [file, line] = row.split(':', 2);
    violations.push(`${file}:${line}: owner domain "${domain}" (from a gitignored override) appears in a tracked file`);
  }
}

// ── 4. Owner credentials (AC14) — publication path only ───────────────────────
// Off unless asked for: the arm reads ~35 keychain entries, which is a cost
// pre-commit should not pay every commit for a class that only matters at
// publication. The finding names the KEY and the location; the value is never
// printed — see lib/credential-scan.js.
let credentials = null;
if (REQUIRE_CREDENTIALS) {
  credentials = await credentialArm(
    { repoRoot: REPO_ROOT, configDir: CONFIG_DIR, readText, readSecret: (key) => readKeychainSecret(key) },
    scanned
  );
  for (const f of credentials.findings) {
    violations.push(`${f.file}:${f.line}: the stored value of credential "${f.key}" appears in a tracked file — rotate it and remove the literal`);
  }
}

// ── non-vacuity assertions (AC13/AC14) ────────────────────────────────────────
// Exit 3, distinct from the exit 1 that means "a leak was found": a
// misconfigured scan and a dirty tree need different fixes, and collapsing them
// into one code is how "the gate failed" stops carrying information.
const blind = [];
if (REQUIRE_DOMAINS && ownerDomains.size === 0) {
  blind.push(
    `--require-domains: zero owner domains cross-checked (looked in ${OWNER_CONFIG_DIR}/*.user.json). `
      + 'A domain arm with no domains compares nothing and would report clean.'
  );
}
if (REQUIRE_CREDENTIALS && credentials && credentials.scanned === 0) {
  blind.push(
    `--require-credentials: ${credentials.keys.length} credential key(s) declared by the product, but 0 stored `
      + `values were readable (${credentials.absent.length} absent, ${credentials.tooShort.length} below the `
      + `${credentials.min}-character minimum). Nothing was compared.`
  );
}
if (blind.length > 0) {
  process.stderr.write('check-public-config-clean: REFUSED — the scan could not see what it was asked to compare:\n');
  for (const b of blind) process.stderr.write(`  ${b}\n`);
  process.exit(3);
}

if (violations.length > 0) {
  process.stderr.write(`check-public-config-clean: ${violations.length} leak(s) in tracked files:\n`);
  for (const v of violations) process.stderr.write(`  ${v}\n`);
  process.stderr.write('Move owner domains/gids/calendar-ids into the gitignored config/*.user.json overrides; ship synthetic/placeholder values in tracked source.\n');
  process.exit(1);
}

const credentialNote = credentials
  ? `; compared ${credentials.scanned} stored credential value(s) of ${credentials.keys.length} declared `
    + `(registry ${credentials.sources.registry}, service literals ${credentials.sources.service_literals}, `
    + `secret() calls ${credentials.sources.secret_calls}; ${credentials.absent.length} not stored, `
    + `${credentials.tooShort.length} below the ${credentials.min}-char minimum and NOT scanned)`
  : '';
console.log(
  `check-public-config-clean: clean (scanned ${scanned.length} tracked files for gids/calendar-ids; `
    + `cross-checked ${ownerDomains.size} owner domain(s) from local overrides${credentialNote})`
);
