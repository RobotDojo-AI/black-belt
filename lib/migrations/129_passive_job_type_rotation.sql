-- 129_passive_job_type_rotation.sql
--
-- df_02d633dc — type-level monopoly cap. The round-robin ordering fix
-- (lib/passive-jobs.js, Piece 1) bounds how long a TYPE can occupy the shared
-- rotation slot in proportion to its own due-row count (R × MAX_ATTEMPTS
-- ticks for the quarantine path, R × (STALL_TURNS+1) for the stall-guard
-- path) — a bound that grows every time the user connects another account
-- of a large type like oauth_sync. This table adds a flat, row-count-
-- independent cap: once a job_type has won the rotation slot more than
-- TYPE_MONOPOLY_CAP_TICKS consecutive times without producing a single
-- real success, it is excluded from type_rank until a cooldown elapses,
-- regardless of how many rows it has or why it isn't succeeding.
--
-- A separate table, not new columns on passive_jobs, because this is a
-- per-(queue, job_type) fact, not a per-row fact — passive_jobs has no
-- natural one-row-per-type anchor to attach it to. Being a separate table
-- also makes this column set structurally immune to enqueuePassiveJob's
-- ON CONFLICT clause by construction — that clause can only ever touch
-- passive_jobs rows, never a different table — so this design cannot
-- repeat the updated_at mistake stall_probe_at was introduced to correct.
--
-- queue+job_type as a composite primary key, not job_type alone: the
-- fairnessMode='round_robin_by_type' mechanism this table backs is scoped
-- to the 'default' queue today (scripts/sync.js's one call site never
-- passes a queue override), but keying on job_type alone would silently
-- share monopoly state across queues if a future caller ever adopted
-- round-robin mode on a different queue. The composite key costs nothing
-- extra and removes that assumption.
--
-- monopoly_streak: resettable counter, NOT NULL DEFAULT 0 — same
-- discipline stall_streak (128_passive_jobs_stall_probe.sql) established:
-- a direct count of consecutive non-success wins, not a derived expression
-- over fields that also carry other, permanent meaning.
--
-- last_monopoly_win_at: nullable, no default. NULL means "this type has
-- never won under round_robin_by_type," which the escape hatch treats as
-- immediately eligible — same convention as stall_probe_at.
CREATE TABLE passive_job_type_rotation (
  queue                 TEXT NOT NULL,
  job_type              TEXT NOT NULL,
  monopoly_streak       INTEGER NOT NULL DEFAULT 0,
  last_monopoly_win_at  TEXT,
  PRIMARY KEY (queue, job_type)
);
