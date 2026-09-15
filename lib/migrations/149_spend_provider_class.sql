-- 149_spend_provider_class.sql
--
-- st_4312c9c0. pipeline_llm_calls recorded model and cost but not WHO was
-- billed or WHY the call happened. Both gaps matter now:
--
--   provider     The owner is moving his default coding agent to Grok. A ledger
--                keyed only on model string cannot answer "what did xAI cost
--                this month" without a model-name lookup table that goes stale
--                the moment a vendor ships a new model. Recording the provider
--                makes the ledger survive a vendor switch.
--
--   spend_class  autonomous | interactive | explicit | research | experimental.
--                This is the distinction the owner actually cares about: work
--                that fired with nobody watching versus work he launched. The
--                whole $1,239 investigation was an attempt to reconstruct this
--                column after the fact from receipts and file mtimes.
--
-- Both are TEXT and nullable. Rows written before this migration have neither,
-- and backfilling them would be inventing history — the honest state is null,
-- which reads as "recorded before attribution existed" rather than as a class.
--
-- The index carries class first because the report's primary question is
-- "what did background work cost", not "what did July cost".

ALTER TABLE pipeline_llm_calls ADD COLUMN provider TEXT;
ALTER TABLE pipeline_llm_calls ADD COLUMN spend_class TEXT;

CREATE INDEX IF NOT EXISTS idx_pipeline_llm_calls_class
  ON pipeline_llm_calls(spend_class, created_at, cost_micros);

CREATE INDEX IF NOT EXISTS idx_pipeline_llm_calls_provider
  ON pipeline_llm_calls(provider, created_at, cost_micros);
