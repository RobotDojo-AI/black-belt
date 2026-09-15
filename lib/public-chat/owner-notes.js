/**
 * Public chat — owner FAQ notes loader (NODE-ONLY).
 *
 * IMPORTANT: this module MUST NEVER be imported by:
 *   - lib/public-chat/core.js          (runtime-agnostic, Edge-bundled)
 *   - lib/public-chat/handler.js       (runtime-agnostic, Edge-bundled)
 *   - api/public-chat.js               (Vercel Edge function)
 *
 * It uses `node:fs`, `node:os`, `node:path` and would break the Edge bundle
 * (Vercel rejects Edge functions that reference Node built-ins). The Edge
 * deployment is intentionally docs-only: it cannot read the operator's local
 * disk, so owner notes do not apply there. Only the LOCAL Node server
 * (`routes/public-chat.js`) imports this module and injects its return value
 * into `buildSystemPrompt(ctx, { ownerNotes })`.
 *
 * Behavior (st_85ca4f3c AC 15):
 *   - Reads `~/robotdojo/user/faq-notes.md` once at module init.
 *   - Returns the file contents (string) if present and non-empty.
 *   - Returns `null` when absent — that is the expected default for a fresh
 *     clone. One-time info log; never warns repeatedly. Server restart is
 *     required to pick up a changed file; this is by design (the notes are
 *     part of the cached system prefix, and re-reading per-request would
 *     defeat the prompt cache).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OWNER_FAQ_NOTES_PATH = join(homedir(), 'robotdojo', 'user', 'faq-notes.md');

export function loadOwnerFaqNotes() {
  try {
    const text = readFileSync(OWNER_FAQ_NOTES_PATH, 'utf8');
    return text.trim() ? text : null;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.info(`[public-chat] owner FAQ notes not found at user/faq-notes.md — using docs only`);
      return null;
    }
    console.warn(`[public-chat] owner FAQ notes read failed (${err && err.message}); using docs only`);
    return null;
  }
}

export const ownerFaqNotes = loadOwnerFaqNotes();

export { OWNER_FAQ_NOTES_PATH };
