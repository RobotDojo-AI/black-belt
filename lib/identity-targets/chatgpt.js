// lib/identity-targets/chatgpt.js — OpenAI ChatGPT (web + apps).
//
// Guided target. ChatGPT's Custom Instructions field has ~1500 char limits
// per sub-field, so we render a condensed prompt and instruct the user to
// paste the full block into a Project's "system prompt" for unlimited depth.

import { renderBlock, contentHashInput } from './render.js';
import { buildExtractionPrompt } from './extraction-prompt.js';
import { createHash } from 'node:crypto';

export default {
  id: 'chatgpt',
  label: 'ChatGPT',
  kind: 'guided',
  url: 'https://chatgpt.com',

  async apply(snapshot) {
    const block = renderBlock(snapshot, { targetLabel: 'ChatGPT' });
    const hash = createHash('sha256').update(contentHashInput(snapshot)).digest('hex').slice(0, 12);
    const extractionPrompt = buildExtractionPrompt({
      memoryFeatureName: 'ChatGPT Memory (the "Saved memories" feature in Settings → Personalization)',
    });
    return {
      id: 'chatgpt',
      label: 'ChatGPT',
      url: 'https://chatgpt.com',
      contentHash: hash,
      extractionPrompt,
      extractionSteps: [
        'Open a fresh chat at chatgpt.com on your most-used account.',
        'Paste the Extraction Prompt below. Send it.',
        'Wait for the dump (can be long — that is the point).',
        'Copy the entire response and paste it back into Robot Dojo so I can distill it into your identity.',
        'Only after the dump is captured, continue with the identity-install steps below.',
      ],
      installBlock: block,
      installSteps: [
        'Open chatgpt.com → click your name (bottom-left) → Customize ChatGPT.',
        'Paste the identity block into "What traits should ChatGPT have?" (or any field with enough room). Save.',
        'For unlimited length, create a Project: "+" next to Projects in the sidebar. Name it "Me". Paste the identity block into the Project\'s Instructions field. Use this project for any conversation where the full identity matters.',
        `Re-paste whenever Robot Dojo shows "version ${hash} not installed" on this target.`,
      ],
    };
  },
};
