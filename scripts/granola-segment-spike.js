#!/usr/bin/env node
/**
 * scripts/granola-segment-spike.js — Phase 0 re-pull gate (st_8a841c68).
 *
 * Compute tier: Tier 0 (extraction) — a live Granola REST re-pull plus a
 * deterministic coverage tally. No LLM, no DB write. This script PROVES the
 * substrate the whole attribution feature stands on before any of it is built:
 * that re-fetching every stored Granola document returns per-segment `source`
 * (microphone | system) AND start/end timestamps at scale. If it does not,
 * STOP — no attribution may be built on an unprovable corpus (plan failure
 * manifest #1).
 *
 * The per-segment source/timestamps are NOT stored anywhere in the DB today
 * (lib/granola-client.js assembleTranscript flattens them away), so the only
 * source of truth is a live re-fetch from /v1/get-document-transcript. This
 * gate re-fetches each document the corpus references and tallies, per
 * document, the fraction of segments carrying a usable `source` and both
 * timestamps. A document "passes" when ALL of its segments carry source +
 * both timestamps; coverage is passing-documents / documents-with-segments.
 *
 * Usage:
 *   cd ~/robotdojo && ROBOTDOJO_ALLOW_PLAINTEXT=1 \
 *     node scripts/granola-segment-spike.js --assert-coverage 0.95
 *
 * Exit 0 when coverage ≥ the asserted threshold; exit 1 otherwise (or on a
 * token/transport failure that prevents proving coverage at all).
 */
export const INTELLIGENCE_TIER = 'extraction';

import db from '../lib/db.js';
import { getGranolaToken, GRANOLA_REST_URL } from '../lib/granola-client.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const ASSERT_COVERAGE = Number(arg('--assert-coverage', '0.95'));
const LIMIT = Number(arg('--limit', '0')) || 0; // 0 = all; >0 caps for a fast smoke

// WHY a small concurrency pool, not a serial loop and not unbounded fan-out:
// the at-scale risk this gate exists to disprove is rate-limiting/pagination
// failure (plan failure manifest #1). A serial loop hides throughput limits;
// unbounded fan-out trips them artificially. A bounded pool re-pulls the real
// corpus the way the backfill will, surfacing genuine API limits.
const CONCURRENCY = Number(arg('--concurrency', '6'));

async function restPost(token, path, body) {
  const res = await fetch(`${GRANOLA_REST_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Granola REST ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// A segment is fully usable when it carries a recognized source AND both
// timestamps. Anything else is counted against coverage, honestly.
function segmentUsable(s) {
  const source = String(s?.source || '').toLowerCase();
  const okSource = source === 'microphone' || source === 'system';
  const okTs = s?.start_timestamp != null && s?.end_timestamp != null;
  return okSource && okTs;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const token = await getGranolaToken();
  if (!token) {
    console.error('[segment-spike] BLOCKED — no Granola token available. Phase 0 cannot run.');
    process.exit(1);
  }

  // The corpus to prove is every stored Granola transcript. We pull the live
  // document list and intersect with the stored meeting_ids so the gate proves
  // exactly the documents the backfill must recover — not a different set.
  const storedIds = new Set(
    db.prepare("SELECT meeting_id FROM transcripts WHERE source = 'granola' AND meeting_id IS NOT NULL").all().map((r) => r.meeting_id),
  );

  let docs;
  try {
    docs = await restPost(token, '/v1/get-documents', {});
  } catch (e) {
    console.error(`[segment-spike] BLOCKED — get-documents failed: ${e.message}`);
    process.exit(1);
  }
  const list = Array.isArray(docs) ? docs : (docs?.documents || []);
  const liveIds = list.map((d) => d.id || d.document_id).filter(Boolean);

  // Prefer the intersection (documents we both store AND can still fetch);
  // fall back to the full live list when no stored ids matched (fresh machine).
  let targets = liveIds.filter((id) => storedIds.has(id));
  const intersected = targets.length;
  if (targets.length === 0) targets = liveIds;
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);

  console.error(`[segment-spike] stored=${storedIds.size} live=${liveIds.length} intersect=${intersected} re-pulling=${targets.length} (concurrency=${CONCURRENCY})`);

  let docsWithSegments = 0;
  let docsFullyCovered = 0;
  let totalSegments = 0;
  let usableSegments = 0;
  let fetchErrors = 0;
  const calEventPresent = { id: 0, ical: 0 };

  const docMeta = new Map();
  for (const d of list) docMeta.set(d.id || d.document_id, d);

  await mapPool(targets, CONCURRENCY, async (id) => {
    let data;
    try {
      data = await restPost(token, '/v1/get-document-transcript', { document_id: id });
    } catch (e) {
      fetchErrors++;
      console.error(`[segment-spike] fetch failed ${id}: ${e.message}`);
      return;
    }
    const segs = Array.isArray(data) ? data : (data?.segments || data?.transcript?.segments || []);
    if (!Array.isArray(segs) || segs.length === 0) return; // no-segment docs don't count toward coverage

    docsWithSegments++;
    let docUsable = 0;
    for (const s of segs) {
      totalSegments++;
      if (segmentUsable(s)) { usableSegments++; docUsable++; }
    }
    if (docUsable === segs.length) docsFullyCovered++;

    const meta = docMeta.get(id);
    if (meta?.google_calendar_event?.id) calEventPresent.id++;
    if (meta?.google_calendar_event?.iCalUID) calEventPresent.ical++;
  });

  const coverage = docsWithSegments > 0 ? docsFullyCovered / docsWithSegments : 0;
  const segmentRate = totalSegments > 0 ? usableSegments / totalSegments : 0;

  // Coverage report (the artifact this gate produces). Plain text to stdout so
  // criteria-runner and a human both read the same line.
  console.log('--- granola-segment-spike coverage report ---');
  console.log(`documents re-pulled:        ${targets.length}`);
  console.log(`fetch errors:               ${fetchErrors}`);
  console.log(`documents with segments:    ${docsWithSegments}`);
  console.log(`documents fully covered:    ${docsFullyCovered}`);
  console.log(`document coverage:          ${(coverage * 100).toFixed(1)}%  (threshold ${(ASSERT_COVERAGE * 100).toFixed(1)}%)`);
  console.log(`segments total / usable:    ${totalSegments} / ${usableSegments}  (${(segmentRate * 100).toFixed(1)}%)`);
  console.log(`calendar-event id present:  ${calEventPresent.id}/${docsWithSegments}`);
  console.log(`calendar iCalUID present:   ${calEventPresent.ical}/${docsWithSegments}`);

  if (docsWithSegments === 0) {
    console.error('[segment-spike] FAIL — no document returned any segments; substrate unproven.');
    process.exit(1);
  }
  if (coverage < ASSERT_COVERAGE) {
    console.error(`[segment-spike] FAIL — coverage ${(coverage * 100).toFixed(1)}% < ${(ASSERT_COVERAGE * 100).toFixed(1)}%.`);
    process.exit(1);
  }
  console.error(`[segment-spike] PASS — coverage ${(coverage * 100).toFixed(1)}% ≥ ${(ASSERT_COVERAGE * 100).toFixed(1)}%.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`[segment-spike] BLOCKED — ${e.message}`);
  process.exit(1);
});
