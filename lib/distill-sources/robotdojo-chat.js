// lib/distill-sources/robotdojo-chat.js — sample the user's own prompts
// from prior robotdojo chat sessions. Direct user→AI signal — how they
// phrase requests, what behaviors they invoke, what they push back on.
//
// We pull user-role messages only (not assistant). Long + substantive only
// (discard short "ok", "yes", "no" responses). Most recent first.

import db from '../db.js';

const MIN_CHARS = 40;   // skip "ok", "yes", "thanks" — no style signal
const MAX_CHARS = 2000; // truncate epics so one prompt doesn't dominate

export async function gather({ limit = 200 } = {}) {
  const rows = db.prepare(`
    SELECT conversation_id, content, created_at
    FROM messages
    WHERE role = 'user'
      AND length(content) >= ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(MIN_CHARS, limit);

  // user→AI direct communication: valid for Soul (behavior directives user
  // gives), Style (how they phrase requests), and User (projects/context
  // mentioned). NOT Philosophy — thinking frameworks need explicit feedback.
  return rows.map((r, i) => ({
    source: `robotdojo-chat:${r.conversation_id || 'unknown'}:${i}`,
    timestamp: r.created_at,
    type: 'user-prompt',
    description: 'user prompt to robotdojo chat',
    body: r.content.slice(0, MAX_CHARS),
    validCards: ['soul', 'style', 'user'],
  }));
}
