/**
 * cloudflare-dns.js — Cloudflare DNS API client for the blind relay's own
 * deploy tree (st_63b59bda).
 *
 * Two jobs, both run from the VPS that hosts the gateway:
 *   1. ACME DNS-01: create/remove the `_acme-challenge` TXT record so Let's
 *      Encrypt can validate a subdomain the Mac generated a CSR for.
 *   2. Routing: point `{slug}.robotdojo.ai` straight at THIS VPS with an
 *      UNPROXIED (DNS-only / grey-cloud) A record, replacing any prior proxied
 *      CNAME. `proxied: false` is the single load-bearing correctness property
 *      in this file: a proxied ("orange-cloud") record means Cloudflare's edge
 *      terminates TLS and decrypts every connection before the ClientHello ever
 *      reaches the blind splice — silently defeating the whole zero-knowledge
 *      premise while the product still appears to work.
 *
 * WHY a fresh reimplementation and not an import of the root app's (now removed)
 * per-user tunnel client's `cfRequest()`: `gateway/` and the root repo are
 * separately deployed trees — `gateway/Dockerfile` only COPYs the `gateway/`
 * directory, so it cannot reach a module in root `lib/`. This mirrors that
 * helper's auth/timeout/error-envelope CONTRACT, not its code.
 *
 * Auth: a Zone:DNS:Edit-scoped API token (CLOUDFLARE_API_TOKEN), never the
 * legacy Global API Key. The VPS's own public IP comes from GATEWAY_PUBLIC_IP —
 * the relay is the only party that knows which box the A record must point at.
 */

const CF_API_BASE = process.env.ROBOTDOJO_CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4';
const CF_TIMEOUT_MS = Number(process.env.ROBOTDOJO_CLOUDFLARE_TIMEOUT_MS) || 8000;
const DNS_ZONE = process.env.DNS_ZONE || 'robotdojo.ai';

/**
 * Read the two Cloudflare secrets. Throws a single clear Error naming every
 * missing variable so a misconfigured relay is an explained stop, never a
 * partial provision.
 * @returns {{ token: string, zoneId: string }}
 */
function cfConfig() {
  const token = process.env.CLOUDFLARE_API_TOKEN || '';
  const zoneId = process.env.CLOUDFLARE_ZONE_ID || '';
  const missing = [];
  if (!token) missing.push('CLOUDFLARE_API_TOKEN');
  if (!zoneId) missing.push('CLOUDFLARE_ZONE_ID');
  if (missing.length) {
    throw new Error(`Cloudflare DNS credentials not configured: missing ${missing.join(', ')}.`);
  }
  return { token, zoneId };
}

/**
 * Issue one authenticated Cloudflare API call and validate the envelope.
 *
 * Cloudflare returns { success, errors:[{code,message}], result } and can report
 * failure with an HTTP 200 body, so both the HTTP status AND `success` are
 * checked, and the CF error codes/messages are surfaced verbatim.
 *
 * @param {string} token
 * @param {string} method
 * @param {string} path   API path relative to CF_API_BASE (leading slash)
 * @param {object} [body]
 * @returns {Promise<object>} parsed Cloudflare response envelope
 */
async function cfRequest(token, method, path, body) {
  const url = `${CF_API_BASE}${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CF_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Cloudflare ${method} ${path} failed: ${err.name === 'AbortError' ? `timed out after ${CF_TIMEOUT_MS}ms` : err.message}`);
  }
  clearTimeout(timer);
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload || payload.success !== true) {
    const errs = Array.isArray(payload?.errors) ? payload.errors : [];
    const detail = errs.length
      ? errs.map((e) => `${e.code}: ${e.message}`).join('; ')
      : (payload ? 'no error detail in response' : 'non-JSON response body');
    throw new Error(`Cloudflare ${method} ${path} failed (HTTP ${res.status}): ${detail}`);
  }
  return payload;
}

/** Fully-qualified DNS-01 challenge record name for a slug. */
function acmeChallengeName(slug) {
  return `_acme-challenge.${slug}.${DNS_ZONE}`;
}

/**
 * Create the DNS-01 challenge TXT record for a slug's subdomain.
 * @param {string} slug
 * @param {string} value  the base64url(SHA256(keyAuthorization)) acme-client hands us
 * @returns {Promise<string>} the Cloudflare record id (for later removal)
 */
export async function addTxtRecord(slug, value) {
  const { token, zoneId } = cfConfig();
  const created = await cfRequest(token, 'POST', `/zones/${zoneId}/dns_records`, {
    type: 'TXT',
    name: acmeChallengeName(slug),
    content: value,
    ttl: 60,
  });
  const id = created.result?.id;
  if (!id) throw new Error('Cloudflare TXT create returned no record id');
  return id;
}

/**
 * Remove a DNS record by id. Best-effort — a cleanup failure is logged, never
 * thrown, so it cannot mask the real cert-issuance outcome.
 * @param {string} id
 */
export async function removeRecord(id) {
  if (!id) return;
  let cfg;
  try { cfg = cfConfig(); } catch (e) { console.warn('[cloudflare-dns] cleanup skipped:', e.message); return; }
  try {
    await cfRequest(cfg.token, 'DELETE', `/zones/${cfg.zoneId}/dns_records/${encodeURIComponent(id)}`);
  } catch (e) {
    console.warn('[cloudflare-dns] TXT cleanup failed:', e.message);
  }
}

/**
 * Point `{slug}.robotdojo.ai` straight at this VPS with an unproxied A record.
 *
 * Deletes every existing record for the hostname first — the interim per-user
 * Cloudflare Tunnel left a `proxied: true` CNAME, and Cloudflare will not hold
 * two records claiming the same name — then creates exactly one A record with
 * `proxied: false` so the raw TLS ClientHello reaches `gateway/lib/sni-router.js`
 * instead of being terminated at Cloudflare's edge.
 *
 * @param {string} slug
 * @param {string} ip   the relay's own public IPv4 (GATEWAY_PUBLIC_IP)
 */
export async function upsertRoutingRecord(slug, ip) {
  if (!slug) throw new Error('upsertRoutingRecord requires a slug');
  if (!ip) throw new Error('upsertRoutingRecord requires the relay IP (set GATEWAY_PUBLIC_IP)');
  const { token, zoneId } = cfConfig();
  const name = `${slug}.${DNS_ZONE}`;

  // Replace any prior record for this hostname. A surviving proxied CNAME would
  // keep Cloudflare terminating TLS in front of the blind splice.
  const existing = await cfRequest(token, 'GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
  for (const record of existing.result || []) {
    await cfRequest(token, 'DELETE', `/zones/${zoneId}/dns_records/${record.id}`);
  }

  await cfRequest(token, 'POST', `/zones/${zoneId}/dns_records`, {
    type: 'A',
    name,
    content: ip,
    ttl: 60,
    proxied: false,
  });
}
