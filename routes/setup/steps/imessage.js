import { safeGet } from '../helpers.js';

function compute() {
  // Source-type 'imessage' in chunks indicates the import ran.
  const row = safeGet("SELECT COUNT(*) AS c FROM chunks WHERE source_type = 'imessage'");
  const count = row?.c || 0;
  return {
    complete: count > 0,
    preview: count ? `${count.toLocaleString()} messages imported` : 'Import iMessage from your Mac',
  };
}

export default {
  id: 'imessage',
  title: 'iMessage',
  description: 'Import from the Mac iMessage database',
  icon: 'chat',
  compute,
  chat_context: 'setup-guide',
  chat_prompt: 'Walk me through importing iMessage from my Mac.',
  inline: false,
  category: 'data',
};
