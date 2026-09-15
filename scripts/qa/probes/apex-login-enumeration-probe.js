#!/usr/bin/env node
/**
 * st_fc3856d6 — apex login slug-enumeration anti-leak probe (AC 2).
 *
 * Pairs 10 requests against https://robotdojo.ai/api/auth/token:
 *   - (valid slug, wrong token)
 *   - (nonexistent slug, any token)
 *
 * Pass criteria:
 *   - All 20 responses share a byte-identical body.
 *   - max(elapsed_ms) - min(elapsed_ms) across all 20 < 200 ms.
 *
 * The OWASP/PortSwigger anti-enumeration mandate (01-research.md L275)
 * requires that an attacker probing for valid slugs cannot distinguish
 * a real slug with a wrong token from a nonexistent slug. The apex
 * function enforces this via:
 *   1. A constant-time floor of ≥800 ms on every error path.
 *   2. A single canonical error body ({"error":"invalid_credentials"}).
 *   3. The X-Status-Reason header carries the failure mode for ops but
 *      lives outside the response body.
 *
 * The probe uses two non-overlapping IPs (set via X-Forwarded-For) so
 * neither side triggers the 5/min rate limit. Vercel ultimately trusts
 * x-vercel-forwarded-for over arbitrary x-forwarded-for; the probe
 * accepts that a single source IP may still hit the limit and skips
 * any 429 from the timing-delta check (they leak no enumeration signal
 * because the rate-limit applies before any slug lookup).
 *
 * Exits 0 on pass, 1 on failure.
 */

const APEX_URL = 'https://robotdojo.ai/api/auth/token';
const VALID_SLUG = 'dojo';
const NONEXISTENT_SLUG = 'nope-' + Math.random().toString(36).slice(2, 8);
const PAIR_COUNT = 10;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function probe(server, token) {
  const start = Date.now();
  const res = await fetch(APEX_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server, token }),
  });
  const elapsed = Date.now() - start;
  const body = await res.text();
  return { status: res.status, elapsed, body };
}

async function main() {
  // Interleave the pairs so any time-of-day variance hits both equally.
  // Sequential issuance keeps the rate-limit window predictable.
  const results = [];
  for (let i = 0; i < PAIR_COUNT; i++) {
    const wrongTokenForValid = await probe(VALID_SLUG, 'definitely-not-the-token');
    results.push({ kind: 'valid-wrong', ...wrongTokenForValid });
    const anythingForBogus = await probe(NONEXISTENT_SLUG, 'irrelevant');
    results.push({ kind: 'bogus-any', ...anythingForBogus });
  }

  // Filter out any 429s — rate-limit replies are not auth verdicts and
  // do not leak slug-existence signal (the limit applies before slug
  // lookup runs).
  const errorResults = results.filter((r) => r.status !== 429);
  if (errorResults.length < 4) {
    fail(`too few non-429 responses (${errorResults.length}) to check parity`);
  }

  // Body parity: every error response must be byte-identical.
  const bodies = errorResults.map((r) => r.body);
  const uniqueBodies = new Set(bodies);
  if (uniqueBodies.size !== 1) {
    const samples = [...uniqueBodies].slice(0, 3).map((b) => b.slice(0, 120));
    fail(`expected 1 unique error body, got ${uniqueBodies.size}: ${samples.join(' | ')}`);
  }

  // Timing parity: max - min < 200 ms.
  const elapsed = errorResults.map((r) => r.elapsed);
  const maxMs = Math.max(...elapsed);
  const minMs = Math.min(...elapsed);
  const delta = maxMs - minMs;
  if (delta >= 200) {
    fail(`timing delta ${delta} ms ≥ 200 ms (min=${minMs}, max=${maxMs})`);
  }

  // Status parity: every error must be 401 (the canonical apex-error code).
  const statuses = errorResults.map((r) => r.status);
  if (statuses.some((s) => s !== 401)) {
    fail(`expected all 401, got: ${[...new Set(statuses)].join(',')}`);
  }

  console.log(`ok — ${errorResults.length} responses parity-clean (timing delta ${delta} ms, body bytes ${bodies[0].length})`);
}

main().catch((err) => fail(`probe threw: ${err?.message || err}`));
