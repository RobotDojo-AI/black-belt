#!/usr/bin/env node
/**
 * scripts/backfill-claude-code-jsonl.js — recover pre-capture coding-agent
 * history from a point-in-time backup of the native Claude Code jsonl logs
 * (st_abf246e4 WS2 / AC2).
 *
 * Compute tier:
 *   Tier 0  parseSessionJsonl — deterministic line parse. Free. Always first.
 *   Tier 1  Haiku topic classify — fires ONLY on a Tier-0 keyword miss, inside
 *           materializeFromJsonl. The LLM classifies; deterministic code writes
 *           the row (LLM write boundary — no LLM writes a DB row).
 *   (no Tier 2 / Tier 3.)
 *
 * The May-27 object-storage backup (the configured files bucket, under
 * `dotclaude/projects/` — see config/backup-buckets.user.json)
 * holds the pre-June bulk (3,447 native jsonl) that survives in no other store.
 * Sync a copy locally and point --source at it. Per file: parseSessionJsonl →
 * materializeFromJsonl (INSERT new, or enrich a one-sided live row with the
 * recovered agent side). Dedup is the thread_id='claude-code:<sessionId>' unique
 * index; UPSERT makes re-runs order-independent and idempotent.
 *
 * Bounded + resumable: --max-seconds caps each slice; a checkpoint file records
 * every processed session_id so a re-run resumes instead of restarting. A
 * partial slice is always safe because every write is idempotent.
 *
 * Usage:
 *   node scripts/backfill-claude-code-jsonl.js --source <dir> [--max-seconds N] [--checkpoint <path>] [--dry-run]
 */
export const INTELLIGENCE_TIER = 'synthesis';

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';

function parseArgs(argv) {
  const args = { source: null, maxSeconds: 0, checkpoint: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--max-seconds') args.maxSeconds = Number(argv[++i]) || 0;
    else if (a === '--checkpoint') args.checkpoint = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

/** Recursively collect every *.jsonl path under a directory. */
function collectJsonlFiles(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...collectJsonlFiles(full));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function loadCheckpoint(path) {
  if (!path || !existsSync(path)) return { processed: [] };
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { processed: [] }; }
}

function saveCheckpoint(path, data) {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  } catch (e) {
    console.warn('[backfill] checkpoint write failed:', e.message);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source) {
    console.error('usage: backfill-claude-code-jsonl.js --source <dir> [--max-seconds N] [--checkpoint <path>] [--dry-run]');
    process.exit(2);
  }
  const source = resolve(args.source);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    console.error(`[backfill] --source not a directory: ${source}`);
    process.exit(2);
  }

  const checkpointPath = args.checkpoint
    ? resolve(args.checkpoint)
    : resolve(homedir(), '.robotdojo', 'backfill-claude-code-jsonl.checkpoint.json');

  const [{ default: db }, { parseSessionJsonl }, { materializeFromJsonl }] = await Promise.all([
    import('../lib/db.js'),
    import('../lib/claude-code-jsonl.js'),
    import('../lib/conversations.js'),
  ]);

  const checkpoint = loadCheckpoint(checkpointPath);
  const processedSet = new Set(checkpoint.processed || []);

  // Deterministic order so a resumed slice continues predictably; one file per
  // session_id (the filename stem is the dedup key — never dedup by file).
  const bySession = new Map();
  for (const f of collectJsonlFiles(source)) {
    const sid = basename(f).replace(/\.jsonl$/i, '');
    if (!bySession.has(sid)) bySession.set(sid, f);
  }
  const sessionIds = [...bySession.keys()].sort();

  const deadline = args.maxSeconds > 0 ? Date.now() + args.maxSeconds * 1000 : null;
  let processed = 0;
  let inserted = 0;
  let enriched = 0;
  let empty = 0;
  let partial = false;

  for (const sid of sessionIds) {
    if (processedSet.has(sid)) continue;
    if (deadline !== null && Date.now() >= deadline) { partial = true; break; }
    const filePath = bySession.get(sid);
    try {
      const parsed = parseSessionJsonl(filePath);
      if (!parsed.messages.length) { empty += 1; processedSet.add(sid); continue; }
      if (!args.dryRun) {
        const res = await materializeFromJsonl(db, `claude-code:${sid}`, parsed, {
          origin: parsed.isSidechain ? 'subagent' : 'owner',
          source: 'gcs-backfill',
        });
        if (res?.materialized) inserted += 1;
        else if (res?.enriched) enriched += 1;
      }
      processedSet.add(sid);
    } catch (e) {
      console.warn('[backfill] failed for', sid, e?.message || e);
    }
    processed += 1;
    // Checkpoint every 25 sessions so a kill mid-slice loses at most 25.
    if (processed % 25 === 0) saveCheckpoint(checkpointPath, { processed: [...processedSet] });
  }

  saveCheckpoint(checkpointPath, { processed: [...processedSet] });
  const remaining = sessionIds.filter((s) => !processedSet.has(s)).length;
  console.log(`[backfill] done — files=${sessionIds.length} processed=${processed} inserted=${inserted} enriched=${enriched} empty=${empty} remaining=${remaining}${partial ? ' (partial slice)' : ''}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[backfill] fatal:', e?.message || e);
  process.exit(1);
});
