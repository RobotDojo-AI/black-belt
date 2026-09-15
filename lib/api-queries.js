/**
 * Data queries for routes/api.js
 * Extracted by st_d499b891 (route-db-prepare-extraction)
 */
import { VISIBLE_CONVERSATION_WHERE } from './conversation-visibility.js';

/**
 * Full-text search over conversations (title or message content).
 *
 * st_abf246e4: gated by the shared visibility predicate so in-app search cannot
 * surface archived, sub-agent, or internal-test conversations (previously a real
 * leak — it filtered deleted_at only).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} like - LIKE pattern (e.g. '%query%')
 * @param {number} limit
 */
export function searchConversations(db, like, limit) {
  return db.prepare(`
    SELECT id, title, updated_at FROM conversations
    WHERE (title LIKE ? OR id IN (
      SELECT conversation_id FROM messages WHERE content LIKE ? LIMIT 50
    )) AND ${VISIBLE_CONVERSATION_WHERE}
    ORDER BY updated_at DESC LIMIT ?
  `).all(like, like, limit);
}

/**
 * Extracts a short excerpt around the first match of `q` inside `content`,
 * for the search-result snippet shown under a content-only match. Falls
 * back to a plain prefix when the term can't be located (e.g. it matched
 * via SQL LIKE case-folding this JS indexOf doesn't replicate).
 *
 * @param {string} content
 * @param {string} q
 * @param {number} radius
 */
function extractMatchSnippet(content, q, radius = 60) {
  if (!content) return '';
  const idx = content.toLowerCase().indexOf(String(q).toLowerCase());
  if (idx === -1) return content.slice(0, 120).trim();
  const start = Math.max(0, idx - radius);
  const end = Math.min(content.length, idx + q.length + radius);
  return (start > 0 ? '…' : '') + content.slice(start, end).trim();
}

/**
 * Ranked, bounded search over conversations for the in-app chat search box
 * (st_01b16272 — chat search finds past conversation threads, not people).
 *
 * Two tiers: title matches first (most relevant), then message-content
 * matches, each ordered by recency. WHY two queries instead of one query
 * with a synthetic rank column: SQLite LIKE has no relevance scoring, and
 * title-only vs content-join are structurally different lookups — two
 * simple bounded queries plus a JS merge stays traceable end to end.
 * Content-tier candidates are bounded to 50 raw message rows before the
 * per-conversation snippet lookup, mirroring searchConversations' bound.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} q - raw query text (not a LIKE pattern)
 * @param {number} limit
 * @returns {Array<{id:string, title:string, updated_at:string, _matchSnippet?:string}>}
 */
export function searchConversationsRanked(db, q, limit) {
  const query = String(q || '').trim();
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  if (!query) return [];
  const like = `%${query}%`;

  const titleMatches = db.prepare(`
    SELECT id, title, updated_at FROM conversations
    WHERE title LIKE ? AND ${VISIBLE_CONVERSATION_WHERE}
    ORDER BY updated_at DESC LIMIT ?
  `).all(like, boundedLimit);

  const remaining = boundedLimit - titleMatches.length;
  if (remaining <= 0) return titleMatches;

  const seenIds = titleMatches.map((r) => r.id);
  const exclusion = seenIds.length
    ? `AND c.id NOT IN (${seenIds.map(() => '?').join(',')})`
    : '';

  const contentRows = db.prepare(`
    SELECT c.id as id, c.title as title, c.updated_at as updated_at,
      (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ORDER BY m.id LIMIT 1) as matched_content
    FROM conversations c
    WHERE c.id IN (
      SELECT conversation_id FROM messages WHERE content LIKE ? LIMIT 50
    ) AND ${VISIBLE_CONVERSATION_WHERE} ${exclusion}
    ORDER BY c.updated_at DESC LIMIT ?
  `).all(like, like, ...seenIds, remaining);

  const contentMatches = contentRows.map((r) => ({
    id: r.id,
    title: r.title,
    updated_at: r.updated_at,
    _matchSnippet: extractMatchSnippet(r.matched_content, query),
  }));

  return [...titleMatches, ...contentMatches];
}

/**
 * Full-text search over companies by name.
 * @param {import('better-sqlite3').Database} db
 * @param {string} like
 * @param {number} limit
 */
export function searchCompanies(db, like, limit) {
  return db.prepare(
    `SELECT id, name FROM companies WHERE name LIKE ? LIMIT ?`
  ).all(like, limit);
}

/**
 * Deletes test/stub conversations with no messages.
 * @param {import('better-sqlite3').Database} db
 */
export function deleteTestConversations(db) {
  return db.prepare(
    "DELETE FROM conversations WHERE title IN ('Test', 'test', 'Untitled', '') AND id NOT IN (SELECT conversation_id FROM messages)"
  ).run();
}

/**
 * Returns usage cost by day for the given number of days back.
 * @param {import('better-sqlite3').Database} db
 * @param {number} days
 */
export function getUsageByDay(db, days) {
  return db.prepare(`
    SELECT date(created_at) as date, SUM(cost_cents) as cost_cents
    FROM token_usage
    WHERE date(created_at) >= date('now', '-' || ? || ' days')
    GROUP BY date(created_at)
    ORDER BY date
  `).all(days);
}

/**
 * Returns usage cost by day and model for the given number of days back.
 * @param {import('better-sqlite3').Database} db
 * @param {number} days
 */
export function getUsageByDayAndModel(db, days) {
  return db.prepare(`
    SELECT date(created_at) as date, model, SUM(cost_cents) as cost_cents
    FROM token_usage
    WHERE date(created_at) >= date('now', '-' || ? || ' days')
    GROUP BY date(created_at), model
    ORDER BY date
  `).all(days);
}

/**
 * Returns usage cost by day and purpose for the given number of days back.
 * @param {import('better-sqlite3').Database} db
 * @param {number} days
 */
export function getUsageByDayAndPurpose(db, days) {
  return db.prepare(`
    SELECT date(created_at) as date, COALESCE(purpose, 'unknown') as purpose, SUM(cost_cents) as cost_cents
    FROM token_usage
    WHERE date(created_at) >= date('now', '-' || ? || ' days')
    GROUP BY date(created_at), purpose
    ORDER BY date
  `).all(days);
}

/**
 * Returns today's token usage totals.
 * @param {import('better-sqlite3').Database} db
 * @returns {{ cost_cents: number, calls: number }}
 */
export function getTodayUsage(db) {
  return db.prepare(`
    SELECT COALESCE(SUM(cost_cents), 0) as cost_cents, COUNT(*) as calls
    FROM token_usage WHERE date(created_at) = date('now')
  `).get();
}
