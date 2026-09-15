import { readSetting } from '../helpers.js';

function compute() {
  const name = readSetting('name');
  const email = readSetting('email');
  const timezone = readSetting('timezone');
  const location = readSetting('location');
  const filled = [name, email, timezone, location].filter(Boolean).length;
  const complete = filled === 4;
  if (!filled) return { complete, preview: 'Tell Miyagi who you are' };
  const bits = [name, location].filter(Boolean).join(', ');
  return {
    complete,
    preview: complete ? bits : `${filled} of 4 fields filled`,
  };
}

export default {
  id: 'identity',
  title: 'Identity',
  description: 'Your name, email, timezone, location',
  icon: 'badge',
  compute,
  chat_context: 'setup-guide',
  chat_prompt: 'Help me set up my identity — name, email, timezone, and where I live.',
  inline: true,
  category: 'core',
};
