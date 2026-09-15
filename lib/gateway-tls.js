/**
 * TLS certificate provisioning for the SNI passthrough tunnel.
 *
 * Provisions a TLS cert for {slug}.robotdojo.ai via the relay's cert API.
 * The relay does the actual ACME DNS-01 challenge — it controls the
 * robotdojo.ai DNS zone so it can set _acme-challenge TXT records.
 *
 * Flow:
 *   1. Check if cert already exists and has > 30 days remaining. If so, skip.
 *   2. Generate RSA-2048 keypair using `openssl genrsa` (requires openssl in PATH).
 *      NOTE: Node's built-in `crypto.generateKeyPairSync` produces PKCS#8 keys
 *      and cannot natively generate a CSR without implementing raw ASN.1 DER
 *      encoding. Rather than bundle a full X.509 library, we shell out to
 *      openssl which is available on every macOS install. If openssl is not
 *      found, this function returns null and cert provisioning is deferred to
 *      a manual step.
 *   3. Generate a CSR for {slug}.robotdojo.ai using `openssl req`.
 *   4. POST the CSR (base64-encoded DER) to:
 *        POST https://relay.robotdojo.ai/api/provision-cert
 *        Authorization: Bearer <deviceSecret>
 *        Body: { slug, csr: base64-DER }
 *   5. Save the returned PEM cert to the active config dir's tls/device.crt
 *   6. Save the private key PEM to the active config dir's tls/device.key
 *
 * Returns: { certPath, keyPath } on success, null on failure.
 */

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import config from './config.js';

const TLS_DIR   = config.tlsCertDir;
const CERT_PATH = resolve(TLS_DIR, 'device.crt');
const KEY_PATH  = resolve(TLS_DIR, 'device.key');
const CSR_PATH  = resolve(TLS_DIR, 'device.csr');  // temp, cleaned up after use

// mkcert-provisioned local cert for localhost / 127.0.0.1 / ::1 (st_bc949e7c).
// install.sh#provision_mkcert_local_tls writes both paths; index.js' SNI
// handler picks this cert when the SNI servername is one of the local
// hostnames. The device cert above is bound to {slug}.robotdojo.ai and is
// NOT trusted by browsers for `localhost` SNI — that's exactly why this
// second cert exists.
const LOCALHOST_CERT_PATH = resolve(TLS_DIR, 'localhost.crt');
const LOCALHOST_KEY_PATH  = resolve(TLS_DIR, 'localhost.key');

// How many days before expiry we consider a cert "expiring soon" and re-issue.
const RENEW_THRESHOLD_DAYS = 30;

/**
 * Return { certPath, keyPath } if a valid, non-expiring cert already exists.
 * Returns null otherwise.
 */
export function getCertPaths() {
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    return { certPath: CERT_PATH, keyPath: KEY_PATH };
  }
  return null;
}

/**
 * Return { certPath, keyPath } for the mkcert-provisioned localhost cert
 * if both files exist on disk; null otherwise. install.sh provisions these
 * via `mkcert -cert-file <config>/tls/localhost.crt -key-file
 * <config>/tls/localhost.key localhost 127.0.0.1 ::1` (st_bc949e7c).
 *
 * No expiry check: mkcert local CA certs are valid for 825 days by default
 * and are renewed by re-running install.sh — there's no remote API to fail
 * the way the device cert can. If the file is malformed, the TLS handshake
 * will fail at connect time with a clear node error rather than silently
 * here.
 */
export function getLocalhostCertPaths() {
  if (existsSync(LOCALHOST_CERT_PATH) && existsSync(LOCALHOST_KEY_PATH)) {
    return { certPath: LOCALHOST_CERT_PATH, keyPath: LOCALHOST_KEY_PATH };
  }
  return null;
}

/**
 * Check whether the existing cert has more than RENEW_THRESHOLD_DAYS left.
 * Returns true if the cert is present AND not expiring soon.
 */
function isCertValid() {
  if (!existsSync(CERT_PATH)) return false;
  try {
    const pem  = readFileSync(CERT_PATH, 'utf8');
    const cert = new X509Certificate(pem);
    const expiresAt = new Date(cert.validTo);
    const daysLeft  = (expiresAt - Date.now()) / (1000 * 60 * 60 * 24);
    return daysLeft > RENEW_THRESHOLD_DAYS;
  } catch (e) {
    console.warn('[gateway-tls] could not parse existing cert:', e.message);
    return false;
  }
}

/**
 * Locate the openssl binary. Checks PATH via `which openssl`.
 * Returns the path string or null if not found.
 */
function findOpenssl() {
  try {
    return execSync('which openssl', { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Provision (or renew) a TLS cert for {slug}.robotdojo.ai.
 *
 * @param {{ slug?: string, deviceSecret?: string, gatewayUrl?: string }} opts
 * @returns {Promise<{ certPath: string, keyPath: string } | null>}
 */
export async function provisionCert(opts = {}) {
  const slug         = opts.slug         ?? config.deviceSlug;
  const deviceSecret = opts.deviceSecret ?? config.deviceSecret;
  const gatewayUrl   = opts.gatewayUrl   ?? config.gatewayUrl;
  const bootstrapSecret = opts.bootstrapSecret ?? config.relayBootstrapSecret;

  if (!slug || !deviceSecret || !gatewayUrl || !bootstrapSecret) {
    console.warn('[gateway-tls] slug / deviceSecret / gatewayUrl / relay bootstrap secret not configured — skipping cert provisioning');
    return null;
  }

  // 1. Skip if cert is valid and not expiring soon
  if (isCertValid()) {
    console.info('[gateway-tls] cert is valid and not expiring soon — skipping provisioning');
    return getCertPaths();
  }

  // 2. Locate openssl
  const opensslBin = findOpenssl();
  if (!opensslBin) {
    // NOTE: openssl not found — cert provisioning requires a manual step.
    // Install openssl via `brew install openssl` and re-run install.sh.
    console.warn('[gateway-tls] openssl not found in PATH — cannot generate CSR. Cert provisioning deferred.');
    return null;
  }

  // Ensure the active config dir's tls/ exists
  mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });

  // 3. Generate RSA-2048 private key (only if it doesn't already exist)
  if (!existsSync(KEY_PATH)) {
    try {
      execFileSync(opensslBin, ['genrsa', '-out', KEY_PATH, '2048'], {
        stdio: 'pipe',
        timeout: 15000,
      });
      console.info('[gateway-tls] RSA-2048 private key generated at', KEY_PATH);
    } catch (e) {
      console.error('[gateway-tls] key generation failed:', e.message);
      return null;
    }
  }

  // 4. Generate CSR for {slug}.robotdojo.ai
  const cn = `${slug}.robotdojo.ai`;
  try {
    execFileSync(
      opensslBin,
      [
        'req', '-new',
        '-key', KEY_PATH,
        '-out', CSR_PATH,
        '-subj', `/CN=${cn}`,
        // SAN is added via a config snippet to satisfy modern CA requirements
        '-addext', `subjectAltName=DNS:${cn}`,
      ],
      { stdio: 'pipe', timeout: 15000 },
    );
  } catch (e) {
    console.error('[gateway-tls] CSR generation failed:', e.message);
    return null;
  }

  // Export CSR as DER (binary), then base64-encode for the API payload
  let csrBase64;
  try {
    const derBuf = execFileSync(
      opensslBin,
      ['req', '-in', CSR_PATH, '-outform', 'DER'],
      { timeout: 10000 },
    );
    csrBase64 = derBuf.toString('base64');
  } catch (e) {
    console.error('[gateway-tls] CSR DER export failed:', e.message);
    return null;
  } finally {
    // Clean up temp CSR file
    try { execSync(`rm -f ${CSR_PATH}`, { stdio: 'ignore' }); } catch {}
  }

  // 5. POST CSR to relay's provisioning API
  const apiUrl = `${gatewayUrl.replace(/\/+$/, '')}/api/provision-cert`;
  let certPem;
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${deviceSecret}`,
        'Content-Type': 'application/json',
        'x-robotdojo-bootstrap': bootstrapSecret,
      },
      body: JSON.stringify({ slug, csr: csrBase64 }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[gateway-tls] relay returned ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const json = await res.json();
    certPem = json.cert || json.certificate || null;
    if (!certPem) {
      console.error('[gateway-tls] relay response missing cert field:', JSON.stringify(json).slice(0, 200));
      return null;
    }
  } catch (e) {
    console.error('[gateway-tls] relay API call failed:', e.message);
    return null;
  }

  // 6. Save cert
  try {
    writeFileSync(CERT_PATH, certPem, { mode: 0o600 });
    console.info(`[gateway-tls] cert provisioned for ${cn} → ${CERT_PATH}`);
  } catch (e) {
    console.error('[gateway-tls] failed to write cert:', e.message);
    return null;
  }

  return { certPath: CERT_PATH, keyPath: KEY_PATH };
}
