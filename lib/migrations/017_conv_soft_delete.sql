-- Soft-delete for conversations. NULL = active, timestamp = deleted.
ALTER TABLE conversations ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_conv_deleted ON conversations(deleted_at) WHERE deleted_at IS NOT NULL;
