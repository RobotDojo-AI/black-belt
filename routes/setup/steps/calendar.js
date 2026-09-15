import { accountHas, safeGet } from '../helpers.js';

function compute() {
  const connected = accountHas('google', 'calendar');
  const eventCount = safeGet('SELECT COUNT(*) AS c FROM calendar_events')?.c || 0;
  return {
    complete: connected,
    preview: connected ? `${eventCount.toLocaleString()} events synced` : 'Connect Google Calendar',
  };
}

export default {
  id: 'calendar',
  title: 'Calendar',
  description: 'Google Calendar sync',
  icon: 'calendar_month',
  compute,
  auth_url: '/auth/google',
  chat_context: 'setup-guide',
  chat_prompt: 'Help me connect my calendar.',
  inline: false,
  category: 'data',
};
