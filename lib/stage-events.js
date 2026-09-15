// lib/stage-events.js — st_43221114 AC 14.
//
// Append-only Merkle-chained event log for pipeline stages. Each gated
// skill emits events as the orchestrator runs them:
//   - bunshin_spawned     (when /build, /scope, etc. spawn Bunshin)
//   - bunshin_returned    (when Bunshin returns its verdict)
//   - print_to_owner_rendered  (when the print-to-owner block renders)
//   - seal_requested      (when story-gate.js --seal is invoked)
//
// Chain integrity: each line carries `prev_event_hash = SHA256(prev_line_bytes)`
// or `root_hash = SHA256(story_id + ':' + stage)` for the first line. Backdating
// any timestamp would require rewriting every downstream line's hash —
// forgery-resistant by the same construction as the Merkle memory log.
//
// Concurrency: writers go through `appendWithLock()`. An advisory `.lock`
// file in the story dir serialises concurrent terminals. Atomic append is
// via `O_APPEND` + small write — POSIX-atomic for writes ≤ PIPE_BUF (4KB);
// JSONL lines are well under that.
//
// INTELLIGENCE_TIER: orchestration — no LLM calls, deterministic only.

import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, openSync, closeSync, writeSync, mkdirSync, statSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { PIPELINE_STORIES_DIR } from './robotdojo-paths.js';

export const INTELLIGENCE_TIER = 'orchestration';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Resolve story dir relative to the pipeline-paths resolver. Honors
// ROBOTDOJO_STORIES_DIR override; default = user/workbenches workbench.
function storyDir(storyId) {
  return join(PIPELINE_STORIES_DIR, storyId);
}

function rootHash(storyId, stage) {
  return sha256(`${storyId}:${stage}`);
}

// Read last non-empty line of the events file (returns null if empty/missing).
function readLastLine(path) {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  if (buf.length === 0) return null;
  // Trim trailing newline(s) to find the last real line.
  let end = buf.length;
  while (end > 0 && (buf[end - 1] === 0x0a || buf[end - 1] === 0x0d)) end--;
  if (end === 0) return null;
  let start = end - 1;
  while (start > 0 && buf[start - 1] !== 0x0a) start--;
  return buf.slice(start, end).toString('utf8');
}

// Acquire advisory lock on `<storyDir>/stage-events.lock`. Best-effort —
// open with `wx` (exclusive create), retry with backoff up to ~2s, then
// proceed without lock (logging) rather than block forever. The chain
// integrity check at seal-time is the durable invariant; lock contention
// is only a "two writes in the same millisecond" rarity.
async function acquireLock(lockPath, maxWaitMs = 2000) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxWaitMs) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // If the lock file is older than 60s, assume the holder crashed.
      try {
        const s = statSync(lockPath);
        if (Date.now() - s.mtimeMs > 60000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {}
      attempt++;
      await sleep(Math.min(50 * attempt, 200));
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch {}
}

/**
 * emitStageEvent — append a Merkle-chained event line.
 *
 * @param {object} opts
 * @param {string} opts.storyId   e.g. "st_43221114"
 * @param {string} opts.stage     e.g. "build"
 * @param {string} opts.agent     e.g. "katagami" | "miyagi" | "bunshin"
 * @param {string} opts.event     e.g. "bunshin_spawned"
 * @param {string} [opts.timestamp]  override ISO timestamp (for retroactive emit)
 * @param {string} [opts.subagent_return_id]  st_862d73d1 — the returning
 *   subagent's identifier, recorded on bunshin_spawned / bunshin_returned so the
 *   stage-event trail binds to a real spawned context's return. Additive +
 *   backward-compatible: omitted on events that don't carry it; the same field
 *   generalizes to any future spawned-specialist evidence (Tantei/Hakase).
 *
 * st_4312c9c0 spend/latency fields, all additive and all recorded on the
 * `{agent}_returned` event so one line carries what a specialist actually spent
 * on every axis:
 *
 * @param {string} [opts.effort]        AC-14 — the reasoning effort the spawn
 *   requested ('low'|'medium'|'high'). Recorded as the value used, not as an
 *   intention stated in a brief, so an uncapped run is visible after the fact.
 * @param {number} [opts.elapsed_ms]    AC-14 — wall-clock the owner waited.
 * @param {number} [opts.ceiling]       AC-8 — the stated tool-call ceiling.
 * @param {number} [opts.tool_calls_used] AC-8 — actual against that ceiling.
 * @param {number} [opts.files_read]    AC-8 — actual file reads.
 * @param {number} [opts.sources_pulled] AC-16 — external sources a research
 *   pass retrieved.
 * @param {string} [opts.stop_reason]   AC-16 — why it stopped pulling. Makes a
 *   twenty-source fan-out that never checked whether three would do visible
 *   rather than invisible.
 * @param {string[]} [opts.retrieval_rungs] AC-16 — which rungs of the cheap-
 *   first ladder were used, in order.
 *
 * Zero is a meaningful value for every numeric field here — a run that made no
 * tool calls is evidence, not a missing field — so they are persisted whenever
 * they are supplied at all, rather than only when truthy.
 *
 * @returns {Promise<{path:string, line:string, hash:string}>}
 */
export async function emitStageEvent({
  storyId, stage, agent, event, timestamp, subagent_return_id, owner_approval,
  effort, elapsed_ms, ceiling, tool_calls_used, files_read,
  sources_pulled, stop_reason, retrieval_rungs,
}) {
  if (!storyId || !stage || !agent || !event) {
    throw new Error('emitStageEvent: storyId, stage, agent, event are required');
  }
  const dir = storyDir(storyId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const eventsPath = join(dir, 'stage-events.jsonl');
  const lockPath = join(dir, 'stage-events.lock');

  const acquired = await acquireLock(lockPath);
  try {
    const last = readLastLine(eventsPath);
    const prev_event_hash = last
      ? sha256(last)
      : rootHash(storyId, stage);
    const entry = {
      stage, agent, event,
      timestamp: timestamp ?? isoNow(),
      // Additive fields — only persisted when supplied (st_862d73d1 / df_aa0f667f).
      // Keeps the line shape backward-compatible for events that don't carry them.
      ...(subagent_return_id ? { subagent_return_id } : {}),
      ...(owner_approval ? { owner_approval } : {}),
      // st_4312c9c0 — `!== undefined` rather than truthiness: 0 tool calls and
      // 0 sources are real measurements, and dropping them would make a
      // perfectly disciplined run indistinguishable from an unrecorded one.
      ...(effort !== undefined ? { effort } : {}),
      ...(elapsed_ms !== undefined ? { elapsed_ms } : {}),
      ...(ceiling !== undefined ? { ceiling } : {}),
      ...(tool_calls_used !== undefined ? { tool_calls_used } : {}),
      ...(files_read !== undefined ? { files_read } : {}),
      ...(sources_pulled !== undefined ? { sources_pulled } : {}),
      ...(stop_reason !== undefined ? { stop_reason } : {}),
      ...(retrieval_rungs !== undefined ? { retrieval_rungs } : {}),
      prev_event_hash,
    };
    const line = JSON.stringify(entry) + '\n';
    // Atomic append — small JSONL line, well under PIPE_BUF.
    const fd = openSync(eventsPath, 'a');
    try { writeSync(fd, line); } finally { closeSync(fd); }
    return { path: eventsPath, line: line.trim(), hash: sha256(line.trim()) };
  } finally {
    if (acquired) releaseLock(lockPath);
  }
}

/**
 * readStageEvents — returns all events for a story (deterministic order).
 * @param {string} storyId
 * @returns {Array<object>}
 */
export function readStageEvents(storyId) {
  const eventsPath = join(storyDir(storyId), 'stage-events.jsonl');
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l));
}

// Re-export hash helpers used by check-stage-event-order.js — single source
// of truth so the gate and the emitter cannot disagree.
export const _testing = { sha256, rootHash, readLastLine };
