/**
 * lib/content-queries.js — short-ID lookups and URL builders for content API.
 *
 * Thin-facade rule: all db.prepare calls live here, never in route files.
 *
 * Short-ID convention: the first 8 hex characters of the entity's UUID
 * (stripping hyphens). A LIKE '{8-hex}%' query is robust and unique
 * in practice for personal-scale datasets (collision probability ~6e-10).
 *
 * URL builders mirror the slug conventions used by the SPAs so a URL
 * generated here can be pasted into a browser and resolved by the server's
 * LIKE lookup.
 */

import { VISIBLE_CONVERSATION_WHERE } from './conversation-visibility.js';

// --- Short-ID and slug helpers ---

/**
 * Produce a URL-safe slug from a display string.
 * Lowercase, collapse non-alphanumeric runs to '-', strip leading/trailing
 * '-', truncate to 50 chars.
 * @param {string} str
 * @returns {string}
 */
function toSlug(str) {
  return (str || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/, '')
    .slice(0, 50);
}

/**
 * Extract the first 8 hex characters of an ID, stripping hyphens first.
 * Works for UUID-with-hyphens and raw 32-char hex strings.
 * @param {string} id
 * @returns {string}
 */
function toShortId(id) {
  return String(id || '').replace(/-/g, '').slice(0, 8);
}

// --- DB lookup functions ---

/**
 * Look up a person by short ID (first 8 hex chars of UUID).
 * Returns an array of 0–2 rows so the caller can detect ambiguity.
 * @param {import('better-sqlite3').Database} db
 * @param {string} shortId — 8 hex chars
 * @returns {{ id: string, display_name: string }[]}
 */
export function getPersonByShortId(db, shortId) {
  return db.prepare(
    'SELECT id, display_name FROM people WHERE LOWER(id) LIKE ? AND archived = 0 LIMIT 2',
  ).all(shortId + '%');
}

/**
 * Look up a company by short ID.
 * @param {import('better-sqlite3').Database} db
 * @param {string} shortId
 * @returns {{ id: string, name: string }[]}
 */
export function getCompanyByShortId(db, shortId) {
  return db.prepare(
    'SELECT id, name FROM companies WHERE LOWER(id) LIKE ? LIMIT 2',
  ).all(shortId + '%');
}

/**
 * Look up a conversation by short ID.
 * Conversations have UUID ids with hyphens; strip hyphens before LIKE.
 * @param {import('better-sqlite3').Database} db
 * @param {string} shortId
 * @returns {{ id: string, title: string, file_path: string|null }[]}
 */
export function getConversationByShortId(db, shortId) {
  // st_abf246e4 — the shared chokepoint for BOTH direct-link routes
  // (routes/api.js and routes/content.js). Gating here once makes a hidden
  // conversation (archived / sub-agent / test) unreachable by direct link.
  return db.prepare(
    `SELECT id, title, file_path FROM conversations WHERE REPLACE(LOWER(id), '-', '') LIKE ? AND ${VISIBLE_CONVERSATION_WHERE} LIMIT 2`,
  ).all(shortId + '%');
}

/**
 * Look up a transcript by short ID.
 * Transcript IDs are 32-char hex strings (no hyphens).
 * @param {import('better-sqlite3').Database} db
 * @param {string} shortId
 * @returns {{ id: string, title: string, file_path: string|null, meeting_date: string|null }[]}
 */
export function getTranscriptByShortId(db, shortId) {
  return db.prepare(
    'SELECT id, title, file_path, meeting_date FROM transcripts WHERE LOWER(id) LIKE ? LIMIT 2',
  ).all(shortId + '%');
}

/**
 * Look up a topic by slug (slug is the PRIMARY KEY in user_topics).
 * @param {import('better-sqlite3').Database} db
 * @param {string} slug — may be 'work' or 'work/project' (nested)
 * @returns {{ slug: string, label: string, parent_slug: string|null }|undefined}
 */
export function getTopicBySlug(db, slug) {
  return db.prepare(
    'SELECT slug, label, parent_slug FROM user_topics WHERE slug = ?',
  ).get(slug);
}

// --- URL builder functions ---

/**
 * Build the canonical URL for a person.
 * @param {string} id — UUID (with or without hyphens)
 * @param {string} displayName
 * @returns {string} e.g. '/network/people/alex-example-01c2ab6b'
 */
export function buildPersonUrl(id, displayName) {
  const slug = toSlug(displayName);
  const shortId = toShortId(id);
  return `/network/people/${slug ? slug + '-' : ''}${shortId}`;
}

/**
 * Build the canonical URL for a company.
 * @param {string} id
 * @param {string} name
 * @returns {string} e.g. '/network/companies/apple-inc-f3e2a1b0'
 */
export function buildCompanyUrl(id, name) {
  const slug = toSlug(name);
  const shortId = toShortId(id);
  return `/network/companies/${slug ? slug + '-' : ''}${shortId}`;
}

/**
 * Build the canonical URL for a chat conversation.
 * @param {string} id — UUID (with hyphens); strip to get 8-hex prefix
 * @param {string} title
 * @returns {string} e.g. '/chat/top-narrative-docs-005337bf'
 */
export function buildConversationUrl(id, title) {
  const slug = toSlug(title);
  const shortId = toShortId(id);
  return `/chat/${slug ? slug + '-' : ''}${shortId}`;
}

/**
 * Build the canonical URL for a transcript.
 * @param {string} id — 32-char hex string; first 8 chars are the short ID
 * @param {string} title
 * @returns {string} e.g. '/transcripts/executive-monday-006a0782'
 */
export function buildTranscriptUrl(id, title) {
  const slug = toSlug(title);
  const shortId = toShortId(id);
  return `/transcripts/${slug ? slug + '-' : ''}${shortId}`;
}
