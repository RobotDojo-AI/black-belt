-- 064_chat_turn_metrics_cache_columns.sql
-- st_74f45a1a Phase 1A amendment — extend chat_turn_metrics with Anthropic
-- prompt-cache token columns. AC 11 asserts that warm turns show
-- cache_read_input_tokens > 0; cache_creation_input_tokens captures the
-- first-turn write cost.
--
-- WHY two columns: the Anthropic SDK returns them as distinct counters on
-- the response usage object. Treating them as separate persistent fields
-- preserves auditability and downstream Langfuse/LangSmith mapping.
ALTER TABLE chat_turn_metrics ADD COLUMN cache_creation_input_tokens INTEGER;
ALTER TABLE chat_turn_metrics ADD COLUMN cache_read_input_tokens INTEGER;
