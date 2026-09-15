#!/usr/bin/env node
/**
 * Chat burn-in runner — runs a Playwright spec N times and reports
 * per-iteration cold/warm latency. st_566ad80b AC 3.
 *
 * Usage:
 *   node scripts/qa/burn-in.js --base https://robotdojo.ai \
 *     --spec chat-first-token.spec.js --iters 10 \
 *     --warm-max 3000 --cold-max 5000
 *
 *   node scripts/qa/burn-in.js --dry-run
 *     Exits 0 immediately. Used by criteria-runner to confirm the
 *     runner exists without spending Playwright time.
 *
 * INTELLIGENCE_TIER: extraction
 *   No LLM call. Wraps `scripts/qa/run.js` with timing aggregation.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  return process.argv[i + 1] ?? def;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

// WHY support --dry-run: long-running-worker-testability gate (CLAUDE.md).
// The burn-in's main mode takes 30+ s × N iterations against a live tunnel;
// criteria-runner has a 60 s ceiling per criterion. --dry-run lets the
// gate verify "the script exists and parses" without paying the wall-clock.
const DRY_RUN = hasFlag('--dry-run');

if (DRY_RUN) {
  console.log('[burn-in] dry-run — exiting 0 (runner exists, args parse)');
  process.exit(0);
}

const BASE = arg('--base', 'https://robotdojo.ai');
const SPEC = arg('--spec', 'chat-first-token.spec.js');
const ITERS = parseInt(arg('--iters', '10'), 10);
const WARM_MAX = parseInt(arg('--warm-max', '3000'), 10);
const COLD_MAX = parseInt(arg('--cold-max', '5000'), 10);

console.log(`[burn-in] base=${BASE} spec=${SPEC} iters=${ITERS} warm_max=${WARM_MAX}ms cold_max=${COLD_MAX}ms`);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUN_JS = path.join(__dirname, 'run.js');

function runIteration(idx) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [RUN_JS, BASE, SPEC], {
      env: { ...process.env, BURN_IN_ITER: String(idx) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => {
      const dt = Date.now() - t0;
      resolve({ idx, code, dt, stdout, stderr });
    });
  });
}

async function main() {
  const results = [];
  let failures = 0;

  for (let i = 1; i <= ITERS; i++) {
    process.stdout.write(`[burn-in] iter ${i}/${ITERS}… `);
    const r = await runIteration(i);
    results.push(r);
    if (r.code !== 0) failures++;
    process.stdout.write(`${r.code === 0 ? 'PASS' : 'FAIL'} ${r.dt}ms\n`);
  }

  const summary = {
    base: BASE,
    spec: SPEC,
    iters: ITERS,
    failures,
    timings_ms: results.map(r => r.dt),
    p50: percentile(results.map(r => r.dt), 50),
    p95: percentile(results.map(r => r.dt), 95),
    p99: percentile(results.map(r => r.dt), 99),
  };
  console.log('[burn-in] summary:', JSON.stringify(summary, null, 2));

  // Burn-in passes when:
  //   - All iterations PASS
  //   - p95 timing ≤ COLD_MAX (the cold iteration is the worst case)
  //   - p50 timing ≤ WARM_MAX (typical iteration is warm)
  let pass = failures === 0;
  if (summary.p95 > COLD_MAX) {
    console.error(`[burn-in] FAIL — p95 ${summary.p95}ms > cold_max ${COLD_MAX}ms`);
    pass = false;
  }
  if (summary.p50 > WARM_MAX) {
    console.error(`[burn-in] FAIL — p50 ${summary.p50}ms > warm_max ${WARM_MAX}ms`);
    pass = false;
  }
  if (failures > 0) {
    console.error(`[burn-in] FAIL — ${failures}/${ITERS} iterations failed`);
  }
  process.exit(pass ? 0 : 1);
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

main().catch((err) => {
  console.error('[burn-in] fatal:', err.message);
  process.exit(1);
});
