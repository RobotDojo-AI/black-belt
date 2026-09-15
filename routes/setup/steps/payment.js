import { safeGet } from '../helpers.js';

function compute() {
  const user = safeGet("SELECT subscription_status FROM users WHERE id = 1");
  const active = user?.subscription_status === 'black';
  return {
    complete: active,
    preview: active ? `Belt: ${user.subscription_status}` : 'Add an issued Black Belt key when you have one',
  };
}

export default {
  id: 'payment',
  title: 'Black Belt access',
  description: 'Private beta access uses issued or prepaid keys. Checkout is not part of the beta setup flow.',
  icon: 'workspace_premium',
  compute,
  chat_context: 'faq-context',
  chat_prompt: 'Explain Black Belt access during the private beta.',
  inline: false,
  category: 'optional',
};
