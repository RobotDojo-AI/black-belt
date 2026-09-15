/**
 * neon-migrate.js — Provision all 7 Robot Dojo tables in Neon.
 *
 * WHY: Neon is replacing Supabase as the sole cloud DB. This script creates
 * the schema idempotently so it can be re-run safely after partial failures
 * or schema drift without destroying existing data.
 *
 * Usage: DATABASE_URL=<neon-conn-string> node scripts/neon-migrate.js
 *
 * Runs DDL statements sequentially (one per fetch) so FK dependencies are
 * satisfied in order (users must exist before sessions references it, etc.).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL env var is required');
  process.exit(1);
}

// WHY: Neon HTTP SQL API endpoint extracted from the connection string.
// The pooler host is embedded in the DATABASE_URL itself — we reuse it
// rather than hard-coding so this script survives branch/project renames.
const url = new URL(DATABASE_URL);
const NEON_SQL_ENDPOINT = `https://${url.host}/sql`;

async function runSQL(label, query) {
  const res = await fetch(NEON_SQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': DATABASE_URL,
    },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok || json.error) {
    console.error(`  FAIL [${label}]: HTTP ${res.status} — ${json.error || text}`);
    return false;
  }
  console.log(`  OK   [${label}]`);
  return true;
}

// DDL statements in dependency order.
// WHY: users table must come before sessions (FK) and stripe_customers (FK).
// Each statement is a discrete fetch call so failures are attributable.
const statements = [
  // ── users ──────────────────────────────────────────────────────────────
  // Core identity table. email is stored as a hash (SHA-256) — plaintext
  // never lands in the cloud DB. plan_tier drives feature gating.
  [
    'users: CREATE TABLE',
    `CREATE TABLE IF NOT EXISTS users (
      user_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      hashed_email TEXT        NOT NULL UNIQUE,
      plan_tier    TEXT        NOT NULL DEFAULT 'white',
      user_slug    TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ
    )`,
  ],
  [
    'users: idx_hashed_email',
    `CREATE INDEX IF NOT EXISTS idx_users_hashed_email ON users (hashed_email)`,
  ],

  // ── magic_links ────────────────────────────────────────────────────────
  // Stores 6-digit codes for the passwordless auth flow. check_count limits
  // brute-force guessing without a separate rate-limit table.
  [
    'magic_links: CREATE TABLE',
    `CREATE TABLE IF NOT EXISTS magic_links (
      id           BIGSERIAL   PRIMARY KEY,
      token        TEXT        NOT NULL UNIQUE,
      hashed_email TEXT        NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ,
      check_count  INTEGER     NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ],
  ['magic_links: idx_token',   `CREATE INDEX IF NOT EXISTS idx_magic_links_token   ON magic_links (token)`],
  ['magic_links: idx_expires', `CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links (expires_at)`],

  // ── sessions ───────────────────────────────────────────────────────────
  // Cloud session store. slug = vanity identifier (e.g. "dojo"), belt = plan
  // tier snapshot at session-creation time for fast middleware gating without
  // a users JOIN on every request.
  [
    'sessions: CREATE TABLE',
    `CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT        PRIMARY KEY,
      user_id    UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      slug       TEXT        NOT NULL,
      belt       TEXT        NOT NULL DEFAULT 'white',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ],
  ['sessions: idx_expires', `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)`],

  // ── stripe_customers ───────────────────────────────────────────────────
  // 1:1 with users. Kept separate so the billing domain can evolve (add
  // subscription_id, trial_ends_at, etc.) without touching the identity table.
  [
    'stripe_customers: CREATE TABLE',
    `CREATE TABLE IF NOT EXISTS stripe_customers (
      user_id            UUID        PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      stripe_customer_id TEXT        NOT NULL UNIQUE,
      plan               TEXT        NOT NULL DEFAULT 'white',
      status             TEXT        NOT NULL DEFAULT 'inactive',
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ],

  // ── public_chat_rate ───────────────────────────────────────────────────
  // Per-IP-per-day rate limiting for the public chat widget. ip_hash (SHA-256)
  // avoids storing raw IPs. Composite PK doubles as the unique constraint.
  [
    'public_chat_rate: CREATE TABLE',
    `CREATE TABLE IF NOT EXISTS public_chat_rate (
      ip_hash    TEXT    NOT NULL,
      date_utc   DATE    NOT NULL,
      count      INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (ip_hash, date_utc)
    )`,
  ],
  ['public_chat_rate: idx_date', `CREATE INDEX IF NOT EXISTS idx_public_chat_rate_date ON public_chat_rate (date_utc)`],

  // ── public_chats ───────────────────────────────────────────────────────
  // Transcript log for public chat sessions. messages_json stores the full
  // turn array so we can replay, audit, and score quality without a separate
  // messages table. source distinguishes widget vs future channels.
  [
    'public_chats: CREATE TABLE',
    `CREATE TABLE IF NOT EXISTS public_chats (
      id            BIGSERIAL   PRIMARY KEY,
      session_id    TEXT        NOT NULL,
      ip_hash       TEXT,
      user_agent    TEXT,
      referrer      TEXT,
      messages_json JSONB       NOT NULL,
      source        TEXT        NOT NULL DEFAULT 'public_chat',
      converted     BOOLEAN     NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ],
  // WHY: Unique on (session_id, source) rather than session_id alone because
  // the same session could theoretically appear on two different surfaces
  // (widget vs in-app). This prevents duplicates while allowing that.
  ['public_chats: unique session+source', `CREATE UNIQUE INDEX IF NOT EXISTS public_chats_session_source_key ON public_chats (session_id, source)`],
  ['public_chats: idx_created',           `CREATE INDEX IF NOT EXISTS idx_public_chats_created ON public_chats (created_at DESC)`],
  ['public_chats: idx_source',            `CREATE INDEX IF NOT EXISTS idx_public_chats_source  ON public_chats (source)`],
];

async function main() {
  console.log(`Neon migrate → ${NEON_SQL_ENDPOINT}`);
  console.log(`Running ${statements.length} DDL statements...\n`);

  let failed = 0;
  for (const [label, query] of statements) {
    const ok = await runSQL(label, query);
    if (!ok) failed++;
  }

  console.log(`\n${statements.length - failed}/${statements.length} statements succeeded.`);
  if (failed > 0) {
    console.error(`${failed} statement(s) failed — aborting.`);
    process.exit(1);
  }
  console.log('Migration complete.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
