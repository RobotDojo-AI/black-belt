#!/usr/bin/env node
/**
 * link-chat-chunk-entities.js — one-time (re-runnable) guarded sweep that ties
 * existing chat chunks to the person/company/place entities they name, and
 * cleans the pre-existing indiscriminate same-name chat person links to zero.
 *
 * Compute tier: Tier 0 deterministic (no LLM). Idempotent — chunk_entities links
 * are INSERT OR IGNORE, and a re-run re-cleans then re-links the same rows.
 *
 * Usage:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/link-chat-chunk-entities.js [--limit N] [--report <path>]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import db from '../lib/db.js';
import { sweepChatChunkEntities } from '../lib/chat-entity-linking.js';

export const INTELLIGENCE_TIER = 'extraction';

const REPO_ROOT = pathResolve(new URL('..', import.meta.url).pathname);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

const limitArg = argValue('--limit');
const limit = limitArg ? Number(limitArg) : Infinity;
const reportPath = argValue('--report');

const triage = [];
const t0 = Date.now();
const result = sweepChatChunkEntities(db, {
  limit,
  collectTriage: reportPath ? (row) => triage.push(row) : null,
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`[chat-link] cleaned ${result.cleaned} same-name collision links`);
console.log(`[chat-link] swept ${result.chunks} chat chunks in ${secs}s`);
console.log(`[chat-link] linked person=${result.linked.person} company=${result.linked.company} place=${result.linked.place}; triage=${result.triage}`);

if (reportPath) {
  const abs = pathResolve(REPO_ROOT, reportPath);
  const lines = [
    `# Chat→entity linking triage — ambiguous mentions queued, never guessed`,
    `Generated: ${new Date().toISOString()}`,
    `Cleaned same-name collision links: ${result.cleaned}`,
    `Swept chunks: ${result.chunks}`,
    `Linked: person=${result.linked.person} company=${result.linked.company} place=${result.linked.place}`,
    '',
    `## Triage (${triage.length})`,
    ...(triage.length ? triage.map((t) => `- [${t.type}] ${t.name} — ${t.reason}${t.collisions ? ` (${t.collisions} same-named)` : ''} — chunk ${t.chunk_id}`) : ['(none)']),
    '',
  ];
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, lines.join('\n'));
  console.log(`[chat-link] triage report → ${reportPath}`);
}

process.exit(0);
