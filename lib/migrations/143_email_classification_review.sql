-- Resolver hardening (role/generic email) — the uncertain-email review queue.
--
-- The deterministic email classifier (lib/identity-matching.js classifyEmailAddress)
-- returns 'role' | 'person' | 'uncertain'. 'role' is refused/detached and 'person'
-- is allowed, both with high confidence. 'uncertain' (an unusual local part on an
-- unusual domain the deterministic rules cannot settle) is ALLOWED but recorded
-- here so a later OFFLINE LLM tier can adjudicate it. This build writes the rows
-- deterministically; NO LLM writes here (LLM-write boundary). The resolver never
-- blocks on this queue — it is asynchronous, off the critical path.
--
-- One row per (person_id, value): UNIQUE so a re-resolve INSERT OR IGNORE never
-- spams duplicates. Written by lib/people-merge.js writeEmailClassificationReview
-- (the live pipeline flags at attach time; the retroactive cleanup enqueues the
-- historical uncertain backlog).
CREATE TABLE IF NOT EXISTS email_classification_review (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   TEXT NOT NULL,                     -- the person the uncertain email is attached to
  value       TEXT NOT NULL,                     -- the normalized email address
  reason      TEXT NOT NULL DEFAULT 'uncertain-email',
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | role | person | dismissed (set by the LLM tier)
  source      TEXT NOT NULL DEFAULT 'resolve',   -- resolve | cleanup | manual
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  UNIQUE(person_id, value)
);
CREATE INDEX IF NOT EXISTS idx_email_classification_review_status ON email_classification_review(status);
