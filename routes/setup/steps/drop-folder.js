import { safeGet } from '../helpers.js';

function compute() {
  const row = safeGet('SELECT COUNT(*) AS c FROM drop_folder_files');
  const count = row?.c || 0;
  return {
    complete: count > 0,
    preview: count ? `${count} files traceable in ~/robotdojo/user/imports` : 'Drop files into ~/robotdojo/user/inbox',
  };
}

export default {
  id: 'drop-folder',
  title: 'Drop folder',
  description: 'Drop files into ~/robotdojo/user/inbox when you choose to import them; status and recovery history live in ~/robotdojo/user/imports.',
  icon: 'folder_open',
  compute,
  chat_context: 'setup-guide',
  chat_prompt: 'Walk me through initializing my drop folder and testing it end-to-end.',
  inline: false,
  category: 'data',
};
