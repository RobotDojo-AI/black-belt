// lib/identity-targets/index.js — registry for identity export targets.
//
// Two kinds:
//   - auto-sync: robotdojo writes a fenced block to a local file on the user's
//     machine (Claude Code, Cursor, Codex, Copilot, generic).
//   - guided: robotdojo produces a copy-paste payload + step-by-step for a
//     hosted AI tool (ChatGPT, Claude.ai, Gemini, Perplexity).
//
// The user's enabled target list lives in user_settings under the key
// `identity.targets`. Its shape:
//   [
//     { id: 'claude-code', enabled: true, path?: string, installedVersion?: string },
//     { id: 'chatgpt', enabled: true, installedVersion?: string },
//     ...
//   ]
// Unknown ids are tolerated (forward-compat with custom targets).

import claudeCode from './claude-code.js';
import cursor from './cursor.js';
import codex from './codex.js';
import copilot from './copilot.js';
import generic from './generic.js';
import chatgpt from './chatgpt.js';
import claudeAi from './claude-ai.js';
import gemini from './gemini.js';
import perplexity from './perplexity.js';

const ADAPTERS = [
  claudeCode,
  cursor,
  codex,
  copilot,
  generic,
  chatgpt,
  claudeAi,
  gemini,
  perplexity,
];

const BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

/**
 * Return the adapter for an id, or null.
 */
export function getAdapter(id) {
  return BY_ID.get(id) || null;
}

/**
 * Return all adapters with summary metadata (no apply() invoked).
 */
export function listAdapters() {
  return ADAPTERS.map((a) => ({
    id: a.id,
    label: a.label,
    kind: a.kind,
    defaultPath: a.defaultPath || null,
    url: a.url || null,
    setupHint: a.setupHint || null,
  }));
}

/**
 * Default target list seeded at first run. Auto-sync local tools are
 * enabled by default (the file gets written when the tool is actually
 * installed — no-op otherwise). Guided web tools start disabled — the user
 * opts in per tool because each install requires manual paste work.
 */
export function defaultTargetList() {
  return [
    { id: 'claude-code', enabled: true },
    { id: 'cursor', enabled: true },
    { id: 'codex', enabled: true },
    { id: 'copilot', enabled: false }, // requires a one-time IDE setting to point at the file
    { id: 'chatgpt', enabled: false },
    { id: 'claude-ai', enabled: false },
    { id: 'gemini', enabled: false },
    { id: 'perplexity', enabled: false },
  ];
}

export const AUTO_SYNC_KINDS = new Set(['auto-sync']);
export const GUIDED_KINDS = new Set(['guided']);
