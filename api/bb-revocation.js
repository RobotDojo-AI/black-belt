/**
 * Vercel serverless function — GET /api/bb-revocation.json.
 *
 * Returns the signed revocation document fetched hourly by every install:
 *   { revoked: ["2026-W01", ...], generated_at: ISO8601, sig: base64 }
 *
 * The revoked-weeks list is read from config/revoked-weeks.json (committed,
 * starts empty). To revoke a cohort, edit that file and redeploy. The
 * signature is computed over `JSON.stringify({revoked, generated_at})` —
 * keep the field order stable.
 *
 * The private key is in the Vercel env var COHORT_PRIVATE_KEY (PEM string).
 * Operator sets it manually post-deploy:
 *   vercel env add COHORT_PRIVATE_KEY production < ~/.config/robotdojo-build/cohort-priv.pem
 *
 * st_5a63545d AC 19.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSign, createPrivateKey } from 'node:crypto';

const _DIR = dirname(fileURLToPath(import.meta.url));
const REVOKED_WEEKS_PATH = resolve(_DIR, '..', 'config', 'revoked-weeks.json');

export default function handler(req, res) {
  // GET only — POST/PUT/DELETE are 405.
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let revoked = [];
  try {
    const parsed = JSON.parse(readFileSync(REVOKED_WEEKS_PATH, 'utf8'));
    revoked = Array.isArray(parsed.revoked) ? parsed.revoked : [];
  } catch (err) {
    res.status(500).json({ error: 'revoked_weeks_unreadable', message: err.message });
    return;
  }

  const generated_at = new Date().toISOString();
  const payload = JSON.stringify({ revoked, generated_at });

  const pemEnv = process.env.COHORT_PRIVATE_KEY;
  if (!pemEnv) {
    // The endpoint is intentionally 500 when the private key isn't set —
    // a 200 with no signature would let an attacker bypass revocation.
    res.status(500).json({ error: 'cohort_key_not_configured' });
    return;
  }

  let sig;
  try {
    const priv = createPrivateKey(pemEnv);
    const signer = createSign('SHA256');
    signer.update(payload);
    signer.end();
    sig = signer.sign(priv).toString('base64');
  } catch (err) {
    res.status(500).json({ error: 'signing_failed', message: err.message });
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({ revoked, generated_at, sig });
}
