-- Story: st_87a0d072 (network-ranking-quality-investigation)
-- Phase 1: Email participant capture.
--
-- WHY a separate table (not columns on emails):
--   To/Cc/Bcc are 0..N per email. A column-per-role would force JSON or
--   delimiter packing — both opaque to SQL filters used in entity extraction.
--   A junction table lets Phase 1 Extract iterate (email_id, participant, role)
--   directly and join on `emails.is_newsletter` / `list_unsubscribe` for filtering.
--
-- Role enum: sender, to, cc, bcc.
--   - sender: redundant with emails.sender_email but stored here for uniform iteration
--   - to/cc/bcc: extracted from corresponding email headers
--
-- Primary key (email_id, participant_email, role) is intentional:
--   - same person can appear in multiple roles (To + Cc) — both rows allowed
--   - duplicates in same role are deduped (PK conflict → INSERT OR IGNORE)
--
-- No FK on email_id: emails table uses TEXT id (gmail message id) — we honour
-- referential integrity via app code, not constraints, to keep backfill robust
-- against partial Gmail metadata fetches.

CREATE TABLE IF NOT EXISTS email_participants (
  email_id          TEXT NOT NULL,
  participant_email TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('sender','to','cc','bcc')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (email_id, participant_email, role)
);

CREATE INDEX IF NOT EXISTS idx_ep_email      ON email_participants(email_id);
CREATE INDEX IF NOT EXISTS idx_ep_participant ON email_participants(participant_email);
CREATE INDEX IF NOT EXISTS idx_ep_role       ON email_participants(role);
