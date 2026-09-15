/**
 * SQLite adapter for public chat — used by the local Hono route.
 *
 * Wraps the same prepared statements the legacy `routes/public-chat.js`
 * had inline. Same semantics as the Supabase adapter:
 *   - `checkAndIncrementRate(ipHash, dayUtc)` → `boolean` (false when over limit)
 *   - `logTranscript({...})` → `void` (upsert on session_id + source)
 *
 * Schema lives in `lib/migrations` (public_chat_rate + public_chats).
 * The composite `key = ip_hash:day` column on public_chat_rate is a SQLite
 * pragma we inherited; keep it for now to avoid a migration.
 */

import db from '../../db.js';
import { DAILY_LIMIT } from '../core.js';

const getRate = db.prepare('SELECT count FROM public_chat_rate WHERE key = ?');
const upsertRate = db.prepare(`
  INSERT INTO public_chat_rate (key, ip_hash, day, count, updated_at)
  VALUES (?, ?, ?, 1, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET
    count = count + 1,
    updated_at = datetime('now')
`);

const insertChat = db.prepare(`
  INSERT INTO public_chats (session_id, ip_hash, user_agent, referrer, messages_json, source, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`);

const updateChat = db.prepare(`
  UPDATE public_chats
     SET messages_json = ?, updated_at = datetime('now')
   WHERE session_id = ? AND source = ?
`);

const findChatBySession = db.prepare(
  `SELECT id FROM public_chats WHERE session_id = ? AND source = ? LIMIT 1`,
);

/**
 * Same contract as the Supabase adapter — synchronous because better-sqlite3
 * is synchronous, but returns a promise-compatible boolean for symmetry.
 */
export function checkAndIncrementRate(ipHash, dayUtc) {
  const key = `${ipHash}:${dayUtc}`;
  const row = getRate.get(key);
  if (row && row.count >= DAILY_LIMIT) return false;
  upsertRate.run(key, ipHash, dayUtc);
  return true;
}

export function logTranscript({ sessionId, ipHash, userAgent, referrer, messages, source }) {
  try {
    const json = JSON.stringify(messages);
    const existing = findChatBySession.get(sessionId, source);
    if (existing) {
      updateChat.run(json, sessionId, source);
    } else {
      insertChat.run(
        sessionId,
        ipHash || null,
        userAgent || null,
        referrer || null,
        json,
        source,
      );
    }
  } catch (err) {
    console.error('[public-chat] sqlite log failed:', err.message);
  }
}
