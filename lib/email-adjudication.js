/**
 * lib/email-adjudication.js — deterministic Tier-0 pre-filter, Haiku batch-prompt
 * builder/validator, and the ONLY writer for the offline email-adjudication tier
 * (st_180aa017 AC-1/AC-2). Every read and write against
 * `email_classification_review` / `person_identifiers` for this tier lives here —
 * the orchestrator (scripts/ingest/adjudicate-email-classification.js) calls
 * into this file and holds no db.prepare of its own (LLM-write-boundary: the
 * model emits ONLY a JSON verdict; deterministic code here decides every write).
 *
 * Fellegi-Sunter three-way split (research st_180aa017 ## External §1): Tier-0
 * (deterministicVerdict) settles the confident majority for free; the residual
 * goes to Haiku in small validated batches (buildBatchPrompt +
 * parseAdjudicationBatch); only verdicts at/above HIGH_CONFIDENCE are ever
 * applied (applyVerdicts), and only when the caller passes apply:true.
 *
 * db is INJECTED everywhere (thin-facade: deps as arguments, no module
 * singleton) so this file stays unit-testable against a plain in-memory
 * better-sqlite3 DB with no dependency on lib/db.js's encrypted-DB bootstrap.
 */

import { rawNameTokens } from './identity-matching.js';
import { backupPathFor, makeBackupAppender } from '../scripts/ingest/detach-role-emails.js';

// ── Tunables ──────────────────────────────────────────────────────────────────

// Verdicts at/above this confidence are the "act" set (applyVerdicts mutates
// them); below stays the "hold" set (flagged for the owner, never applied).
// 0.85 matches this repo's existing entity-matching floor (build-conventions:
// "Entity matching binary: >=0.85 link, below create. No review zone.") — reused
// here rather than inventing a second unrelated threshold. Threshold placement
// is a practitioner call against the real confidence distribution (research
// ## External §1); the owner can retune this constant once dry-run output over
// the live queue shows the actual score spread.
export const HIGH_CONFIDENCE = 0.85;

// Small batch by design (research ## External §2: Elastic measured a 30.2%
// malformed-JSON rate at batch size 5 on a comparable stack — structured-output
// reliability degrades faster than reasoning quality as batch size rises).
// Kept intentionally small; the orchestrator's retry/shrink logic is the second
// line of defense, not a substitute for a small starting batch.
export const BATCH_SIZE = 5;

const VERDICTS = new Set(['person', 'role', 'junk']);
const STATUS_FOR_VERDICT = { person: 'person', role: 'role', junk: 'dismissed' };
const AUDIT_COLUMNS = [
  ['verdict', 'TEXT'],
  ['confidence', 'REAL'],
  ['decided_by', 'TEXT'],
  ['decided_at', 'TEXT'],
];
const TRUSTED_COIDENTIFIER_SOURCES = new Set(['contacts', 'google_contacts']);

// ── Reads (the only SELECTs this tier needs; kept here so the orchestrator
//    never holds a db.prepare of its own) ─────────────────────────────────────

/**
 * Pending email_classification_review rows, bounded by `limit`, enriched with
 * each attached person's display name and CO-IDENTIFIERS (their other email/
 * phone handles) — the "different signal" deterministicVerdict reasons over
 * (never a re-call of classifyEmailAddress on the same value).
 *
 * @returns {Array<{id:number, person_id:string, value:string, reason:string,
 *   source:string, created_at:string, displayName:string,
 *   coIdentifiers:Array<{type:string,value:string,source:string}>}>}
 */
export function readPendingWithContext(db, { limit = 200 } = {}) {
  const rows = db.prepare(`
    SELECT id, person_id, value, reason, source, created_at
      FROM email_classification_review
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT ?
  `).all(limit);
  if (!rows.length) return [];

  const personIds = [...new Set(rows.map((r) => r.person_id))];
  const placeholders = personIds.map(() => '?').join(',');
  let people = [];
  let idents = [];
  try {
    people = db.prepare(`SELECT id, display_name FROM people WHERE id IN (${placeholders})`).all(...personIds);
  } catch { people = []; }
  try {
    idents = db.prepare(`SELECT person_id, type, value, source FROM person_identifiers WHERE person_id IN (${placeholders})`).all(...personIds);
  } catch { idents = []; }

  const nameById = new Map(people.map((p) => [p.id, p.display_name]));
  const identsByPerson = new Map();
  for (const i of idents) {
    if (!identsByPerson.has(i.person_id)) identsByPerson.set(i.person_id, []);
    identsByPerson.get(i.person_id).push(i);
  }
  return rows.map((r) => ({
    ...r,
    displayName: nameById.get(r.person_id) || '',
    coIdentifiers: (identsByPerson.get(r.person_id) || []).filter((i) => i.value !== r.value),
  }));
}

// ── Tier-0 deterministic pre-filter ───────────────────────────────────────────

function localPartOf(value) {
  return String(value || '').toLowerCase().split('@')[0] || '';
}

/** Opaque machine-generated local part: long hex-ish token, or mostly digits —
 * a bounce id / tracking token a human never typed. */
function isDigitHeavyLocal(local) {
  if (!local) return false;
  if (/^[0-9a-f]{10,}$/.test(local)) return true;
  const digits = local.replace(/[^0-9]/g, '').length;
  return digits / local.length > 0.6;
}

/** A classic human handle shape: 2-4 alpha segments joined by ./_/- , no digits. */
function isNameShapedLocal(local) {
  return /^[a-z]{2,}([._-][a-z]{2,}){1,3}$/.test(local);
}

/** Does the local part encode a token (>=3 chars) of the person's own display
 * name? Same-person structural evidence independent of any co-identifier. */
function sharesNameToken(local, displayName) {
  if (!displayName) return false;
  const nameTokenSet = new Set(rawNameTokens(displayName).filter((t) => t.length >= 3));
  if (!nameTokenSet.size) return false;
  return local.split(/[._-]+/).some((t) => t.length >= 3 && nameTokenSet.has(t));
}

/**
 * The Tier-0 deterministic verdict for one review row, or null when Tier-0
 * cannot settle it confidently (falls through to the Haiku residual tier).
 * Reasons over CO-IDENTIFIER corroboration + structural local-part shape — NOT
 * a re-call of classifyEmailAddress (these rows already carry its 'uncertain'
 * or role-carve-out verdict; re-running the same signal would filter nothing).
 *
 * @param {{value:string, reason?:string}} row
 * @param {{coIdentifiers?:Array, displayName?:string}} [ctx]
 * @returns {{verdict:'person'|'role'|'junk', confidence:number, tier:'deterministic'}|null}
 */
export function deterministicVerdict(row, ctx = {}) {
  const value = String(row?.value || '').toLowerCase();
  const local = localPartOf(value);
  const coIdentifiers = Array.isArray(ctx.coIdentifiers) ? ctx.coIdentifiers : [];
  const displayName = ctx.displayName || '';
  const hasTrustedCoIdentifier = coIdentifiers.some(
    (ci) => ci && ci.value !== value && TRUSTED_COIDENTIFIER_SOURCES.has(ci.source),
  );

  // Signal A — opaque local part + no trusted co-identifier corroborating a
  // real human behind it → machine-generated junk.
  if (isDigitHeavyLocal(local) && !hasTrustedCoIdentifier) {
    return { verdict: 'junk', confidence: 0.9, tier: 'deterministic' };
  }
  // Signal B — name-shaped local part corroborated by a co-identifier the
  // person already holds from a human-curated source (contacts/google_contacts).
  if (isNameShapedLocal(local) && hasTrustedCoIdentifier) {
    return { verdict: 'person', confidence: 0.92, tier: 'deterministic' };
  }
  // Signal C — the local part literally encodes the person's own display name.
  if (isNameShapedLocal(local) && sharesNameToken(local, displayName)) {
    return { verdict: 'person', confidence: 0.88, tier: 'deterministic' };
  }
  // Signal D — the never-orphan guard (detach-role-emails.js) already judged
  // this a real named person's sole handle; a co-identifier or name-shape here
  // corroborates that upstream judgment further.
  if (row?.reason === 'sole-identifier-review' && (hasTrustedCoIdentifier || sharesNameToken(local, displayName))) {
    return { verdict: 'person', confidence: 0.87, tier: 'deterministic' };
  }
  return null;
}

// ── Tier-1 Haiku batch prompt + strict response validation ───────────────────

/**
 * Build the Haiku batch classification prompt for a slice of residual rows.
 * @param {Array<{id:number|string, value:string, displayName?:string}>} rows
 * @returns {{system:string, user:string}}
 */
export function buildBatchPrompt(rows) {
  const items = (rows || []).map((r) => ({
    id: r.id,
    email: r.value,
    attached_to: r.displayName || null,
  }));
  const system = [
    'You classify email addresses attached to a personal contacts graph.',
    'For each item decide whether the address belongs to a real individual',
    '("person"), a shared/automated/organizational address ("role" — e.g.',
    'info@, no-reply@, a distribution list, a notification sender), or an',
    'invalid/junk address ("junk").',
    '',
    'Return ONLY a JSON array, no prose, no markdown fence — one object per',
    'input id, every input id present exactly once, in any order:',
    '[{"id": <id>, "verdict": "person"|"role"|"junk", "confidence": <0..1 number>}]',
  ].join('\n');
  const user = `Classify these ${items.length} email address(es):\n${JSON.stringify(items, null, 2)}`;
  return { system, user };
}

/**
 * Validate + parse a Haiku batch response. Rejects malformed JSON, an id that
 * doesn't round-trip to `expectedIds`, a duplicate id, an out-of-vocabulary
 * verdict, or a confidence outside [0,1] — any single defect fails the WHOLE
 * batch (the caller shrinks/retries; a partially-trusted parse is worse than a
 * clean failure).
 *
 * @param {string} text - raw model output
 * @param {Array<number|string>} expectedIds
 * @returns {{ok:true, verdicts:Array<{id:string, verdict:string, confidence:number}>}
 *          |{ok:false, reason:string}}
 */
export function parseAdjudicationBatch(text, expectedIds) {
  const expected = new Set((expectedIds || []).map(String));
  let raw;
  try {
    const match = String(text || '').match(/\[[\s\S]*\]/);
    raw = JSON.parse(match ? match[0] : text);
  } catch (err) {
    return { ok: false, reason: `malformed JSON: ${err.message}` };
  }
  if (!Array.isArray(raw)) return { ok: false, reason: 'response is not a JSON array' };

  const seen = new Set();
  const verdicts = [];
  for (const item of raw) {
    const id = item && item.id != null ? String(item.id) : null;
    const verdict = item?.verdict;
    const confidence = Number(item?.confidence);
    if (!id || !expected.has(id)) return { ok: false, reason: `id not in expected set: ${id}` };
    if (seen.has(id)) return { ok: false, reason: `duplicate id: ${id}` };
    if (!VERDICTS.has(verdict)) return { ok: false, reason: `verdict out of vocabulary: ${verdict}` };
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, reason: `confidence out of range: ${item?.confidence}` };
    }
    seen.add(id);
    verdicts.push({ id, verdict, confidence });
  }
  if (seen.size !== expected.size) return { ok: false, reason: `missing ids: expected ${expected.size}, got ${seen.size}` };
  return { ok: true, verdicts };
}

// ── Schema (runtime lazy-ensure — never a numbered migration) ────────────────

/**
 * Idempotent additive-column ensure for the apply-time audit trail. Reads
 * PRAGMA table_info first and ALTERs only the columns that are absent, so a
 * repeated --apply run (or a repeated test call) never errors on
 * "duplicate column". Called ONLY from the --apply path and from tests —
 * NEVER from dry-run, and NEVER as a numbered lib/migrations/*.sql file (a
 * migration file would auto-apply to the LIVE db.js-managed database at
 * import time on any build/QA read; see 02-plan.md "Schema changes").
 *
 * @returns {{added:string[], columns:string[]}}
 */
export function ensureAdjudicationColumns(db) {
  const existing = new Set(db.prepare('PRAGMA table_info(email_classification_review)').all().map((c) => c.name));
  const added = [];
  for (const [name, type] of AUDIT_COLUMNS) {
    if (!existing.has(name)) {
      db.prepare(`ALTER TABLE email_classification_review ADD COLUMN ${name} ${type}`).run();
      added.push(name);
    }
  }
  return { added, columns: AUDIT_COLUMNS.map(([name]) => name) };
}

/**
 * Read-only presence check: does THIS db already carry the 4 apply-time audit
 * columns? Never mutates — the single canonical check reused by applyVerdicts
 * (to decide which UPDATE shape is safe) and by lib/review-digest.js (to
 * decide which SELECT shape is safe). Fresh every call, never cached, because
 * a live db (audit columns absent until the owner runs --apply) and an
 * already-applied test db can differ within the same process.
 */
export function hasAuditColumns(db) {
  let cols;
  try { cols = db.prepare('PRAGMA table_info(email_classification_review)').all(); }
  catch { return false; }
  const names = new Set(cols.map((c) => c.name));
  return AUDIT_COLUMNS.every(([name]) => names.has(name));
}

// ── The only writer: apply-gated, reversible, high-confidence-only ───────────

/**
 * Apply verdicts to the review queue. A no-op unless `apply:true` — dry-run
 * NEVER reaches this function with apply:true. Only verdicts at/above
 * HIGH_CONFIDENCE are ever applied; everything else stays 'pending' (the
 * low-confidence hold-set, untouched, for the owner). For an applied
 * 'role'/'junk' verdict the matching person_identifiers row is detached
 * (reusing the shipped JSONL-backup mechanism from detach-role-emails.js
 * BEFORE the delete) — a 'person' verdict leaves the identifier attached and
 * only updates the review row.
 *
 * SCHEMA BOUNDARY (fixed post-QC, st_180aa017): this function NEVER calls
 * ensureAdjudicationColumns and NEVER ALTERs the table itself. It checks
 * hasAuditColumns(db) once and picks the UPDATE shape that matches: full
 * audit stamp (verdict/confidence/decided_by/decided_at) when those columns
 * already exist, or a base-143-only update (status + resolved_at) when they
 * don't. The real work — status transition, reversible detach, JSONL backup —
 * always happens either way. Only the OFFLINE --apply CLI path calls
 * ensureAdjudicationColumns (before calling this function) to actually add the
 * audit columns; a chat-driven resolveReviewMaybe call against the live,
 * audit-column-ABSENT DB must never trigger a schema mutation.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{id:number|string, person_id:string, value:string,
 *   verdict:string, confidence:number, tier?:string}>} verdicts
 * @param {{apply?:boolean, backupPath?:string}} [opts]
 * @returns {{applied:number, detached:number, skippedLowConfidence:number, backupPath:string|null}}
 */
export function applyVerdicts(db, verdicts, { apply = false, backupPath = null } = {}) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  const report = { applied: 0, detached: 0, skippedLowConfidence: 0, backupPath: null };
  if (!apply) {
    report.skippedLowConfidence = list.length;
    return report;
  }

  const path = backupPath || backupPathFor('adjudicate-email-classification');
  const backup = makeBackupAppender(path);
  report.backupPath = path;
  const withAudit = hasAuditColumns(db); // checked ONCE per call — read-only, never ALTERs

  for (const v of list) {
    if (!(Number(v.confidence) >= HIGH_CONFIDENCE)) { report.skippedLowConfidence++; continue; }
    const status = STATUS_FOR_VERDICT[v.verdict];
    if (!status) { report.skippedLowConfidence++; continue; } // out-of-vocabulary verdict — never applied

    let prior;
    try { prior = db.prepare('SELECT * FROM email_classification_review WHERE id = ? AND status = ?').get(v.id, 'pending'); }
    catch { prior = null; }
    if (!prior) continue; // already resolved or gone — idempotent skip

    backup([{ table: 'email_classification_review', row: prior }]);

    if (v.verdict === 'role' || v.verdict === 'junk') {
      let idRow;
      try { idRow = db.prepare("SELECT * FROM person_identifiers WHERE person_id = ? AND type = 'email' AND value = ?").get(prior.person_id, prior.value); }
      catch { idRow = null; }
      if (idRow) {
        backup([{ table: 'person_identifiers', row: idRow }]);
        db.prepare('DELETE FROM person_identifiers WHERE id = ?').run(idRow.id);
        report.detached++;
      }
    }

    if (withAudit) {
      const decidedBy = v.tier === 'deterministic' ? 'deterministic' : v.tier === 'owner' ? 'owner' : 'llm';
      db.prepare(`
        UPDATE email_classification_review
           SET status = ?, verdict = ?, confidence = ?, decided_by = ?, decided_at = datetime('now'), resolved_at = datetime('now')
         WHERE id = ?
      `).run(status, v.verdict, Number(v.confidence), decidedBy, v.id);
    } else {
      // Audit columns absent (live DB pre-offline-apply, or any DB the owner
      // has never run --apply against) — base-143-only update. The status
      // transition + detach + backup above already did the real work; this
      // branch just never references a column that may not exist.
      db.prepare(`
        UPDATE email_classification_review
           SET status = ?, resolved_at = datetime('now')
         WHERE id = ?
      `).run(status, v.id);
    }
    report.applied++;
  }
  return report;
}
