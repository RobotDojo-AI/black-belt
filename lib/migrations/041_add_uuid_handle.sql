-- Add permanent UUID and identity handle to users.
-- uuid: relay routing key (permanent, never changes)
-- user_handle: identity handle in URLs (globally unique, user-chosen, mutable)
--
-- SQLite does not support ADD COLUMN ... UNIQUE directly.
-- We add the columns without the constraint first, populate them,
-- then create unique indexes separately.
ALTER TABLE users ADD COLUMN uuid TEXT;
ALTER TABLE users ADD COLUMN user_handle TEXT;
UPDATE users SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL;
UPDATE users SET user_handle = user_slug WHERE user_handle IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_uuid_unique ON users(uuid);
CREATE UNIQUE INDEX IF NOT EXISTS users_user_handle_unique ON users(user_handle);
