#!/usr/bin/env node
/**
 * Provisions a Let's Encrypt TLS cert for {slug}.robotdojo.ai via ACME DNS-01.
 * DNS challenge records are managed via the Vercel CLI (already authenticated).
 *
 * Usage: node scripts/provision-cert.js [--slug dojo] [--force]
 *
 * Output: cert + key saved to ~/.robotdojo/tls/device.{crt,key}
 */
import acme from 'acme-client';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { X509Certificate } from 'node:crypto';

const args = process.argv.slice(2);
const force = args.includes('--force');
const slugIdx = args.indexOf('--slug');
const slug = slugIdx !== -1 ? args[slugIdx + 1] : (process.env.ROBOTDOJO_DEVICE_SLUG || 'dojo');

const TLS_DIR   = resolve(homedir(), '.robotdojo', 'tls');
const CERT_PATH = resolve(TLS_DIR, 'device.crt');
const KEY_PATH  = resolve(TLS_DIR, 'device.key');
const ACME_KEY  = resolve(TLS_DIR, 'acme-account.key');
const DOMAIN    = `${slug}.robotdojo.ai`;
const DNS_ZONE  = 'robotdojo.ai';

mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });

// Check if existing cert is valid for 30+ days
if (!force && existsSync(CERT_PATH)) {
  try {
    const cert = new X509Certificate(readFileSync(CERT_PATH, 'utf8'));
    const daysLeft = (new Date(cert.validTo) - Date.now()) / 86400000;
    if (daysLeft > 30) {
      console.info(`[provision-cert] cert valid for ${daysLeft.toFixed(0)} more days — skipping (use --force to renew)`);
      console.info(`  cert: ${CERT_PATH}`);
      console.info(`  key:  ${KEY_PATH}`);
      process.exit(0);
    }
    console.info(`[provision-cert] cert expires in ${daysLeft.toFixed(0)} days — renewing`);
  } catch {}
}

console.info(`[provision-cert] provisioning cert for ${DOMAIN}`);

// Load or generate ACME account key
let accountKey;
if (existsSync(ACME_KEY)) {
  accountKey = readFileSync(ACME_KEY);
  console.info('[provision-cert] loaded existing ACME account key');
} else {
  accountKey = await acme.crypto.createPrivateKey();
  writeFileSync(ACME_KEY, accountKey, { mode: 0o600 });
  console.info('[provision-cert] generated new ACME account key');
}

// Generate cert private key + CSR
const [certKey, csr] = await acme.crypto.createCsr({ altNames: [DOMAIN] });

const client = new acme.Client({
  directoryUrl: acme.directory.letsencrypt.production,
  accountKey,
});

// Track TXT record IDs for cleanup
const addedRecordIds = [];

// _acme-challenge.dojo.robotdojo.ai → relative name is _acme-challenge.dojo
const challengeRelativeName = `_acme-challenge.${slug}`;

let certPem;
try {
  certPem = await client.auto({
    csr,
    email: process.env.ROBOTDOJO_CERT_EMAIL || 'admin@robotdojo.ai',
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],

    challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
      console.info(`[provision-cert] adding TXT ${challengeRelativeName}.${DNS_ZONE} = ${keyAuthorization.slice(0, 20)}...`);
      const out = execSync(
        `vercel dns add ${DNS_ZONE} '${challengeRelativeName}' TXT '${keyAuthorization}'`,
        { encoding: 'utf8', timeout: 30000 },
      );
      console.info('[provision-cert]', out.trim());
      const m = out.match(/rec_[a-f0-9]+/i);
      if (m) addedRecordIds.push(m[0]);
      // Wait for DNS propagation
      console.info('[provision-cert] waiting 20s for DNS propagation...');
      await new Promise(r => setTimeout(r, 20000));
    },

    challengeRemoveFn: async (_authz, _challenge, _keyAuthorization) => {
      for (const id of addedRecordIds) {
        try {
          execSync(`vercel dns rm ${id} --yes`, { encoding: 'utf8', timeout: 15000 });
          console.info(`[provision-cert] removed TXT record ${id}`);
        } catch (e) {
          console.warn(`[provision-cert] could not remove DNS record ${id}: ${e.message}`);
        }
      }
      addedRecordIds.length = 0;
    },
  });
} catch (e) {
  console.error('[provision-cert] ACME challenge failed:', e.message);
  for (const id of addedRecordIds) {
    try { execSync(`vercel dns rm ${id} --yes`, { encoding: 'utf8', timeout: 15000 }); } catch {}
  }
  process.exit(1);
}

writeFileSync(CERT_PATH, certPem, { mode: 0o600 });
writeFileSync(KEY_PATH, certKey, { mode: 0o600 });

console.info(`[provision-cert] cert provisioned successfully`);
console.info(`  domain: ${DOMAIN}`);
console.info(`  cert:   ${CERT_PATH}`);
console.info(`  key:    ${KEY_PATH}`);

const cert = new X509Certificate(certPem);
console.info(`  valid:  ${cert.validFrom} → ${cert.validTo}`);
