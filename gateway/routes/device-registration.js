/**
 * Device registration — public bootstrap for fresh installs.
 *
 * This endpoint intentionally stores only relay routing metadata. It does not
 * receive user data, app sessions, local DB content, chats, imports, memories,
 * or API keys. The Mac generates the device secret locally and sends it once
 * so later /tcp-tunnel connections can be authenticated per device instead of
 * by one global gateway secret.
 *
 * st_63b59bda AC-5: connecting needs only a slug and a token. Any owner-identity
 * field an older installer sends in the body is ignored — the device secret hash
 * is the sole credential the relay keeps.
 *
 * Two device-lifecycle actions live here:
 *   - POST /api/register-device — claim a slug. Bootstrap-authed (fresh install
 *     proves it holds the beta invite secret before it can reserve a name).
 *   - POST /api/release-device  — give up a slug. Device-authed: the caller must
 *     present the device secret whose hash claimed the slug. No bootstrap proof,
 *     because only the owning device knows that secret.
 */
import { Hono } from 'hono';
import { registerDevice, releaseDevice, validateBootstrapProof } from '../lib/device-registry.js';
import { upsertRoutingRecord } from '../lib/cloudflare-dns.js';

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const GATEWAY_PUBLIC_IP = process.env.GATEWAY_PUBLIC_IP || '';

export function deviceRegistrationRoutes(opts = {}) {
  const bootstrapSecret = opts.bootstrapSecret ?? process.env.GATEWAY_BOOTSTRAP_SECRET ?? '';
  const app = new Hono();

  app.post('/api/register-device', async (c) => {
    let body;
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'invalid_json' }, 400); }

    const slug = typeof body?.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    const deviceSecret = typeof body?.deviceSecret === 'string' ? body.deviceSecret : '';
    const bootstrapProof = c.req.header('x-robotdojo-bootstrap') ||
      (typeof body?.bootstrapProof === 'string' ? body.bootstrapProof : '');

    const proof = validateBootstrapProof(bootstrapProof, bootstrapSecret);
    if (!proof.ok) {
      const status = proof.reason === 'bootstrap_not_configured' ? 503 : 401;
      return c.json({ error: proof.reason }, status);
    }

    if (!SLUG_REGEX.test(slug)) return c.json({ error: 'invalid_slug' }, 400);
    if (deviceSecret.length < 32) return c.json({ error: 'weak_device_secret' }, 400);

    const device = await registerDevice(slug, deviceSecret);
    if (!device.ok) {
      if (device.reason === 'taken') return c.json(device, 409);
      return c.json(device, 400);
    }

    // Seamless friend install: DNS lives on the VPS (Cloudflare zone token here,
    // never on the friend's Mac). Point {slug}.robotdojo.ai at this relay as soon
    // as the slug is claimed so provision-cert + the SNI tunnel client can land
    // without any CLOUDFLARE_* secrets on the install machine. Best-effort —
    // cert-provision re-upserts the same unproxied A record.
    let dns = null;
    if (GATEWAY_PUBLIC_IP) {
      try {
        await upsertRoutingRecord(slug, GATEWAY_PUBLIC_IP);
        dns = { ok: true, host: `${slug}.robotdojo.ai` };
      } catch (e) {
        console.warn(`[register-device] DNS upsert for ${slug} failed:`, e.message);
        dns = { ok: false, error: e.message };
      }
    }

    return c.json({ ok: true, dns });
  });

  // Device-authenticated release — no bootstrap proof. The device secret in the
  // body is the credential: releaseDevice only removes the slug when its hash
  // matches the one that claimed it.
  app.post('/api/release-device', async (c) => {
    let body;
    try { body = await c.req.json(); }
    catch { return c.json({ error: 'invalid_json' }, 400); }

    const slug = typeof body?.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    const deviceSecret = typeof body?.deviceSecret === 'string' ? body.deviceSecret : '';

    if (!SLUG_REGEX.test(slug)) return c.json({ error: 'invalid_slug' }, 400);
    if (deviceSecret.length < 32) return c.json({ error: 'weak_device_secret' }, 400);

    const result = await releaseDevice(slug, deviceSecret);
    if (!result.ok) {
      if (result.reason === 'forbidden') return c.json(result, 403);
      return c.json(result, 404); // not_found
    }
    return c.json({ ok: true });
  });

  return app;
}
