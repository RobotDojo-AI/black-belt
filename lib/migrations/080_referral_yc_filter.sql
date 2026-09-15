-- 080_referral_yc_filter.sql — st_b879a361 (referral-yc-tech-filter)
--
-- Adds the YC + big-tech + VC + AI-content filter columns to referral_scores.
--
-- WHY additive: existing 1,334 rows in referral_scores keep their composite-
-- scorer values; this migration only adds new columns + a composite index.
-- New columns are all nullable / default 0 so a partial-apply rerun is
-- idempotent. Live qualification is computed by lib/referral/yc-filter.js
-- and materialized at write time inside lib/referral.js#scoreReferralCandidate.
--
-- COLUMNS
--   qualifies_for_referral       1 when (Path A OR Path B OR Path C) AND non-excluded role
--   has_path_c_signal            1 when Path C cumulative keyword weight >= 3
--   path_c_weight                cumulative weight (diagnostic / threshold tuning)
--   company_priority_tier        1=YC+VC, 2=hard-tech/frontier, 3=mega-cap
--   role_bucket_priority         0=founder, 1=c-level, 2=vp, 3=eng, 4=design, 5=business
--   detected_role                resolved bucket name (string)
--   detected_role_source         which priority tier resolved the title
--                                ('person_professional'|'linkedin_title'|'signature'|'default')
--   company_type                 'startup'|'bigTech'|'vc'|'unknown'
--   qualified_domain_source      which priority tier resolved the domain
--                                ('person_professional'|'company_id'|'recent_email'|'signature')
--   qualified_path               concatenation of qualifying paths ('A','B','C','A+B', etc.)
--   most_recent_prof_email_domain derived domain for diagnostic + UI surfacing
--
-- INDEX idx_referral_filter_sort matches the 4-tier ORDER BY in
-- lib/invite-targets-queries.js#getInviteTargets.
--
-- Down migration (manual):
--   DROP INDEX IF EXISTS idx_referral_filter_sort;
--   ALTER TABLE referral_scores DROP COLUMN most_recent_prof_email_domain;
--   ALTER TABLE referral_scores DROP COLUMN qualified_path;
--   ALTER TABLE referral_scores DROP COLUMN qualified_domain_source;
--   ALTER TABLE referral_scores DROP COLUMN company_type;
--   ALTER TABLE referral_scores DROP COLUMN detected_role_source;
--   ALTER TABLE referral_scores DROP COLUMN detected_role;
--   ALTER TABLE referral_scores DROP COLUMN role_bucket_priority;
--   ALTER TABLE referral_scores DROP COLUMN company_priority_tier;
--   ALTER TABLE referral_scores DROP COLUMN path_c_weight;
--   ALTER TABLE referral_scores DROP COLUMN has_path_c_signal;
--   ALTER TABLE referral_scores DROP COLUMN qualifies_for_referral;

-- Defensive create: 011_person_professional.sql ships this table, but a fresh
-- DB without all prior migrations applied would fail the ALTER below.
CREATE TABLE IF NOT EXISTS referral_scores (
  person_id            TEXT PRIMARY KEY,
  total_score          REAL NOT NULL DEFAULT 0,
  relationship_score   REAL NOT NULL DEFAULT 0,
  technical_score      REAL NOT NULL DEFAULT 0,
  tool_spend_score     REAL NOT NULL DEFAULT 0,
  privacy_score        REAL NOT NULL DEFAULT 0,
  sharing_score        REAL NOT NULL DEFAULT 0,
  top_signal           TEXT,
  breakdown            TEXT DEFAULT '{}',
  computed_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE referral_scores ADD COLUMN qualifies_for_referral INTEGER DEFAULT 0;
ALTER TABLE referral_scores ADD COLUMN has_path_c_signal INTEGER DEFAULT 0;
ALTER TABLE referral_scores ADD COLUMN path_c_weight INTEGER DEFAULT 0;
ALTER TABLE referral_scores ADD COLUMN company_priority_tier INTEGER;
ALTER TABLE referral_scores ADD COLUMN role_bucket_priority INTEGER;
ALTER TABLE referral_scores ADD COLUMN detected_role TEXT;
ALTER TABLE referral_scores ADD COLUMN detected_role_source TEXT;
ALTER TABLE referral_scores ADD COLUMN company_type TEXT;
ALTER TABLE referral_scores ADD COLUMN qualified_domain_source TEXT;
ALTER TABLE referral_scores ADD COLUMN qualified_path TEXT;
ALTER TABLE referral_scores ADD COLUMN most_recent_prof_email_domain TEXT;

CREATE INDEX IF NOT EXISTS idx_referral_filter_sort
  ON referral_scores(
    qualifies_for_referral,
    has_path_c_signal DESC,
    company_priority_tier ASC,
    role_bucket_priority ASC
  );
