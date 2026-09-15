// Onboarding: "teach Robot Dojo everything your other AIs already know."
// For each external AI (ChatGPT, Claude.ai, Gemini, Perplexity, Grok), the
// user pastes an extraction prompt we render for them, then pastes the
// resulting dump back. The dumps get fed to the identity distill pipeline
// AFTER the API-key step is complete (runs on the user's key, not ours).
//
// Gate: blocked on `api-key` step being complete. This is enforced in the
// UI (card shows "locked" until api-key shows complete) and can be
// enforced server-side too by checking keychainHas() before accepting
// dumps.

import { readSetting, safeGet } from '../helpers.js';
import { keychainHas, SUPPORTED_PROVIDERS } from './api-key.js';

const PROMPT_TOOLS = [
  { id: 'chatgpt',    label: 'ChatGPT',    url: 'https://chatgpt.com',              settingKey: 'extraction_dump_chatgpt',   importTag: 'import-openai' },
  { id: 'claude-ai',  label: 'Claude.ai',  url: 'https://claude.ai',                settingKey: 'extraction_dump_claude_ai', importTag: 'import-claude-code' },
  { id: 'gemini',     label: 'Gemini',     url: 'https://gemini.google.com',        settingKey: 'extraction_dump_gemini',    importTag: 'import-gemini' },
  { id: 'perplexity', label: 'Perplexity', url: 'https://www.perplexity.ai',        settingKey: 'extraction_dump_perplexity', importTag: null },
  { id: 'grok',       label: 'Grok',       url: 'https://grok.com',                 settingKey: 'extraction_dump_grok',      importTag: null },
];

// Cache tag existence check — import-* tags are stable once written
const _importTagCache = new Map();
function hasImportTag(tag) {
  if (!tag) return false;
  if (!_importTagCache.has(tag)) {
    const row = safeGet(`SELECT 1 FROM conversations WHERE tags LIKE ? LIMIT 1`, [`%${tag}%`]);
    _importTagCache.set(tag, !!row);
  }
  return _importTagCache.get(tag);
}

function gateOpen() {
  return SUPPORTED_PROVIDERS.some((p) => keychainHas(p.keychain, p.aliases));
}

function compute() {
  // The live prompt dump does not need a Robot Dojo API key — the user
  // pastes into ChatGPT / Claude / Gemini / Grok in the browser.
  const dumped = PROMPT_TOOLS.filter((t) => {
    const v = readSetting(t.settingKey);
    if (v && v.length > 200) return true;
    return hasImportTag(t.importTag);
  });
  const count = dumped.length;
  const complete = count > 0;
  const preview = complete
    ? `${count} of ${PROMPT_TOOLS.length} imported: ${dumped.map((t) => t.label).join(', ')}`
    : 'Copy the prompt into ChatGPT, Claude, Gemini, or Grok';
  return { complete, preview };
}

export default {
  id: 'extraction-prompts',
  title: 'Import what other AIs know about you',
  description: 'Copy one prompt into ChatGPT, Claude, Gemini, or Grok — the fastest identity dump',
  icon: 'download',
  compute,
  chat_context: 'extraction-prompts',
  chat_prompt: 'Walk me through importing what ChatGPT, Claude.ai, Gemini, Perplexity, and Grok already know about me. You have the extraction prompts — give them to me one at a time, I\'ll paste the dumps back.',
  inline: false,
  category: 'data',
  featured: true,
  prompt: true,
  tools: PROMPT_TOOLS,
  how: [
    'Click the copy icon on the prompt below. The whole prompt is now on your clipboard.',
    'Click Open ChatGPT — or Claude, Gemini, or Grok, whichever you actually use. A new tab opens.',
    'Start a new chat in that tab. Paste. Send. Let it finish. Do not stop it early. The longer dump is the useful one.',
    'Select the entire reply. Copy it.',
    'Come back. On You, click Bring the answer back. Paste the dump with Miyagi.',
    'Repeat for each AI you actually use. Then mark this complete.',
  ],
  done: 'You pasted at least one AI dump back into Robot Dojo.',
  links: [
    { label: 'Open ChatGPT', href: 'https://chatgpt.com' },
    { label: 'Open Claude', href: 'https://claude.ai' },
    { label: 'Open Gemini', href: 'https://gemini.google.com' },
    { label: 'Open Grok', href: 'https://grok.com' },
    { label: 'Bring the answer back', href: '/account/you' },
  ],
};

export { PROMPT_TOOLS, gateOpen };
