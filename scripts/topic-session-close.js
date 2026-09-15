#!/usr/bin/env node
/**
 * Persist a topic-session close into LOG.md + SESSION-STATUS.md.
 * Used by /close (work-close.js) so topic close is the same command
 * as the old workbench close.
 *
 * Usage: node scripts/topic-session-close.js <work-dir>
 */
import { persistWorkSessionClose } from '../lib/topic-session.js';

const dir = process.argv[2];
const result = persistWorkSessionClose(dir);
if (!result.ok) {
  console.error(`topic-session-close: ${result.reason || 'failed'}`);
  process.exit(result.reason === 'no_work_dir' || result.reason === 'no_topic_root' ? 0 : 1);
}
console.log(`topic-session-close: wrote resume to ${result.root}`);
