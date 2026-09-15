#!/usr/bin/env node
// scripts/migrate-code-out-of-workbench.js — st_862d73d1 AC13/AC14.
//
// Relocate every foreign git repo living inside a workbench subtree to the
// parallel ~/code/{t1}/{t2} tree, leaving a LINKED-SOURCES.md pointer behind.
// Migrations are DISCOVERED from disk (no hardcoded project names) by walking
// user/workbenches/topics for nested .git dirs under any wk_* subtree — the same
// detection check-workbench-tree-clean.js uses.
//
// The procedure is DATA-SAFE — COPY → VERIFY → DELETE, never move:
//   (a) record the SOURCE head + remote. No remote → HALT for that repo, leave
//       it fully intact (never a destructive move without a verified remote).
//   (b) COPY the whole repo dir INCLUDING .git to the target. Source untouched.
//   (c) VERIFY target head === source head AND target remote === source remote.
//   (d) ONLY after both verifications pass: write the pointer, then DELETE source.
//   On any failure: HALT, remove the incomplete target, leave the source intact.
//
// Usage:
//   node scripts/migrate-code-out-of-workbench.js --plan      # list discovered migrations
//   node scripts/migrate-code-out-of-workbench.js --run       # run every discovered migration
//   node scripts/migrate-code-out-of-workbench.js --source <abs> --target <abs> [--remote-name origin]
//
// Exit 0 = all migrated (or HALTED-safe with source intact); exit 1 = a real
// error left the tree unexpected (failures HALT safe and report).

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, basename, relative } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  ? process.env.ROBOTDOJO_REPO_ROOT
  : join(homedir(), 'robotdojo');
const TOPICS_ROOT = join(REPO_ROOT, 'user', 'workbenches', 'topics');
const CODE_ROOT = process.env.ROBOTDOJO_CODE_ROOT
  ? process.env.ROBOTDOJO_CODE_ROOT
  : join(homedir(), 'code');

function git(dir, ...args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}
function gitHead(dir) {
  const r = git(dir, 'rev-parse', 'HEAD');
  return r.status === 0 ? r.stdout.trim() : null;
}
function gitRemote(dir, name = 'origin') {
  const r = git(dir, 'remote', 'get-url', name);
  return r.status === 0 ? r.stdout.trim() : null;
}
function isGitRepo(dir) {
  return existsSync(join(dir, '.git'));
}
function safeReaddir(d) { try { return readdirSync(d); } catch { return []; } }
function isDir(p) { try { return lstatSync(p).isDirectory(); } catch { return false; } }

// Discover foreign-repo migrations: for each wk_* subtree (under a 2-segment
// topic path topics/{t1}/{t2}/), find the dirs that ARE git repos and derive the
// mirrored ~/code/{t1}/{t2}/{repoName} target.
export function discoverMigrations(topicsRoot = TOPICS_ROOT, codeRoot = CODE_ROOT) {
  const out = [];
  if (!existsSync(topicsRoot)) return out;
  for (const t1 of safeReaddir(topicsRoot)) {
    const t1Abs = join(topicsRoot, t1);
    if (!isDir(t1Abs)) continue;
    for (const t2 of safeReaddir(t1Abs)) {
      const t2Abs = join(t1Abs, t2);
      if (!isDir(t2Abs)) continue;
      // Find each wk_* under this t2, then every nested git repo within it.
      for (const wk of safeReaddir(t2Abs)) {
        if (!wk.startsWith('wk_')) continue;
        const wkAbs = join(t2Abs, wk);
        if (!isDir(wkAbs)) continue;
        for (const repoDir of findGitRepos(wkAbs)) {
          out.push({
            source: repoDir,
            target: join(codeRoot, t1, t2, basename(repoDir)),
            t1, t2,
          });
        }
      }
    }
  }
  return out;
}

// Find every directory that contains a `.git` (a foreign repo root) beneath root.
// Does not descend into a repo once found (the whole repo migrates as a unit).
function findGitRepos(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (dir !== root && isGitRepo(dir)) { found.push(dir); continue; }
    for (const child of safeReaddir(dir)) {
      if (child === '.git') continue;
      const childAbs = join(dir, child);
      if (isDir(childAbs)) stack.push(childAbs);
    }
  }
  return found;
}

/**
 * migrateOne({ source, target, remoteName }) → result.
 * result.status ∈ { 'migrated', 'halted', 'error' } with a `reason`. Pure of
 * process.exit so tests can assert each branch.
 */
export function migrateOne({ source, target, remoteName = 'origin', linkLabel }) {
  if (!existsSync(source)) return { status: 'error', reason: `source does not exist: ${source}` };
  if (!isGitRepo(source)) return { status: 'error', reason: `source is not a git repo (no .git): ${source}` };

  // (a) Record source head + remote. No remote → HALT, source untouched.
  const srcHead = gitHead(source);
  const srcRemote = gitRemote(source, remoteName);
  if (!srcHead) return { status: 'error', reason: `cannot read source HEAD: ${source}` };
  if (!srcRemote) {
    return {
      status: 'halted',
      reason: `source has no '${remoteName}' remote — HALTED, source left intact, target not created`,
      srcHead, source, target,
    };
  }

  if (existsSync(target)) return { status: 'error', reason: `target already exists: ${target}` };

  // (b) COPY the whole dir INCLUDING .git. Source remains untouched.
  mkdirSync(dirname(target), { recursive: true });
  const cp = spawnSync('cp', ['-a', source, target], { encoding: 'utf8' });
  if (cp.status !== 0) {
    try { rmSync(target, { recursive: true, force: true }); } catch {}
    return { status: 'error', reason: `copy failed: ${cp.stderr || cp.stdout}` };
  }

  // (c) VERIFY target head === source head AND target remote === source remote.
  const tgtHead = gitHead(target);
  const tgtRemote = gitRemote(target, remoteName);
  if (tgtHead !== srcHead || tgtRemote !== srcRemote) {
    try { rmSync(target, { recursive: true, force: true }); } catch {}
    return {
      status: 'error',
      reason: `target verification failed (head ${tgtHead} vs ${srcHead}, remote mismatch ${tgtRemote !== srcRemote}) — partial target removed, source intact`,
      srcHead, tgtHead, source, target,
    };
  }

  // (d) Both verifications passed → write the pointer, then DELETE the source.
  writePointer(source, target, srcRemote, srcHead, linkLabel);
  try {
    rmSync(source, { recursive: true, force: true });
  } catch (e) {
    return { status: 'error', reason: `source delete failed after verified copy: ${e.message} — target good at ${target}` };
  }
  return { status: 'migrated', reason: 'verified copy → delete', source, target, srcHead, srcRemote, tgtHead };
}

// Leave a LINKED-SOURCES.md pointer in the workbench where the repo lived (the
// source's PARENT dir — the source dir itself is deleted).
function writePointer(source, target, remote, head, linkLabel) {
  const parent = dirname(source);
  const name = linkLabel || basename(source);
  const pointerPath = join(parent, 'LINKED-SOURCES.md');
  const block = [
    `## ${name}`,
    '',
    `- Code lives at: \`${target}\``,
    `- Remote: ${remote}`,
    `- Head at migration: ${head}`,
    `- Relocated by st_862d73d1 (code-out-of-workbenches). The workbench holds only this pointer + the agent's own notes; no code or PII remains here.`,
    '',
  ].join('\n');
  if (existsSync(pointerPath)) {
    const prev = readFileSync(pointerPath, 'utf8');
    if (!prev.includes(`## ${name}`)) writeFileSync(pointerPath, prev.replace(/\n*$/, '\n\n') + block);
  } else {
    writeFileSync(pointerPath, '# Linked sources\n\nForeign repos relocated to the parallel `~/code` tree (st_862d73d1).\n\n' + block);
  }
}

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--source') a.source = argv[++i];
    else if (argv[i] === '--target') a.target = argv[++i];
    else if (argv[i] === '--remote-name') a.remoteName = argv[++i];
    else if (argv[i] === '--plan') a.plan = true;
    else if (argv[i] === '--run') a.run = true;
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  if (a.plan) {
    const migs = discoverMigrations();
    if (migs.length === 0) { console.log('[migrate] no foreign repos under any workbench subtree.'); process.exit(0); }
    for (const m of migs) console.log(`${relative(REPO_ROOT, m.source)}\n  → ${m.target}`);
    process.exit(0);
  }
  if (a.run) {
    const migs = discoverMigrations();
    let anyError = false;
    for (const m of migs) {
      const r = migrateOne(m);
      console.log(`[migrate] ${r.status}: ${relative(REPO_ROOT, m.source)} → ${m.target}\n          ${r.reason}`);
      if (r.status === 'error') anyError = true;
    }
    process.exit(anyError ? 1 : 0);
  }
  if (!a.source || !a.target) {
    console.error('Usage: migrate-code-out-of-workbench.js (--plan | --run | --source <abs> --target <abs> [--remote-name origin])');
    process.exit(1);
  }
  const r = migrateOne({ source: a.source, target: a.target, remoteName: a.remoteName });
  console.log(`[migrate] ${r.status}: ${r.reason}`);
  process.exit(r.status === 'error' ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
