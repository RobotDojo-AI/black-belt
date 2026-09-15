import db from '../../db.js';
import { defineTool, ok, err } from '../registry.js';

/**
 * SOUL — the persona/behavior instructions the agent reads before every reply.
 * Stored in user_settings under the `system_prompt_extra` key because that's
 * the slot lib/chat.js → buildUserContext() actually injects into the system
 * prompt. Editing only a markdown profile/context file can change what the
 * user sees, but not this extra system-prompt field, so we deliberately
 * target the DB-backed field that does.
 */
const SOUL_KEY = 'system_prompt_extra';
const MAX_LEN = 20000; // ~5K tokens — prevents runaway system prompts.

defineTool('update_soul', {
  description: 'Read, replace, or append to the SOUL identity — the persona and behavior instructions the AI follows in every conversation (tone, directness, when to push back, etc.). Use mode="read" to see current SOUL, "replace" for a full rewrite, "append" to add a rule without losing what\'s there.',
  parameters: {
    properties: {
      mode: {
        type: 'string',
        enum: ['read', 'replace', 'append'],
        description: "read → return current SOUL. replace → overwrite entirely. append → add to end.",
      },
      content: {
        type: 'string',
        description: 'New SOUL content (required for replace/append). Markdown is fine. Max ~20k chars.',
      },
    },
    required: ['mode'],
  },
  execute({ mode, content }) {
    const row = db.prepare('SELECT value FROM user_settings WHERE key = ?').get(SOUL_KEY);
    const current = row?.value || '';

    if (mode === 'read') {
      return ok({ soul: current, length: current.length, key: SOUL_KEY });
    }

    if (typeof content !== 'string' || !content.trim()) {
      return err('content is required for replace/append and must be a non-empty string.');
    }
    if (content.length > MAX_LEN) {
      return err(`content is ${content.length} chars, exceeds max ${MAX_LEN}. Tighten it or split across topic context docs.`);
    }

    let next;
    if (mode === 'replace') {
      next = content;
    } else if (mode === 'append') {
      next = current ? current.trimEnd() + '\n\n' + content : content;
      if (next.length > MAX_LEN) {
        return err(`Appending would exceed ${MAX_LEN} chars (current ${current.length} + new ${content.length}). Use mode="replace" with a tightened version instead.`);
      }
    } else {
      return err(`Unknown mode: ${mode}. Use read, replace, or append.`);
    }

    db.prepare(
      "INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
    ).run(SOUL_KEY, next, next);

    return ok({ mode, length: next.length, key: SOUL_KEY });
  },
});
