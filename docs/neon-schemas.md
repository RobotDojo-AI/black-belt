# Neon Postgres schemas

Cloud auth, sessions, and public-chat storage. Connection: Keychain key `robotdojo-DATABASE_URL`. Endpoint: `ep-polished-math-a4p01zbw-pooler.us-east-1.aws.neon.tech`.

HTTP SQL API: POST `https://{NEON_HOST}/sql` with header `Neon-Connection-String: {connection_string}`, body `{ query, params }`.

## Tables (as of 2026-04-29)

| Table | Key columns |
|-------|-------------|
| `users` | `user_id TEXT PK, hashed_email TEXT UNIQUE, user_slug TEXT, belt TEXT, created_at` |
| `magic_links` | `id TEXT PK, hashed_email TEXT, token TEXT UNIQUE, expires_at, used_at` |
| `sessions` | `session_id TEXT PK, user_id, slug, belt, expires_at, created_at` |
| `public_chat_rate` | `ip_hash TEXT, day TEXT, count INT` |
| `public_chat_transcripts` | `id, session_id, ip_hash, message, response, tokens, day` |

## Public routing

Public chat routes are covered by `PASS_THROUGH_PREFIXES` in `middleware.js`; do not add individual routes unless they need distinct auth behavior. HMAC hashing uses `SESSION_SECRET`, which must match Keychain and Vercel env exactly.
