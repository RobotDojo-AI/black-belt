#!/usr/bin/env node
/**
 * check-story-worktree.js
 *
 * Blocks build/close when tracked worktree dirt is outside the active story's
 * declared ownership. Story-local artifacts stay local pipeline state.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORIES_DIR = PIPELINE_STORIES_DIR;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--story') args.story = argv[++i];
    else if (argv[i] === '--stage') args.stage = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.story) throw new Error('--story is required');
  if (!args.stage) throw new Error('--stage is required');
  return args;
}

function loadMeta(story) {
  const path = join(STORIES_DIR, story, 'meta.json');
  if (!existsSync(path)) throw new Error(`story meta not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function normalize(path) {
  return path.replace(/^\.?\//, '');
}

function matchesOwned(path, patterns) {
  const p = normalize(path);
  return patterns.some((raw) => {
    const pattern = normalize(String(raw || ''));
    if (!pattern) return false;
    return p === pattern || p.startsWith(pattern.replace(/\/$/, '') + '/');
  });
}

function statusRows() {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain=v1', '--untracked-files=all'], {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean).map((line) => ({
    code: line.slice(0, 2),
    path: line.slice(3).replace(/^"|"$/g, ''),
  }));
}

function isStoryLocal(story, path) {
  return normalize(path).startsWith(`user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/${story}/`);
}

function exceptionMatches(path, stage, exceptions = []) {
  return exceptions.some((entry) => {
    if (!entry || !entry.path || !entry.reason) return false;
    if (entry.stage && entry.stage !== stage && entry.stage !== 'all') return false;
    return matchesOwned(path, [entry.path]);
  });
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) {
    console.error(`[check-story-worktree] FAIL — ${err.message}`);
    process.exit(2);
  }

  const meta = loadMeta(args.story);
  const touches = Array.isArray(meta.touches) ? meta.touches : [];
  const exceptions = Array.isArray(meta.worktree_exceptions) ? meta.worktree_exceptions : [];
  const findings = [];

  for (const row of statusRows()) {
    const path = row.path;
    if (isStoryLocal(args.story, path)) continue;
    if (matchesOwned(path, touches)) continue;
    if (exceptionMatches(path, args.stage, exceptions)) continue;
    findings.push(`${row.code} ${path}`);
  }

  if (findings.length) {
    console.error(`[check-story-worktree] FAIL — ${findings.length} dirty path(s) outside story ownership`);
    for (const finding of findings) console.error(`  - ${finding}`);
    process.exit(1);
  }

  console.log(`[check-story-worktree] ok — ${args.story} ${args.stage} worktree owned`);
}

main();
