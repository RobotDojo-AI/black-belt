import { safeGet } from '../helpers.js';

function compute() {
  const row = safeGet('SELECT COUNT(*) AS c FROM key_documents');
  const count = row?.c || 0;
  return {
    complete: count > 0,
    preview: count ? `${count} key documents parsed` : 'Drop a tax return or utility bill',
  };
}

export default {
  id: 'key-documents',
  title: 'Key documents',
  description: 'Tax returns, utility bills, statements',
  icon: 'description',
  compute,
  chat_context: 'setup-guide',
  chat_prompt: 'Help me add key documents so you can verify my residence and identity.',
  inline: false,
  category: 'data',
};
