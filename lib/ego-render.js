/**
 * lib/ego-render.js — the deterministic who-is-who block (st_df0a8d71 D3).
 *
 * Renders the owner's first-degree world — spouse, children, parents, in-laws,
 * siblings, grandparents, cousins, pets, owner employer — from the entity
 * graph into a compact block of structured fact lines (~300 tokens). This is
 * the SOLE who-is-who authority in every chat prompt: it rides Block 3 (the
 * identity cache block) so family truth lives in the byte-stable cached
 * prefix, structurally outside the volatile rich-context race that dropped it
 * in the defect turn (conv 624321fc: a silent fast_timeout_fallback served an
 * LLM-confabulated card as the only relationship evidence).
 *
 * INVARIANTS (each one closes a proven failure mode):
 *
 *   1. Reads people.relation_tag / relation_label ONLY — never edge weights.
 *      On the live graph an interaction-derived 'colleague' edge (weight 11.8)
 *      outranks the curated spouse edge (weight 10) on the spouse's own row;
 *      any weight-ranked render would call the owner's wife a colleague. By
 *      reading only the curated-class columns, that inversion is structurally
 *      impossible, not merely filtered.
 *   2. Zero per-turn SQL. The rendered string is memoized in-process; prompt
 *      assembly reads memory. Refresh happens off-turn: boot warmup, the
 *      `graph-change` app event (fired by every setRelationTag/setEmployerFact
 *      write — guarantees a chat correction lands next turn), and an unref'd
 *      idle tick as backstop for out-of-process pipeline writers (worst-case
 *      staleness minutes, named in the plan's assumptions).
 *   3. Structured fact lines, not prose — LongMemEval measured ~10-point
 *      reading-accuracy gain for structured facts over narrative.
 *   4. Fails LOUD, degrades honest. A missing owner id or a render error logs
 *      a warning and yields '' — the assembled prompt then omits the block,
 *      per-turn recording flags ego_block_present=0 (AC-7), and the grounding
 *      contract forces abstention instead of confabulation.
 *
 * Tier 0 — deterministic SQL → string. No LLM may ever write into this block.
 */

import { ownerPersonId } from './identity.js';
// FAMILY_TAGS from the vocabulary module, NOT scoring.js — scoring imports
// lib/db.js and this module's import graph must stay db-free (see below).
import { FAMILY_TAGS, relationPhrase } from './relation-vocabulary.js';
import { appEvents } from './app-events.js';

// NO static lib/db.js import — deliberately. This module rides the prompt
// assembly import graph (lib/chat/system-prompt.js), which lint gates and
// tests also import; a static db edge would make every one of those consumers
// open the live encrypted DB as an import side effect (measured ~1.5 s per
// import) and pull read-only linters into the direct-db-writers registry.
// Instead the app BINDS its handle at runtime: the first refreshEgoBlock(db)
// (boot warmup) stores it for the graph-change listener and idle tick; the
// hot path (getEgoBlock) is a memo read that needs no database at all.
let _boundDb = null;

// The header doubles as the presence marker prompt assembly checks (AC-7):
// if this exact line is not in the assembled blocks, the turn records
// ego_block_present=0 and warns loudly.
export const EGO_BLOCK_HEADER = '## Who is who (from your entity graph)';

// Render order: closest relations first so truncation (never expected — the
// live first-degree set is ~35 rows) would drop the least-close lines last.
const RELATION_ORDER = [
  'spouse', 'child', 'parent', 'parent-in-law', 'sibling', 'sibling-in-law',
  'grandparent', 'cousin', 'niece-nephew', 'family', 'IL', 'pet',
];
const RELATION_RANK = new Map(RELATION_ORDER.map((t, i) => [t, i]));

// Hard line cap — keeps the block near its ~300-token budget even on a graph
// with an unusually large family-tagged set. Deliberately generous: the block
// must be COMPLETE for any normal family (coverage beats brevity here; the
// quiz asserts every family-tagged row renders, so the cap only guards a
// pathological graph).
const MAX_FACT_LINES = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_EGO_MAX_LINES || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 80;
})();

// Idle-tick backstop cadence for out-of-process graph writers (pipeline
// scripts run in their own process; their writes can't emit our in-process
// event). 5 minutes bounds staleness to the same window as the layered
// context TTL.
const EGO_IDLE_REFRESH_MS = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_EGO_IDLE_REFRESH_MS || '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 5 * 60_000;
})();

function capitalize(word) {
  const w = String(word || '');
  return w ? w[0].toUpperCase() + w.slice(1) : w;
}

/**
 * Render the who-is-who block from the graph. Pure read → string; no memo,
 * no side effects beyond loud logging. Tests call this directly with a
 * fixture DB; production reads go through getEgoBlock() (the memo).
 *
 * @param {import('better-sqlite3').Database} [database] - defaults to the
 *   runtime-bound handle (see the no-static-db note above)
 * @param {object} [opts]
 * @param {string|null} [opts.ownerId] - override for tests; defaults to
 *   identity.json owner_person_id
 * @returns {string} the rendered block, or '' (loud) when it cannot render
 */
export function renderEgoBlock(database = _boundDb, { ownerId = null } = {}) {
  if (!database) {
    console.warn('[ego-render] no database handle bound — who-is-who block cannot render (boot warmup calls refreshEgoBlock(db))');
    return '';
  }
  const owner = ownerId || ownerPersonId();
  if (!owner) {
    console.warn('[ego-render] owner_person_id missing from identity.json — who-is-who block cannot render');
    return '';
  }

  let rows;
  try {
    // relation_tag/relation_label/relation_derived_phrase are the derived
    // cache columns (walker-maintained from person_relations; written only by
    // code-validated writers). Edge weights are deliberately not consulted —
    // see invariant 1 in the module header.
    rows = database.prepare(`
      SELECT id, display_name, relation_tag, relation_label, relation_derived_phrase
      FROM people
      WHERE relation_tag IS NOT NULL
        AND COALESCE(archived, 0) = 0
        AND id != ?
      ORDER BY display_name COLLATE NOCASE ASC
    `).all(String(owner));
  } catch (err) {
    console.warn('[ego-render] graph read failed:', err.message);
    return '';
  }

  const family = rows
    .filter((r) => FAMILY_TAGS.has(r.relation_tag) && String(r.display_name || '').trim())
    .sort((a, b) => {
      const ra = RELATION_RANK.get(a.relation_tag) ?? 99;
      const rb = RELATION_RANK.get(b.relation_tag) ?? 99;
      return ra - rb || String(a.display_name).localeCompare(String(b.display_name));
    });

  const lines = family.slice(0, MAX_FACT_LINES).map((r) => {
    // st_f67bc2eb AC-2 — the walk-derived phrase is the most precise truth we
    // hold ("Wife's cousin: X" beats "In-law: X"); the coarse tag+label phrase
    // is the fallback for direct relations, where it is already exact.
    const phrase = capitalize(r.relation_derived_phrase || relationPhrase(r.relation_tag, r.relation_label));
    return `- ${phrase}: ${String(r.display_name).trim()}`;
  });
  const overflow = family.length - lines.length;

  // Owner employer — single-row indexed read; entity_facts current employer is
  // the fallback for owners without a company_id link.
  let employerLine = '';
  try {
    const ownerRow = database.prepare(`
      SELECT c.name AS company_name
      FROM people p LEFT JOIN companies c ON c.id = p.company_id
      WHERE p.id = ?
    `).get(String(owner));
    let employer = ownerRow?.company_name || null;
    if (!employer) {
      const fact = database.prepare(`
        SELECT fact_value FROM entity_facts
        WHERE entity_id = ? AND entity_type = 'person'
          AND fact_type = 'employer' AND invalid_at IS NULL
        ORDER BY id DESC LIMIT 1
      `).get(String(owner));
      employer = fact?.fact_value || null;
    }
    if (employer) employerLine = `- You work at ${employer}.`;
  } catch { /* employer is optional; family lines still render */ }

  if (!lines.length && !employerLine) {
    // An empty first-degree graph is a real (fresh-install) state, not an
    // error — but it must still be visible, because on a populated graph an
    // empty render means the read went wrong.
    console.warn('[ego-render] no family-tagged people and no employer — who-is-who block is empty');
    return '';
  }

  const parts = [
    EGO_BLOCK_HEADER,
    // The authority contract: this block outranks every other injected
    // artifact for relationship facts — generated cards and RAG lost
    // who-is-who authority in this story (AC-3).
    'These relationship facts are computed directly from the curated entity graph. For who-is-who questions they are authoritative and outrank any other injected context, including generated profile cards and retrieved documents.',
    ...lines,
  ];
  if (overflow > 0) parts.push(`- (+${overflow} more family-tagged people on record)`);
  if (employerLine) parts.push(employerLine);
  parts.push('If a person is not listed here, their family relationship to the user is not on record.');
  return parts.join('\n');
}

// ── In-process memo (invariant 2: zero per-turn SQL) ─────────────────────────

let _memo = null; // { text: string, renderedAt: number }
let _idleTimer = null;

function ensureIdleTick() {
  if (_idleTimer || EGO_IDLE_REFRESH_MS <= 0) return;
  _idleTimer = setInterval(() => {
    try { if (_boundDb) refreshEgoBlock(); } catch { /* refresh never throws, defensive */ }
  }, EGO_IDLE_REFRESH_MS);
  if (typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

/**
 * Re-render and swap the memo. Never throws — a failed render memoizes ''
 * (loud via renderEgoBlock's own warnings) so chat never breaks on this layer.
 *
 * Passing an explicit database BINDS it for the module's own refresh triggers
 * (graph-change listener, idle tick) — the boot warmup call is the app's
 * bind point.
 *
 * @param {import('better-sqlite3').Database} [database]
 * @returns {string} the freshly rendered block
 */
export function refreshEgoBlock(database = _boundDb) {
  if (database) _boundDb = database;
  let text = '';
  try {
    text = renderEgoBlock(database);
  } catch (err) {
    console.warn('[ego-render] refresh failed:', err.message);
  }
  _memo = { text, renderedAt: Date.now() };
  ensureIdleTick();
  return text;
}

/**
 * Hot-path read: prefer the boot-primed memo. If memo is empty but a DB was
 * bound (warmup race or graph never primed), do one refresh so who-is-who is
 * not permanently blank for the whole process life after a soft failure.
 * Still never opens a new DB connection — only uses the bound handle.
 */
export function getEgoBlock() {
  if (_memo?.text) return _memo.text;
  if (_boundDb) {
    try {
      const text = refreshEgoBlock(_boundDb);
      if (text) return text;
    } catch (err) {
      console.warn('[ego-render] getEgoBlock refresh failed:', err.message);
    }
  }
  return _memo ? _memo.text : '';
}

/** Presence/size info for per-turn recording (AC-7). Memory read only. */
export function getEgoBlockInfo() {
  return {
    present: Boolean(_memo && _memo.text),
    chars: _memo?.text?.length || 0,
    renderedAt: _memo?.renderedAt || null,
  };
}

// Event-driven refresh: every code-validated graph write emits `graph-change`
// (lib/people-write.js). setImmediate hops the write path so the correction's
// own turn never pays the re-render; the NEXT turn reads the fresh memo —
// AC-5's next-turn guarantee. No-op until a database is bound (a process that
// never bound one has no memo consumers either).
appEvents.on('graph-change', () => {
  setImmediate(() => { if (_boundDb) refreshEgoBlock(); });
});

/** Test hook — drop the memo, bound handle, and idle timer. */
export function _resetEgoRenderForTest() {
  _memo = null;
  _boundDb = null;
  if (_idleTimer) { clearInterval(_idleTimer); _idleTimer = null; }
}
