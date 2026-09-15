-- Action chat columns + agent name preference.
--
-- chat_type distinguishes regular chats from @agent command chats.
-- action_status tracks lifecycle: pending → running → completed | failed.
-- action_summary holds a short LLM-written description of the action result.
--
-- agent_name lets users rename the default Miyagi agent.

ALTER TABLE conversations ADD COLUMN chat_type TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE conversations ADD COLUMN action_status TEXT;
ALTER TABLE conversations ADD COLUMN action_summary TEXT;
CREATE INDEX IF NOT EXISTS idx_conv_type ON conversations(chat_type) WHERE chat_type = 'action';

-- Agent name in account preferences
ALTER TABLE account_preferences ADD COLUMN agent_name TEXT NOT NULL DEFAULT 'miyagi';
