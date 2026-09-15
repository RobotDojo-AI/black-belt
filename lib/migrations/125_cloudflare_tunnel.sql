-- st_96bb626f AC-2 / Phase B — per-user Cloudflare Tunnel identity.
--
-- Records the named Cloudflare Tunnel provisioned for this install so the Admin
-- relay panel (AC-5) can report status and the app can tear the tunnel down on
-- subscription lapse. Both columns are nullable; NULL = not yet provisioned.
--   cloudflare_tunnel_id       — the Cloudflare cfd_tunnel id (for delete/update).
--   cloudflare_tunnel_hostname — the public {slug}.connect.robotdojo.ai hostname.
--
-- The `users` table is created by 002_users_auth.sql, which runs before this
-- file (SQL migrations apply in name order), so these ADD COLUMNs bind cleanly —
-- the same pattern as every prior ALTER TABLE users migration (008, 038, 041, 066, 072).
ALTER TABLE users ADD COLUMN cloudflare_tunnel_id TEXT;
ALTER TABLE users ADD COLUMN cloudflare_tunnel_hostname TEXT;
