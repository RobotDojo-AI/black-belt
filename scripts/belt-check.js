#!/usr/bin/env node
/**
 * belt-check — periodic sanity sweep of the Black Belt key.
 *
 * Responsibilities:
 *   1. If the key is past its grace window, delete it + unload modules.
 *   2. Optionally ping the gateway for belt status (future — stubbed).
 *
 * Wire via launchd (macOS) or systemd timer (Linux) every ~1h:
 *     node scripts/belt-check.js
 *
 * Exit code 0 on success (including "nothing to do"), 1 on unexpected error.
 */
import { loadKey, isExpired, deleteKey } from '../lib/key-store.js';
import { loadModules, unloadModules, getLoadedBelt } from '../lib/module-loader.js';

async function main() {
  const meta = await loadKey();

  if (!meta) {
    console.info('[belt-check] no key present — White Belt');
    return;
  }

  if (isExpired(meta)) {
    console.info(`[belt-check] grace expired at ${meta.graceUntil} — revoking`);
    await deleteKey();
    unloadModules();
    console.info('[belt-check] key deleted, modules unloaded');
    return;
  }

  // Grace window active but not expired, or no grace set (healthy key).
  // Rehydrate modules in case the process is running but empty.
  const result = await loadModules();
  console.info(`[belt-check] healthy — belt=${result.belt} loaded=${getLoadedBelt()} modules=${result.modules?.length ?? 0}`);

  if (meta.graceUntil) {
    const remaining = Math.max(0, Date.parse(meta.graceUntil) - Date.now());
    const hrs = Math.round(remaining / 3600000);
    console.info(`[belt-check] grace window active — ${hrs}h remaining`);
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error('[belt-check] error:', e.message); process.exit(1); }
);
