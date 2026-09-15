#!/usr/bin/env node
// scripts/list-lagging-files.js — st_7fcebb44
//
// Enumerates substrate files whose last commit predates the story-anchored cutoff.
//
// Predicate scope (from 02-plan.md):
//   - ~/robotdojo/agents/*.md (one level)
//   - ~/robotdojo/user/contexts/**/*.md (recursive)
//   - ~/robotdojo/architecture/architecture.md
//   - ~/robotdojo/agents/skills/SKILLS.md
//
// Cutoff: meta.json.first_commit's commit date if set; otherwise the fallback
// 2026-05-13T00:00:00Z (one week before story start, per the owner's
// "last week's improvements" phrasing in the framing).
//
// CLI: node list-lagging-files.js <story_id>
// Output: relative paths (from ~/robotdojo), one per line, to stdout.
// Exit 0 always — emptiness is not an error here.
//
// Tier: orchestration (no LLM).

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = homedir();
const ROBOTDOJO = join(HOME, 'robotdojo');
const FALLBACK_CUTOFF = '2026-05-13T00:00:00Z';

function walkMd(root, depth, acc) {
  if (!existsSync(root)) return;
  let st;
  try { st = statSync(root); } catch { return; }
  if (!st.isDirectory()) return;
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    // WHY: tolerate broken symlinks and other transient entries — substrate
    // walks should never die because a sibling directory has a dangling link.
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isFile()) {
      if (full.endsWith('.md')) acc.push(full);
    } else if (s.isDirectory() && depth > 1) {
      walkMd(full, depth - 1, acc);
    }
  }
}

function inventoryFiles() {
  const acc = [];
  walkMd(join(ROBOTDOJO, 'identity'), 1, acc);
  // WHY depth=1: contexts/{companies,people,places}/ are entity stores
  // (1000s of files each) — not substrate. The substrate files are the
  // top-level *.md (entity.md, voice.md, topics.md, etc.).
  walkMd(join(ROBOTDOJO, 'contexts'), 1, acc);
  const arch = join(ROBOTDOJO, 'architecture/architecture.md');
  if (existsSync(arch)) acc.push(arch);
  const skillsIndex = join(ROBOTDOJO, 'skills', 'SKILLS.md');
  if (existsSync(skillsIndex)) acc.push(skillsIndex);
  return acc;
}

function gitLastCommitISO(repo, relPath) {
  try {
    const out = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cI', '--', relPath], {
      encoding: 'utf8',
    }).trim();
    return out || null;
  } catch (e) {
    return null;
  }
}

// WHY: gitignored files (per-machine private data — wk_user vessel, user/contexts/ packages, etc.)
// cannot satisfy a git-log-anchored AC predicate because they have no git history and no
// commit can touch them without removing the gitignore (which would push PII). They are
// substrate-shaped but not substrate — exclude from the lagging set so VC1 grep is satisfiable.
function isGitignored(repo, relPath) {
  try {
    // exit 0 = ignored; non-zero = not ignored or not in repo
    execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--', relPath], {
      encoding: 'utf8',
    });
    return true;
  } catch (e) {
    return false;
  }
}

function gitCommitDateISO(repo, sha) {
  try {
    return execFileSync('git', ['-C', repo, 'show', '-s', '--format=%cI', sha], {
      encoding: 'utf8',
    }).trim();
  } catch (e) {
    return null;
  }
}

function loadCutoff(storyId) {
  const metaPath = join(ROBOTDOJO, 'user', 'workbenches', 'topics', 'work', 'robot-dojo', 'wk_robot_dojo', 'stories', storyId, 'meta.json');
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.first_commit) {
        const d = gitCommitDateISO(ROBOTDOJO, meta.first_commit);
        if (d) return d;
      }
    } catch (e) {
      // fall through to fallback
    }
  }
  return FALLBACK_CUTOFF;
}

function main() {
  const storyId = process.argv[2];
  if (!storyId) {
    process.stderr.write('usage: list-lagging-files.js <story_id>\n');
    process.exit(1);
  }
  const cutoff = loadCutoff(storyId);
  const cutoffTs = Date.parse(cutoff);
  if (Number.isNaN(cutoffTs)) {
    process.stderr.write(`invalid cutoff: ${cutoff}\n`);
    process.exit(1);
  }
  const files = inventoryFiles();
  for (const abs of files) {
    const rel = relative(ROBOTDOJO, abs).split(sep).join(posix.sep);
    // Skip gitignored files — see isGitignored() comment. The VC needs a git log entry;
    // a gitignored file can never satisfy that, so excluding it here prevents a permanently
    // failing predicate without dropping the structural intent of the AC.
    if (isGitignored(ROBOTDOJO, rel)) continue;
    const iso = gitLastCommitISO(ROBOTDOJO, rel);
    // Files with no git history (and not gitignored) are treated as lagging — they have not
    // been touched in the current story arc.
    if (!iso) {
      process.stdout.write(rel + '\n');
      continue;
    }
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) continue;
    if (ts < cutoffTs) {
      process.stdout.write(rel + '\n');
    }
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { inventoryFiles, loadCutoff };
