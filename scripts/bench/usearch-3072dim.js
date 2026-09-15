#!/usr/bin/env node
/**
 * usearch micro-bench at production dimensionality (3072d Voyage).
 *
 * st_566ad80b. Run once during build to calibrate
 * HNSW_P99_PER_VEC_US in lib/ann/ann-config.js. Output is committed to
 * the story's bench-result.json (under the wk_robot_dojo stories tree) so
 * the chosen latency cap is reproducible.
 *
 * INTELLIGENCE_TIER: extraction
 *   No LLM calls. Synthetic data; pure arithmetic + native HNSW.
 *
 * Methodology:
 *   1. Build a synthetic index with N random unit vectors at dim=3072.
 *   2. Run M random queries; capture per-query wall-clock.
 *   3. Report mean, p50, p95, p99 latency.
 *   4. Also report build time and RSS delta (rough RAM footprint).
 *
 * The number that matters: p99 per-query latency. The hot-tier sizer
 * uses (latency_target_ms × 1000) / p99_per_vec_us to compute the
 * vector budget. If this bench changes the p99 figure materially,
 * update HNSW_P99_PER_VEC_US.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { Index } from 'usearch';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIM = 3072;
const N = parseInt(process.env.BENCH_N || '10000', 10);
const M = parseInt(process.env.BENCH_M || '200', 10);

function randomUnitVector(d) {
  const v = new Float32Array(d);
  let mag2 = 0;
  for (let i = 0; i < d; i++) {
    // Box-Muller-ish; doesn't need to be precise — we just want diverse
    // points spread on the unit sphere.
    v[i] = Math.random() * 2 - 1;
    mag2 += v[i] * v[i];
  }
  const mag = Math.sqrt(mag2);
  for (let i = 0; i < d; i++) v[i] /= mag;
  return v;
}

function rssMb() {
  try { return process.memoryUsage.rss() / (1024 * 1024); } catch { return 0; }
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  console.info(`[bench] usearch ${DIM}d N=${N} M=${M}`);
  const rssBefore = rssMb();

  // ── Build ────────────────────────────────────────────────────────────────
  const idx = new Index({
    metric: 'cos',
    dimensions: DIM,
    connectivity: 16,
    expansion_add: 128,
    expansion_search: 64,
  });

  const buildStart = Date.now();
  for (let i = 0; i < N; i++) {
    idx.add(BigInt(i), randomUnitVector(DIM));
  }
  const buildMs = Date.now() - buildStart;
  console.info(`[bench] build: ${N} vectors in ${buildMs} ms (${(N / (buildMs / 1000)).toFixed(0)} vec/s)`);

  // ── Query ────────────────────────────────────────────────────────────────
  const queries = Array.from({ length: M }, () => randomUnitVector(DIM));
  const latencies = [];

  // Warmup — first few queries are JIT noise.
  for (let i = 0; i < Math.min(10, M); i++) {
    idx.search(queries[i], 10);
  }

  for (let i = 0; i < M; i++) {
    const t0 = process.hrtime.bigint();
    idx.search(queries[i], 10);
    const t1 = process.hrtime.bigint();
    latencies.push(Number(t1 - t0) / 1000); // → microseconds
  }
  latencies.sort((a, b) => a - b);

  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);

  const rssAfter = rssMb();

  // Per-vector cost approximation: HNSW search visits ~log(N) * ef_search
  // nodes. We report the total query latency µs and let the sizer use that
  // directly — the "p99 per-vec" naming in ann-config is the conservative
  // upper bound, used as the divisor in latency_budget / per_vec.
  // For sizing purposes the relevant number is "how many vectors can the
  // hot tier hold so that the FULL search (not per-vec) finishes within
  // the p99 latency target." That's the µs/query number divided by hot
  // size. We report it as a "p99_per_vec_us" ratio for symmetry with the
  // sizer formula.
  const p99PerVecUs = p99 / N;

  const result = {
    timestamp: new Date().toISOString(),
    machine: {
      arch: process.arch,
      platform: process.platform,
      cpus: (await import('node:os')).cpus().length,
    },
    params: { dim: DIM, n: N, m: M, k: 10, M_connectivity: 16, ef_construction: 128, ef_search: 64 },
    build: { ms: buildMs, vec_per_sec: Math.round(N / (buildMs / 1000)) },
    query_us: {
      mean: Math.round(mean),
      p50: Math.round(p50),
      p95: Math.round(p95),
      p99: Math.round(p99),
    },
    p99_per_vec_us: Number(p99PerVecUs.toFixed(4)),
    rss_mb: { before: Math.round(rssBefore), after: Math.round(rssAfter), delta: Math.round(rssAfter - rssBefore) },
  };

  console.info(`[bench] query µs — mean=${result.query_us.mean} p50=${result.query_us.p50} p95=${result.query_us.p95} p99=${result.query_us.p99}`);
  console.info(`[bench] p99 per-vec µs = ${result.p99_per_vec_us}`);
  console.info(`[bench] RSS Δ = ${result.rss_mb.delta} MB`);

  // Write bench result next to this script's story directory.
  const __filename = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
  const outPath = path.join(repoRoot, 'user', 'workbenches', 'topics', 'work', 'robot-dojo', 'wk_robot_dojo', 'stories', 'st_566ad80b', 'bench-result.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.info(`[bench] wrote ${outPath}`);
}

main().catch(err => {
  console.error('[bench] fatal:', err.message);
  process.exit(1);
});
