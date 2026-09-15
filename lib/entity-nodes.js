/**
 * Entity Nodes — entity context provider for the RAG Layer 0.5.
 *
 * Two responsibilities:
 *   1. getEntityNodesForQuery(query, belt) — detect people/companies mentioned
 *      in a chat query and return profile summaries for RAG context injection.
 *   2. extractAndPersistEntities(text, filename) — fire-and-forget entity
 *      detection on uploaded file text. Matches against existing graph, writes
 *      to file_entities if the table exists.
 */
import db from './db.js';
import { matchPerson } from './entity-resolve.js';

// --- Layer 0.5: Query-time entity node lookup ---

/**
 * Detect people and companies mentioned in a query and return their profile
 * summaries. Used by the RAG layered context system (Layer 0.5).
 *
 * @param {string} query
 * @param {string} [belt] - belt tier (unused for now, reserved for gating)
 * @returns {Promise<Array<{name: string, type: string, summary: string}>>}
 */
export async function getEntityNodesForQuery(query, belt = 'white') {
  if (!query || query.length < 3) return [];

  const results = [];
  const queryLower = query.toLowerCase();

  // --- People ---
  try {
    const people = db.prepare(`
      SELECT p.id, p.display_name, p.short_name, p.tier, p.score, p.last_seen,
             c.name AS company_name
      FROM people p
      LEFT JOIN companies c ON c.id = p.company_id
      WHERE p.display_name IS NOT NULL
        AND p.archived = 0
      LIMIT 500
    `).all();

    const matched = people.filter(p => {
      const name = (p.display_name || '').toLowerCase();
      const short = (p.short_name || '').toLowerCase();
      // Match any word-part of the name that is ≥3 chars
      const parts = name.split(/\s+/).filter(w => w.length >= 3);
      return parts.some(part => queryLower.includes(part)) ||
        (short.length >= 3 && queryLower.includes(short));
    }).slice(0, 5);

    for (const p of matched) {
      const parts = [
        p.company_name && `Works at ${p.company_name}`,
        p.tier && `Tier: ${p.tier}`,
        p.last_seen && `Last seen: ${p.last_seen.split('T')[0]}`,
      ].filter(Boolean);

      results.push({
        name: p.display_name,
        type: 'person',
        summary: parts.length > 0 ? parts.join('. ') : 'Person in your network',
      });
    }
  } catch {
    // people table may not exist (test env or very fresh install)
  }

  // --- Companies ---
  try {
    const companies = db.prepare(`
      SELECT id, name, tier, people_count, industry
      FROM companies
      WHERE name IS NOT NULL
      LIMIT 300
    `).all();

    const matched = companies.filter(c => {
      const name = (c.name || '').toLowerCase();
      return name.length >= 3 && queryLower.includes(name);
    }).slice(0, 3);

    for (const c of matched) {
      const parts = [
        c.industry && c.industry,
        c.people_count && `${c.people_count} contacts`,
        c.tier && `Tier: ${c.tier}`,
      ].filter(Boolean);

      results.push({
        name: c.name,
        type: 'company',
        summary: parts.length > 0 ? parts.join('. ') : 'Company in your network',
      });
    }
  } catch {
    // companies table may not exist
  }

  return results;
}

// --- File upload: entity extraction + persistence ---

// Regex heuristic: consecutive Title-Cased words (2–4 words) as candidate names.
// Avoids single-word noise and limits false positives on sentence-start caps.
const NAME_RE = /\b([A-Z][a-z]{1,20})(?:\s+[A-Z][a-z]{1,20}){1,3}\b/g;

// Common title words to skip so "John Smith" passes but "The Report" doesn't.
const STOP_WORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'and', 'but', 'for',
  'not', 'are', 'was', 'were', 'has', 'have', 'had', 'been',
  'will', 'would', 'could', 'should', 'may', 'might', 'must',
  'with', 'from', 'into', 'onto', 'upon', 'over', 'under',
  'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'inc', 'llc', 'ltd', 'corp', 'figure', 'table', 'page', 'section',
]);

function extractCandidateNames(text) {
  const candidates = new Set();
  const snippet = text.slice(0, 15000); // cap at 15K chars for speed

  let m;
  NAME_RE.lastIndex = 0;
  while ((m = NAME_RE.exec(snippet)) !== null && candidates.size < 30) {
    const words = m[0].split(/\s+/);
    // Reject if any word is a stop-word
    if (words.some(w => STOP_WORDS.has(w.toLowerCase()))) continue;
    // Require at least 2 words and at least one word ≥4 chars (filters "Jo Li")
    if (words.length < 2 || !words.some(w => w.length >= 4)) continue;
    candidates.add(m[0]);
  }

  return [...candidates].slice(0, 20);
}

/**
 * Ensure file_entities table exists (no-op if already created by migration).
 * Silently swallowed if the table exists or cannot be created.
 */
function ensureFileEntitiesTable() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_entities (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        filename    TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_file_entities ON file_entities(entity_id);
    `);
  } catch {
    // table already exists, or DB is read-only — both are fine
  }
}

// Lazy-init: create table only on first call to avoid import-time side effects.
let _tableReady = false;
function getInsertStmt() {
  if (!_tableReady) {
    ensureFileEntitiesTable();
    _tableReady = true;
  }
  return db.prepare(
    `INSERT OR IGNORE INTO file_entities (filename, entity_type, entity_id) VALUES (?, ?, ?)`
  );
}

/**
 * Fire-and-forget: extract named entities from file text and persist matches
 * to file_entities. Never throws — errors are swallowed to protect the upload
 * flow.
 *
 * @param {string} text   - Extracted plain text from the uploaded file
 * @param {string} filename - Original upload filename (for provenance)
 */
export async function extractAndPersistEntities(text, filename) {
  if (!text || text.length < 20) return;

  try {
    const candidates = extractCandidateNames(text);
    if (candidates.length === 0) return;

    const insert = getInsertStmt();

    // Match each candidate against people graph
    for (const name of candidates) {
      try {
        const match = matchPerson({ name });
        if (match && match.confidence >= 0.85) {
          insert.run(filename, 'person', match.personId);
        }
      } catch {
        // individual match failure — skip and continue
      }
    }

    // Company matching: check if any company name appears as a substring
    try {
      const companies = db.prepare(`
        SELECT id, name FROM companies WHERE name IS NOT NULL LIMIT 300
      `).all();

      const textLower = text.slice(0, 15000).toLowerCase();
      for (const c of companies) {
        const cname = (c.name || '').toLowerCase();
        if (cname.length >= 3 && textLower.includes(cname)) {
          insert.run(filename, 'company', c.id);
        }
      }
    } catch {
      // companies may not be available
    }
  } catch {
    // swallow all — never break the upload flow
  }
}

export default { getEntityNodesForQuery, extractAndPersistEntities };
