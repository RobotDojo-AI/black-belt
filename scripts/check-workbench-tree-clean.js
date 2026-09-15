#!/usr/bin/env node
import { existsSync, readdirSync, lstatSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fail } from './frontend-workbench-lib.js';
import { scanWorkbenchesFromDisk } from '../lib/workbenches.js';

const repoRoot = process.cwd();
const errors = [];

const scan = scanWorkbenchesFromDisk(repoRoot);
if (scan.strays.length) {
  errors.push(`duplicate workbench-id strays remain: ${scan.strays.join(', ')}`);
}

const topicsRoot = resolve(repoRoot, 'user/workbenches/topics');
if (existsSync(topicsRoot)) {
  walk(topicsRoot, []);
}

const contextsRoot = resolve(repoRoot, 'user/contexts/topics');
if (existsSync(contextsRoot)) {
  for (const name of readdirSync(contextsRoot)) {
    if (name.startsWith('wk_')) errors.push(`stale workbench-id topic context remains: user/contexts/topics/${name}`);
    if (name === 'maint-new-topic') errors.push('maintenance topic context remains: user/contexts/topics/maint-new-topic');
  }
}

fail(errors);

function walk(absPath, segments) {
  const base = basename(absPath);
  if (base.startsWith('wk_') && segments.length >= 2) {
    const children = safeReaddir(absPath);
    for (const child of children) {
      const childAbs = join(absPath, child);
      if (safeIsDirectory(childAbs) && child.startsWith('wk_')) {
        errors.push(`nested workbench scaffold remains: ${relative(repoRoot, childAbs)}`);
      }
    }
    // st_862d73d1 AC12 — reject any nested foreign git repo ANYWHERE under this
    // wk_* subtree, not just under substrate/ (a second live .git existed under
    // wk_health/renderings/). Code and bulk PII must live in the parallel ~/code
    // tree; a workbench holds only pointers + the agent's own notes.
    for (const gitDir of findNestedGitDirs(absPath)) {
      errors.push(`foreign git repo under workbench subtree: ${relative(repoRoot, gitDir)} — relocate the repo to ~/code and leave a LINKED-SOURCES.md pointer (st_862d73d1 AC12/AC14)`);
    }
    return;
  }
  for (const child of safeReaddir(absPath)) {
    const childAbs = join(absPath, child);
    if (!safeIsDirectory(childAbs)) continue;
    if (segments.length === 0 && child === 'maint-new-topic') {
      errors.push('maintenance workbench fixture remains: user/workbenches/topics/maint-new-topic');
      continue;
    }
    walk(childAbs, [...segments, child]);
  }
}

// Recursively find every nested `.git` (dir OR file — a submodule/worktree uses
// a `.git` file) anywhere beneath a wk_* subtree. Returns absolute paths.
function findNestedGitDirs(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const child of safeReaddir(dir)) {
      const childAbs = join(dir, child);
      if (child === '.git') {
        found.push(childAbs); // .git dir or .git file — both signal a foreign repo
        continue;
      }
      if (safeIsDirectory(childAbs)) stack.push(childAbs);
    }
  }
  return found;
}

function safeReaddir(absPath) {
  try { return readdirSync(absPath); } catch { return []; }
}

function safeIsDirectory(absPath) {
  try { return lstatSync(absPath).isDirectory(); } catch { return false; }
}
