-- 103_chat_turn_memory_context.sql
-- Safe per-turn memory-context observability. These columns describe prompt
-- shape, not private content: tier, chars, section names, source classes,
-- target types, event type names, cache-hit, and timeout flags.

ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_present INTEGER;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_cache_hit INTEGER;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_tier TEXT;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_chars INTEGER;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_sections_json TEXT;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_source_types_json TEXT;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_target_types_json TEXT;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_event_types_json TEXT;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_timeout INTEGER;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_has_latest INTEGER;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_has_snapshots INTEGER;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_has_conflicts INTEGER;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_has_chronology INTEGER;
ALTER TABLE chat_turn_metrics ADD COLUMN memory_context_summary_json TEXT;
