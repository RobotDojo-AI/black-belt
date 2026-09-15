/**
 * neon-seed-user.js — Seed the admin user record from SQLite into Neon users table.
 *
 * WHY: The Neon users table is the new source of truth for cloud auth. The
 * owner record must exist before any session or stripe_customer rows can
 * reference the user_id. This is a one-time bootstrap step; ON CONFLICT DO
 * NOTHING makes re-runs safe.
 *
 * Usage:
 *   DATABASE_URL=<neon-conn-string> ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/neon-seed-user.js
 *
 * ROBOTDOJO_ALLOW_PLAINTEXT=1 skips SQLCipher encryption so the local dev DB
 * is readable without the Keychain key being available in the current shell.
 */

import db from '../lib/db.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL env var is required');
  process.exit(1);
}

// WHY: Reuse pooler host from DATABASE_URL rather than hard-coding the endpoint
// so this script survives Neon project/branch renames.
const url = new URL(DATABASE_URL);
const NEON_SQL_ENDPOINT = `https://${url.host}/sql`;

async function neonQuery(query, params = []) {
  const res = await fetch(NEON_SQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': DATABASE_URL,
    },
    body: JSON.stringify({ query, params }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok || json.error) {
    throw new Error(`Neon query failed (HTTP ${res.status}): ${json.error || text}`);
  }
  return json;
}

async function main() {
  // ── 1. Read admin record from local SQLite ──────────────────────────────
  // WHY: We pull email_hash (not plaintext email) — the privacy contract is
  // that plaintext email never touches the cloud DB.
  const admin = db.prepare(
    'SELECT email_hash, user_slug, subscription_status FROM users WHERE is_admin = 1 LIMIT 1'
  ).get();

  if (!admin) {
    console.error('ERROR: No admin user found in local SQLite. Run onboard.js first.');
    process.exit(1);
  }

  console.log(`Found admin in SQLite: slug=${admin.user_slug}, status=${admin.subscription_status}`);

  // WHY: plan_tier in Neon maps directly to subscription_status in SQLite.
  // Any non-black status defaults to white (free tier) — belt logic is
  // additive so this is safe to be conservative.
  const planTier = admin.subscription_status === 'black' ? 'black' : 'white';
  const hashedEmail = admin.email_hash;

  // ── 2. Upsert into Neon users ───────────────────────────────────────────
  console.log(`Upserting into Neon users (plan_tier=${planTier}, user_slug=${admin.user_slug})...`);

  await neonQuery(
    `INSERT INTO users (hashed_email, plan_tier, user_slug)
     VALUES ($1, $2, $3)
     ON CONFLICT (hashed_email) DO UPDATE SET user_slug = EXCLUDED.user_slug`,
    [hashedEmail, planTier, admin.user_slug]
  );

  // ── 3. Retrieve user_id for logging ────────────────────────────────────
  // WHY: The caller (Phase 2 scripts) will need this UUID to seed the
  // sessions table. Log it here so it's captured in the terminal output
  // without requiring a second script or manual query.
  const result = await neonQuery(
    `SELECT user_id, plan_tier, user_slug, created_at FROM users WHERE hashed_email = $1`,
    [hashedEmail]
  );

  if (!result.rows || result.rows.length === 0) {
    console.error('ERROR: Could not retrieve user_id after upsert. Something went wrong.');
    process.exit(1);
  }

  const row = result.rows[0];
  console.log('\nOwner Neon user record:');
  console.log(`  user_id:    ${row.user_id}`);
  console.log(`  plan_tier:  ${row.plan_tier}`);
  console.log(`  user_slug:  ${row.user_slug}`);
  console.log(`  created_at: ${row.created_at}`);
  console.log('\nSeed complete.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
