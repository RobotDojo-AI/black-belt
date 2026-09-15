import { startIntelRegenerationJob } from './health-intel.js';
import { clearHealthMarkerPayloadCache } from './health-marker-payload-cache.js';

let healthMarkerPayloadWarmer = null;

export function registerHealthMarkerPayloadWarmer(warmer) {
  healthMarkerPayloadWarmer = typeof warmer === 'function' ? warmer : null;
}

function invalidateHealthMarkerPayloads({ reason } = {}) {
  clearHealthMarkerPayloadCache();
  if (!healthMarkerPayloadWarmer) return;
  try {
    healthMarkerPayloadWarmer({ reason });
  } catch (err) {
    console.warn(`[health-intel] could not prewarm marker payloads after ${reason}: ${err.message}`);
  }
}

// Auto-regeneration is now OPT-IN (df_feb7754e): no automatic health-data change
// spends a paid model call. Health intel regenerates only on an explicit owner
// command via the manual routes, which bypass this gate by design.
//
// The test-environment disables (NODE_ENV==='test' / ':memory:' / an rd-test db
// path) are evaluated FIRST so a test can never fall through to the flag and fire
// Opus, whatever the flag is set to. Only when none of those hold does the opt-in
// flag decide: auto-regen stays OFF unless ROBOTDOJO_HEALTH_INTEL_AUTO_REGEN is
// exactly '1'. Exported so the gate can be unit-tested directly (df_feb7754e).
export function autoRegenerationDisabled() {
  const dbPath = process.env.ROBOTDOJO_DB || '';
  return process.env.NODE_ENV === 'test'
    || dbPath === ':memory:'
    || /\/rd-test|\\rd-test/.test(dbPath)
    || process.env.ROBOTDOJO_HEALTH_INTEL_AUTO_REGEN !== '1';
}

export function queueHealthIntelRegeneration({ reason = 'health_data_updated', inserted = null } = {}) {
  invalidateHealthMarkerPayloads({ reason });
  if (autoRegenerationDisabled()) {
    return {
      job: null,
      alreadyRunning: false,
      queued: false,
      skipped: true,
      reason,
    };
  }

  try {
    const result = startIntelRegenerationJob({ reason });
    console.info(`[health-intel] queued regeneration after ${reason}${inserted == null ? '' : ` (+${inserted})`}`);
    return { ...result, skipped: false, reason };
  } catch (err) {
    console.warn(`[health-intel] could not queue regeneration after ${reason}: ${err.message}`);
    return {
      job: null,
      alreadyRunning: false,
      queued: false,
      skipped: false,
      reason,
      error: err.message,
    };
  }
}

export function queueHealthIntelRegenerationIfChanged({ inserted = 0, dryRun = false, reason = 'health_data_updated' } = {}) {
  const count = Number(inserted || 0);
  if (dryRun || count <= 0) return null;
  return queueHealthIntelRegeneration({ reason, inserted: count });
}
