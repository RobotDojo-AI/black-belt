-- 134_relation_questions.sql — the relationship question queue (st_f67bc2eb D8).
--
-- Inference can rank importance and GENERATE QUESTIONS but can never write an
-- edge of any type (the Buzz/PYMK firewall). Candidates land here; the owner's
-- one-word answer converts a row into an owner-provenance edge through
-- lib/relation-store.js.
--
-- dedup_key is UNIQUE and rows are never deleted: a DECLINED row blocks
-- re-insert forever — a declined candidate is never re-asked (AC-6).
--
-- Queue rows are structurally invisible to chat context: no context builder,
-- prompt assembler, RAG surface, or ego render may read this table
-- (grep-enforced criterion). Surfacing is post-stream only.
CREATE TABLE IF NOT EXISTS relation_questions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL CHECK (kind IN ('confirm','disambiguate','decompose','conflict','cross-anchor')),
  dedup_key         TEXT NOT NULL UNIQUE,   -- subject|object|rel_type|kind
  subject_person_id TEXT,
  object_person_id  TEXT,
  rel_type          TEXT,
  question_text     TEXT NOT NULL,          -- one line, deterministic template, answerable in a word
  payload           TEXT NOT NULL DEFAULT '{}',  -- candidates, evidence refs, decomposition options
  confidence        REAL NOT NULL DEFAULT 0,
  priority          REAL NOT NULL DEFAULT 0,     -- expected information gain: confidence x subject tier
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','asked','confirmed','declined')),
  asked_conversation_id TEXT,
  asked_at          TEXT,
  answered_at       TEXT,
  answer            TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rq_open ON relation_questions(priority DESC) WHERE status = 'open';
-- Answer capture matches a reply against the conversation's newest asked
-- question — one indexed read on the deterministic pre-model lane.
CREATE INDEX IF NOT EXISTS idx_rq_asked_conversation ON relation_questions(asked_conversation_id) WHERE status = 'asked';
