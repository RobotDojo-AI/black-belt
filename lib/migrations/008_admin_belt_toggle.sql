-- Admin belt toggle.
-- Adds an is_admin flag on users (for authorization) and a
-- belt_override column on sessions (for runtime belt swap).
--
-- Only admins may POST /api/admin/belt-override; see routes/admin.js.
-- The override is scoped to the current session and does not affect
-- subscription_status or encryption_key_hash.

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sessions ADD COLUMN belt_override TEXT;
-- belt_override: null | 'white' | 'black' | 'samurai'
