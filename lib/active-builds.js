// active-builds.js — lightweight per-session build-claim log.
//
// Purpose: coordinate concurrent Claude sessions on the same robotdojo checkout
// so one terminal's bare `git commit` / `git add -A` doesn't scoop another
// terminal's in-progress WIP. Append-only JSONL at pipeline/active-builds.jsonl
// (gitignored). Each session claims a story on build start and releases on
// close complete (or on explicit shutdown).
//
// Schema (one JSON object per line):
//   {
//     "story_id": "st_xxxxxxx",
//     "session_id": "<uuid or pid+hostname>",
//     "started_at": "<ISO timestamp>",
//     "released_at": null | "<ISO timestamp>",
//     "files": ["scripts/X.js", "tests/Y.test.js"]  // optional scope hint
//   }
//
// Reads scan the file forward and consider an entry ACTIVE if released_at is
// null and started_at is < 24h ago (stale claims auto-expire to avoid orphans).
//
// Why a JSONL append-only log instead of a database row: zero install cost,
// idempotent on partial writes, easy to inspect with `cat`, and survives any
// crash because writes are line-atomic. No mutex needed — concurrent appends
// from different sessions interleave cleanly because each line is fully
// written by one writev syscall.
//
// Source: st_64d21872 build extension after the commit-scoop pattern recurred
// (st_4e6e2ea9, st_cfb2859e). Owner intent: stop the failure mode where
// concurrent sessions silently overwrite each other's work.

import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { PIPELINE_ACTIVE_BUILDS_PATH } from './robotdojo-paths.js';

const LOG_PATH = PIPELINE_ACTIVE_BUILDS_PATH;

// Stale-claim threshold. After this many milliseconds with no release_at, the
// claim is considered abandoned (session crashed, agent killed, etc.) and
// excluded from active scans. 24h is generous enough for an overnight run.
const STALE_MS = 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Append a new build claim. Returns the claim object for later reference.
 *
 * `session_id` defaults to `${process.pid}@${hostname}` — unique per CLI
 * invocation. Pass an explicit value if a session needs a deterministic ID.
 */
export function claimBuild({ story_id, session_id, files = [] } = {}) {
  if (!story_id) throw new Error('claimBuild requires story_id');
  const claim = {
    story_id,
    session_id: session_id ?? `${process.pid}@${process.env.HOSTNAME || 'localhost'}`,
    started_at: nowIso(),
    released_at: null,
    files,
  };
  appendFileSync(LOG_PATH, JSON.stringify(claim) + '\n');
  return claim;
}

/**
 * Release a build claim by appending a release record. We do NOT mutate
 * existing lines — append-only — so the audit trail is preserved. The reader
 * pairs the latest claim with the latest release for each (story_id, session_id).
 */
export function releaseBuild({ story_id, session_id }) {
  if (!story_id) throw new Error('releaseBuild requires story_id');
  const sid = session_id ?? `${process.pid}@${process.env.HOSTNAME || 'localhost'}`;
  const record = {
    story_id,
    session_id: sid,
    released_at: nowIso(),
  };
  appendFileSync(LOG_PATH, JSON.stringify(record) + '\n');
  return record;
}

/**
 * Release EVERY active claim for a story across ALL sessions (st_a5baa72c AC5).
 *
 * A story accrues claims under multiple session_ids (intake writes one with the
 * intake pid, plan approval another). `releaseBuild` keys on
 * (story_id, session_id) and defaults session_id to the CURRENT pid, so it
 * cannot release a claim made by a different pid. This iterates the active
 * claims for the story and appends a release record for each distinct
 * session_id, so a story's own in-flight claims are fully cleared at seal/commit
 * and never block its own (or a later) commit. Returns the released session_ids.
 */
export function releaseAllForStory(story_id) {
  if (!story_id) throw new Error('releaseAllForStory requires story_id');
  const sessions = [
    ...new Set(activeBuilds().filter((r) => r.story_id === story_id).map((r) => r.session_id)),
  ];
  for (const session_id of sessions) {
    releaseBuild({ story_id, session_id });
  }
  return sessions;
}

/**
 * Read the log and return the set of (story_id, session_id) pairs that are
 * currently active. A claim is active if:
 *   - the latest record for that (story_id, session_id) is a claim
 *     (released_at: null), AND
 *   - the claim is not stale (started_at within STALE_MS).
 */
export function activeBuilds() {
  if (!existsSync(LOG_PATH)) return [];
  const lines = readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
  // Map "${story_id}|${session_id}" -> latest record.
  const latest = new Map();
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.story_id || !rec.session_id) continue;
    const key = `${rec.story_id}|${rec.session_id}`;
    latest.set(key, rec);
  }
  const now = Date.now();
  const active = [];
  for (const rec of latest.values()) {
    if (rec.released_at) continue;
    if (!rec.started_at) continue;
    const started = Date.parse(rec.started_at);
    if (isNaN(started)) continue;
    if (now - started > STALE_MS) continue;
    active.push(rec);
  }
  return active;
}

/**
 * Given an array of staged file paths (relative to repo root or absolute),
 * return the subset that are claimed by ANOTHER session's active build.
 * Used by the pre-commit gate to warn before scooping concurrent work.
 *
 * Matching is conservative: we compare file basename and parent-dir, so
 * "scripts/check-X.js" in this session's staged list will match an active
 * claim that listed "scripts/check-X.js" or just "check-X.js".
 */
export function findForeignStagedFiles({ stagedPaths, ownSessionId, storyId }) {
  const sid = ownSessionId ?? `${process.pid}@${process.env.HOSTNAME || 'localhost'}`;
  // A claim is "foreign" only if it belongs to ANOTHER session AND a DIFFERENT
  // story. The session_id filter alone was the bug (st_a5baa72c AC5): the
  // committing git-hook runs as a NEW pid, so its session_id never matches the
  // pid that wrote the story's own claim at intake/plan — so a story reliably
  // blocked its own commit. Excluding same-story_id claims fixes it: a claim on
  // story X must never block a commit FOR story X. The session_id exclusion is
  // kept as the fallback for callers that pass no storyId. The real target of
  // this gate is CROSS-story scooping (terminal A on story X scooping terminal
  // B's story-Y WIP), which the story_id exclusion preserves.
  const others = activeBuilds().filter((r) => {
    if (r.session_id === sid) return false;
    if (storyId && r.story_id === storyId) return false;
    return true;
  });
  if (others.length === 0) return [];
  const foreignFiles = new Set();
  for (const claim of others) {
    for (const f of claim.files || []) foreignFiles.add(f);
  }
  const matches = [];
  for (const staged of stagedPaths) {
    if (foreignFiles.has(staged)) {
      matches.push({ staged, claimed_by: 'another active build' });
      continue;
    }
    // Loose match on basename for paths normalized differently.
    const base = staged.split('/').pop();
    for (const f of foreignFiles) {
      if (f.split('/').pop() === base) {
        matches.push({ staged, claimed_by: `another session's claim ${f}` });
        break;
      }
    }
  }
  return matches;
}
