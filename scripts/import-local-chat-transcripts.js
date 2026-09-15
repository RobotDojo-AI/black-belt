#!/usr/bin/env node
/**
 * Import local Markdown chat transcripts into the DB/chunk index.
 *
 * Source of truth: user/transcripts/chat.
 * Derived state: conversations, messages, chunks(embedded=0).
 */
import { resolve } from 'node:path';
import { importChatTranscriptDirectory } from '../lib/chat-transcript-import.js';
import { USER_TRANSCRIPTS_DIR } from '../lib/robotdojo-paths.js';
import { withScheduledDbWriterGuard } from '../lib/db-writer-policy.js';

const dirArg = process.argv.find((arg) => !arg.startsWith('-') && arg !== process.argv[1] && arg !== process.argv[0]);
const dir = dirArg ? resolve(dirArg) : resolve(USER_TRANSCRIPTS_DIR, 'chat');

const started = Date.now();
const result = await withScheduledDbWriterGuard('import-local-chat-transcripts', async () => (
  importChatTranscriptDirectory(dir)
));
const guardSkipped = result?.skipped === true && result?.reason;

process.stdout.write(JSON.stringify({
  ok: !guardSkipped && !result.errors?.length,
  dir,
  duration_ms: Date.now() - started,
  ...result,
}, null, 2) + '\n');

if (guardSkipped || result.errors?.length) process.exitCode = 1;
