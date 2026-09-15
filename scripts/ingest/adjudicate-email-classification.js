#!/usr/bin/env node
/**
 * adjudicate-email-classification.js — offline batched adjudication pass over
 * the email_classification_review queue (st_180aa017 AC-1/AC-2).
 *
 * Compute Tier Protocol (agents/build-conventions.md):
 *   Tier 0 (free, deterministic) — lib/email-adjudication.js deterministicVerdict
 *     settles the confident majority for free, reasoning over co-identifier
 *     corroboration + structural local-part shape (never a re-call of the
 *     original classifyEmailAddress verdict already on these rows).
 *   Tier 1 (Haiku, modelFor('fast')) — only the residual Tier-0 could not settle,
 *     in small validated batches (lib/email-adjudication.js BATCH_SIZE).
 *     Batch size is a precision lever, not just a cost lever — research
 *     (st_180aa017 01-research.md ## External §2) measured a 30.2% malformed-
 *     JSON rate at batch size 5 on a comparable stack; a malformed/unparseable
 *     batch shrinks and retries rather than being trusted.
 *
 * INTELLIGENCE_TIER: synthesis — reads structure (the pending queue), calls
 * Haiku on the residual, and writes NOTHING itself: every read and write
 * against email_classification_review / person_identifiers lives in
 * lib/email-adjudication.js. This file holds no db.prepare of its own
 * (LLM-write-boundary: the model emits ONLY a JSON verdict; deterministic
 * library code decides every mutation).
 *
 * SAFE BY DEFAULT: `--dry-run` (the default — this flag is accepted but
 * redundant) reports a per-row verdict + confidence and mutates nothing.
 * `--apply` is the only path that mutates data (owner-run, post-merge — never
 * invoked by an autonomous build or QA pass).
 *
 * Flags:
 *   --dry-run       default behavior; report only, no mutation (redundant with
 *                   the default — accepted for explicitness)
 *   --apply         gate the actual mutation (ensureAdjudicationColumns then
 *                   applyVerdicts on the high-confidence set only)
 *   --json          emit the full {summary, verdicts} report as a single JSON
 *                   blob on stdout (all diagnostic logging moves to stderr)
 *   --limit N       bound how many pending rows this pass reads (default 200)
 *
 * Usage:
 *   node scripts/ingest/adjudicate-email-classification.js --dry-run --json --limit 20
 *   node scripts/ingest/adjudicate-email-classification.js --apply --limit 500
 */

export const INTELLIGENCE_TIER = 'synthesis';

import { resolve } from 'node:path';
import { getAnthropicClient } from '../../lib/anthropic-client.js';
import { modelFor } from '../../lib/model-lane.js';
import {
  readPendingWithContext,
  deterministicVerdict,
  buildBatchPrompt,
  parseAdjudicationBatch,
  applyVerdicts,
  ensureAdjudicationColumns,
  HIGH_CONFIDENCE,
  BATCH_SIZE,
} from '../../lib/email-adjudication.js';

const DEFAULT_LIMIT = 200;
const HAIKU_CONCURRENCY = 5; // parallelize-by-default, capped so a large --limit doesn't burst-flood the API
const MAX_SHRINK_DEPTH = 3;  // halve-and-retry a malformed batch this many times before giving up on a row

/** Bounded-concurrency map — runs `fn` over `items` with at most `limit` in flight. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** A row this pass could not resolve after every retry/shrink — held, never
 * applied (confidence 0 is always below HIGH_CONFIDENCE). */
function unresolvedResult(row) {
  return { id: row.id, person_id: row.person_id, value: row.value, verdict: 'unresolved', confidence: 0, tier: 'unparsed' };
}

/**
 * Classify one batch via Haiku with strict validation. On a malformed/
 * unparseable response or an API failure, halve the batch and retry — never
 * silently trust a partial parse. Rows that still can't resolve after
 * MAX_SHRINK_DEPTH become unresolvedResult() (held, never applied).
 */
async function classifyBatchWithRetry(client, rows, depth = 0) {
  if (!rows.length) return [];
  if (!client) return rows.map(unresolvedResult);

  const { system, user } = buildBatchPrompt(rows);
  let text = '';
  let apiFailed = false;
  try {
    const msg = await client.messages.create({
      model: modelFor('fast'),
      max_tokens: Math.max(300, rows.length * 80),
      system,
      messages: [{ role: 'user', content: user }],
    });
    text = msg.content?.[0]?.text || '';
  } catch {
    apiFailed = true;
  }

  const parsed = apiFailed ? { ok: false } : parseAdjudicationBatch(text, rows.map((r) => r.id));
  if (parsed.ok) {
    const byId = new Map(parsed.verdicts.map((v) => [String(v.id), v]));
    return rows.map((r) => {
      const v = byId.get(String(r.id));
      return { id: r.id, person_id: r.person_id, value: r.value, verdict: v.verdict, confidence: v.confidence, tier: 'haiku' };
    });
  }

  if (depth >= MAX_SHRINK_DEPTH) return rows.map(unresolvedResult);

  if (rows.length === 1) {
    // Same single row, one more direct retry at the depth cap.
    return classifyBatchWithRetry(client, rows, depth + 1);
  }
  const mid = Math.ceil(rows.length / 2);
  const [a, b] = [rows.slice(0, mid), rows.slice(mid)];
  const [ra, rb] = await Promise.all([
    classifyBatchWithRetry(client, a, depth + 1),
    classifyBatchWithRetry(client, b, depth + 1),
  ]);
  return [...ra, ...rb];
}

async function run({ apply, json, limit }) {
  const logInfo = (...args) => { if (json) console.error(...args); else console.log(...args); };

  const { default: db } = await import('../../lib/db.js');
  const rows = readPendingWithContext(db, { limit });
  logInfo(`[adjudicate-email-classification] ${rows.length} pending row(s) read (limit=${limit})`);

  const tier0 = [];
  const residual = [];
  for (const row of rows) {
    const v = deterministicVerdict(row, { coIdentifiers: row.coIdentifiers, displayName: row.displayName });
    if (v) tier0.push({ id: row.id, person_id: row.person_id, value: row.value, ...v });
    else residual.push(row);
  }
  logInfo(`[adjudicate-email-classification] tier-0 settled ${tier0.length}, residual ${residual.length} -> Haiku`);

  let haikuResults = [];
  if (residual.length) {
    let client = null;
    try { client = getAnthropicClient(); } catch (err) {
      logInfo(`[adjudicate-email-classification] Anthropic client unavailable: ${err.message}`);
    }
    const batches = [];
    for (let i = 0; i < residual.length; i += BATCH_SIZE) batches.push(residual.slice(i, i + BATCH_SIZE));
    const batchResults = await mapWithConcurrency(batches, HAIKU_CONCURRENCY, (batch) => classifyBatchWithRetry(client, batch));
    haikuResults = batchResults.flat();
  }

  const verdicts = [...tier0, ...haikuResults];
  const highConfidenceCount = verdicts.filter((v) => v.confidence >= HIGH_CONFIDENCE).length;
  const lowConfidenceCount = verdicts.length - highConfidenceCount;

  let changed = 0;
  let applyReport = null;
  if (apply) {
    ensureAdjudicationColumns(db);
    applyReport = applyVerdicts(db, verdicts, { apply: true });
    changed = applyReport.applied;
    logInfo(`[adjudicate-email-classification] applied ${applyReport.applied} (${applyReport.detached} identifier(s) detached), backup=${applyReport.backupPath}`);
  }

  const summary = {
    total: rows.length,
    tier0: tier0.length,
    haiku: haikuResults.length,
    highConfidence: highConfidenceCount,
    lowConfidence: lowConfidenceCount,
    changed,
  };
  const report = { summary, verdicts };

  if (json) {
    process.stdout.write(JSON.stringify(report));
  } else {
    console.log(`[adjudicate-email-classification] summary: ${JSON.stringify(summary)}`);
  }
  return report;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const json = argv.includes('--json');
  const limitIdx = argv.indexOf('--limit');
  const parsedLimit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_LIMIT;

  await run({ apply, json, limit });
}

// Run as CLI only (not when imported, e.g. by a future caller inspecting exports).
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => { console.error('[adjudicate-email-classification] fatal:', err?.message || err); process.exitCode = 1; });
}
