#!/usr/bin/env node
/**
 * check-launch-state-ownership.js
 *
 * Launch safety gate for scheduled workers that can write the local DB.
 * These workers must cross the launch DB writer guard before importing
 * `lib/db.js` or any module that statically imports it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LAUNCH_AGENTS_DIR = process.env.ROBOTDOJO_LAUNCH_AGENTS_DIR
  || resolve(REPO_ROOT, 'apps/static/launch-agents');

const LAUNCH_AGENTS_CONFIG = process.env.ROBOTDOJO_LAUNCH_AGENTS_CONFIG
  || resolve(REPO_ROOT, 'config/launch-agents.json');

const NODE_BUILTIN_RE = /^(node:|fs$|path$|url$|child_process$|os$|crypto$|util$|events$|stream$|buffer$)/;
const GUARD_IMPORTS = new Set([
  '../lib/db-writer-policy.js',
  '../lib/idle-gate.js',
  '../lib/request-observer.js',
]);

function rel(path) {
  return path.startsWith(REPO_ROOT + '/') ? path.slice(REPO_ROOT.length + 1) : path;
}

function readProgramArgs(plistPath) {
  const xml = readFileSync(plistPath, 'utf8');
  const match = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!match) return [];
  return [...match[1].matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
}

function readEnvKeys(plistPath) {
  const xml = readFileSync(plistPath, 'utf8');
  const match = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!match) return new Set();
  return new Set([...match[1].matchAll(/<key>(.*?)<\/key>/g)].map((m) => m[1]));
}

function resolveTemplateArg(arg) {
  const permissionApp = process.env.ROBOTDOJO_PERMISSION_APP || '';
  const runtimeBin = process.env.ROBOTDOJO_RUNTIME_BIN
    || (permissionApp ? join(permissionApp, 'Contents', 'MacOS', 'Robot Dojo') : process.execPath);
  return arg
    .replaceAll('__ROBOTDOJO_HOME__', REPO_ROOT)
    .replaceAll('__ROBOTDOJO_APP__', permissionApp)
    .replaceAll('__ROBOTDOJO_LAUNCHER__', process.env.ROBOTDOJO_PERMISSION_LAUNCHER || '')
    .replaceAll('__ROBOTDOJO_RUNTIME__', runtimeBin)
    .replaceAll('__NODE__', process.execPath);
}

function readLaunchAgentConfig() {
  if (!existsSync(LAUNCH_AGENTS_CONFIG)) {
    throw new Error(`launch-agent config not found: ${rel(LAUNCH_AGENTS_CONFIG)}`);
  }
  const parsed = JSON.parse(readFileSync(LAUNCH_AGENTS_CONFIG, 'utf8'));
  if (!Array.isArray(parsed.agents)) {
    throw new Error('config/launch-agents.json is missing agents[]');
  }
  return parsed.agents.filter((agent) => agent.audience === 'product');
}

function configuredWorkerScripts(agents) {
  const out = [];
  for (const agent of agents) {
    if (!agent.label || !agent.template) {
      out.push({ agent, missing: 'manifest entry missing label or template' });
      continue;
    }
    const plistPath = resolve(REPO_ROOT, agent.template);
    if (!plistPath.startsWith(LAUNCH_AGENTS_DIR) || !existsSync(plistPath)) {
      out.push({ agent, plistPath, missing: `template not found: ${agent.template}` });
      continue;
    }
    const args = readProgramArgs(plistPath);
    const envKeys = readEnvKeys(plistPath);
    for (const arg of args) {
      const resolved = resolveTemplateArg(arg);
      const scriptRel = rel(resolved);
      if (scriptRel.endsWith('.js') || scriptRel.endsWith('.mjs')) {
        out.push({ agent, plistPath, scriptPath: resolve(REPO_ROOT, scriptRel), scriptRel, envKeys });
      }
    }
  }
  return out;
}

function staticImports(source) {
  const imports = [];
  const importRe = /^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"];?/gm;
  for (const match of source.matchAll(importRe)) imports.push(match[1]);
  return imports;
}

function dynamicImports(source) {
  const imports = [];
  const importRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(importRe)) imports.push(match[1]);
  return imports;
}

function literalImports(source) {
  return [...staticImports(source), ...dynamicImports(source)];
}

function topLevelCallArgs(source, callIdx, callee) {
  const openIdx = source.indexOf('(', callIdx + callee.length);
  if (openIdx === -1) return [];
  const args = [];
  let current = '';
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = openIdx + 1; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      current += ch;
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      current += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      current += ch + next;
      i += 1;
      lineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      current += ch + next;
      i += 1;
      blockComment = true;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (ch === ')' && depth === 0) {
        args.push(current.trim());
        return args;
      }
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  return [];
}

// SQL write verbs, matched only inside db.prepare()/db.exec()/db.run(). A bare
// word scan would hit JavaScript's own String.replace() and flag every file
// that touches a string.
const SQL_CALL_RE = /\b(?:db|database)\s*\.\s*(?:prepare|exec|run)\s*\(\s*([`'"])([\s\S]*?)\1/g;
const SQL_WRITE_RE = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE)\b/i;

/** True when config/direct-db-writers.json classifies this script read-only. */
function declaredReadOnly(scriptRel) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'config/direct-db-writers.json'), 'utf8'));
    return (manifest.writers || []).some(
      (w) => w.path === scriptRel && w.classification === 'read-only-launch-agent',
    );
  } catch {
    // No manifest, no exemption. Failing closed is the whole point.
    return false;
  }
}

function isReadOnlyDbConsumer(source) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');
  for (const m of stripped.matchAll(SQL_CALL_RE)) {
    if (SQL_WRITE_RE.test(m[2])) return false;
  }
  return true;
}

function chatYieldingWriteFindings(source, worker) {
  const findings = [];
  let idx = source.indexOf('withChatYieldingWrite(');
  while (idx !== -1) {
    const args = topLevelCallArgs(source, idx, 'withChatYieldingWrite');
    const dbArg = args[2] || '';
    if (args.length < 3 || !dbArg || /^null\b|^undefined\b/.test(dbArg) || dbArg.startsWith('{')) {
      findings.push(`${worker.scriptRel}: withChatYieldingWrite must receive a real DB handle as its third argument`);
    }
    idx = source.indexOf('withChatYieldingWrite(', idx + 'withChatYieldingWrite('.length);
  }
  return findings;
}

function resolveLocalImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  let target = resolve(dirname(fromFile), spec);
  if (!extname(target)) target += '.js';
  return target;
}

function importGraphTouchesDb(file, seen = new Set()) {
  const abs = resolve(file);
  if (seen.has(abs)) return false;
  seen.add(abs);
  if (rel(abs) === 'lib/db.js') return true;
  if (!existsSync(abs)) return false;
  const source = readFileSync(abs, 'utf8');
  for (const spec of literalImports(source)) {
    if (NODE_BUILTIN_RE.test(spec)) continue;
    const local = resolveLocalImport(abs, spec);
    if (!local) continue;
    if (importGraphTouchesDb(local, seen)) return true;
  }
  return false;
}

function assertGuarded(worker) {
  if (worker.missing) return `${worker.agent?.label || 'launch-agent'}: ${worker.missing}`;
  if (!existsSync(worker.scriptPath)) {
    return `${worker.agent.label}: target script not found: ${worker.scriptRel}`;
  }
  const touchesDb = importGraphTouchesDb(worker.scriptPath);
  const needsConfigEnv = touchesDb || worker.scriptRel === 'scripts/backup-dispatcher.js';
  if (needsConfigEnv) {
    const missingEnv = ['ROBOTDOJO_HOME', 'ROBOTDOJO_CONFIG', 'ROBOTDOJO_DB']
      .filter((key) => !worker.envKeys?.has(key));
    if (missingEnv.length) {
      return `${worker.agent.label}: missing LaunchAgent env key(s) for DB/config path parity: ${missingEnv.join(', ')}`;
    }
  }
  if (!touchesDb) return null;
  if (worker.scriptRel === 'index.js') return null; // server-owned DB access.

  const source = readFileSync(worker.scriptPath, 'utf8');

  // st_4312c9c0 — a launch agent that only READS needs no writer guard: the
  // guard serialises writers against each other, and there is nothing to
  // serialise. Requiring one would be compliance theatre.
  //
  // BELT AND BRACES, deliberately. The exemption needs BOTH an explicit
  // 'read-only-launch-agent' classification in config/direct-db-writers.json
  // AND a source scan confirming no SQL write. Inferring read-only from source
  // alone was the first version of this and it was wrong: a worker that reaches
  // db.js and writes through a helper, or builds SQL dynamically, shows no
  // literal write verb and would have been waved through silently. Requiring the
  // declaration means a NEW unclassified worker still fails closed, which is the
  // property this gate exists for; requiring the scan means the declaration
  // cannot be used to smuggle a writer past it.
  if (declaredReadOnly(worker.scriptRel) && isReadOnlyDbConsumer(source)) return null;
  const chatYieldFindings = chatYieldingWriteFindings(source, worker);
  if (chatYieldFindings.length) return chatYieldFindings[0];
  const legacyGuardIdx = source.indexOf('withLaunchDbWriterGuard(');
  const chatYieldGuardIdx = source.indexOf('withChatYieldingWrite(');
  const guardIdx = legacyGuardIdx === -1 ? chatYieldGuardIdx
    : chatYieldGuardIdx === -1 ? legacyGuardIdx
    : Math.min(legacyGuardIdx, chatYieldGuardIdx);
  if (guardIdx === -1) {
    return `${worker.scriptRel}: missing withLaunchDbWriterGuard(...) or withChatYieldingWrite(...) boundary`;
  }

  const beforeGuard = source.slice(0, guardIdx);
  if (!beforeGuard.includes("from '../lib/db-writer-policy.js'")) {
    return `${worker.scriptRel}: guard boundary must import ../lib/db-writer-policy.js before use`;
  }

  for (const spec of staticImports(beforeGuard)) {
    if (NODE_BUILTIN_RE.test(spec) || GUARD_IMPORTS.has(spec)) continue;
    const local = resolveLocalImport(worker.scriptPath, spec);
    if (!local) {
      return `${worker.scriptRel}: non-local pre-guard import is not allowed: ${spec}`;
    }
    if (importGraphTouchesDb(local)) {
      return `${worker.scriptRel}: pre-guard import reaches lib/db.js via ${rel(local)}`;
    }
    return `${worker.scriptRel}: pre-guard import is not guard-safe: ${spec}`;
  }

  const namedLegacy = source.includes(`withLaunchDbWriterGuard('`) || source.includes(`withLaunchDbWriterGuard("`);
  const namedYield = source.includes(`withChatYieldingWrite('`) || source.includes(`withChatYieldingWrite("`);
  // Also accept WORKER_NAME constant pattern: const WORKER_NAME = '...'
  const hasWorkerNameConst = /const WORKER_NAME\s*=\s*['"]/.test(source);
  if (!namedLegacy && !namedYield && !hasWorkerNameConst) {
    return `${worker.scriptRel}: guard call must name the worker`;
  }
  return null;
}

const productAgents = readLaunchAgentConfig();
const workers = configuredWorkerScripts(productAgents);
const findings = [];
for (const worker of workers) {
  const finding = assertGuarded(worker);
  if (finding) findings.push(finding);
}

if (findings.length) {
  process.stderr.write('[check-launch-state-ownership] FAIL\n');
  for (const finding of findings) process.stderr.write(`  - ${finding}\n`);
  process.exit(1);
}

const dbWorkers = workers.filter((worker) => worker.scriptPath && existsSync(worker.scriptPath) && importGraphTouchesDb(worker.scriptPath));
process.stdout.write(`[check-launch-state-ownership] ok — ${productAgents.length} product LaunchAgent surface(s), ${workers.length} JS/MJS script target(s), ${dbWorkers.length} DB-touching script(s) safe\n`);
