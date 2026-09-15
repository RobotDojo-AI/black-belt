/**
 * lib/review-digest.js — the owner review surface for the "genuine maybes"
 * (st_180aa017 AC-3): pending uncertain-email rows and pending borderline-merge
 * rows, unified into one small list so @miyagi can surface a few at a time and
 * resolve them in natural language.
 *
 * listReviewMaybes references ONLY base-143 email_classification_review
 * columns (id, person_id, value, reason, status, created_at) by default and
 * does a PRAGMA table_info presence check before ever referencing the
 * apply-time audit columns (verdict, confidence, decided_by, decided_at) — it
 * NEVER COALESCEs over an absent column, because SQLite errors "no such
 * column" at bind time regardless of COALESCE, which would crash this digest
 * against the live DB before the owner ever runs --apply once.
 *
 * resolveReviewMaybe never re-implements merge logic: a merge-type ('merge')
 * item routes through the shipped resolveTriageRow/resolveSurvivor
 * (scripts/ingest/merge-triage.js / lib/people-merge.js) so clearing one never
 * orphans a fragment. An email-type item routes through
 * lib/email-adjudication.js's applyVerdicts — the SAME deterministic writer the
 * offline pass uses, just with decided_by:'owner' instead of 'llm'.
 *
 * SCHEMA BOUNDARY: this file never adds the apply-time audit columns and
 * never ALTERs the live table — that column-adding step lives ONLY in the
 * offline --apply CLI (scripts/ingest/adjudicate-email-classification.js). A
 * chat resolution against the live, audit-column-absent DB relies on
 * applyVerdicts's own graceful degrade to base-143 columns (status +
 * resolved_at, still detaches + backs up) — never a schema mutation.
 */
import { listPendingTriage, resolveTriageRow } from '../scripts/ingest/merge-triage.js';
import { applyVerdicts, hasAuditColumns } from './email-adjudication.js';

const EMAIL_DECISIONS = new Set(['person', 'role', 'junk']);
const MERGE_DECISIONS = new Set(['merge', 'separate', 'dismiss']);

function readEmailMaybes(db, limit) {
  const withAudit = hasAuditColumns(db);
  // Base-143 columns ALWAYS selected; audit columns only added to the query
  // when PRAGMA confirms they exist — never referenced unconditionally.
  const columns = withAudit
    ? 'id, person_id, value, reason, status, created_at, verdict, confidence'
    : 'id, person_id, value, reason, status, created_at';
  const orderBy = withAudit ? 'confidence ASC, created_at DESC' : 'created_at DESC';
  let rows;
  try {
    rows = db.prepare(`
      SELECT ${columns} FROM email_classification_review
       WHERE status = 'pending'
       ORDER BY ${orderBy}
       LIMIT ?
    `).all(limit);
  } catch { rows = []; }
  return rows.map((r) => ({ kind: 'email', ...r }));
}

function readMergeMaybes(db, limit) {
  return listPendingTriage(db, { limit }).map((r) => ({ kind: 'merge', ...r }));
}

/**
 * A few pending "maybes" at a time, from both queues, newest first.
 * @param {import('better-sqlite3').Database} db
 * @param {{limit?:number}} [opts]
 * @returns {Array<object>} each row tagged with `kind: 'email'|'merge'`
 */
export function listReviewMaybes(db, { limit = 5 } = {}) {
  const email = readEmailMaybes(db, limit);
  const merge = readMergeMaybes(db, limit);
  return [...email, ...merge]
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, limit);
}

/**
 * Resolve one pending maybe in natural language.
 *   kind:'email', decision: 'person'|'role'|'junk' — routes through
 *     lib/email-adjudication.js applyVerdicts (decided_by:'owner').
 *   kind:'merge', decision: 'merge'|'separate'|'dismiss' — routes through the
 *     shipped resolveTriageRow (survivor-chain remap-before-act; never a
 *     re-implementation).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{id:number, kind:'email'|'merge', decision:string}} params
 * @returns {{ok:boolean, [key:string]:any}}
 */
export function resolveReviewMaybe(db, { id, kind, decision } = {}) {
  if (kind === 'merge') {
    if (!MERGE_DECISIONS.has(decision)) return { ok: false, reason: `unknown merge decision "${decision}" (use merge|separate|dismiss)` };
    return resolveTriageRow(db, id, decision);
  }
  if (kind === 'email') {
    if (!EMAIL_DECISIONS.has(decision)) return { ok: false, reason: `unknown email decision "${decision}" (use person|role|junk)` };
    let row;
    try { row = db.prepare("SELECT id, person_id, value FROM email_classification_review WHERE id = ? AND status = 'pending'").get(id); }
    catch { row = null; }
    if (!row) return { ok: false, reason: `no pending email review row #${id}` };
    // Never add the audit columns here (schema boundary, st_180aa017 QC fix)
    // — applyVerdicts degrades to a base-143-only update on its own when the
    // audit columns are absent, so a chat resolution against the live DB
    // never ALTERs it. The offline --apply CLI is the sole path that adds
    // those columns.
    const report = applyVerdicts(db, [{ id: row.id, person_id: row.person_id, value: row.value, verdict: decision, confidence: 1, tier: 'owner' }], { apply: true });
    return { ok: report.applied > 0, ...report };
  }
  return { ok: false, reason: `unknown kind "${kind}" (use "email" or "merge")` };
}
