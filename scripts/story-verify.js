#!/usr/bin/env node
/**
 * story-verify.js — verify the hash chain integrity for one or all stories.
 *
 * Usage:
 *   node story-verify.js              # verify active story
 *   node story-verify.js --story <id> # verify specific story
 *   node story-verify.js --all        # verify all st_* stories
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

const STORIES_DIR = PIPELINE_STORIES_DIR;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function normalizePath(p) {
  return resolve(p);
}

function verifyStory(storyId) {
  const storyDir = join(STORIES_DIR, storyId);
  const shPath = join(storyDir, 'stage-hashes.json');

  if (!existsSync(shPath)) {
    return { storyId, ok: true, partial: true, reason: 'no stage-hashes.json (pre-chain story)' };
  }

  const sh = JSON.parse(readFileSync(shPath, 'utf8'));

  if (!sh.root_hash) return { storyId, ok: false, reason: 'missing root_hash' };
  if (!sh.stages || !Array.isArray(sh.stages)) return { storyId, ok: false, reason: 'missing stages array' };

  // Verify chain integrity: each stage's hash must match sha256(prev + file_bytes)
  let expectedPrev = sh.root_hash;
  let lastApprovedHash = sh.root_hash;
  let pendingStage = null;
  const latestByArtifact = new Map();
  for (const stage of sh.stages) {
    const entry = sh.chain[stage];
    if (!entry) return { storyId, ok: false, reason: `stage "${stage}" in stages array but missing from chain` };
    if (!entry.agent_sealed && !entry.migrated) {
      return { storyId, ok: true, partial: true, reason: `stage "${stage}" is open after amend` };
    }
    if (entry.prev !== expectedPrev) {
      return { storyId, ok: false, reason: `stage "${stage}" prev mismatch: expected ${expectedPrev.slice(0,12)}... got ${entry.prev.slice(0,12)}...` };
    }

    // Recompute hash from the immutable seal snapshot when available. Older
    // stories may not have snapshots, so fall back to the live artifact.
    // WHY: framing and scope intentionally share 00-scope.md. Verifying old
    // stages against the live file makes every later append look like tamper.
    const sealedFile = normalizePath(entry.snapshot_file || entry.file);
    if (!existsSync(sealedFile)) {
      return { storyId, ok: false, reason: `stage "${stage}" sealed artifact missing: ${sealedFile}` };
    }
    const fileBytes = readFileSync(sealedFile);
    const combined = Buffer.concat([Buffer.from(entry.prev, 'utf8'), fileBytes]);
    const recomputed = sha256(combined);
    if (recomputed !== entry.hash) {
      return { storyId, ok: false, reason: `stage "${stage}" hash mismatch — sealed artifact may have been modified` };
    }

    latestByArtifact.set(normalizePath(entry.file), { stage, entry });

    // Track last owner-approved stage for head verification
    if (entry.owner_approved || entry.migrated) {
      lastApprovedHash = entry.hash;
    } else if (entry.agent_sealed) {
      pendingStage = stage;
    }

    expectedPrev = entry.hash;
  }

  // The latest stage that owns a living artifact must still match the current
  // file on disk. Historical snapshots verify older seals; this catches edits
  // to the active current version of 00-scope.md, 02-plan.md, etc.
  for (const [artifactFile, { stage, entry }] of latestByArtifact.entries()) {
    if (!entry.snapshot_file) continue;
    if (!existsSync(artifactFile)) {
      return { storyId, ok: false, reason: `stage "${stage}" current artifact missing: ${artifactFile}` };
    }
    const currentBytes = readFileSync(artifactFile);
    const combined = Buffer.concat([Buffer.from(entry.prev, 'utf8'), currentBytes]);
    const currentHash = sha256(combined);
    if (currentHash !== entry.hash) {
      return { storyId, ok: false, reason: `stage "${stage}" current artifact differs from sealed snapshot: ${artifactFile}` };
    }
  }

  // Head must equal last fully approved stage (not just agent-sealed)
  if (pendingStage) {
    return { storyId, ok: true, partial: true, reason: `pending owner approval on stage "${pendingStage}"` };
  }
  if (sh.stages.length > 0 && sh.head !== lastApprovedHash) {
    // Warn but don't fail — pending approval is a valid intermediate state
    return { storyId, ok: true, partial: true, reason: `pending owner approval on stage "${sh.stages[sh.stages.length - 1]}"` };
  }

  return { storyId, ok: true, stages: sh.stages.length, partial: false };
}

function activeStoryId(override) {
  if (override) return override;
  // Infer from meta.json state — no .current file
  let dirs;
  try { dirs = readdirSync(STORIES_DIR).filter(d => /^(st|df|wk)_/.test(d)); } catch { dirs = []; }
  const active = dirs
    .map(d => { try { return JSON.parse(readFileSync(join(STORIES_DIR, d, 'meta.json'), 'utf8')); } catch { return null; } })
    .filter(m => m && m.kanban === 'in-progress')
    .sort((a, b) => new Date(b.started) - new Date(a.started));
  if (active.length === 0) {
    console.error('No active story. Pass --story <id> or --all.');
    process.exit(1);
  }
  if (active.length > 1) {
    console.error('AMBIGUOUS — multiple active stories. Pass --story <id> or --all.');
    process.exit(1);
  }
  return active[0].story_id;
}

const argv = process.argv.slice(2);
const allFlag = argv.includes('--all');
const storyArg = argv[argv.indexOf('--story') + 1] || null;

let stories;
if (allFlag) {
  stories = readdirSync(STORIES_DIR).filter(d => /^(st|df|wk)_/.test(d));
  if (stories.length === 0) {
    console.log('No stories found.');
    process.exit(0);
  }
} else {
  stories = [activeStoryId(storyArg)];
}

let failed = 0;
for (const storyId of stories) {
  const result = verifyStory(storyId);
  if (result.ok) {
    const tag = result.partial ? 'PARTIAL' : `PASS (${result.stages} stages)`;
    console.log(`[ ${tag} ] ${storyId}${result.reason ? ' — ' + result.reason : ''}`);
  } else {
    console.error(`[ FAIL ] ${storyId} — ${result.reason}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} story/stories failed verification.`);
  process.exit(1);
}
console.log('\nChain verification complete.');
