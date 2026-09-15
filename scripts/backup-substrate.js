#!/usr/bin/env node
// scripts/backup-substrate.js — st_7fcebb44
//
// Captures pre-modification snapshots of every substrate file the cleanup
// story may touch. Writes copies + a SHA-256 manifest to
// ~/robotdojo/.backup/<story_id>/                (no --rung)
// ~/robotdojo/.backup/<story_id>/rung-<N>/       (with --rung N)
//
// Inventory scope (per st_7fcebb44 plan):
//   - ~/.claude/skills/*/SKILL.md
//   - ~/.claude/agents/*.md
//   - ~/robotdojo/agents/*.md
//   - ~/robotdojo/agents/personas/*.md
//   - ~/robotdojo/agents/skills/**/*.md
//   - ~/robotdojo/agents/suggestions/*.md
//   - ~/robotdojo/user/contexts/**/*.md
//   - ~/robotdojo/user/workbenches/user/wk_user/USER.md
//   - ~/robotdojo/architecture/architecture.md
//   - ~/robotdojo/agents/skills/SKILLS.md
//   - every human-authored path in ~/robotdojo/architecture/surfaces.json
//
// CLI: node backup-substrate.js <story_id> [--rung N]
// Idempotent — re-running overwrites the destination with current source.
// Backup root never overlaps story dir or git history.
//
// Manifest schema:
//   { created_at: ISO8601, files: { "<path-from-home>": { sha256, backed_up_at } } }
//
// Tier: orchestration (no LLM).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative, isAbsolute, sep, posix } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const ROBOTDOJO = join(HOME, 'robotdojo');

function parseArgs(argv) {
  const out = { storyId: null, rung: null, phase: null, home: HOME };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--rung' && argv[i + 1]) {
      out.rung = String(argv[i + 1]);
      i++;
    } else if (argv[i] === '--phase' && argv[i + 1]) {
      const v = String(argv[i + 1]);
      if (v !== 'start' && v !== 'close') {
        process.stderr.write(`error: --phase must be 'start' or 'close', got '${v}'\n`);
        process.exit(1);
      }
      out.phase = v;
      i++;
    } else if (argv[i] === '--home' && argv[i + 1]) {
      // WHY: test harness can override the home root to avoid touching ~/.
      out.home = argv[i + 1];
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  out.storyId = positional[0];
  return out;
}

function sha256Hex(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Walk a directory, returning *.md file paths. `depth=1` means only the
// immediate children; `depth=Infinity` recurses.
function walkMd(root, depth, acc) {
  if (!existsSync(root)) return;
  let st;
  try { st = statSync(root); } catch { return; }
  if (!st.isDirectory()) return;
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    // WHY: tolerate broken symlinks (e.g. contexts/contexts → ~/.robotdojo/…).
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isFile()) {
      if (full.endsWith('.md')) acc.push(full);
    } else if (s.isDirectory() && depth > 1) {
      walkMd(full, depth - 1, acc);
    }
  }
}

// Returns the absolute path for an entry from canonical-surfaces.json.
// Resolves `~/` against home; treats other relative paths as relative to repo root.
function resolveSurfacePath(p, home) {
  if (p.startsWith('~/')) return join(home, p.slice(2));
  if (isAbsolute(p)) return p;
  return join(home, 'robotdojo', p);
}

// Inventory all candidate files. Returns absolute paths, deduplicated.
function inventory(home) {
  const robotdojo = join(home, 'robotdojo');
  const claude = join(home, '.claude');
  const acc = new Set();

  // ~/.claude/skills/*/SKILL.md
  const skillsRoot = join(claude, 'skills');
  if (existsSync(skillsRoot)) {
    for (const name of readdirSync(skillsRoot)) {
      const skillFile = join(skillsRoot, name, 'SKILL.md');
      if (existsSync(skillFile)) acc.add(skillFile);
    }
  }

  // ~/.claude/agents/*.md (top-level only)
  const agentsRoot = join(claude, 'agents');
  if (existsSync(agentsRoot)) {
    for (const name of readdirSync(agentsRoot)) {
      const full = join(agentsRoot, name);
      if (statSync(full).isFile() && full.endsWith('.md')) acc.add(full);
    }
  }

  // ~/robotdojo/agents/*.md, personas, source skills, and suggestions.
  const agentTopAcc = [];
  walkMd(join(robotdojo, 'agents'), 1, agentTopAcc);
  for (const p of agentTopAcc) acc.add(p);
  const personaAcc = [];
  walkMd(join(robotdojo, 'agents', 'personas'), 1, personaAcc);
  for (const p of personaAcc) acc.add(p);
  const skillAcc = [];
  walkMd(join(robotdojo, 'agents', 'skills'), 2, skillAcc);
  for (const p of skillAcc) acc.add(p);
  const suggestionAcc = [];
  walkMd(join(robotdojo, 'agents', 'suggestions'), 1, suggestionAcc);
  for (const p of suggestionAcc) acc.add(p);

  // ~/robotdojo/user/contexts/*.md (top-level only)
  // WHY depth=1: contexts/{companies,people,places}/ are entity stores
  // (thousands of files each) — not substrate. The substrate is the
  // top-level *.md files (entity.md, voice.md, topics.md, etc.).
  const ctxAcc = [];
  walkMd(join(robotdojo, 'user', 'contexts'), 1, ctxAcc);
  for (const p of ctxAcc) acc.add(p);

  // Direct files. wk_user vessel (st_0c491456 Phase 1) — both the
  // chat-injected dense distillation and the deep IDE companion are
  // substrate that must be revert-able.
  const wkUserContext = join(robotdojo, 'user', 'workbenches', 'user', 'wk_user', 'context.md');
  if (existsSync(wkUserContext)) acc.add(wkUserContext);
  const wkUserDeep = join(robotdojo, 'user', 'workbenches', 'user', 'wk_user', 'USER.md');
  if (existsSync(wkUserDeep)) acc.add(wkUserDeep);
  const arch = join(robotdojo, 'architecture', 'architecture.md');
  if (existsSync(arch)) acc.add(arch);
  const skillsIndex = join(robotdojo, 'agents', 'skills', 'SKILLS.md');
  if (existsSync(skillsIndex)) acc.add(skillsIndex);
  const bunshinQs = join(robotdojo, 'config', 'bunshin-questions.json');
  if (existsSync(bunshinQs)) acc.add(bunshinQs);
  // architecture/surfaces.json — back up the registry itself AND its
  // human-authored entries. The registry is substrate too (it's hand-curated)
  // and changes to it must be revert-able.
  const csPath = join(robotdojo, 'architecture', 'surfaces.json');
  if (existsSync(csPath)) {
    acc.add(csPath);
    try {
      const cs = JSON.parse(readFileSync(csPath, 'utf8'));
      for (const s of cs.surfaces || []) {
        if (s.class !== 'human-authored') continue;
        const abs = resolveSurfacePath(s.path, home);
        if (existsSync(abs)) acc.add(abs);
      }
    } catch (e) {
      // Non-fatal — skip if the registry can't be parsed.
      process.stderr.write(`warning: cannot parse ${csPath}: ${e.message}\n`);
    }
  }

  return Array.from(acc).sort();
}

// Compute destination path relative to the backup root, using path relative to
// the user's home — preserves both repo and ~/.claude trees.
function pathFromHome(abs, home) {
  const rel = relative(home, abs);
  // Use POSIX separators inside the manifest for portability.
  return rel.split(sep).join(posix.sep);
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.storyId) {
    process.stderr.write('usage: backup-substrate.js <story_id> [--rung N | --phase start|close]\n');
    process.exit(1);
  }
  if (args.rung && args.phase) {
    process.stderr.write('error: --rung and --phase are mutually exclusive\n');
    process.exit(1);
  }
  let backupRoot;
  if (args.rung) {
    backupRoot = join(args.home, 'robotdojo', '.backup', args.storyId, `rung-${args.rung}`);
  } else if (args.phase) {
    backupRoot = join(args.home, 'robotdojo', '.backup', args.storyId, args.phase);
  } else {
    backupRoot = join(args.home, 'robotdojo', '.backup', args.storyId);
  }
  ensureDir(backupRoot);

  const files = inventory(args.home);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const manifest = { created_at: now, files: {} };

  for (const abs of files) {
    const rel = pathFromHome(abs, args.home);
    const dest = join(backupRoot, rel);
    ensureDir(dirname(dest));
    copyFileSync(abs, dest);
    manifest.files[rel] = {
      sha256: sha256Hex(abs),
      backed_up_at: now,
    };
  }

  const manifestPath = join(backupRoot, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(`backup: ${manifestPath} (${files.length} files)\n`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { inventory, pathFromHome, parseArgs };
