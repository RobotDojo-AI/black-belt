#!/usr/bin/env node
/**
 * scripts/check-session-conflicts.js — st_8745309c AC5.
 *
 * Reads the session registry, surveys the worktree state of each live
 * session, and prints "START" or "WARN: <reason>" advice for the operator.
 *
 * Never blocks. Never exits non-zero. The whole point of this script is to
 * surface information; the owner decides what to do with it.
 *
 * Pure coordination — no LLM, no DB, no INTELLIGENCE_TIER declaration
 * needed (matches the build-conventions "extraction/synthesis/orchestration"
 * tier protocol only when LLMs are involved).
 *
 * CLI:
 *   check-session-conflicts.js [--story <id>] [--verbose]
 *
 * Exit:
 *   0 — always. The output text encodes the state.
 *
 * Output format:
 *   "START — no conflicts detected"
 *   "WARN: <reason1>; <reason2>; ..."
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { activeSessions } from '../lib/session-registry.js';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

function parseArgs(argv) {
  const out = { story: null, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--story' && argv[i + 1]) { out.story = argv[++i]; }
    else if (argv[i] === '--verbose') { out.verbose = true; }
  }
  return out;
}

function loadStoryMeta(storyId) {
  if (!storyId) return null;
  const metaPath = join(PIPELINE_STORIES_DIR, storyId, 'meta.json');
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

function isDirtyWorktree(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return false;
  const r = spawnSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (r.status !== 0) return false;
  return r.stdout.trim().length > 0;
}

function intersectFiles(touchesA, touchesB) {
  if (!Array.isArray(touchesA) || !Array.isArray(touchesB)) return [];
  const setB = new Set(touchesB);
  return touchesA.filter(f => setB.has(f));
}

function main() {
  const args = parseArgs(process.argv);
  const reasons = [];

  // Live sessions from the registry (already pruned of dead entries).
  const sessions = activeSessions();
  const myPid = process.pid;
  const others = sessions.filter(s => s.pid !== myPid);

  // 1. Dirty-worktree check — any live session with a dirty worktree gets
  //    surfaced. Pre-plan check, always available.
  for (const s of others) {
    if (s.worktree_path && isDirtyWorktree(s.worktree_path)) {
      const label = s.label || s.session_id.slice(-6);
      const sid = s.story_id || 'idle';
      reasons.push(`session [${label}] has dirty worktree at ${s.worktree_path} (story=${sid})`);
    }
  }

  // 2. File-overlap check — sharpens once the target story has meta.touches.
  if (args.story) {
    const myMeta = loadStoryMeta(args.story);
    const myTouches = myMeta && Array.isArray(myMeta.touches) ? myMeta.touches : [];
    if (myTouches.length > 0) {
      for (const s of others) {
        if (!s.story_id) continue;
        // Try to load the other session's story.meta.touches (post-plan).
        const otherMeta = loadStoryMeta(s.story_id);
        const otherTouches = otherMeta && Array.isArray(otherMeta.touches) ? otherMeta.touches : [];
        // Combine the registry's per-session files[] with the other story's
        // declared touches — either signal a possible file collision.
        const otherActive = [...new Set([...otherTouches, ...(s.files || [])])];
        const overlap = intersectFiles(myTouches, otherActive);
        if (overlap.length > 0) {
          const label = s.label || s.session_id.slice(-6);
          reasons.push(`file overlap with [${label}] (story=${s.story_id}): ${overlap.slice(0, 5).join(', ')}${overlap.length > 5 ? '…' : ''}`);
        }
      }
    } else if (myMeta) {
      // Coarse warning: target story has no touches[] yet (pre-plan).
      // Surface other live sessions running a story so the operator at
      // least sees them.
      const livePeers = others.filter(s => s.story_id);
      if (livePeers.length > 0) {
        const list = livePeers.map(s => `[${s.label || s.session_id.slice(-6)}]:${s.story_id}`).join(', ');
        reasons.push(`other active sessions running stories (pre-plan, no precise overlap yet): ${list}`);
      }
    }
  }

  if (reasons.length === 0) {
    process.stdout.write('START — no conflicts detected\n');
  } else {
    process.stdout.write(`WARN: ${reasons.join('; ')}\n`);
  }

  if (args.verbose) {
    process.stderr.write(`\nsessions: ${sessions.length} live (self=${myPid})\n`);
    for (const s of sessions) {
      process.stderr.write(`  [${s.label}] pid=${s.pid} story=${s.story_id || '-'} worktree=${s.worktree_path || '-'}\n`);
    }
  }

  process.exit(0);
}

main();
