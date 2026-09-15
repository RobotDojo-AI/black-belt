/**
 * lib/conversation-visibility.js — the single source of truth for which
 * conversations are shown to the owner (st_abf246e4 Phase 3).
 *
 * Soft-delete / hide leaks happen when the visibility rule is re-typed in each
 * surface's WHERE clause and one surface forgets a clause. This module holds
 * the ONE predicate every authenticated conversation surface reads through:
 * the list, in-app search, and both direct-link routes. A row is visible when
 * it is not soft-deleted, not archived, and not owned by a machine (sub-agent
 * or internal test). NULL origin = pre-existing imports + web chats = visible.
 *
 * VISIBLE_CONVERSATION_WHERE is a raw SQL fragment (safe to interpolate — it
 * contains only literals, no user input) for query-time filtering.
 * isConversationVisible(row) is its JS mirror for post-fetch single-row gating
 * on a route that fetched by full id.
 */

export const VISIBLE_CONVERSATION_WHERE =
  "deleted_at IS NULL AND (archived IS NULL OR archived = 0) AND (origin IS NULL OR origin = 'owner')";

/**
 * JS mirror of VISIBLE_CONVERSATION_WHERE for gating a single already-fetched
 * row (the full-id direct-fetch route). Must stay byte-for-byte equivalent in
 * meaning to the SQL predicate above.
 *
 * @param {{deleted_at?: any, archived?: any, origin?: string|null}|null|undefined} row
 * @returns {boolean}
 */
export function isConversationVisible(row) {
  if (!row) return false;
  if (row.deleted_at != null) return false;
  if (row.archived != null && Number(row.archived) !== 0) return false;
  const origin = row.origin;
  if (origin != null && origin !== 'owner') return false;
  return true;
}
