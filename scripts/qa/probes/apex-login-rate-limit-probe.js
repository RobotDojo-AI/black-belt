#!/usr/bin/env node
/**
 * st_fc3856d6 — apex login rate-limit probe (AC 5).
 *
 * Fires 6 sequential POSTs from the same simulated source IP against
 * https://robotdojo.ai/api/auth/token with deliberately wrong credentials.
 *
 * Pass criteria:
 *   - First 5 responses return 401 (invalid_credentials).
 *   - 6th response returns 429 (rate_limited).
 *
 * Vercel Edge instances each maintain their own in-memory rate map
 * (api/auth/token.js mirrors api/feedback.js's per-instance pattern).
 * If requests load-balance across two different isolates, the cap
 * resets — the probe accepts the risk that in worst case the 6th call
 * lands on a fresh isolate. The rate-limit cap is best-effort, not
 * adversarial-strength, by design (see 02-plan.md failure manifest).
 *
 * The probe sleeps 65 s at exit so the next criteria-runner pass
 * starts on a cleared window per the plan's idempotency note.
 *
 * Exits 0 on pass, 1 on failure.
 */

const APEX_URL = 'https://robotdojo.ai/api/auth/token';
const ATTEMPTS = 6;
// Random source-IP per run so consecutive probe runs do not stack
// against the same rate-limit bucket on a long-lived isolate.
const SIM_IP = `198.51.100.${10 + Math.floor(Math.random() * 200)}`;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function attempt(headers) {
  const res = await fetch(APEX_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ server: 'dojo', token: 'definitely-not-the-token' }),
  });
  return res.status;
}

async function main() {
  // The Vercel runtime ultimately keys rate-limit on the real client IP
  // (visible via x-vercel-forwarded-for). Earlier probes in the same
  // criteria-runner pass (apex-login-enumeration-probe runs 20 requests
  // before this probe runs) leave the bucket hot. The 1-minute rolling
  // window must clear before this probe can run an accurate cap test —
  // wait unconditionally, since the budget exhausted from any prior
  // run-in-same-isolate would produce a false negative.
  console.log('clearing rate-limit window (sleeping 65s)...');
  await sleep(65_000);

  const statuses = [];
  for (let i = 0; i < ATTEMPTS; i++) {
    statuses.push(await attempt({ 'x-forwarded-for': SIM_IP }));
  }

  const first5 = statuses.slice(0, 5);
  const sixth = statuses[5];
  const ok401s = first5.every((s) => s === 401);
  if (!ok401s) fail(`expected first 5 statuses all 401, got [${first5.join(',')}]`);
  if (sixth !== 429) {
    fail(`expected 6th status 429, got ${sixth}; full sequence [${statuses.join(',')}]`);
  }

  console.log(`ok — rate limit: [${statuses.join(',')}]`);
  // Note: the pre-probe 65s sleep above replaces the prior post-probe
  // sleep — order-independence is achieved by clearing the window
  // before any attempts rather than after.
}

main().catch((err) => fail(`probe threw: ${err?.message || err}`));
