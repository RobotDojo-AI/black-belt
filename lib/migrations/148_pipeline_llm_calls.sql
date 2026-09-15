-- 148_pipeline_llm_calls.sql
--
-- st_4312c9c0 AC-5 — persisted, queryable pipeline spend.
--
-- WHY. Before this table there was no durable record of what the application
-- spent on its own model calls. Two surfaces existed and neither answered the
-- question:
--
--   token_usage        — created, never written to. Zero rows.
--   chat_turn_metrics  — interactive chat turns only. Silent on every pipeline
--                        call: entity enrichment, topic context, health intel,
--                        the followup sweep, profile research.
--
-- What remained was console output scraped out of the server log, which is
-- append-only, unrotated, and truncated by every restart. Measuring 2.5 months
-- of spend that way accounted for ~$47 against auto-recharge invoices that
-- said otherwise, and the gap was unattributable — not because the money was
-- mysterious but because nothing recorded where it went.
--
-- COST UNIT: micro-dollars (millionths of a USD), stored as INTEGER.
-- NOT cents. The pre-existing token_usage.cost_cents is why that table would
-- have been useless even if it had been written to: a Haiku routing call costs
-- ~$0.0013, which rounds to 0 cents. At 630 such calls that is $0.78 recorded
-- as $0.00. Micros hold four more digits of resolution than the cheapest call
-- needs, and INTEGER avoids the float drift that makes summed REAL columns
-- disagree with themselves across a large table.
--
-- CACHE COLUMNS are separate from input_tokens because they are billed at
-- different rates (cache writes at a premium, cache reads at a discount).
-- Folding them into input_tokens would make AC-6's caching work unmeasurable —
-- the whole point of caching is that the read column grows while the cost does
-- not, and that is only visible if the columns are distinct.
--
-- served_by DISTINGUISHES the batch discount (AC-7). A batch-served call bills
-- at half rate; without this column a batch migration would look like a 50%
-- price cut of unknown origin rather than the lever that produced it.

CREATE TABLE IF NOT EXISTS pipeline_llm_calls (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  label                       TEXT    NOT NULL,
  model                       TEXT    NOT NULL,
  tier                        TEXT,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_micros                 INTEGER NOT NULL DEFAULT 0,
  served_by                   TEXT    NOT NULL DEFAULT 'sync',
  created_at                  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The spend report's two queries: a window scan by time, and a rollup by label
-- within that window. Both are covered here so the report stays cheap as the
-- table grows — this table gains a row on every pipeline call, so it is the one
-- place in the schema guaranteed to grow with usage rather than with data size.
CREATE INDEX IF NOT EXISTS idx_pipeline_llm_calls_created_at
  ON pipeline_llm_calls(created_at, label, cost_micros);

CREATE INDEX IF NOT EXISTS idx_pipeline_llm_calls_label
  ON pipeline_llm_calls(label, created_at, cost_micros);
