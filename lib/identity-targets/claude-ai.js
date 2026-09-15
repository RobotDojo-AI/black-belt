// lib/identity-targets/claude-ai.js — Anthropic Claude.ai (web + desktop).
//
// Guided. Claude.ai has Personal Preferences (global) and Projects (scoped
// with a custom system prompt). We recommend a Project for full-depth
// identity; Personal Preferences for a condensed version.

import { renderBlock, contentHashInput } from './render.js';
import { buildExtractionPrompt } from './extraction-prompt.js';
import { createHash } from 'node:crypto';

export default {
  id: 'claude-ai',
  label: 'Claude.ai',
  kind: 'guided',
  url: 'https://claude.ai',

  async apply(snapshot) {
    const block = renderBlock(snapshot, { targetLabel: 'Claude.ai' });
    const hash = createHash('sha256').update(contentHashInput(snapshot)).digest('hex').slice(0, 12);
    const extractionPrompt = buildExtractionPrompt({
      memoryFeatureName: 'Claude\'s memory feature and any Project context you hold about me',
    });
    return {
      id: 'claude-ai',
      label: 'Claude.ai',
      url: 'https://claude.ai',
      contentHash: hash,
      extractionPrompt,
      extractionSteps: [
        'Open a new conversation at claude.ai — ideally inside the Project you use most, so Claude has maximum context.',
        'Paste the Extraction Prompt below. Send it.',
        'Copy the entire response back into Robot Dojo.',
      ],
      installBlock: block,
      installSteps: [
        'Open claude.ai → your initials (bottom-left) → Settings → Profile → "What personal preferences should Claude consider in responses?". Paste the identity block. Save.',
        'For unlimited length, create a Project: "Projects" in the sidebar → New project. Name it "Me" (or use an existing personal project). Paste the full identity block into the Project\'s "Project instructions" (custom system prompt). Use this project for deep work.',
        `Re-paste whenever Robot Dojo shows "version ${hash} not installed" on this target.`,
      ],
    };
  },
};
