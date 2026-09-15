-- Story: st_87a0d072 (network-ranking-quality-investigation)
-- Phase 9: functional indexes that make the AC 4 verification join (and any
-- future LOWER(email) joins) tractable.
--
-- Without these, the JOIN in VC 4
--   ON LOWER(e.sender_email) = LOWER(pi.value)
-- forces a full-scan O(N×M) over 350K emails × 30K identifiers, taking
-- 5+ minutes — past the 180s criteria-runner timeout. The functional
-- indexes let SQLite resolve the join via index seek.
--
-- Filtered indexes are intentional: WHERE clauses limit the index to the
-- rows that the join cares about (sender_email present, identifier type
-- 'email').
--
-- Also benefits the in-loop newsletter-cleanup pass in lib/scoring.js.

CREATE INDEX IF NOT EXISTS idx_emails_lower_sender
  ON emails(LOWER(sender_email))
  WHERE sender_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pi_lower_value
  ON person_identifiers(LOWER(value))
  WHERE type = 'email';
