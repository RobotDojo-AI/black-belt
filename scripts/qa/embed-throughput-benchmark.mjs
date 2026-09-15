#!/usr/bin/env node
/**
 * Local embedding throughput benchmark for the launch SLA.
 *
 * This is intentionally separate from data-pipeline-status: status should be
 * cheap and read evidence; this script creates the evidence by measuring the
 * local ONNX model on this machine.
 */

export const INTELLIGENCE_TIER = 'verification';

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import db from '../../lib/db.js';
import { embedBatch } from '../../lib/rag.js';
import { effectiveBatchSize } from '../../lib/rag/embed.js';
import {
  EMBED_SLA_DIRECT_SOURCE_TYPES,
  freshUserCappedEmailMix,
  chatHistoryFirstLaneProjection,
  intelligenceCoverageProjection,
  projectedHoursForLengthMix,
} from '../../lib/rag/embed-sla.js';
import { setEmbedProfile } from '../../lib/rag/local-embed.js';
import { LanePool } from '../../lib/rag/lane-pool.js';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_FILE), '..', '..');
const RUNTIME_DIR = process.env.ROBOTDOJO_CONFIG
  ? resolve(process.env.ROBOTDOJO_CONFIG, 'runtime')
  : resolve(homedir(), '.robotdojo', 'runtime');
const RESULT_FILE = argValue('--result-file') || resolve(RUNTIME_DIR, 'embed-throughput-benchmark.json');
const SHORT_SAMPLE = positiveInt(argValue('--short-sample') || process.env.ROBOTDOJO_EMBED_BENCH_SHORT_SAMPLE, 64);
const MEDIUM_SAMPLE = positiveInt(argValue('--medium-sample') || process.env.ROBOTDOJO_EMBED_BENCH_MEDIUM_SAMPLE, 32);
const LONG_SAMPLE = positiveInt(argValue('--long-sample') || process.env.ROBOTDOJO_EMBED_BENCH_LONG_SAMPLE, 8);
const LANE_COUNT = positiveInt(argValue('--lanes') || process.env.ROBOTDOJO_EMBED_BENCH_LANES, 2);
const EMBED_LONG_INPUT_CHARS = positiveInt(process.env.ROBOTDOJO_EMBED_LONG_INPUT_CHARS, 2000);
const EMBED_MEDIUM_INPUT_CHARS = positiveInt(process.env.ROBOTDOJO_EMBED_MEDIUM_INPUT_CHARS, 800);
const RECENT_INTELLIGENCE_DAYS = positiveInt(process.env.ROBOTDOJO_FIRST_HOUR_INTELLIGENCE_RECENT_DAYS, 90);
const DEPS = Object.freeze([
  'lib/rag/embed.js',
  'lib/rag/local-embed.js',
  'lib/rag/lane-pool.js',
  'lib/rag/embed-sla.js',
  'lib/chunk-worker.js',
  'config/defaults.json',
]);
const DIRECT_SOURCE_SQL = EMBED_SLA_DIRECT_SOURCE_TYPES
  .map((sourceType) => `'${String(sourceType).replace(/'/g, "''")}'`)
  .join(', ');

function positiveInt(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function argValue(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function sha256(rel) {
  return createHash('sha256').update(readFileSync(resolve(REPO_ROOT, rel))).digest('hex');
}

function sample(where, limit) {
  return db.prepare(`
    SELECT content
      FROM chunks
     WHERE skip_embed = 0
       AND LENGTH(content) > 0
       AND ${where}
     ORDER BY id
     LIMIT ?
  `).all(limit).map((row) => row.content);
}

async function bench(label, texts, runner, batchSize) {
  const t0 = Date.now();
  await runner(texts, batchSize);
  const ms = Math.max(1, Date.now() - t0);
  return {
    label,
    n: texts.length,
    batch_size: batchSize,
    ms,
    rate_per_hour: Math.round(texts.length / (ms / 3_600_000)),
  };
}

function lengthMix() {
  return db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN LENGTH(content) <= ${EMBED_MEDIUM_INPUT_CHARS} THEN 1 ELSE 0 END) AS short,
           SUM(CASE WHEN LENGTH(content) > ${EMBED_MEDIUM_INPUT_CHARS}
                     AND LENGTH(content) <= ${EMBED_LONG_INPUT_CHARS} THEN 1 ELSE 0 END) AS medium,
           SUM(CASE WHEN LENGTH(content) > ${EMBED_LONG_INPUT_CHARS} THEN 1 ELSE 0 END) AS long,
           SUM(CASE WHEN source_type = 'email' AND LENGTH(content) <= ${EMBED_MEDIUM_INPUT_CHARS} THEN 1 ELSE 0 END) AS emailShort,
           SUM(CASE WHEN source_type = 'email'
                     AND LENGTH(content) > ${EMBED_MEDIUM_INPUT_CHARS}
                     AND LENGTH(content) <= ${EMBED_LONG_INPUT_CHARS} THEN 1 ELSE 0 END) AS emailMedium,
           SUM(CASE WHEN source_type = 'email' AND LENGTH(content) > ${EMBED_LONG_INPUT_CHARS} THEN 1 ELSE 0 END) AS emailLong
      FROM chunks
     WHERE skip_embed = 0
       AND LENGTH(content) > 0
  `).get();
}

function intelligenceGroups() {
  return db.prepare(`
    WITH base AS (
      SELECT
        COALESCE(source_type, '') AS source_type,
        COALESCE(content_rank, 3) AS content_rank,
        COALESCE(embedded, 0) AS embedded,
        CASE WHEN EXISTS (SELECT 1 FROM chunk_entities ce WHERE ce.chunk_id = chunks.id)
          THEN 1 ELSE 0 END AS entity_linked,
        CASE
          WHEN COALESCE(CAST(strftime('%s', event_time) AS INTEGER), 0) >= CAST(strftime('%s', 'now', '-${RECENT_INTELLIGENCE_DAYS} days') AS INTEGER)
            OR COALESCE(CAST(strftime('%s', created_at) AS INTEGER), 0) >= CAST(strftime('%s', 'now', '-${RECENT_INTELLIGENCE_DAYS} days') AS INTEGER)
          THEN 1 ELSE 0
        END AS recent,
        CASE WHEN COALESCE(source_type, '') IN (${DIRECT_SOURCE_SQL}) THEN 1 ELSE 0 END AS direct_source,
        LENGTH(content) AS chars
      FROM chunks
      WHERE skip_embed = 0
        AND LENGTH(content) > 0
    )
    SELECT
      source_type,
      content_rank,
      entity_linked,
      recent,
      direct_source,
      COUNT(*) AS count,
      SUM(CASE WHEN embedded = 0 THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN chars <= ${EMBED_MEDIUM_INPUT_CHARS} THEN 1 ELSE 0 END) AS short,
      SUM(CASE
            WHEN chars > ${EMBED_MEDIUM_INPUT_CHARS}
             AND (chars <= ${EMBED_LONG_INPUT_CHARS} OR source_type = 'email')
            THEN 1 ELSE 0
          END) AS medium,
      SUM(CASE WHEN chars > ${EMBED_LONG_INPUT_CHARS} AND source_type != 'email' THEN 1 ELSE 0 END) AS long,
      SUM(CASE WHEN embedded = 0 AND chars <= ${EMBED_MEDIUM_INPUT_CHARS} THEN 1 ELSE 0 END) AS pending_short,
      SUM(CASE
            WHEN embedded = 0
             AND chars > ${EMBED_MEDIUM_INPUT_CHARS}
             AND (chars <= ${EMBED_LONG_INPUT_CHARS} OR source_type = 'email')
            THEN 1 ELSE 0
          END) AS pending_medium,
      SUM(CASE WHEN embedded = 0 AND chars > ${EMBED_LONG_INPUT_CHARS} AND source_type != 'email' THEN 1 ELSE 0 END) AS pending_long
    FROM base
    GROUP BY source_type, content_rank, entity_linked, recent, direct_source
  `).all().map((row) => ({
    source_type: row.source_type,
    content_rank: Number(row.content_rank || 3),
    entity_linked: Number(row.entity_linked || 0),
    recent: Number(row.recent || 0),
    direct_source: Number(row.direct_source || 0),
    count: Number(row.count || 0),
    pending_count: Number(row.pending_count || 0),
    short: Number(row.short || 0),
    medium: Number(row.medium || 0),
    long: Number(row.long || 0),
    pending_short: Number(row.pending_short || 0),
    pending_medium: Number(row.pending_medium || 0),
    pending_long: Number(row.pending_long || 0),
  }));
}

function ratesFrom(results, prefix) {
  return {
    short: results.find((row) => row.label === `${prefix}_short`)?.rate_per_hour || null,
    medium: results.find((row) => row.label === `${prefix}_medium`)?.rate_per_hour || null,
    long: results.find((row) => row.label === `${prefix}_long`)?.rate_per_hour || null,
  };
}

async function main() {
  setEmbedProfile('night');
  const mix = lengthMix();
  const short = sample(`LENGTH(content) <= ${EMBED_MEDIUM_INPUT_CHARS}`, SHORT_SAMPLE);
  const medium = sample(`LENGTH(content) > ${EMBED_MEDIUM_INPUT_CHARS} AND LENGTH(content) <= ${EMBED_LONG_INPUT_CHARS}`, MEDIUM_SAMPLE);
  const long = sample(`LENGTH(content) > ${EMBED_LONG_INPUT_CHARS}`, LONG_SAMPLE);
  await embedBatch(['warmup benchmark'], 1, null, { inputType: 'document' });

  const results = [];
  results.push(await bench('serial_short', short, (texts, bs) => embedBatch(texts, bs, null, { inputType: 'document' }), effectiveBatchSize(short, { shortBatchSize: 16 })));
  results.push(await bench('serial_medium', medium, (texts, bs) => embedBatch(texts, bs, null, { inputType: 'document' }), effectiveBatchSize(medium, { shortBatchSize: 16 })));
  results.push(await bench('serial_long', long, (texts, bs) => embedBatch(texts, bs, null, { inputType: 'document' }), effectiveBatchSize(long, { shortBatchSize: 16 })));

  let pool = null;
  let laneReadyMs = null;
  try {
    pool = new LanePool({
      laneCount: LANE_COUNT,
      sliceTimeoutMs: 600_000,
      env: {
        ROBOTDOJO_LANE_INTRA_THREADS: '2',
        ROBOTDOJO_EMBED_ORT_INTRA_THREADS: '2',
        ROBOTDOJO_MMAP_SIZE: '0',
      },
    });
    const poolStart = Date.now();
    await pool.waitUntilReady({ timeoutMs: 300_000 });
    laneReadyMs = Date.now() - poolStart;
    results.push(await bench('lane_short', short, (texts, bs) => pool.embedBatch(texts, bs, null), effectiveBatchSize(short, { shortBatchSize: 16 })));
    results.push(await bench('lane_medium', medium, (texts, bs) => pool.embedBatch(texts, bs, null), effectiveBatchSize(medium, { shortBatchSize: 16 })));
    results.push(await bench('lane_long', long, (texts, bs) => pool.embedBatch(texts, bs, null), effectiveBatchSize(long, { shortBatchSize: 16 })));
  } finally {
    pool?.destroy?.();
  }

  const laneRates = ratesFrom(results, 'lane');
  const serialRates = ratesFrom(results, 'serial');
  const freshMix = freshUserCappedEmailMix(mix);
  const laneFullHours = projectedHoursForLengthMix(freshMix, laneRates);
  const serialFullHours = projectedHoursForLengthMix(freshMix, serialRates);
  const groups = intelligenceGroups();
  const intelligence = intelligenceCoverageProjection(groups, laneRates);
  const chatHistoryFirstLane = chatHistoryFirstLaneProjection(groups, laneRates);
  const valuableMix = {
    short: Math.max(0, Number(mix.short || 0) - Number(mix.emailShort || 0)),
    medium: Math.max(0, Number(mix.medium || 0) - Number(mix.emailMedium || 0)),
    long: Math.max(0, Number(mix.long || 0) - Number(mix.emailLong || 0)),
  };
  const laneValuableHours = projectedHoursForLengthMix(valuableMix, laneRates);
  const firstVectorHours = 512 / Math.max(1, Number(laneRates.short || serialRates.short || 1));

  const report = {
    action: 'embed_throughput_benchmark',
    ok: Boolean(laneFullHours && laneFullHours > 0),
    checked_at: new Date().toISOString(),
    script: {
      path: SCRIPT_FILE,
      sha256: sha256('scripts/qa/embed-throughput-benchmark.mjs'),
    },
    dependencies: DEPS.map((rel) => ({ rel, sha256: sha256(rel) })),
    policy: {
      medium_input_chars: EMBED_MEDIUM_INPUT_CHARS,
      long_input_chars: EMBED_LONG_INPUT_CHARS,
      fresh_user_email_cap: 'overlong email chunks are compacted into the medium tier at ingest',
    },
    samples: { short: short.length, medium: medium.length, long: long.length },
    corpus_mix: mix,
    fresh_user_capped_mix: freshMix,
    valuable_non_email_mix: valuableMix,
    chat_history_first_lane: chatHistoryFirstLane,
    first_hour_intelligence: intelligence,
    lane_ready_ms: laneReadyMs,
    results,
    rates_per_hour: {
      serial: serialRates,
      lane: laneRates,
    },
    projected_hours: {
      first_vector: Number(firstVectorHours.toFixed(3)),
      valuable: laneValuableHours === null ? null : Number(laneValuableHours.toFixed(3)),
      full_drain: laneFullHours === null ? null : Number(laneFullHours.toFixed(3)),
      serial_full_drain: serialFullHours === null ? null : Number(serialFullHours.toFixed(3)),
    },
  };

  mkdirSync(dirname(RESULT_FILE), { recursive: true });
  writeFileSync(RESULT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(`[embed-throughput-benchmark] ${err?.stack || err?.message || err}`);
  process.exitCode = 1;
});
