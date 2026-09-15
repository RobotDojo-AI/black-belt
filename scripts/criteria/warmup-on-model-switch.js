#!/usr/bin/env node
/**
 * warmup-on-model-switch.js — VC M1 for st_566ad80b (AC 10).
 *
 * Synthesizes a `model-change` event on appEvents in-process, waits
 * briefly for the listener chain to settle, and verifies that a
 * `warmup_events` row with `trigger_reason='model-change'` was written
 * within 100 ms of the synthesized event.
 *
 * WHY in-process synthesis: the criteria-runner has a 60 s ceiling per
 * criterion (lib/criteria.json) — a live model-switch via the chat UI
 * exceeds that and is covered by the manual Playwright pass. This
 * criterion verifies the *wiring*: warmup module subscribes, handler
 * fires synchronously off emit(), the row writes within the latency
 * ceiling.
 *
 * Exit codes:
 *   0 = wiring works, row landed within 100 ms
 *   1 = no row, row late, or wrong trigger_reason
 *
 * INTELLIGENCE_TIER: extraction
 *   No LLM call. The synthetic provider name causes warmProvider to
 *   fail with "no provider found" — the row is still written with the
 *   error column populated, which is what we assert on.
 */

export const INTELLIGENCE_TIER = 'extraction';

import db from '../../lib/db.js';
import { appEvents } from '../../lib/app-events.js';
// Importing lib/warmup.js attaches the model-change subscriber.
import '../../lib/warmup.js';

const LATENCY_CEILING_MS = 100;
const SETTLE_MS = 250;

async function main() {
  // Snapshot the highest existing row so we don't confuse our own emit
  // with prior boot/test events.
  const before = db.prepare(`
    SELECT IFNULL(MAX(id), 0) AS max_id FROM warmup_events
  `).get();
  const beforeId = before?.max_id ?? 0;
  const beforeTs = Date.now();

  // Synthesize a model-change event. The provider name is intentionally
  // synthetic so we don't actually call out to a real API.
  appEvents.emit('model-change', {
    provider: 'criterion-test-provider',
    model: 'fast',
    prev_model: 'test-prev',
    source: 'warmup-on-model-switch-criterion',
  });

  // Give the async chain time to settle. The handler calls warmProvider
  // which awaits an SDK call (it will fail for the synthetic provider,
  // but the row still writes in the catch path).
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  const row = db.prepare(`
    SELECT id, provider, trigger_reason, started_at, latency_ms, error
    FROM warmup_events
    WHERE id > ? AND trigger_reason = 'model-change'
    ORDER BY started_at DESC
    LIMIT 1
  `).get(beforeId);

  if (!row) {
    console.error('[warmup-on-model-switch] FAIL — no warmup_events row written');
    process.exit(1);
  }

  // started_at is captured inside the handler. AC 10 requires the
  // warmup PING to fire within 100 ms of the model-change event.
  const delta = row.started_at - beforeTs;
  if (!(delta >= 0 && delta < LATENCY_CEILING_MS)) {
    console.error(
      `[warmup-on-model-switch] FAIL — started_at delta ${delta}ms not in [0, ${LATENCY_CEILING_MS}). ` +
      `Row: ${JSON.stringify(row)}`,
    );
    process.exit(1);
  }

  console.log(
    `[warmup-on-model-switch] ok — row id=${row.id} provider=${row.provider} ` +
    `delta=${delta}ms latency_ms=${row.latency_ms}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[warmup-on-model-switch] fatal:', err.message);
  process.exit(1);
});
