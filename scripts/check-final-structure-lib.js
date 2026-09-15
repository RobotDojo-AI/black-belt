#!/usr/bin/env node
/**
 * Shared helpers for final structure checks.
 *
 * These checks are deterministic extraction gates. They should fail with a
 * concrete path and line, not infer intent.
 */
export const INTELLIGENCE_TIER = 'extraction';

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(__dirname, '..');

export const AGENT_NAMES = ['Miyagi', 'Tantei', 'Hakase', 'Ori', 'Katagami', 'Bunshin'];

export const REQUIRED_SKILLS = [
  'goal',
  'story',
  'defect',
  'work',
  'framing',
  'research',
  'scope',
  'plan',
  'build',
  'qa',
  'close',
  'write',
  'format',
  'kanban',
  'coach',
  'health',
  'asana',
  'promote',
];

export const USER_CHILDREN = [
  'profile.md',
  'inbox',
  'imports',
  'files',
  'contexts',
  'workbenches',
  'transcripts',
  'memory',
  'databases',
  'logs',
  'media',
  'models',
];

export const RETIRED_PRIVATE_ROOTS = [
  'contexts',
  'workbenches',
  'transcripts',
  'memory',
  'imports',
  'userfiles',
  'databases',
  'logs',
  'media',
  'models',
];

export const DEFAULT_EXCLUDES = [
  '.backup/',
  '.git/',
  '.claude/',
  '.vercel/',
  'node_modules/',
  'code/',
  'contexts/',
  'databases/',
  'imports/',
  'agents/dist/',
  'logs/',
  'media/',
  'memory/',
  'models/',
  'pipeline/',
  'user/',
  'userfiles/',
  'workbenches/',
  'transcripts/',
  'user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/st_608fe3ed/',
  'pipeline/archive/',
  'quarantine/',
];

export const CHECK_SCRIPT_ALLOWLIST = [
  /^scripts\/check-final-structure.*\.js$/,
  /^scripts\/check-agent-os.*\.js$/,
  /^scripts\/check-user-root-boundary\.js$/,
  /^scripts\/check-import-flow-boundary\.js$/,
  /^scripts\/check-structure-migration-manifest\.js$/,
];

export const LEGACY_AGENT_RULES = [
  {
    name: 'retired identity agent source',
    pattern: /(?:~\/robotdojo\/)?identity\/(?:agents(?:\.md|\/)|dist\/|build-conventions\.md|default-quality\.md|README\.md|suggestions\/)/g,
  },
  {
    name: 'retired identity user profile',
    pattern: /(?:~\/robotdojo\/)?identity\/user\.md/g,
  },
  {
    name: 'retired identity root markdown',
    pattern: /(?:~\/robotdojo\/)?identity\/[A-Za-z0-9_.-]+\.md/g,
  },
  {
    name: 'retired top-level skills source',
    pattern: /(?<!agents\/)(?<!\.claude\/)(?:~\/robotdojo\/)?skills\/(?:SKILLS\.md|[A-Za-z0-9_-]+\/(?:SKILL\.md|README\.md|write\.js|renderer\.js)?)/g,
  },
];

export const LEGACY_PRIVATE_RULES = [
  {
    name: 'hybrid dot-robotdojo user root',
    pattern: /~\/\.robotdojo\/user\//g,
  },
  {
    name: 'absolute retired private root',
    pattern: /~\/robotdojo\/(?:contexts|workbenches|transcripts|memory|imports|userfiles|databases|logs|media|models)\/(?=[\s`'")])/g,
  },
  {
    name: 'retired context root',
    pattern: /(?<!user\/)(?:~\/robotdojo\/)?contexts\/(?:topics|people|companies|places|research|voice\.md|[A-Za-z0-9_.-]+\.md)/g,
  },
  {
    name: 'retired workbench root',
    pattern: /(?<!user\/)(?:~\/robotdojo\/)?workbenches\/(?:topics|entities|owner-fixtures\.json|[A-Za-z0-9_.-]+)/g,
  },
  {
    name: 'retired transcript root',
    pattern: /(?<!user\/)(?:~\/robotdojo\/)?transcripts\/(?:calls|chat|[A-Za-z0-9_.-]+)/g,
  },
  {
    name: 'retired memory root',
    pattern: /(?<!user\/)(?<!\.claude\/projects\/[^/]+\/)(?:~\/robotdojo\/)?memory\/(?:log|bin|MEMORY\.md|LOG_PROTOCOL\.md|context)/g,
  },
  {
    name: 'retired import root',
    pattern: /(?<!user\/)(?:~\/robotdojo\/)?imports\/(?:Inbox|\.index|imported-memories|drive|[0-9a-f]{2})/g,
  },
  {
    name: 'retired userfiles root',
    pattern: /(?:~\/robotdojo\/)?userfiles\/[A-Za-z0-9_.-]+/g,
  },
  {
    name: 'retired database root',
    pattern: /(?<!user\/)(?:~\/robotdojo\/)?databases\/(?:health|backups|emails|finance|network|[A-Za-z0-9_.-]+\.db)/g,
  },
  {
    name: 'retired logs root',
    pattern: /(?<!user\/)(?<!\.robotdojo\/)(?:~\/robotdojo\/)?logs\/[A-Za-z0-9_.-]+/g,
  },
  {
    name: 'retired media root',
    pattern: /(?<!user\/)(?:~\/robotdojo\/)?media\/[A-Za-z0-9_.-]+/g,
  },
  {
    name: 'retired models root',
    pattern: /(?<!user\/)(?<!\.robotdojo\/)(?:~\/robotdojo\/)?models\/[A-Za-z0-9_.-]+/g,
  },
];

export const LEGACY_RULES = [...LEGACY_AGENT_RULES, ...LEGACY_PRIVATE_RULES];

export function parseArgs(argv = process.argv) {
  const out = {
    repoRoot: process.env.ROBOTDOJO_REPO_ROOT
      ? resolve(process.env.ROBOTDOJO_REPO_ROOT)
      : DEFAULT_REPO_ROOT,
    story: null,
    db: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') out.repoRoot = resolve(argv[++i]);
    else if (arg === '--story') out.story = argv[++i];
    else if (arg === '--db') out.db = resolve(argv[++i]);
  }
  return out;
}

export function repoPath(repoRoot, relPath) {
  return join(repoRoot, relPath);
}

export function fileExists(repoRoot, relPath) {
  return existsSync(repoPath(repoRoot, relPath));
}

export function readText(repoRoot, relPath) {
  return readFileSync(repoPath(repoRoot, relPath), 'utf8');
}

export function readJson(repoRoot, relPath, errors) {
  try {
    return JSON.parse(readText(repoRoot, relPath));
  } catch (err) {
    errors.push(`cannot read JSON ${relPath}: ${err.message}`);
    return null;
  }
}

export function normalizeRelPath(path) {
  return path.split('\\').join('/');
}

export function listTrackedFiles(repoRoot) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'buffer',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString('utf8') || 'git ls-files failed');
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(normalizeRelPath)
    .sort();
}

export function trackedUnder(repoRoot, prefix) {
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return listTrackedFiles(repoRoot).filter((file) => file === prefix || file.startsWith(p));
}

export function hasEntries(repoRoot, relDir) {
  const abs = repoPath(repoRoot, relDir);
  if (!existsSync(abs)) return false;
  try {
    return readdirSync(abs).length > 0;
  } catch {
    return false;
  }
}

export function isDirectory(repoRoot, relPath) {
  try {
    return statSync(repoPath(repoRoot, relPath)).isDirectory();
  } catch {
    return false;
  }
}

export function walkFiles(repoRoot, relRoot = '.', excludes = DEFAULT_EXCLUDES) {
  const out = [];
  const rootAbs = repoPath(repoRoot, relRoot);
  if (!existsSync(rootAbs)) return out;
  const stack = [rootAbs];
  while (stack.length) {
    const abs = stack.pop();
    const rel = normalizeRelPath(relative(repoRoot, abs)) || '.';
    if (rel !== '.' && isExcluded(rel, excludes)) continue;
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) stack.push(join(abs, name));
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

export function isExcluded(relPath, excludes = DEFAULT_EXCLUDES) {
  const rel = normalizeRelPath(relPath);
  return excludes.some((prefix) => {
    const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return rel === prefix.replace(/\/$/, '') || rel.startsWith(p);
  });
}

export function isCheckScript(relPath) {
  return CHECK_SCRIPT_ALLOWLIST.some((re) => re.test(relPath));
}

export function isTextPath(relPath) {
  return /\.(cjs|css|html|js|json|md|mjs|sh|txt|ts|tsx|yml|yaml)$/i.test(relPath)
    || relPath === '.vercelignore'
    || relPath === '.gitignore'
    || relPath === 'CLAUDE.md'
    || relPath === 'README.md';
}

export function activeTextFiles(repoRoot, relRoots, extraExcludes = []) {
  const excludes = [...DEFAULT_EXCLUDES, ...extraExcludes];
  return relRoots
    .flatMap((relRoot) => walkFiles(repoRoot, relRoot, excludes))
    .filter((relPath, idx, arr) => arr.indexOf(relPath) === idx)
    .filter(isTextPath)
    .sort();
}

export function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function scanLegacyReferences(repoRoot, files, rules = LEGACY_RULES, options = {}) {
  const allowCheckScripts = options.allowCheckScripts !== false;
  const allow = options.allow || (() => false);
  const errors = [];
  for (const relPath of files) {
    if (allowCheckScripts && isCheckScript(relPath)) continue;
    if (allow(relPath)) continue;
    let text;
    try {
      text = readText(repoRoot, relPath);
    } catch {
      continue;
    }
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(text)) !== null) {
        errors.push(`${relPath}:${lineNumberAt(text, match.index)} ${rule.name}: ${match[0]}`);
      }
    }
  }
  return errors;
}

export function requirePaths(repoRoot, relPaths, errors) {
  for (const relPath of relPaths) {
    if (!fileExists(repoRoot, relPath)) errors.push(`missing required path: ${relPath}`);
  }
}

export function requireTrackedAbsent(repoRoot, prefixes, errors) {
  for (const prefix of prefixes) {
    const tracked = trackedUnder(repoRoot, prefix);
    if (tracked.length > 0) {
      errors.push(`tracked retired root ${prefix}/ still has files: ${tracked.slice(0, 8).join(', ')}${tracked.length > 8 ? ' ...' : ''}`);
    }
  }
}

export function copyTrackedTree(repoRoot, targetRoot) {
  mkdirSync(targetRoot, { recursive: true });
  for (const relPath of listTrackedFiles(repoRoot)) {
    const src = repoPath(repoRoot, relPath);
    if (!existsSync(src)) continue;
    const dst = join(targetRoot, relPath);
    mkdirSync(dirname(dst), { recursive: true });
    const stat = lstatSync(src);
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(src), dst);
    } else {
      cpSync(src, dst, { dereference: false, recursive: false });
    }
  }
}

export function failOrPass(label, errors, okMessage = 'ok') {
  if (errors.length > 0) {
    process.stderr.write(`[${label}] FAIL - ${errors.length} violation(s):\n`);
    for (const err of errors) process.stderr.write(`  - ${err}\n`);
    process.exit(1);
  }
  process.stdout.write(`[${label}] ${okMessage}\n`);
}
