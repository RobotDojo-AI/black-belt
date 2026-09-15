#!/usr/bin/env node
/**
 * Device-cert renewal agent (st_63b59bda hardening).
 *
 * Runs daily as com.robotdojo.cert-renew. Two steps, both idempotent:
 *   1. Register this device's slug at the relay (self-heals per-device auth if
 *      the relay ever lost its registry — fresh box, restore, redeploy).
 *   2. Renew the {slug}.robotdojo.ai cert through the relay if it is within
 *      RENEW_THRESHOLD_DAYS (30) of expiry. provisionCert() self-skips when the
 *      cert is still fresh, so running daily is cheap.
 *
 * Only restarts the local server when the cert actually changed, so a normal
 * (no-op) day is silent and non-disruptive.
 *
 * INTELLIGENCE_TIER: orchestration — no LLM, deterministic renewal only.
 */
import { execSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import config from '../lib/config.js';
import { registerDeviceAtRelay } from '../lib/relay-client.js';
import { provisionCert, getCertPaths } from '../lib/gateway-tls.js';

function certExpiry() {
  try {
    const { certPath } = getCertPaths();
    return new Date(new X509Certificate(readFileSync(certPath)).validTo).getTime();
  } catch { return 0; }
}

async function main() {
  const slug = config.deviceSlug;
  const deviceSecret = config.deviceSecret;
  if (!slug || !deviceSecret) {
    console.info('[cert-renew] no device slug/secret configured — nothing to do');
    return;
  }

  // 1. Idempotent self-healing registration.
  const reg = await registerDeviceAtRelay({ slug, deviceSecret });
  if (!reg?.ok) console.warn(`[cert-renew] register: ${reg?.error || 'failed'} (continuing to cert check)`);

  // 2. Renew if within threshold (provisionCert self-skips when fresh).
  const before = certExpiry();
  await provisionCert({});
  const after = certExpiry();

  if (after > before) {
    console.info('[cert-renew] cert renewed — restarting server to serve the new cert');
    try {
      execSync(`launchctl kickstart -k gui/$(id -u)/com.robotdojo.server`, { timeout: 8000 });
    } catch (e) {
      console.warn(`[cert-renew] server restart failed (new cert applies on next restart): ${e.message}`);
    }
  } else {
    console.info('[cert-renew] cert still fresh — no renewal needed');
  }
}

main().catch((e) => { console.error('[cert-renew] fatal:', e.message); process.exit(1); });
