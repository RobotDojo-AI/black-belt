/**
 * cert-provision.js — POST /api/provision-cert.
 *
 * Fresh installs terminate TLS on the user's Mac. The Mac generates the private
 * key and CSR locally, then asks the relay to complete DNS-01 because the relay
 * owns robotdojo.ai DNS at Cloudflare (st_63b59bda — moved off the old Vercel
 * DNS API). The private key never leaves the Mac.
 *
 * Two DNS actions in one request, both via gateway/lib/cloudflare-dns.js:
 *   1. The transient `_acme-challenge` TXT record that Let's Encrypt validates.
 *   2. The durable routing record: an UNPROXIED A record pointing
 *      `{slug}.robotdojo.ai` at this VPS, replacing any prior proxied CNAME so
 *      the raw ClientHello reaches the blind splice instead of Cloudflare's edge.
 */
import { Hono } from 'hono';
import acme from 'acme-client';
import { validateBootstrapProof, validateDevice } from '../lib/device-registry.js';
import { addTxtRecord, removeRecord, upsertRoutingRecord } from '../lib/cloudflare-dns.js';

const DNS_ZONE = process.env.DNS_ZONE || 'robotdojo.ai';
const ACME_EMAIL = process.env.ACME_CONTACT_EMAIL || 'hello@robotdojo.ai';
const ACME_DIRECTORY = process.env.ACME_DIRECTORY_URL || acme.directory.letsencrypt.production;
const GATEWAY_PUBLIC_IP = process.env.GATEWAY_PUBLIC_IP || '';
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

let accountKeyPromise = null;

async function accountKey() {
  if (process.env.GATEWAY_ACME_ACCOUNT_KEY) return process.env.GATEWAY_ACME_ACCOUNT_KEY;
  // Persistent ACME account key (st_63b59bda hardening). A PEM has newlines that
  // a systemd EnvironmentFile can't carry, so accept a file path instead. Reusing
  // one account across restarts avoids churning Let's Encrypt account registrations
  // (a rate-limited operation) every time the relay bounces.
  const keyFile = process.env.GATEWAY_ACME_ACCOUNT_KEY_FILE;
  if (keyFile) {
    try {
      const { readFileSync } = await import('node:fs');
      return readFileSync(keyFile, 'utf8');
    } catch (e) {
      console.error('[cert-provision] account key file unreadable, generating ephemeral:', e.message);
    }
  }
  accountKeyPromise ||= acme.crypto.createPrivateKey();
  return accountKeyPromise;
}

function derToPem(label, der) {
  const body = Buffer.from(der).toString('base64').match(/.{1,64}/g)?.join('\n') || '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/**
 * @returns {Hono}
 */
export function certProvisionRoutes(opts = {}) {
  const bootstrapSecret = typeof opts === 'object'
    ? opts.bootstrapSecret ?? process.env.GATEWAY_BOOTSTRAP_SECRET ?? ''
    : process.env.GATEWAY_BOOTSTRAP_SECRET ?? '';
  const app = new Hono();

  app.post('/api/provision-cert', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const deviceSecret = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const bootstrapProof = c.req.header('x-robotdojo-bootstrap') ?? '';

    let body;
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'invalid_json' }, 400); }

    const slug = typeof body?.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    const csrBase64 = typeof body?.csr === 'string' ? body.csr.trim() : '';
    if (!SLUG_REGEX.test(slug) || !csrBase64) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    const proof = validateBootstrapProof(bootstrapProof, bootstrapSecret);
    if (!proof.ok) {
      const status = proof.reason === 'bootstrap_not_configured' ? 503 : 401;
      return c.json({ error: proof.reason }, status);
    }

    const device = await validateDevice(slug, deviceSecret);
    if (!device.ok) return c.json({ error: 'unauthorized' }, 401);

    let csr;
    let domains;
    try {
      csr = derToPem('CERTIFICATE REQUEST', Buffer.from(csrBase64, 'base64'));
      domains = acme.crypto.readCsrDomains(csr);
    } catch (e) {
      return c.json({ error: 'invalid_csr', message: e.message }, 400);
    }

    const expected = `${slug}.${DNS_ZONE}`;
    const names = new Set([domains.commonName, ...(domains.altNames || [])].filter(Boolean));
    if (names.size !== 1 || !names.has(expected)) {
      return c.json({ error: 'csr_domain_mismatch' }, 400);
    }

    const client = new acme.Client({
      directoryUrl: ACME_DIRECTORY,
      accountKey: await accountKey(),
    });

    const recordIds = [];
    let certificate;
    try {
      certificate = await client.auto({
        csr,
        email: ACME_EMAIL,
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        skipChallengeVerification: false,
        challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
          const id = await addTxtRecord(slug, keyAuthorization);
          recordIds.push(id);
          await new Promise((resolve) => setTimeout(resolve, 25_000));
        },
        challengeRemoveFn: async () => {
          await Promise.all(recordIds.splice(0).map(removeRecord));
        },
      });
    } catch (e) {
      await Promise.all(recordIds.splice(0).map(removeRecord));
      console.error('[cert-provision] failed:', e.message);
      return c.json({ error: 'cert_provision_failed' }, 502);
    }

    // Cert issued. Now point the subdomain straight at this VPS with an
    // UNPROXIED A record (replacing any interim proxied CNAME). This is what
    // makes the relay actually reachable AND blind — a proxied record would let
    // Cloudflare decrypt in front of the splice.
    try {
      await upsertRoutingRecord(slug, GATEWAY_PUBLIC_IP);
    } catch (e) {
      console.error('[cert-provision] routing record upsert failed:', e.message);
      return c.json({ error: 'routing_record_failed', message: e.message }, 502);
    }

    return c.json({ ok: true, cert: certificate });
  });

  return app;
}
