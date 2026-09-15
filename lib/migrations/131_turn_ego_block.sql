-- 131_turn_ego_block.sql
-- st_df0a8d71 AC-7 — per-turn who-is-who (ego block) presence recording.
--
-- The defect class this story closes was UNOBSERVABLE: no per-turn record
-- existed of whether identity/relationship truth actually reached the prompt
-- (research soft-fail #10 — `stable_context: ok` fires even when the identity
-- card resolved to ''). These two columns make ego-block presence a recorded
-- per-turn fact so absence can flag loudly and the nightly quiz can audit it.
--
--   ego_block_present — 1 when the graph-rendered who-is-who block was in the
--                       assembled system prompt for this turn, 0 when absent.
--                       NULL = turn predates this story or bypassed the model
--                       path (deterministic local answers).
--   ego_block_chars   — rendered block size, for budget observability.
--
-- Same additive ALTER pattern as 064 on the same SQL-migration-owned table.
ALTER TABLE chat_turn_metrics ADD COLUMN ego_block_present INTEGER;
ALTER TABLE chat_turn_metrics ADD COLUMN ego_block_chars INTEGER;
