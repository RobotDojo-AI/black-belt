ALTER TABLE conversations ADD COLUMN thread_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_thread_id ON conversations (thread_id) WHERE thread_id IS NOT NULL;
