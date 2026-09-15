#!/usr/bin/env node
// scripts/gate-human-authored.js — pre-commit gate for human-authored class.
//
// Story st_a78848a0. Rejects any commit whose staged file set contains a
// human-authored canonical surface (marker present AND classified in
// canonical-surfaces.json as human-authored) unless a story in
// user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/ declares that
// path in its meta.json.touches array. Open stories authorize
// normal in-flight edits; just-closed stories authorize their final commit so
// the pipeline can close before commit without trapping the operator.
//
// Slot into scripts/pre-commit.sh AFTER check-doc-budget.js, BEFORE gate.js.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// REPO_ROOT is configurable for tests; default = parent of this script.
const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  || resolve(__dirname, '..');

const HUMAN_MARKER_RE = /^<!-- HUMAN-AUTHORED\. REGEN BLOCKED\. -->\s*$/m;
const SURFACES_PATH = process.env.ROBOTDOJO_SURFACES_PATH
  || resolve(REPO_ROOT, 'architecture/surfaces.json');
const STORIES_DIR = PIPELINE_STORIES_DIR;
const TERMINAL_STAGES = new Set(['close-complete', 'done', 'cancelled', 'closed', 'closed-superseded', 'archived', 'absorbed', 'superseded']);
const TERMINAL_KANBANS = new Set(['done', 'cancelled', 'closed', 'closed-superseded', 'archived', 'absorbed']);
const CLOSED_COMMIT_GRACE_MS = 24 * 60 * 60 * 1000;

// ─── Path normalization ──────────────────────────────────────────────────────
// Same logical file via different forms (`~/...`, repo-relative absolute,
// repo-relative) collapses to a single canonical key.
function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  if (isAbsolute(p)) return p;
  return resolve(REPO_ROOT, p);
}

function canonicalKey(p) {
  const abs = expandPath(p);
  if (abs.startsWith(REPO_ROOT + '/')) return abs.slice(REPO_ROOT.length + 1);
  if (abs === REPO_ROOT) return '.';
  if (abs.startsWith(homedir() + '/')) return '~/' + abs.slice(homedir().length + 1);
  return abs;
}

// ─── Load classifications ────────────────────────────────────────────────────
function loadSurfaceClassByKey() {
  if (!existsSync(SURFACES_PATH)) return new Map();
  const raw = JSON.parse(readFileSync(SURFACES_PATH, 'utf8'));
  const byKey = new Map();
  for (const s of raw.surfaces || []) byKey.set(canonicalKey(s.path), s);
  return byKey;
}

// ─── Load authorized story touches ───────────────────────────────────────────
// Walks PIPELINE_STORIES_DIR/*/meta.json, filters to non-terminal stories plus
// stories closed recently enough to be committing their own final diff, returns
// (a) a Map from canonical-key path → story_ids authorizing it, and (b) a Set
// of every authorizing story_id (regardless of whether it touches anything yet — the
// user-facing error message lists these so the user knows where to add a
// touches entry).
function isTerminal(meta) {
  return TERMINAL_STAGES.has(meta.stage) || TERMINAL_KANBANS.has(meta.kanban);
}

function isRecentlyClosed(meta) {
  if (!isTerminal(meta)) return false;
  const stamp = meta.closed_at || meta.updated_at;
  if (!stamp) return false;
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= CLOSED_COMMIT_GRACE_MS;
}

function loadAuthorizedTouches() {
  const authorized = new Map(); // key -> list of authorizing story_ids
  const allAuthorizingStories = new Set();
  if (!existsSync(STORIES_DIR)) return { authorized, allAuthorizingStories };
  for (const dir of readdirSync(STORIES_DIR)) {
    const metaPath = resolve(STORIES_DIR, dir, 'meta.json');
    if (!existsSync(metaPath)) continue;
    let meta;
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); }
    catch { continue; }
    if (isTerminal(meta) && !isRecentlyClosed(meta)) continue;
    allAuthorizingStories.add(meta.story_id || dir);
    const touches = Array.isArray(meta.touches) ? meta.touches : [];
    for (const t of touches) {
      const key = canonicalKey(t);
      if (!authorized.has(key)) authorized.set(key, []);
      authorized.get(key).push(meta.story_id || dir);
    }
  }
  return { authorized, allAuthorizingStories };
}

// ─── Staged files ────────────────────────────────────────────────────────────
function getStagedFiles() {
  // Allow tests to override via env (newline-separated list).
  if (process.env.ROBOTDOJO_STAGED_FILES) {
    return process.env.ROBOTDOJO_STAGED_FILES.split('\n').filter(Boolean);
  }
  let out;
  try {
    out = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    // Outside a git repo or git missing — nothing to check.
    return [];
  }
  return out.split('\n').filter(Boolean);
}

// ─── Marker detection ────────────────────────────────────────────────────────
// A staged file qualifies as human-authored if its CURRENT on-disk content
// carries the marker. (Pre-commit hooks run before commit; on-disk == staged
// for a normal commit. Edge case: rename-only — diff-filter=R surfaces it;
// the underlying file content is the renamed-target's content.)
function fileHasMarker(absPath) {
  try {
    const content = readFileSync(absPath, 'utf8');
    return HUMAN_MARKER_RE.test(content);
  } catch {
    return false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
function main() {
  const staged = getStagedFiles();
  if (staged.length === 0) {
    process.exit(0);
  }

  const surfaces = loadSurfaceClassByKey();
  const { authorized, allAuthorizingStories } = loadAuthorizedTouches();

  const unauthorized = [];

  for (const rel of staged) {
    const abs = expandPath(rel);
    const key = canonicalKey(rel);

    // A file is gated as human-authored if EITHER:
    //   (a) classified human-authored in canonical-surfaces.json, OR
    //   (b) the on-disk content carries the HUMAN-AUTHORED marker.
    // The marker check catches new files being added before they've been
    // registered in canonical-surfaces.json — first-edit defense.
    const surface = surfaces.get(key);
    const classifiedHuman = surface && surface.class === 'human-authored';
    const hasMarker = fileHasMarker(abs);

    if (!classifiedHuman && !hasMarker) continue;

    if (authorized.has(key)) continue; // authorized — proceed

    unauthorized.push({ key, classifiedHuman, hasMarker });
  }

  if (unauthorized.length === 0) {
    process.exit(0);
  }

  process.stderr.write(
    `\n[gate-human-authored] BLOCKED: ${unauthorized.length} human-authored canonical surface(s) staged without an authorizing story.\n\n`,
  );
  for (const u of unauthorized) {
    const why = u.classifiedHuman
      ? 'classified human-authored'
      : 'carries HUMAN-AUTHORED marker';
    process.stderr.write(`  - ${u.key} (${why})\n`);
  }
  process.stderr.write(
    `\nTo authorize: add the path(s) to user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/<story_id>/meta.json "touches" array of an open story, or commit a just-closed story within 24h.\n`,
  );
  if (allAuthorizingStories.size > 0) {
    process.stderr.write(`Currently authorizing stories: ${[...allAuthorizingStories].join(', ')}\n`);
  } else {
    process.stderr.write(`No open or just-closed stories found in ${STORIES_DIR}.\n`);
  }
  process.stderr.write('\n');
  process.exit(1);
}

main();
