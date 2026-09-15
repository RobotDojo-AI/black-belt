#!/usr/bin/env node
/**
 * sync-imessage.js — incremental bridge from Apple's chat.db into Robot Dojo.
 *
 * Reads ~/Library/Messages/chat.db read-only, converts Apple-epoch timestamps
 * to Unix epoch, deduplicates to (handle, day), resolves handles to
 * `person_id` via the shared entity-matcher (link-only — iMessage is a
 * low-trust source per CLAUDE.md's entity-extraction hierarchy), and writes
 * into `imessages` + `person_interactions`.
 *
 * Idempotent by design:
 *   - Apple `message.date` watermark in kv_store (`imessage:last_synced_apple_ns`)
 *   - UPSERT on `imessages(source_id)` folds counts into the existing row
 *   - UNIQUE index on person_interactions.source_id + INSERT OR IGNORE
 *
 * Full Disk Access is required to open chat.db. The script surfaces a legible
 * error if macOS denies the read.
 *
 * CLI:
 *   node scripts/sync-imessage.js
 *   node scripts/sync-imessage.js --since 2026-01-01
 *   node scripts/sync-imessage.js --limit 1000
 *   node scripts/sync-imessage.js --dry-run
 *   node scripts/sync-imessage.js --reset-watermark
 */

import { parseArgs } from 'node:util';
import {
  APPLE_EPOCH_OFFSET,
  getWatermark,
  setWatermark,
  syncIMessage,
} from '../lib/imessage.js';

// --- CLI -------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    since:             { type: 'string' },
    limit:             { type: 'string' },
    'dry-run':         { type: 'boolean', default: false },
    'reset-watermark': { type: 'boolean', default: false },
    help:              { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`Usage: node scripts/sync-imessage.js [options]

  --since <ISO-date>    Sync messages after this date (YYYY-MM-DD or full ISO).
                        Overrides the stored watermark for this run only.
  --limit <N>           Cap rows pulled from chat.db.
  --dry-run             Read + aggregate but don't write to robotdojo.db.
  --reset-watermark     Clear the watermark so the next run starts from scratch.
  -h, --help            Show this help.
`);
  process.exit(0);
}

const LIMIT = values.limit ? parseInt(values.limit, 10) : null;
if (values.limit && (!Number.isFinite(LIMIT) || LIMIT <= 0)) {
  console.error('[imessage] --limit must be a positive integer');
  process.exit(1);
}

// Convert --since or stored watermark into Apple nanoseconds.
function resolveSinceAppleNs() {
  if (values['reset-watermark']) {
    setWatermark(0n);
    console.info('[imessage] watermark reset to 0');
    return 0n;
  }
  if (values.since) {
    const ms = Date.parse(values.since);
    if (!Number.isFinite(ms)) {
      console.error(`[imessage] --since "${values.since}" is not a parseable date`);
      process.exit(1);
    }
    const unixSec = Math.floor(ms / 1000);
    const appleSec = unixSec - APPLE_EPOCH_OFFSET;
    if (appleSec <= 0) return 0n;
    return BigInt(appleSec) * 1_000_000_000n;
  }
  return getWatermark();
}

// --- Run -------------------------------------------------------------------

async function main() {
  const sinceAppleNs = resolveSinceAppleNs();
  console.info(`[imessage] since apple_ns: ${sinceAppleNs}`);
  console.info(`[imessage] mode: ${values['dry-run'] ? 'DRY RUN' : 'LIVE'}`);
  if (LIMIT) console.info(`[imessage] limit: ${LIMIT}`);

  const result = syncIMessage({
    since: values.since || null,
    limit: LIMIT,
    dryRun: values['dry-run'],
    resetWatermark: values['reset-watermark'],
  });
  console.info(`[imessage] chat.db contains ${Number(result.total || 0).toLocaleString()} text messages`);
  console.info(`[imessage] pulled ${Number(result.pulled || 0).toLocaleString()} new messages`);
  if (result.pulled === 0) {
    console.info('[imessage] nothing to do');
    return;
  }
  console.info(`[imessage] aggregated to ${Number(result.pairs || 0).toLocaleString()} (handle, day) pairs`);
  if (values['dry-run']) {
    console.info('[imessage] dry-run: no writes, watermark unchanged');
    return;
  }
    console.info(
      `[imessage] done — linked=${result.linked} ` +
      `unresolved=${result.unresolved} group=${result.group} ` +
      `watermark=${result.watermark}`,
    );
}

main().catch((err) => {
  console.error('[imessage] failed:', err.message);
  process.exit(1);
});
