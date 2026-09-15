// lib/identity-targets/gemini.js — Google Gemini (gemini.google.com + Gems).
//
// Guided. Gemini supports "Saved info" (global memory) and "Gems" (custom
// bots with a system prompt). Gems give the most room for full identity.

import { renderBlock, contentHashInput } from './render.js';
import { buildExtractionPrompt } from './extraction-prompt.js';
import { createHash } from 'node:crypto';

export default {
  id: 'gemini',
  label: 'Google Gemini',
  kind: 'guided',
  url: 'https://gemini.google.com',

  async apply(snapshot) {
    const block = renderBlock(snapshot, { targetLabel: 'Gemini' });
    const hash = createHash('sha256').update(contentHashInput(snapshot)).digest('hex').slice(0, 12);
    const extractionPrompt = buildExtractionPrompt({
      memoryFeatureName: 'Gemini\'s "Saved info" feature and any Gem-specific context about me',
    });
    return {
      id: 'gemini',
      label: 'Google Gemini',
      url: 'https://gemini.google.com',
      contentHash: hash,
      extractionPrompt,
      extractionSteps: [
        'Open a new conversation at gemini.google.com.',
        'Paste the Extraction Prompt below. Send it.',
        'Copy the entire response back into Robot Dojo.',
      ],
      installBlock: block,
      installSteps: [
        'Open gemini.google.com → Settings (bottom left) → "Saved info". Paste a condensed version of your identity (Gemini currently limits free-form saved info). Save.',
        'For full depth, create a Gem: sidebar → "Gem manager" → New Gem. Name it "Me". Paste the full identity block into the Instructions field. Use this Gem for any conversation where your identity should apply.',
        `Re-paste whenever Robot Dojo shows "version ${hash} not installed" on this target.`,
      ],
    };
  },
};
