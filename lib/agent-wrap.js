/**
 * lib/agent-wrap.js — launch a flat-fee coding agent under Robot Dojo.
 *
 * Subscription thinking stays on the host. Provider keys stay dark. Identity
 * is appended at spawn or the launch refuses. Extra key spend needs a typed yes.
 */

// INTELLIGENCE_TIER: extraction — env, PATH, files. Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readKeychainSecret } from './keychain.js';

export const STRIP_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
]);

const HOSTS = {
  claude: ['claude'],
  grok: ['grok'],
  codex: ['codex'],
  cursor: ['cursor-agent', 'cursor'],
};

const KNOWN_DIRS = [
  join(homedir(), '.local/bin'),
  join(homedir(), '.grok/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultIdentityDir() {
  return join(REPO_ROOT, 'agents', 'dist');
}

export function identityFilesFor(host) {
  if (host === 'claude') return ['claude.md'];
  if (host === 'grok') return ['grok.md'];
  if (host === 'codex') return ['AGENTS.md'];
  if (host === 'cursor') return ['cursor-identity.mdc'];
  return [];
}

export function wrapDir(configDir = process.env.ROBOTDOJO_CONFIG || join(homedir(), '.robotdojo')) {
  // Under runtime/ so ~/.robotdojo/wrap is not a new top-level dotdir entry.
  return join(configDir, 'runtime', 'wrap', 'bin');
}

export function shimPath(configDir) {
  return join(wrapDir(configDir), 'security');
}

export function shimSource() {
  const needles = STRIP_KEYS.map((n) => `*${n}*`).join('|');
  return `#!/bin/sh
# robotdojo wrap — deny provider-key reads from coding agents.
for a in "$@"; do
  case "$a" in
    ${needles})
      echo "robotdojo-wrap: provider keys are not readable from this agent." >&2
      echo "Directed API spend: robotdojo llm --lane fast --label <why> \\"...\\"" >&2
      exit 1
      ;;
  esac
done
exec /usr/bin/security "$@"
`;
}

export function ensureShim(configDir) {
  const dir = wrapDir(configDir);
  mkdirSync(dir, { recursive: true });
  const dest = shimPath(configDir);
  writeFileSync(dest, shimSource(), { mode: 0o755 });
  chmodSync(dest, 0o755);
  return dest;
}

function defaultReadLocalDbKey() {
  if (process.env.NODE_TEST_CONTEXT) return null;
  return readKeychainSecret('LOCAL_DB_KEY');
}

export function childEnv(base = process.env, { configDir, readLocalDbKey } = {}) {
  const env = { ...base, ROBOTDOJO_WRAP: '1' };
  for (const key of STRIP_KEYS) delete env[key];
  const shimDir = wrapDir(configDir);
  env.PATH = `${shimDir}:${env.PATH || ''}`;
  if (!env.ROBOTDOJO_LOCAL_DB_KEY) {
    const reader = readLocalDbKey || defaultReadLocalDbKey;
    const key = reader();
    if (key) env.ROBOTDOJO_LOCAL_DB_KEY = key;
  }
  return env;
}

export function deniesProviderKeyLookup(args) {
  const blob = (Array.isArray(args) ? args : [args]).join(' ');
  return STRIP_KEYS.some((n) => blob.includes(n));
}

export function resolveHost(name, { pathEnv = process.env.PATH } = {}) {
  const keys = HOSTS[name];
  if (!keys) return null;
  const dirs = [
    ...String(pathEnv || '').split(':').filter(Boolean),
    ...KNOWN_DIRS,
  ];
  for (const bin of keys) {
    for (const dir of dirs) {
      const candidate = join(dir, bin);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function preflightIdentity(host, { identityDir = defaultIdentityDir() } = {}) {
  const names = identityFilesFor(host);
  if (!names.length) {
    const err = new Error(`robotdojo: unknown host "${host}"`);
    err.code = 'HOST_UNKNOWN';
    throw err;
  }
  const missing = [];
  const paths = [];
  for (const name of names) {
    const p = join(identityDir, name);
    if (!existsSync(p) || !String(readFileSync(p, 'utf8') || '').trim()) {
      missing.push(name);
    } else {
      paths.push(p);
    }
  }
  if (missing.length) {
    const err = new Error(`robotdojo: identity missing: ${missing.join(', ')}`);
    err.code = 'IDENTITY_MISSING';
    err.missing = missing;
    throw err;
  }
  return { files: paths, identityDir };
}

export function buildLaunchSpec(host, argv = [], {
  configDir,
  identityDir = defaultIdentityDir(),
  pathEnv = process.env.PATH,
  resolve = resolveHost,
} = {}) {
  const bin = resolve(host, { pathEnv });
  if (!bin) {
    const err = new Error(`robotdojo: ${host} is not installed`);
    err.code = 'HOST_MISSING';
    throw err;
  }
  const base = String(bin).split('/').pop();
  if (host === 'cursor' && base === 'cursor') {
    const err = new Error('robotdojo: Cursor GUI cannot receive injected identity. Install cursor-agent.');
    err.code = 'IDENTITY_UNATTACHABLE';
    throw err;
  }
  const ident = preflightIdentity(host, { identityDir });
  const env = childEnv(process.env, { configDir });
  const outArgv = [...argv];
  const identityPath = ident.files[0];

  if (host === 'codex') {
    const home = join(dirname(wrapDir(configDir)), 'codex-home');
    mkdirSync(home, { recursive: true });
    copyFileSync(identityPath, join(home, 'AGENTS.md'));
    env.CODEX_HOME = home;
  } else if (host === 'grok') {
    // WHY: installed grok appends --rules TEXT. A file-path flag is ignored;
    // --system-prompt / --system-prompt-override replace the harness.
    outArgv.unshift('--rules', readFileSync(identityPath, 'utf8'));
  } else {
    outArgv.unshift('--append-system-prompt-file', identityPath);
  }

  return { bin, argv: outArgv, env, identityPath };
}

export function confirmExtraSpend({ line } = {}) {
  const v = String(line ?? '').trim().toLowerCase();
  return v === 'yes' || v === 'y';
}

export function readSeat(_host, { reader } = {}) {
  if (typeof reader === 'function') return reader(_host);
  return { readable: false, reason: 'cannot read remaining seat for this host' };
}

export function shouldWarnSeat(seat, warnAtPct = 50) {
  if (!seat || !seat.readable) return false;
  const pct = Number(seat.remainingPct);
  if (!Number.isFinite(pct)) return false;
  return pct <= Number(warnAtPct);
}

export function launchAgent(name, argv, opts = {}) {
  const spec = buildLaunchSpec(name, argv, opts);
  ensureShim(opts.configDir);
  return spawn(spec.bin, spec.argv, {
    env: spec.env,
    stdio: opts.stdio || 'inherit',
    cwd: process.cwd(),
  });
}

export function installCli({ home = homedir(), repoRoot = REPO_ROOT } = {}) {
  const destDir = join(home, '.local', 'bin');
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, 'robotdojo');
  const src = join(repoRoot, 'scripts', 'robotdojo.js');
  try { unlinkSync(dest); } catch { /* ok */ }
  symlinkSync(src, dest);
  chmodSync(src, 0o755);
  return dest;
}

export function cliPath() {
  return join(REPO_ROOT, 'scripts', 'robotdojo.js');
}
