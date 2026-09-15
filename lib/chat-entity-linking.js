/**
 * chat-entity-linking.js — tie existing chat chunks to the person/company/place
 * entities they name, precisely.
 *
 * Compute tier: Tier 0 deterministic (no LLM). Person-mention linking already
 * runs in production via the FTS pass; this closes the two real gaps:
 *   (i)  companies and places named in chat text (the FTS pass only does
 *        person→company inheritance, never company/place name matching), and
 *   (ii) a same-name collision guard the FTS pass lacks entirely.
 *
 * Both are handled by routing chat-chunk matching through the precise
 * `resolveEntitiesFromText` recognizer (word-boundary alignment, nickname
 * tolerance, best-ranked-per-name collapse) that already powers the live-chat
 * entity chips — instead of the guardless full-name FTS pass (which is now
 * scoped out of chat in scripts/ingest/link-chunk-entities.js). Two extra
 * guards keep casual prose from mislinking:
 *   - person: a common-surname same-name collision routes to triage, never a
 *     guess (isSurnameRare decides; a rare surname links to the best-ranked).
 *   - company: a short single-token/acronym name below the config floor
 *     ("X", "True", "BVP") is NOT linked — the sharpest false-positive risk.
 *
 * The sweep also cleans the pre-existing indiscriminate same-name chat person
 * links (a chunk linked to all three "Paul Hurst") down to zero before
 * re-linking, so no chat chunk is ever linked to two same-named people.
 */

import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { resolveEntitiesFromText } from './chat-context.js';
import { isSurnameRare } from './nickname-resolver.js';
import { linkChunkToEntity } from './entity-source-evidence.js';

export const INTELLIGENCE_TIER = 'extraction';

const REPO_ROOT = pathResolve(new URL('..', import.meta.url).pathname);
const CHAT_SOURCE_TYPES = ['llm_export', 'conversation'];

function chatEntityConfig() {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(pathResolve(REPO_ROOT, 'config', 'defaults.json'), 'utf8')).chatEntityLinking || {};
  } catch { /* defaults.json absent — hardcoded floors below */ }
  return {
    companyShortNameFloor: Number(process.env.ROBOTDOJO_CHAT_COMPANY_SHORTNAME_FLOOR || raw.companyShortNameFloor || 4),
    sweepBatchSize: Number(process.env.ROBOTDOJO_CHAT_SWEEP_BATCH || raw.sweepBatchSize || 500),
  };
}

/**
 * Delete the pre-existing same-name-collision chat person links (a chunk linked
 * to ≥2 people who share one display_name). All members of each collision group
 * are removed; the guarded re-link below re-adds only the single best-ranked
 * person per name. Returns the number of rows deleted.
 */
export function cleanSameNameChatCollisions(db) {
  const placeholders = CHAT_SOURCE_TYPES.map(() => '?').join(', ');
  const info = db.prepare(`
    DELETE FROM chunk_entities
    WHERE entity_type = 'person'
      AND (chunk_id, entity_id) IN (
        SELECT ce.chunk_id, ce.entity_id
        FROM chunk_entities ce
        JOIN chunks c ON c.id = ce.chunk_id
        JOIN people p ON p.id = ce.entity_id
        WHERE ce.entity_type = 'person'
          AND c.source_type IN (${placeholders})
          AND (ce.chunk_id, p.display_name) IN (
            SELECT ce2.chunk_id, p2.display_name
            FROM chunk_entities ce2
            JOIN chunks c2 ON c2.id = ce2.chunk_id
            JOIN people p2 ON p2.id = ce2.entity_id
            WHERE ce2.entity_type = 'person'
              AND c2.source_type IN (${placeholders})
            GROUP BY ce2.chunk_id, p2.display_name
            HAVING COUNT(*) > 1
          )
      )
  `).run(...CHAT_SOURCE_TYPES, ...CHAT_SOURCE_TYPES);
  return info.changes;
}

function surnameOf(name) {
  const toks = String(name || '').trim().split(/\s+/).filter(Boolean);
  return toks.length ? toks[toks.length - 1] : '';
}

function isShortCompanyToken(name, floor) {
  const toks = String(name || '').trim().split(/\s+/).filter(Boolean);
  return toks.length === 1 && toks[0].length <= floor;
}

// Count active people carrying an exact display_name — the collision signal.
function sameNamePeopleCount(db, displayName, stmt) {
  if (!displayName) return 0;
  return stmt.get(displayName)?.n || 0;
}

/**
 * Sweep chat chunks, linking each to the entities it names via the precise
 * recognizer + the same-name/short-name guards. Deterministic Tier 0; the match
 * is CPU/DB-bound single-connection work (resolveEntitiesFromText is synchronous
 * better-sqlite3), so a bounded batch loop — not fan-out — is the correct shape.
 *
 * @returns {{ cleaned, chunks, linked: {person,company,place}, triage: number }}
 */
export function sweepChatChunkEntities(db, options = {}) {
  const cfg = chatEntityConfig();
  const floor = Number(options.companyShortNameFloor ?? cfg.companyShortNameFloor);
  const batchSize = Number(options.batchSize || cfg.sweepBatchSize);
  const limit = Number.isFinite(options.limit) ? options.limit : Infinity;
  const collectTriage = options.collectTriage || null;

  const cleaned = cleanSameNameChatCollisions(db);

  const placeholders = CHAT_SOURCE_TYPES.map(() => '?').join(', ');
  const countStmt = db.prepare("SELECT COUNT(*) n FROM people WHERE display_name = ? AND COALESCE(archived,0) = 0");
  const pageStmt = db.prepare(`
    SELECT id, content
    FROM chunks
    WHERE source_type IN (${placeholders})
      AND content IS NOT NULL AND content != ''
    ORDER BY id
    LIMIT ? OFFSET ?
  `);

  const linked = { person: 0, company: 0, place: 0 };
  let triage = 0;
  let processed = 0;
  let offset = 0;

  for (;;) {
    if (processed >= limit) break;
    const page = pageStmt.all(...CHAT_SOURCE_TYPES, batchSize, offset);
    if (!page.length) break;
    offset += page.length;

    for (const chunk of page) {
      if (processed >= limit) break;
      processed++;
      let entities = [];
      try { entities = resolveEntitiesFromText(chunk.content, { limit: 8 }); } catch { continue; }
      for (const e of entities) {
        if (e.type === 'person') {
          const collisions = sameNamePeopleCount(db, e.name, countStmt);
          if (collisions > 1 && !isSurnameRare(surnameOf(e.name))) {
            triage++;
            if (collectTriage) collectTriage({ type: 'person', name: e.name, chunk_id: chunk.id, reason: 'common-surname-collision', collisions });
            continue; // ambiguous common name → queued, never guessed
          }
        } else if (e.type === 'company') {
          if (isShortCompanyToken(e.name, floor)) {
            triage++;
            if (collectTriage) collectTriage({ type: 'company', name: e.name, chunk_id: chunk.id, reason: 'short-name-acronym-floor' });
            continue; // "X" / "True" / "BVP" in casual prose → not linked
          }
        }
        const res = linkChunkToEntity(db, chunk.id, e.id, e.type);
        if (res.inserted) linked[e.type] = (linked[e.type] || 0) + 1;
      }
    }
  }

  return { cleaned, chunks: processed, linked, triage };
}
