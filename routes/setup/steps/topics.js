import { safeGet } from '../helpers.js';

function compute() {
  const row = safeGet('SELECT COUNT(*) AS c FROM user_topics WHERE visible IS NULL OR visible = 1');
  const count = row?.c || 0;
  return {
    complete: count >= 5,
    preview: count ? `${count} topics defined` : 'Build your T1/T2 topic tree',
  };
}

export default {
  id: 'topics',
  title: 'Topics',
  description: 'Your T1/T2 topic tree for Work, Family, and Personal',
  icon: 'label',
  compute,
  chat_context: 'setup-guide',
  chat_prompt: 'Help me design my topic tree. Walk me through Work, Family, and Personal tiers.',
  inline: true,
  category: 'core',
};
