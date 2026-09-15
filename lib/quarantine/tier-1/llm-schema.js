/**
 * llm-schema.js — Tool schema sent to Claude (Tier 1, Haiku) for classification.
 *
 * WHY strict + enum on action: this is Layer 1 of two-layer action enforcement.
 * Without strict mode + an explicit enum, the model is free to invent actions
 * outside our whitelist (delete, gitignore, regenerate, etc.). Cursor CVE
 * GHSA-82wg-qcm4-fp2w showed schema-side defense is necessary but not sufficient
 * — the executor's ALLOWED_ACTIONS guard is Layer 2. Both layers required.
 */

import { ALLOWED_ACTIONS } from '../schema.js';

export const schema = {
  name: 'classify_misplaced_file',
  strict: true,
  description:
    'Classify a misplaced file. Output the canonical action and destination. ' +
    'Allowed actions: fix-code (rewrite the writer\'s path string and move the file), ' +
    'move-to-canonical (move the file to its canonical home, no source change), ' +
    'quarantine (no canonical home is known; surface for human resolution).',
  input_schema: {
    type: 'object',
    properties: {
      what_it_is:  { type: 'string', description: 'One-line description of what this file contains' },
      intent:      { type: 'string', description: 'What the file is for; who/what consumes it' },
      action:      { type: 'string', enum: [...ALLOWED_ACTIONS] },
      destination: { type: 'string', description: 'Repo-relative path or quarantine subpath' },
      confidence:  { type: 'number', description: 'Confidence in [0,1]' },
      reason:      { type: 'string', description: 'Brief justification for the action + destination' },
      warnings:    { type: 'array', items: { type: 'string' } },
    },
    required: ['what_it_is', 'intent', 'action', 'destination', 'confidence', 'reason'],
    additionalProperties: false,
  },
};
