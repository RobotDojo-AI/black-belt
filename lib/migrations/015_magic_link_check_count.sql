-- Add check_count to magic_links for DB-backed brute-force rate limiting.
-- Survives process restarts; replaces the in-memory codeAttempts Map.
ALTER TABLE magic_links ADD COLUMN check_count INTEGER NOT NULL DEFAULT 0;
