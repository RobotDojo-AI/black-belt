-- 110_chat_turn_enrichment_health.sql
-- Durable per-turn health for additive chat enrichment. Stores layer/status/ms
-- metadata only; no prompt text or private content.

ALTER TABLE chat_turn_metrics ADD COLUMN enrichment_fallback_count INTEGER;
ALTER TABLE chat_turn_metrics ADD COLUMN enrichment_health_json TEXT;
