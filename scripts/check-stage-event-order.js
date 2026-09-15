#!/usr/bin/env node
/**
 * check-stage-event-order.js — st_43221114 AC 14.
 *
 * Verifies the Merkle-chained stage-events.jsonl trail for a story+stage.
 *
 * Chain semantics — ONE chain per events.jsonl (NOT one per stage). Mirrors
 * the memory-log construction: every line is linked to the previous line in
 * the file by `prev_event_hash = SHA256(previous_line_bytes)`. The very first
 * line of the file uses `prev_event_hash = SHA256(storyId + ':' + stage)`
 * where `stage` is the FIRST line's stage (the file's genesis). Subsequent
 * lines — even those starting a new stage — chain from the prior line's
 * bytes, not from a per-stage root. This matches `lib/stage-events.js`
 * emit semantics exactly.
 *
 * The script performs three passes:
 *   (1) Chain integrity: walk all lines; each `prev_event_hash` must equal
 *       SHA256 of the previous line's verbatim bytes (genesis anchor for
 *       line 1 — `SHA256("{storyId}:{firstLineStage}")`).
 *   (2) Required event presence: filter to events matching the `--stage`
 *       parameter and verify the three Bunshin-QC-evidence events are present:
 *         bunshin_spawned, bunshin_returned, seal_requested
 *       (st_862d73d1: print_to_owner_rendered was REMOVED from the required set —
 *       it is a presentation event, not Bunshin-QC evidence, and the seal path
 *       never emits it, so requiring it blocked every real seal. Presentation
 *       shape is enforced separately by check-stage-presentation-contract.js.)
 *   (2b) Bunshin events carry a non-empty `subagent_return_id` (st_862d73d1):
 *       the binding to the real spawned context's return. A spawn/return event
 *       with no return id is not evidence a context actually ran.
 *   (3) Canonical ordering within the filtered subset: bunshin_spawned
 *       BEFORE bunshin_returned BEFORE seal_requested.
 *   (4) Timestamp monotonicity within the filtered subset.
 *
 * Forgery resistance: backdating any event would require rewriting every
 * downstream prev_event_hash (and the lines they're computed from). A
 * single-line mutation breaks the chain — surface as `BLOCKED — chain
 * integrity broken at line N`.
 *
 * Usage:
 *   node check-stage-event-order.js --story <storyId> --stage <stage>
 *   node check-stage-event-order.js --file <path-to-stage-events.jsonl> --stage <stage> --story <storyId>
 *
 * Exit 0 = chain valid; exit 1 = chain forged, order violated, or required
 * events missing for the requested stage.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag.startsWith('--')) out[flag.slice(2)] = argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(`BLOCKED — ${msg}`);
  process.exit(1);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const args = parseArgs(process.argv);
const stage = args.stage;
const storyId = args.story;
if (!stage) fail('--stage <stage> required');
if (!storyId) fail('--story <storyId> required');

const storiesBase = PIPELINE_STORIES_DIR;
const eventsPath = args.file ?? join(storiesBase, storyId, 'stage-events.jsonl');

if (!existsSync(eventsPath)) {
  fail(`stage-events.jsonl missing for story ${storyId}: ${eventsPath}`);
}

const buf = readFileSync(eventsPath);
const text = buf.toString('utf8');
// Emitter writes `JSON.stringify(entry) + '\n'` and hashes the trimmed line
// (no trailing newline). Split on '\n' and drop empty entries.
const lines = text.split('\n').filter(l => l.trim().length > 0);

if (lines.length === 0) {
  fail(`stage-events.jsonl empty for ${storyId}/${stage}: ${eventsPath}`);
}

// Parse all lines first so we can determine the genesis stage from line 1.
const parsed = [];
for (let i = 0; i < lines.length; i++) {
  try {
    parsed.push(JSON.parse(lines[i]));
  } catch (e) {
    fail(`chain integrity broken at line ${i + 1} — not valid JSON: ${e.message}`);
  }
}

// Pass 1: chain integrity across ALL lines (one chain per file).
// Genesis anchor uses line 1's stage — matches lib/stage-events.js where the
// first emitter call computes `rootHash(storyId, stage)` from whatever stage
// it was given (line 1's stage, by definition).
const genesisStage = parsed[0].stage;
const rootHash = sha256(`${storyId}:${genesisStage}`);
let prevLineBytes = null;
for (let i = 0; i < lines.length; i++) {
  const entry = parsed[i];
  const expected = prevLineBytes === null ? rootHash : sha256(prevLineBytes);
  if (entry.prev_event_hash !== expected) {
    const why = prevLineBytes === null
      ? `root hash for ${storyId}:${genesisStage}`
      : `sha256 of line ${i}`;
    fail(
      `chain integrity broken at line ${i + 1} — prev_event_hash=` +
      `${(entry.prev_event_hash ?? 'MISSING').slice(0, 12)}... expected ` +
      `${expected.slice(0, 12)}... (${why})`
    );
  }
  prevLineBytes = lines[i];
}

// Pass 2: required events present for the requested stage. The required,
// ordered set is exactly the Bunshin-QC-evidence chain (st_862d73d1):
//   bunshin_spawned → bunshin_returned → seal_requested
const stageEvents = parsed.filter(e => e.stage === stage);
const REQUIRED = ['bunshin_spawned', 'bunshin_returned', 'seal_requested'];

const idxFor = (name) => stageEvents.findIndex(e => e.event === name);
const missing = REQUIRED.filter(r => idxFor(r) === -1);
if (missing.length > 0) {
  fail(`missing required event(s) for ${storyId}/${stage}: ${missing.join(', ')}`);
}

// Pass 3: canonical ordering, anchored on the LATEST seal attempt (st_862d73d1
// retry-hygiene fix). A failed --seal still appends a `seal_requested` before the
// gate blocks, so a retry leaves a stale `seal_requested` earlier in the trail.
// Anchoring on the FIRST occurrence would fail forever once that happened. Anchor
// on the LAST `seal_requested` instead and require it be preceded by a
// `bunshin_returned`, itself preceded by a `bunshin_spawned`. Stale earlier
// seal_requesteds from blocked attempts are correctly ignored; a real
// spawn→return→seal sequence for the current attempt still passes.
const lastIdxFor = (name) => {
  for (let i = stageEvents.length - 1; i >= 0; i--) if (stageEvents[i].event === name) return i;
  return -1;
};
const sealIdx = lastIdxFor('seal_requested');
let returnIdx = -1;
for (let i = sealIdx - 1; i >= 0; i--) if (stageEvents[i].event === 'bunshin_returned') { returnIdx = i; break; }
let spawnIdx = -1;
for (let i = returnIdx - 1; i >= 0; i--) if (stageEvents[i].event === 'bunshin_spawned') { spawnIdx = i; break; }
if (sealIdx === -1 || returnIdx === -1 || spawnIdx === -1) {
  fail(
    `ordering violation in ${storyId}/${stage}: the latest 'seal_requested' (idx=${sealIdx}) must be ` +
    `preceded by 'bunshin_returned' (idx=${returnIdx}) preceded by 'bunshin_spawned' (idx=${spawnIdx}). ` +
    `Bunshin must be spawned and returned before the seal is requested.`
  );
}

// Pass 2b: the Bunshin spawn/return events in the ANCHORED CHAIN must carry a
// non-empty subagent_return_id (st_862d73d1) — the binding to the real spawned
// context's return. Without it, the trail proves nothing was ever spawned.
// Uses the same spawnIdx/returnIdx computed by Pass 3 so that stale events from
// retry attempts (which may have no subagent_return_id) do not poison the check.
// (Honest limit: this proves a context ran and returned a verdict bound to these
// bytes, NOT that the context reasoned well — the achievable ceiling per scope OOS-2.)
for (const [name, idx] of [['bunshin_spawned', spawnIdx], ['bunshin_returned', returnIdx]]) {
  const ev = stageEvents[idx];
  if (ev && (!ev.subagent_return_id || String(ev.subagent_return_id).trim() === '')) {
    fail(
      `'${name}' for ${storyId}/${stage} has no subagent_return_id — a Bunshin ` +
      `spawn/return event must bind the real returning context's identifier.`
    );
  }
}

// Pass 4: timestamps strictly increase within the filtered stage subset.
for (let i = 1; i < stageEvents.length; i++) {
  const prevTs = Date.parse(stageEvents[i - 1].timestamp);
  const curTs = Date.parse(stageEvents[i].timestamp);
  if (!Number.isFinite(prevTs) || !Number.isFinite(curTs)) {
    fail(
      `invalid timestamp in ${storyId}/${stage} at event '${stageEvents[i].event}': ` +
      `${stageEvents[i - 1].timestamp} / ${stageEvents[i].timestamp}`
    );
  }
  if (curTs < prevTs) {
    fail(
      `timestamp regression in ${storyId}/${stage}: '${stageEvents[i].event}' ` +
      `(${stageEvents[i].timestamp}) precedes '${stageEvents[i - 1].event}' (${stageEvents[i - 1].timestamp})`
    );
  }
}

console.log(`ok — ${storyId}/${stage}: ${stageEvents.length} events, chain integrity verified, ordering canonical`);
