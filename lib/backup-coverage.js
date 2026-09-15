/**
 * lib/backup-coverage.js — one path classifier, several consumers.
 *
 * Every question of the form "who holds this file if the machine dies?" is
 * answered here. `scripts/check-backup-recoverability.js` (the pre-commit
 * tripwire), `scripts/check-backup-mece.js` (the ownership audit), and
 * `lib/backup-guardian.js` (the running coverage scan) all call the same
 * `classifyPath`. Before df_3df1f108 the rule was duplicated across two gates
 * whose hand-maintained lists drifted apart — that drift is what produced the
 * live false positive on `config/source-topic-routing.user.json`, and a
 * detector that names one wrong file alongside three right ones trains the
 * owner to discount it.
 *
 * Two structural rules replace two hand-maintained lists:
 *
 *   1. CREDENTIAL VETO (df_3df1f108 AC6). A regenerable ALLOWLIST can never
 *      certify a live secret as disposable. `.vercel/` is an allowlisted
 *      regenerable prefix, which is how `.vercel/.env.production.local` — an
 *      Anthropic key, a cohort private key, a session secret, a database URL —
 *      was affirmatively marked safe to lose. The fix narrows the RULE rather
 *      than special-casing the file: a path or content shape that looks like a
 *      credential overrides any regenerable verdict, so the next file created
 *      under that prefix does not inherit the same wrong green light. The live
 *      second instance found while writing this: `~/.robotdojo/runtime/
 *      cloudflared/token`, a tunnel credential inside a directory that was a
 *      candidate for wholesale regenerable exclusion.
 *
 *   2. DERIVED config/ SECRETS. Every gitignored file directly under `config/`
 *      is bucket-covered by pattern (`discoverPrivateConfigFiles`), merged with
 *      the static PRIVATE_DATA_FILES list. That closes the CLASS rather than
 *      today's instances: scope named three uncovered config files, and by the
 *      time the plan sealed there were seven. The enumeration was drifting
 *      faster than it could be maintained.
 *
 * WHY the veto is scoped to the allowlist classes and not applied globally:
 * a credential that already sits under a backup root IS backed up, so flagging
 * it would be a false alarm; and `node_modules/` test fixtures are full of
 * `key.pem` files, so a global content scan would be both slow (224K ignored
 * files in the live repo) and noisy. The veto applies exactly where a
 * regenerable ALLOWLIST made the "safe to lose" claim.
 *
 * Compute tier 0 — pure local file and git reads. No LLM call.
 */

import { spawnSync } from 'node:child_process';
import { openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PRIVATE_DATA_FILES, PRIVATE_DATA_ROOTS } from './private-data-roots.js';

// Prefixes whose contents are re-creatable from a source that survives this
// machine's loss (a registry, a build step, a vendor download).
export const REGENERABLE_PREFIXES = Object.freeze([
  '.vercel/',
  'agents/dist/',
  'gateway/node_modules/',
  'node_modules/',
]);

export const REGENERABLE_EXACT = new Set([
  'apps/static/version.json',
  'lib/cohort/build-info.js',
]);

// docs/ rebuild reports are auto-generated build/QA output (scripts/rebuild/
// phase-12-report.js, scripts/ingest/06-archive.js).
export const DOCS_REGENERABLE_PATTERN = /^docs\/rebuild-report-.*\.md$/;

// Verdicts an allowlist produced. Only these can be overridden by the
// credential veto — see the module header for why the veto is not global.
const VETOABLE = new Set([
  'regenerable:artifact',
  'regenerable:tooling',
  'regenerable:build-report',
]);

// ── Credential shape ─────────────────────────────────────────────────────────

// PRECISION IS PART OF THE RULE, not a nice-to-have. AC3(e) is explicit that a
// detector naming one wrong file alongside three right ones trains the owner to
// discount it, which destroys the capability the detector buys. The first draft
// of this veto flagged five Vercel BUILD ARTEFACTS on the live tree — a route
// directory called `token.func`, and two shell scripts assigning
// `RELAY_BOOTSTRAP_SECRET="${...}"` — none of which is a stored secret. Each
// signal below was narrowed until the live tree reported only real credentials.

// A basename in the `.env` family: `.env`, `env.local`, `.env.production.local`.
// A search, not an anchored match, so a multi-segment name is caught by its
// first segment. This family is a secret by convention, so it stands alone.
const CREDENTIAL_BASENAME_RE = /(^|\.)env($|\.)/;
// Key-material file extensions. Also self-sufficient.
const CREDENTIAL_EXT_RE = /\.(pem|p12|pfx|jks|key)$/i;
// A path component that IS a secret word, not one that merely contains it.
// `token.func` (a Vercel route build directory) is not a credential; `token`
// (the live Cloudflare tunnel credential at ~/.robotdojo/runtime/cloudflared/)
// is. Containment cannot tell them apart; exact match can.
const CREDENTIAL_COMPONENTS = new Set([
  'secret', 'secrets', '.secret', '.secrets',
  'credential', 'credentials', '.credentials',
  'token', 'tokens', '.token',
  'password', 'passwords', 'passwd',
  'private-key', 'private_key', 'privatekey',
]);
// PEM private-key armour.
const CREDENTIAL_PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
// An assignment whose NAME carries a secret word as a whole underscore-token.
// Substring matching is wrong here: `PAT` is inside `PATH`, so every `*_PATH=`
// line in every shell script matched the first draft.
const SECRET_NAME_TOKENS = new Set([
  'KEY', 'KEYS', 'APIKEY', 'SECRET', 'SECRETS', 'TOKEN', 'TOKENS',
  'PASSWORD', 'PASSWD', 'CREDENTIAL', 'CREDENTIALS', 'PAT', 'PRIVATE',
]);
const ASSIGNMENT_RE = /^([A-Z][A-Z0-9_]*)=(.*)$/gm;
// A stored credential's value is a LITERAL. A value that begins with a shell or
// template expansion, or reads as a path, is a reference to a secret held
// somewhere else — which is the correct pattern, not a leak.
const NON_LITERAL_VALUE_RE = /^["']?[\s$`{<%(~/.]/;

// STRUCTURED FORMATS. The shell-assignment rule above requires `NAME=` at the
// start of a line, so it sees nothing in JSON or YAML — and the credential
// formats that actually ship are structured. `tunnel-credentials.json` is the
// classic cloudflared format, the same subsystem whose newer `token` file the
// exact-component path rule already catches; without this, the older format
// walks straight through. Matching is on the KEY, never the value, which is
// what keeps the earlier false positives out: `token.func` was a path
// component and `PATH` was a shell variable name, and neither is a JSON or
// YAML key.
const JSON_PAIR_RE = /"([A-Za-z0-9_.-]{2,64})"\s*:\s*"([^"\\\n]{4,4096})"/g;
// A YAML mapping entry: optional indent, optional list dash, key, colon, value.
// The value may be quoted or bare; a trailing `#` comment is discarded.
const YAML_PAIR_RE = /^[ \t]*-?[ \t]*([A-Za-z0-9_.-]{2,64})[ \t]*:[ \t]+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s#]+))[ \t]*(?:#.*)?$/gm;

// The structured rule applies to CONFIG DOCUMENTS only, and this restriction is
// load-bearing rather than cautious. JavaScript object-literal syntax is
// character-for-character identical to a YAML mapping, so without it the rule
// reads `credentials: 'same-origin'` in a fetch call, `maxOutputTokens:
// MAX_TOKENS` in a model config, and `key: episode.key || ...` in a render
// loop as stored credentials — four .js files and one .html on the live tree
// did exactly that. `key: value` means "a key in a config document" inside a
// config document; inside source code it means an object property, and source
// code is not a stored credential.
const STRUCTURED_DOC_EXT_RE = /\.(json|jsonc|yaml|yml|toml|ini|cfg|conf|properties|credentials)$/i;
// An extensionless file is treated as a possible config document: the
// credential formats that ship without one (`credentials`, `token`, `id_rsa`)
// are exactly the shape this rule exists to catch, and they carry no code.
const NO_EXTENSION_RE = /^[^.]+$|^\.[^.]+$/;

const CONTENT_SNIFF_BYTES = 64 * 1024;

/**
 * Split a key or variable name into whole words, so a secret token is matched
 * as a word and never as a substring. `TunnelSecret` → TUNNEL, SECRET.
 * `AccountTag` → ACCOUNT, TAG. `PATH` → PATH, which is why `PAT` no longer
 * matches inside it.
 */
function keyTokens(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toUpperCase());
}

function isSecretKeyName(name) {
  return keyTokens(name).some((token) => SECRET_NAME_TOKENS.has(token));
}

/**
 * Does this value look like stored key material rather than prose, a boolean,
 * a number, a path, or a template reference?
 *
 * The no-whitespace test is the one carrying the most weight: real secrets are
 * single opaque tokens, and it is what stops a documentation line like
 * `Secret: rotate this every 90 days` from tripping the gate on the markdown
 * sitting under `agents/dist/`.
 */
function isLiteralSecretValue(raw) {
  const value = String(raw ?? '').trim();
  if (value.length < 8) return false;              // empty or a placeholder
  if (/\s/.test(value)) return false;              // prose, not a secret
  if (NON_LITERAL_VALUE_RE.test(value)) return false; // an expansion or a path
  if (!/[A-Za-z]/.test(value)) return false;       // a timestamp or a size
  return true;
}

/**
 * A JSON or YAML key naming key material, paired with a literal value.
 * Exported so the tests can exercise the rule directly.
 */
export function structuredCredentialKey(text) {
  if (!text) return null;
  for (const [re, groups] of [[JSON_PAIR_RE, [2]], [YAML_PAIR_RE, [2, 3, 4]]]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const name = match[1];
      if (!isSecretKeyName(name)) continue;
      const value = groups.map((g) => match[g]).find((v) => v !== undefined);
      if (isLiteralSecretValue(value)) return name;
    }
  }
  return null;
}

/** Basename of a POSIX-ish repo-relative path. */
function baseName(path) {
  const parts = String(path).split('/');
  return parts[parts.length - 1] || '';
}

/**
 * True when the path alone is enough to call this credential material.
 * Cheap — no file read.
 */
export function credentialPathShape(path) {
  const base = baseName(path);
  if (CREDENTIAL_BASENAME_RE.test(base)) return 'basename';
  if (CREDENTIAL_EXT_RE.test(base)) return 'extension';
  if (String(path).split('/').some((part) => CREDENTIAL_COMPONENTS.has(part.toLowerCase()))) return 'component';
  return null;
}

/** True when `path` is a config document rather than source code. */
export function isStructuredDocument(path) {
  const base = baseName(path || '');
  if (!base) return false;
  if (STRUCTURED_DOC_EXT_RE.test(base)) return true;
  return NO_EXTENSION_RE.test(base);
}

/**
 * True when the first 64 KB of content carries key material. Three shapes:
 * PEM armour, a shell/dotenv assignment, and a structured (JSON/YAML) key.
 * The third exists because the first two miss every structured credential
 * format, which is most of them — the shell rule needs `NAME=` at the start of
 * a line and sees nothing in a `.json` file.
 *
 * @param {string} text first 64 KB of the file
 * @param {object} [opts]
 * @param {string} [opts.path] the file's path. The structured rule is applied
 *   only when this names a config document; omitting it applies the rule
 *   unconditionally, which is what the unit tests exercise.
 */
export function credentialContentShape(text, { path } = {}) {
  if (!text) return null;
  if (CREDENTIAL_PEM_RE.test(text)) return 'pem';
  ASSIGNMENT_RE.lastIndex = 0;
  for (const match of text.matchAll(ASSIGNMENT_RE)) {
    const [, name, rawValue] = match;
    if (!isSecretKeyName(name)) continue;
    if (isLiteralSecretValue(rawValue)) return 'assignment';
  }
  if ((path === undefined || isStructuredDocument(path)) && structuredCredentialKey(text)) return 'structured';
  return null;
}

/**
 * The veto itself. `readContent` is a lazy `(path) => string|null` so a caller
 * that already has the bytes can supply them and a caller that does not pays
 * one bounded read only for paths an allowlist tried to clear.
 */
export function credentialVeto(path, readContent) {
  const byPath = credentialPathShape(path);
  if (byPath) return `path:${byPath}`;
  if (typeof readContent !== 'function') return null;
  let text = null;
  try { text = readContent(path); } catch { text = null; }
  const byContent = credentialContentShape(text, { path });
  return byContent ? `content:${byContent}` : null;
}

/** Reads at most the first 64 KB of a file as UTF-8. Null on any error. */
export function readHead(absPath, bytes = CONTENT_SNIFF_BYTES) {
  let fd = null;
  try {
    fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function sameOrUnder(path, root) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path === root || path.startsWith(prefix);
}

function hasPathSegment(path, segment) {
  return path.split('/').includes(segment);
}

function dsStore(path) {
  return path === '.DS_Store' || path.endsWith('/.DS_Store');
}

/** A gitignored file sitting DIRECTLY under `config/` (not in a subdirectory). */
export function isPrivateConfigFile(path) {
  const parts = path.split('/');
  return parts.length === 2 && parts[0] === 'config';
}

/** Bucket destination for a discovered private config file. */
export function privateConfigRemote(rel) {
  return `repo-local/${rel}`;
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Who owns `path` after the machine is gone?
 *
 * @param {string} path repo-relative POSIX path
 * @param {object} opts
 * @param {Set<string>} [opts.tracked] git-tracked paths
 * @param {(p: string) => string|null} [opts.readContent] lazy content reader
 * @returns {string|null} owner label, or null when NOBODY holds it
 */
export function classifyPath(path, { tracked, readContent } = {}) {
  if (tracked?.has(path)) return 'github';
  if (PRIVATE_DATA_FILES.some((file) => path === file.local)) return 'gcp:file';
  // Cheap structural regenerables first: these are never credential-vetoed
  // (see header) and they are the overwhelming majority of ignored files, so
  // deciding them without a content read keeps the audit linear and fast.
  if (hasPathSegment(path, '.git')) return 'regenerable:git-internals';
  if (hasPathSegment(path, '.terraform')) return 'regenerable:terraform-cache';
  if (hasPathSegment(path, 'node_modules')) return 'regenerable:dependencies';
  if (dsStore(path)) return 'regenerable:os';

  // Derived config/ secrets — every gitignored file directly under config/ is
  // bucket-covered by pattern, so a new secret is protected the moment it is
  // written rather than when someone remembers to name it.
  if (isPrivateConfigFile(path)) return 'gcp:config-private';

  // Allowlisted regenerables. The credential veto sits AHEAD of the verdict,
  // not beside it: no prefix may certify a secret as disposable (AC6).
  let allowlisted = null;
  if (REGENERABLE_EXACT.has(path)) allowlisted = 'regenerable:artifact';
  else if (REGENERABLE_PREFIXES.some((prefix) => path.startsWith(prefix))) allowlisted = 'regenerable:tooling';
  else if (DOCS_REGENERABLE_PATTERN.test(path)) allowlisted = 'regenerable:build-report';
  if (allowlisted) {
    if (VETOABLE.has(allowlisted) && credentialVeto(path, readContent)) return 'unrecoverable:credential';
    return allowlisted;
  }

  if (PRIVATE_DATA_ROOTS.some((root) => sameOrUnder(path, root.local))) return 'gcp:root';
  return null;
}

/** The reason string a veto produced, for reporting. Null when not vetoed. */
export function classifyReason(path, { readContent } = {}) {
  return credentialVeto(path, readContent);
}

// ── git plumbing ─────────────────────────────────────────────────────────────

export function gitFiles(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.toString('utf8') || `git ${args.join(' ')} failed`);
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((p) => p.split('\\').join('/'))
    .sort();
}

/**
 * Every gitignored file directly under `config/`, as backup file descriptors.
 * This is the derived class that replaces the hand-maintained config secret
 * enumeration. Returns [] when the repo root is not a git checkout — callers
 * (tests with a fake $HOME, fresh clones) must never crash on that.
 *
 * @param {string} repoRoot absolute path to the repository root
 * @returns {{key: string, local: string, remote: string}[]} repo-relative locals
 */
export function discoverPrivateConfigFiles(repoRoot) {
  let ignored = [];
  try {
    ignored = gitFiles(repoRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', 'config']);
  } catch {
    return [];
  }
  const staticLocals = new Set(PRIVATE_DATA_FILES.map((file) => file.local));
  return ignored
    .filter((rel) => isPrivateConfigFile(rel))
    .filter((rel) => !staticLocals.has(rel))
    .map((rel) => ({
      key: `config-discovered-${rel.slice('config/'.length)}`,
      local: rel,
      remote: privateConfigRemote(rel),
    }));
}

/**
 * Full coverage audit of a repository.
 *
 * @param {string} repoRoot absolute repository root
 * @returns {{covered: Map<string, number>, uncovered: string[], reasons: Map<string, string>, ignoredCount: number}}
 */
export function auditCoverage(repoRoot) {
  const root = resolve(repoRoot);
  const tracked = new Set(gitFiles(root, ['ls-files', '-z']));
  const ignored = gitFiles(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  const readContent = (rel) => readHead(join(root, rel));

  const covered = new Map();
  const uncovered = [];
  const reasons = new Map();
  for (const path of ignored) {
    const owner = classifyPath(path, { tracked, readContent });
    // A vetoed credential is NOT covered — the veto only revokes the
    // regenerable claim. Nothing holds the file until it is moved under a
    // backup root or deleted, so the gate must keep naming it.
    if (!owner || owner === 'unrecoverable:credential') {
      uncovered.push(path);
      if (owner === 'unrecoverable:credential') {
        reasons.set(path, `credential (${classifyReason(path, { readContent }) || 'shape'}) under a regenerable allowlist`);
      }
      continue;
    }
    covered.set(owner, (covered.get(owner) || 0) + 1);
  }
  return { covered, uncovered, reasons, ignoredCount: ignored.length };
}
