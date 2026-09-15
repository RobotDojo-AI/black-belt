#!/usr/bin/env node
// Replay historical chat messages into the immutable memory event ledger.

import db from '../lib/db.js';
import { backfillChatMemoryEvents } from '../lib/chat-memory-backfill.js';

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value = true] = arg.slice(2).split('=');
    out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const result = backfillChatMemoryEvents(db, {
  limit: args.limit ? Number(args.limit) : null,
  conversationId: args.conversation || args.conversationId || null,
});

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[chat-memory-backfill] scanned=${result.scanned} inserted=${result.inserted} skipped_existing=${result.skipped_existing}`);
}
