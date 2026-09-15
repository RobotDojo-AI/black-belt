// lib/identity-targets/perplexity.js — Perplexity AI.
//
// Guided. Perplexity has "AI Profile" (personalized settings) and Spaces
// (the Project equivalent with a system prompt). Spaces give the most
// room for full identity.

import { renderBlock, contentHashInput } from './render.js';
import { buildExtractionPrompt } from './extraction-prompt.js';
import { createHash } from 'node:crypto';

export default {
  id: 'perplexity',
  label: 'Perplexity',
  kind: 'guided',
  url: 'https://www.perplexity.ai',

  async apply(snapshot) {
    const block = renderBlock(snapshot, { targetLabel: 'Perplexity' });
    const hash = createHash('sha256').update(contentHashInput(snapshot)).digest('hex').slice(0, 12);
    const extractionPrompt = buildExtractionPrompt({
      memoryFeatureName: 'Perplexity\'s AI Profile and any Space-specific context you hold about me',
    });
    return {
      id: 'perplexity',
      label: 'Perplexity',
      url: 'https://www.perplexity.ai',
      contentHash: hash,
      extractionPrompt,
      extractionSteps: [
        'Open a new thread at perplexity.ai.',
        'Paste the Extraction Prompt below. Send it.',
        'Copy the entire response back into Robot Dojo.',
      ],
      installBlock: block,
      installSteps: [
        'Open perplexity.ai → Settings → AI Profile → "What should the AI know about you?". Paste your identity block. Save.',
        'For more depth, create a Space: sidebar → Spaces → New. Name it "Me". Paste the full identity block into the Space\'s AI Instructions. Use this Space for any thread where identity should apply.',
        `Re-paste whenever Robot Dojo shows "version ${hash} not installed" on this target.`,
      ],
    };
  },
};
