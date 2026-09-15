import { readSetting } from '../helpers.js';

function compute() {
  const style = readSetting('communication_style');
  const tone = readSetting('tone');
  const coaching = readSetting('coaching_toggle');
  const filled = [style, tone, coaching].filter(Boolean).length;
  return {
    complete: filled >= 2,
    preview: filled >= 2
      ? `${style || tone || coaching}`.slice(0, 60)
      : 'Teach Miyagi how to talk to you',
  };
}

export default {
  id: 'soul',
  title: 'Soul',
  description: 'How Miyagi should behave',
  icon: 'self_improvement',
  compute,
  chat_context: 'setup-guide',
  chat_prompt: 'Help me define how you should talk to me — tone, directness, and when to push back.',
  inline: false,
  category: 'core',
  how: [
    'This is how Robot Dojo should talk: blunt vs warm, when to argue, what never to do.',
    'Click Open You. You stay in Account. The You page opens.',
    'Use the You-tab prompt for another AI if you have not already. That dump usually contains voice and preferences.',
    'Or tell chat, in one paragraph: how you want answers, what to skip, when to push back.',
    'Come back to Set Up and mark complete.',
  ],
  done: 'You have given Robot Dojo at least a voice preference, from You or from chat.',
  links: [
    { label: 'Open You', href: '/account/you' },
  ],
};
