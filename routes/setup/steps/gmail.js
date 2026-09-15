import { accountHas, safeGet } from '../helpers.js';

function compute() {
  const connected = accountHas('google', 'email');
  const emailCount = safeGet('SELECT COUNT(*) AS c FROM emails')?.c || 0;
  return {
    complete: connected,
    preview: connected ? `Connected — ${emailCount.toLocaleString()} emails indexed` : 'Connect Gmail to feed your RAG',
  };
}

export default {
  id: 'gmail',
  title: 'Gmail',
  description: 'Connect email to feed your RAG',
  icon: 'mail',
  compute,
  auth_url: '/auth/google',
  chat_context: 'setup-guide',
  chat_prompt: 'Help me connect Gmail.',
  inline: false,
  category: 'data',
};
