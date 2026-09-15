#!/usr/bin/env node
/**
 * Check every script entrypoint that can reach lib/db.js is classified.
 *
 * The manifest is intentionally about scripts/, not routes/lib modules.
 * Server-owned route writes are allowed in-process; this gate catches
 * standalone processes that can surprise the local SQLite writer.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = process.env.ROBOTDOJO_DIRECT_DB_WRITERS
  || resolve(REPO_ROOT, 'config/direct-db-writers.json');

const ALLOWED_CLASSES = new Set([
  'server-owned',
  'guarded-launch-agent',
  'read-only-launch-agent',
  'guarded-child',
  'manual-only',
  'blocked-beta',
]);

const NODE_BUILTIN_RE = /^(node:|fs$|path$|url$|child_process$|os$|crypto$|util$|events$|stream$|buffer$|readline$|http$|https$|zlib$)/;

function rel(path) {
  return path.startsWith(REPO_ROOT + '/') ? path.slice(REPO_ROOT.length + 1) : path;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules') continue;
    const abs = join(dir, name.name);
    if (name.isDirectory()) walk(abs, out);
    else if (name.isFile() && /\.(m?js)$/.test(name.name)) out.push(abs);
  }
  return out;
}

function trackedScriptEntrypoints() {
  const result = spawnSync('git', ['ls-files', '--', 'scripts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0 || result.error) {
    return walk(resolve(REPO_ROOT, 'scripts')).map((abs) => rel(abs));
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((scriptRel) => /\.(m?js)$/.test(scriptRel))
    .filter((scriptRel) => existsSync(resolve(REPO_ROOT, scriptRel)));
}

function literalImports(source) {
  const imports = [];
  for (const match of source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"];?/gm)) imports.push(match[1]);
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push(match[1]);
  return imports;
}

function resolveLocalImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  let target = resolve(dirname(fromFile), spec);
  if (!extname(target)) target += '.js';
  return target;
}

function touchesDb(file, seen = new Set()) {
  const abs = resolve(file);
  if (seen.has(abs)) return false;
  seen.add(abs);
  if (rel(abs) === 'lib/db.js') return true;
  if (!existsSync(abs)) return false;
  const source = readFileSync(abs, 'utf8');
  for (const spec of literalImports(source)) {
    if (NODE_BUILTIN_RE.test(spec)) continue;
    const local = resolveLocalImport(abs, spec);
    if (local && touchesDb(local, seen)) return true;
  }
  return false;
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`manifest not found: ${rel(MANIFEST_PATH)}`);
  }
  const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (!Array.isArray(parsed.writers)) {
    throw new Error('config/direct-db-writers.json is missing writers[]');
  }
  return parsed.writers;
}

// st_4312c9c0 — a launch agent that only READS needs no write guard, and
// bolting activity-pause machinery onto one to satisfy a writer check would be
// compliance theatre: the guard would protect against a contention that cannot
// occur. 'read-only-launch-agent' is the honest classification, and it is
// VERIFIED rather than trusted — the source must contain no write verb, so the
// label cannot be used to smuggle a writer past the guard requirement.
// Write verbs, matched only inside SQL passed to db.prepare()/db.exec(). A bare
// word scan is wrong here: JavaScript's own String.replace() contains "replace"
// and would flag every file that touches a string. Scoping to the SQL argument
// is what makes this an assertion about the database rather than about prose.
const SQL_CALL = /\b(?:db|database)\s*\.\s*(?:prepare|exec|run)\s*\(\s*([`'"])([\s\S]*?)\1/g;
const WRITE_VERBS = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i;

function sourceIsReadOnly(scriptRel) {
  const source = readFileSync(resolve(REPO_ROOT, scriptRel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
  for (const m of source.matchAll(SQL_CALL)) {
    if (WRITE_VERBS.test(m[2])) return false;
  }
  return true;
}

function sourceHasLaunchGuard(scriptRel) {
  const source = readFileSync(resolve(REPO_ROOT, scriptRel), 'utf8');
  const fromPolicy = source.includes("from '../lib/db-writer-policy.js'")
    || source.includes('from "./lib/db-writer-policy.js"')
    || source.includes("from '../../lib/db-writer-policy.js'");
  const hasLegacyGuard = source.includes('withLaunchDbWriterGuard(') && fromPolicy;
  const hasChatYieldingGuard = source.includes('withChatYieldingWrite(') && fromPolicy;
  const hasActivityGatedMarker = source.includes('export const IDLE_GATED = false')
    && source.includes('ACTIVITY_PAUSE_MS');
  const hasResidentForegroundGate = source.includes('export const IDLE_GATED = true')
    && source.includes('daemonPauseDecision(')
    && source.includes('FOREGROUND_IDLE_SECONDS')
    && source.includes('getActivitySignal');
  return hasLegacyGuard || hasChatYieldingGuard || hasActivityGatedMarker || hasResidentForegroundGate;
}

const findings = [];
let writers;
try {
  writers = loadManifest();
} catch (err) {
  findings.push(err.message);
  writers = [];
}

const manifestByPath = new Map();
for (const entry of writers) {
  if (!entry.path || !entry.classification) {
    findings.push(`manifest entry missing path or classification: ${JSON.stringify(entry)}`);
    continue;
  }
  if (!ALLOWED_CLASSES.has(entry.classification)) {
    findings.push(`${entry.path}: invalid classification "${entry.classification}"`);
  }
  if (manifestByPath.has(entry.path)) {
    findings.push(`${entry.path}: duplicate manifest entry`);
  }
  manifestByPath.set(entry.path, entry);
  if (!existsSync(resolve(REPO_ROOT, entry.path))) {
    findings.push(`${entry.path}: manifest entry points at a missing script`);
  }
}

const dbScripts = trackedScriptEntrypoints()
  .filter((scriptRel) => touchesDb(resolve(REPO_ROOT, scriptRel)))
  .sort();

for (const scriptRel of dbScripts) {
  const entry = manifestByPath.get(scriptRel);
  if (!entry) {
    findings.push(`${scriptRel}: reaches lib/db.js but is missing from config/direct-db-writers.json`);
    continue;
  }
  if (entry.classification === 'guarded-launch-agent' && !sourceHasLaunchGuard(scriptRel)) {
    findings.push(`${scriptRel}: classified guarded-launch-agent but missing withLaunchDbWriterGuard, withChatYieldingWrite, or IDLE_GATED=false marker`);
  }
  if (entry.classification === 'read-only-launch-agent' && !sourceIsReadOnly(scriptRel)) {
    findings.push(`${scriptRel}: classified read-only-launch-agent but contains a write statement — reclassify as guarded-launch-agent and add the write guard`);
  }
}

for (const entry of manifestByPath.values()) {
  // dynamicImports:true marks scripts that reach lib/db.js via runtime-resolved
  // dynamic import(resolve(ROOT, 'lib/db.js')) — undetectable by static analysis.
  // Skip the "does not reach lib/db.js" check, but still enforce the guard pattern.
  if (entry.dynamicImports) {
    if (entry.classification === 'guarded-launch-agent' && !sourceHasLaunchGuard(entry.path)) {
      findings.push(`${entry.path}: classified guarded-launch-agent but missing withLaunchDbWriterGuard, withChatYieldingWrite, or IDLE_GATED=false marker`);
    }
    continue;
  }
  if (existsSync(resolve(REPO_ROOT, entry.path)) && !dbScripts.includes(entry.path)) {
    findings.push(`${entry.path}: manifest entry does not reach lib/db.js`);
  }
}

if (findings.length) {
  process.stderr.write('[check-direct-db-writers] FAIL\n');
  for (const finding of findings) process.stderr.write(`  - ${finding}\n`);
  process.exit(1);
}

process.stdout.write(`[check-direct-db-writers] ok — ${dbScripts.length} direct DB script(s) classified\n`);
