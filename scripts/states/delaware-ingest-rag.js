/**
 * delaware-ingest-rag.js — Index the wk_states workbench into the RAG system.
 *
 * Calls indexWorkbench(db, 'wk_states') which scans all text files under the
 * workbench root, writes chunks to the chunks table, and queues them for
 * embedding. The embed daemon (scripts/chunk-embed-daemon.mjs) picks up the
 * new chunks on its next cycle.
 *
 * WHY this is INTELLIGENCE_TIER 'orchestration': this script coordinates the
 * RAG indexing pipeline. It makes no direct LLM calls and writes no DB rows
 * via LLM output. It is the wiring layer between the workbench files and the
 * embedding queue.
 *
 * Note: RAG search resolves after the embed daemon completes the embedding pass.
 * If the daemon is not running, chunks are written but not yet embedded.
 * Verify: pgrep -f chunk-embed-daemon.mjs
 *
 * INTELLIGENCE_TIER: orchestration — coordinates indexing, no direct LLM calls.
 *
 * Usage:
 *   cd ~/robotdojo && node scripts/states/delaware-ingest-rag.js
 */
export const INTELLIGENCE_TIER = 'orchestration';

import db from '../../lib/db.js';
import { indexWorkbench } from '../../lib/workbench-rag.js';

const result = indexWorkbench(db, 'wk_states');
const chunkCount = result.chunks?.length ?? 'n/a';
console.info(`[states-rag] indexed: chunks=${chunkCount}`);
console.log(JSON.stringify({ ok: true, workbench_id: 'wk_states', chunks: chunkCount }, null, 2));
