import { safeGet } from '../helpers.js';

function compute() {
  const row = safeGet("SELECT COUNT(*) AS c FROM (SELECT 1 FROM people LIMIT 50)");
  const count = row?.c || 0;
  return {
    complete: count >= 50,
    preview: count >= 50 ? '50+ people in your graph' : count ? `${count} people in your graph` : 'Import Mac Contacts',
  };
}

export default {
  id: 'contacts',
  title: 'Contacts',
  description: 'Import from Mac Contacts',
  icon: 'contacts',
  compute,
  chat_context: 'setup-guide',
  chat_prompt: 'Help me import my contacts from Mac.',
  inline: false,
  category: 'data',
};
