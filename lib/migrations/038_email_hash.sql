-- Email hashing: store HMAC-SHA256(email, SESSION_SECRET) instead of plaintext email.
-- email_hash is the durable identifier; the email column is nulled after backfill.
ALTER TABLE users ADD COLUMN email_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_hash_idx ON users(email_hash);
ALTER TABLE magic_links ADD COLUMN email_hash TEXT;
