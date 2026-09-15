-- Migration 059 — onboarding task tiles.
-- Tracks which onboarding tiles have been completed or dismissed by the user.
-- WHY DB-not-localStorage: dismissal must survive page reloads, machine reboots,
-- and DB rebuilds inside the user's profile (PostHog/Cal.com pattern).
-- Single-user local SQLite — no user_id column needed.
CREATE TABLE IF NOT EXISTS setup_steps (
  step          TEXT PRIMARY KEY,
  completed_at  INTEGER,        -- unix-ms timestamp, NULL = not done
  dismissed_at  INTEGER         -- unix-ms timestamp, NULL = not dismissed
);
