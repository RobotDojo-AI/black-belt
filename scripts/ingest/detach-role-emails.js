#!/usr/bin/env node
/**
 * detach-role-emails.js — retroactively remove role/generic emails wrongly
 * attached to PEOPLE (resolver hardening, build companion to the live-pipeline
 * refusal in scripts/ingest/02-resolve.js).
 *
 * A role/generic email (info@, investors@, onboarding@, no-reply@, an ESP /
 * notification-domain address like office365@messaging.microsoft.com, or a
 * machine-generated local part) is NEVER an individual's identifier — it is a
 * shared/automated address, so a person_identifiers row carrying one is a data
 * error ~100% of the time (owner-confirmed). The live pipeline now refuses these
 * at attach time; this script cleans the rows that were attached BEFORE that
 * shipped. It DELETES every `person_identifiers` row (type='email') whose value
 * satisfies isRoleOrGenericEmail — the email was never a valid person identifier.
 *
 * If removing a person's role emails leaves them with ZERO real identifiers and
 * ZERO real signal (no email/phone identifier, no chunk coverage, no
 * interactions, no context document, source_count ≤ 1), that row is a residual
 * ghost — it is archived (mirrors the zero-signal ghost predicate in
 * 02-resolve.js mergeExactDuplicatePeoplePass). The declared owner is never
 * archived (and never zero-signal in practice).
 *
 * Reports counts by REASON (local-part vs domain vs pattern) so the owner can
 * see the shape of the cleanup before executing.
 *
 * INTELLIGENCE_TIER: extraction
 *   Deterministic. No LLM. No synthesis. Reads structured rows, deletes invalid
 *   identifier rows by exact id, flips an archived flag. (Does not call
 *   getAnthropicClient or reference MODELS; declares its tier per the Intelligence
 *   Tier Protocol for pipeline-write scripts.)
 *
 * Operational discipline (mirrors scripts/ingest/reap-archived-endpoints.js):
 *   - writes through lib/db.js (the encrypted pipeline connection), never raw.
 *   - wal_checkpoint(RESTART) before the first write clears stale reader marks.
 *   - transaction PER batch (default 2000) so the live embed daemon — sharing the
 *     single WAL writer — is never starved.
 *   - a pre-mutation JSONL backup of EVERY detached identifier row AND every
 *     pre-archive people row is appended per batch to
 *     ~/.robotdojo/detach-role-emails-backup-<ts>.jsonl so the delete is reversible.
 *   - residual-zero assert on a completed pass; idempotent (a second run finds
 *     nothing and is a clean no-op that writes no backup).
 *   - --max-seconds N stops between batches on the budget and exits 0-partial
 *     (bounded-resumable); the residual-zero assert runs only on a completed pass.
 *
 * SAFE BY DEFAULT: `--dry-run` (the default) counts the targets by reason and the
 * would-archive people, and writes NOTHING. `--execute` performs the cleanup.
 *
 * Usage:
 *   cd ~/robotdojo && ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/ingest/detach-role-emails.js --dry-run
 *   cd ~/robotdojo && ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/ingest/detach-role-emails.js --execute
 *
 * Exit codes: 0 success (incl. nothing-to-do / dry-run / bounded-partial), 1 on a
 * residual-non-zero completed pass or a SQLite/IO error (safe to re-run).
 */

export const INTELLIGENCE_TIER = 'extraction';

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { roleEmailReason, classifyEmailAddress } from '../../lib/identity-matching.js';
import { ownerPersonId } from '../../lib/identity.js';

const DEFAULT_BATCH = 2000;

// ── Backup path (allowlisted runtime dir; dry-run writes nothing) ────────────
// WHY ~/.robotdojo/backups/ not the root: `backups` is in the root-allowlist
// (config/root-allowlist.lock.json dot_robotdojo_entries); a stray backup at the
// ~/.robotdojo/ root stop-the-lines check-structure.js on every scheduled run.
function backupDir() {
  return process.env.ROBOTDOJO_DETACH_BACKUP_DIR || resolve(homedir(), '.robotdojo', 'backups');
}
// Generic backup-path builder (st_180aa017): any reversible batch write in this
// detach/adjudication family shares ONE backup directory + JSONL naming scheme
// (`<prefix>-backup-<ts>.jsonl`) so a restore tool never special-cases per-caller
// paths. detachBackupPathFor is the pre-existing caller, unchanged in behavior.
export function backupPathFor(prefix, ts = Date.now()) {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${prefix}-backup-${ts}.jsonl`);
}
export function detachBackupPathFor(ts = Date.now()) {
  return backupPathFor('detach-role-emails', ts);
}
// Exported (st_180aa017) so lib/email-adjudication.js's --apply path reuses the
// exact same reversible-write mechanism instead of re-implementing JSONL backup.
export function makeBackupAppender(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return (records) => {
    if (!records || !records.length) return;
    appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
  };
}

/**
 * One scan over every email identifier attached to a person, split by the
 * three-way verdict. `role` rows are detached; `uncertain` rows are LEFT attached
 * but enqueued for the later LLM tier (sizes its backlog). The predicate is JS
 * (not SQL-expressible). Bounded by the emails attached to people — never the DB.
 *
 * @returns {{role:{id,person_id,value,reason}[], uncertain:{id,person_id,value}[]}}
 */
export function classifyEmailRows(db) {
  let rows;
  try {
    rows = db.prepare("SELECT id, person_id, value FROM person_identifiers WHERE type = 'email'").all();
  } catch {
    return { role: [], uncertain: [] }; // person_identifiers absent in a minimal test DB
  }
  const role = [];
  const uncertain = [];
  for (const r of rows) {
    const verdict = classifyEmailAddress(r.value);
    if (verdict === 'role') role.push({ id: r.id, person_id: r.person_id, value: r.value, reason: roleEmailReason(r.value) });
    else if (verdict === 'uncertain') uncertain.push({ id: r.id, person_id: r.person_id, value: r.value });
  }
  return { role, uncertain };
}

/** The role-email rows to detach (drives the residual-zero assert + idempotency). */
export function findRoleEmailRows(db) {
  return classifyEmailRows(db).role;
}

// Enqueue emails for the later LLM/human adjudication tier. Inlined (not imported
// from lib/people-merge.js) so this cleanup module stays a pure leaf — no db.js
// side-effect at import. Mirrors people-merge.writeEmailClassificationReview
// (INSERT OR IGNORE on UNIQUE(person_id, value)); source='cleanup'. Two reasons:
//   'uncertain-email'       — the classifier could not settle role vs person.
//   'sole-identifier-review'— a role email that is a real named person's ONLY handle
//                             (never-orphan guard) — flagged instead of hard-deleted.
function enqueueReview(db, rows, { reason, batch }) {
  let stmt;
  try {
    stmt = db.prepare(
      "INSERT OR IGNORE INTO email_classification_review (person_id, value, reason, source) VALUES (?, ?, ?, 'cleanup')",
    );
  } catch {
    return 0; // table absent (minimal test DB)
  }
  let inserted = 0;
  const tx = db.transaction((slice) => {
    for (const r of slice) inserted += stmt.run(String(r.person_id), String(r.value).toLowerCase(), reason).changes;
  });
  for (let i = 0; i < rows.length; i += batch) {
    try { tx(rows.slice(i, i + batch)); } catch { /* non-fatal */ }
  }
  return inserted;
}

// ── Never-orphan guard (FIX B) ────────────────────────────────────────────────
// Org/role tokens that disqualify a display_name from being a "plausible human
// node". If any name token is one of these, the row is not a person to protect.
const ORG_NAME_TOKENS = new Set([
  'inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'group', 'team',
  'services', 'service', 'solutions', 'technologies', 'technology', 'systems',
  'labs', 'ventures', 'capital', 'partners', 'holdings', 'foundation', 'institute',
  'department', 'office', 'support', 'sales', 'billing', 'info', 'notifications',
  'admin', 'accounts', 'account', 'the',
]);

/** A plausible HUMAN display name: ≥2 name-ish tokens, no '@', not a '[role…]'
 * placeholder, and no org-looking token. Used to protect a real named node from
 * being orphaned when its only handle is a role-looking email. */
function looksHumanName(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  if (!n || n.includes('@') || n.startsWith('[')) return false;
  const tokens = n.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z]/g, ''))
    .filter((t) => t.length >= 2);
  if (tokens.length < 2) return false;                 // need two name-ish tokens
  if (tokens.some((t) => ORG_NAME_TOKENS.has(t))) return false; // org-looking
  return true;
}

/**
 * The never-orphan guard: would detaching this person's role emails leave a REAL
 * named person with no handle at all? Protect (flag, don't delete) when the person
 * is ACTIVE, has a plausible human display_name, has real signal (chunk_entities>3
 * OR interaction signal), AND deleting the role emails would leave ZERO remaining
 * identifiers of any real type (name rows excluded — they are display echoes, not
 * handles). The owner is never a candidate (handled separately, never orphaned).
 */
function shouldProtectSoleIdentifier(db, personId, roleRowCount, owner) {
  if (owner && String(personId) === String(owner)) return false;
  const sig = personSignal(db, personId);
  if (!sig || sig.archived !== 0) return false;                 // active only
  if (sig.totalIds - roleRowCount > 0) return false;            // keeps another handle
  if (!(sig.chunks > 3 || sig.ic > 0)) return false;            // must have real signal
  if (!looksHumanName(sig.name)) return false;                  // must be a human node
  return true;
}

/** Tally role-email hits by detection layer. */
export function countByReason(rows) {
  const c = { 'local-part': 0, domain: 0, pattern: 0 };
  for (const r of rows) c[r.reason] = (c[r.reason] || 0) + 1;
  return c;
}

/** A person's remaining real signal (call AFTER role emails are gone, or pass a
 * pre-removed identifier count via the caller). idCount = email/phone handles;
 * totalIds = every identifier EXCEPT the display-name echo (type='name'). */
function personSignal(db, personId) {
  let p;
  try {
    p = db.prepare(
      "SELECT display_name, COALESCE(archived,0) archived, COALESCE(interaction_count,0) ic, COALESCE(source_count,0) sc, context_file_path FROM people WHERE id = ?",
    ).get(personId);
  } catch {
    return null;
  }
  if (!p) return null;
  let idCount = 0;
  try {
    idCount = db.prepare("SELECT COUNT(*) n FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')").get(personId).n;
  } catch { idCount = 0; }
  let totalIds = 0;
  try {
    totalIds = db.prepare("SELECT COUNT(*) n FROM person_identifiers WHERE person_id = ? AND type != 'name'").get(personId).n;
  } catch { totalIds = idCount; }
  let chunks = 0;
  try {
    chunks = db.prepare("SELECT COUNT(*) n FROM chunk_entities WHERE entity_id = ? AND entity_type = 'person'").get(personId).n;
  } catch { chunks = 0; }
  return { name: p.display_name, archived: Number(p.archived), ic: Number(p.ic), sc: Number(p.sc), ctx: p.context_file_path, idCount, totalIds, chunks };
}

/** Zero-signal ghost predicate (mirrors 02-resolve.js) — safe to archive. */
function isZeroSignal(sig) {
  return !!sig && sig.archived === 0 && sig.idCount === 0 && sig.chunks === 0
    && sig.ic === 0 && !sig.ctx && sig.sc <= 1;
}

/**
 * Dry-run preview: how many people WOULD be archived if their role emails were
 * removed. Simulates the post-delete state (remaining email/phone identifiers
 * excluding the role ones) without mutating anything. The owner is never counted.
 */
export function previewArchiveCount(db, rows) {
  const roleByPerson = new Map(); // person_id -> Set(roleIdentifierId)
  for (const r of rows) {
    let s = roleByPerson.get(r.person_id);
    if (!s) { s = new Set(); roleByPerson.set(r.person_id, s); }
    s.add(r.id);
  }
  const owner = String(ownerPersonId() || '');
  let count = 0;
  for (const [pid, roleIds] of roleByPerson) {
    if (owner && String(pid) === owner) continue;
    let idRows = [];
    try {
      idRows = db.prepare("SELECT id FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')").all(pid);
    } catch { idRows = []; }
    const remaining = idRows.filter((x) => !roleIds.has(x.id)).length;
    if (remaining > 0) continue; // still holds a real identifier → keep
    const sig = personSignal(db, pid);
    if (sig && sig.archived === 0 && sig.chunks === 0 && sig.ic === 0 && !sig.ctx && sig.sc <= 1) count++;
  }
  return count;
}

/**
 * Dry-run preview of the never-orphan guard: how many role-email rows (and people)
 * would be PROTECTED — flagged for review instead of hard-deleted — because they
 * are a real named person's sole handle. Pure reads.
 */
export function previewProtect(db, rows) {
  const owner = String(ownerPersonId() || '');
  const byPerson = new Map();
  for (const r of rows) {
    let a = byPerson.get(r.person_id);
    if (!a) { a = []; byPerson.set(r.person_id, a); }
    a.push(r);
  }
  let rowCount = 0;
  let people = 0;
  for (const [pid, prows] of byPerson) {
    if (shouldProtectSoleIdentifier(db, pid, prows.length, owner)) { rowCount += prows.length; people += 1; }
  }
  return { rows: rowCount, people };
}

/**
 * Detach every role/generic email from people, archiving any person left with no
 * real signal. Dry-run (execute=false) mutates nothing.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{execute?:boolean, batch?:number, maxSeconds?:number|null,
 *          backupPath?:string|null, log?:Function}} opts
 * @returns {object} report
 */
export function detachRoleEmails(db, {
  execute = false,
  batch = DEFAULT_BATCH,
  maxSeconds = null,
  backupPath = null,
  log = () => {},
} = {}) {
  const { role: rows, uncertain } = classifyEmailRows(db);
  const before = {
    total: rows.length,
    byReason: countByReason(rows),
    people: new Set(rows.map((r) => r.person_id)).size,
    uncertain: uncertain.length,
    uncertainPeople: new Set(uncertain.map((r) => r.person_id)).size,
  };
  const report = {
    execute, before,
    detached: 0, archived: 0, protected: 0, uncertainEnqueued: 0, byReason: before.byReason,
    uncertain: before.uncertain,
    backupPath: null, completed: true, residual: null, residualZero: null,
  };
  if (!execute) {
    report.wouldArchive = previewArchiveCount(db, rows);
    report.wouldProtect = previewProtect(db, rows);
    report.hardDetach = rows.length - report.wouldProtect.rows;
    return report;
  }

  // Enqueue the uncertain backlog for the later LLM adjudication tier. Idempotent
  // (INSERT OR IGNORE), independent of the role detach, and writes no backup.
  report.uncertainEnqueued = enqueueReview(db, uncertain, { reason: 'uncertain-email', batch });

  // Never-orphan guard (FIX B): partition role rows into hard-DELETE vs PROTECT. A
  // role email that is a real named person's SOLE handle is flagged for review
  // ('sole-identifier-review') and LEFT ATTACHED, not deleted — protecting the
  // Avik-Chatterjee false positive and the relay-address counterparties.
  const owner = String(ownerPersonId() || '');
  const roleByPerson = new Map();
  for (const r of rows) {
    let a = roleByPerson.get(r.person_id);
    if (!a) { a = []; roleByPerson.set(r.person_id, a); }
    a.push(r);
  }
  const toDelete = [];
  const toProtect = [];
  for (const [pid, prows] of roleByPerson) {
    if (shouldProtectSoleIdentifier(db, pid, prows.length, owner)) for (const r of prows) toProtect.push(r);
    else for (const r of prows) toDelete.push(r);
  }
  const protectedIds = new Set(toProtect.map((r) => r.id));
  report.protected = toProtect.length;
  enqueueReview(db, toProtect, { reason: 'sole-identifier-review', batch });

  // The residual that must reach zero = role rows minus the protected ones. Protected
  // rows are intentionally retained (flagged), so they never count against residual.
  const residualExcludingProtected = () => findRoleEmailRows(db).filter((r) => !protectedIds.has(r.id)).length;

  if (toDelete.length === 0) {
    report.residual = residualExcludingProtected();
    report.residualZero = report.residual === 0;
    return report; // nothing to hard-delete — no checkpoint, no backup file
  }

  // Clear stale WAL reader marks before the write batch (Migration Protocol).
  try { db.pragma('wal_checkpoint(RESTART)'); } catch (err) { log(`  wal_checkpoint skipped: ${err.message}`); }

  const deadline = Number.isFinite(maxSeconds) && maxSeconds > 0 ? Date.now() + maxSeconds * 1000 : null;
  const path = backupPath || detachBackupPathFor();
  const backup = makeBackupAppender(path);
  report.backupPath = path;

  const del = db.prepare('DELETE FROM person_identifiers WHERE id = ?');
  const delBatch = db.transaction((slice) => { for (const r of slice) del.run(r.id); });

  const affected = new Set();
  let budgetHit = false;
  for (let i = 0; i < toDelete.length; i += batch) {
    if (deadline && Date.now() >= deadline) { budgetHit = true; break; }
    const slice = toDelete.slice(i, i + batch);
    backup(slice.map((r) => ({ table: 'person_identifiers', row: r })));
    delBatch(slice);
    report.detached += slice.length;
    for (const r of slice) affected.add(r.person_id);
  }

  // Archive now-zero-signal ghosts (owner never archived; already-archived skipped).
  const archiveRow = db.prepare("UPDATE people SET archived = 1, updated_at = datetime('now') WHERE id = ?");
  const archiveBatch = db.transaction((ids) => { for (const pid of ids) archiveRow.run(pid); });
  const toArchive = [];
  for (const pid of affected) {
    if (owner && String(pid) === owner) continue;
    if (isZeroSignal(personSignal(db, pid))) toArchive.push(pid);
  }
  for (let i = 0; i < toArchive.length; i += batch) {
    const ids = toArchive.slice(i, i + batch);
    const fulls = ids.map((pid) => {
      try { return db.prepare('SELECT * FROM people WHERE id = ?').get(pid); } catch { return { id: pid }; }
    });
    backup(fulls.map((row) => ({ table: 'people_archived', row })));
    archiveBatch(ids);
    report.archived += ids.length;
  }

  report.completed = !budgetHit;
  report.residual = residualExcludingProtected();
  if (report.completed) report.residualZero = report.residual === 0;
  return report;
}

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const batchIdx = argv.indexOf('--batch');
  const batch = batchIdx >= 0 ? Math.max(1, parseInt(argv[batchIdx + 1], 10) || DEFAULT_BATCH) : DEFAULT_BATCH;
  const msIdx = argv.indexOf('--max-seconds');
  const maxSeconds = msIdx >= 0 ? parseInt(argv[msIdx + 1], 10) : null;

  const { default: db } = await import('../../lib/db.js');
  const { role: rows, uncertain } = classifyEmailRows(db);
  const byReason = countByReason(rows);
  const people = new Set(rows.map((r) => r.person_id)).size;
  const uncertainPeople = new Set(uncertain.map((r) => r.person_id)).size;
  console.log(
    `[detach-role-emails] role/generic emails on people: ${rows.length} ` +
    `(local-part=${byReason['local-part']}, domain=${byReason.domain}, pattern=${byReason.pattern}) across ${people} people`,
  );
  console.log(
    `[detach-role-emails] uncertain emails (allow + flag for LLM tier): ${uncertain.length} across ${uncertainPeople} people`,
  );

  if (!execute) {
    const wouldArchive = previewArchiveCount(db, rows);
    const protect = previewProtect(db, rows);
    console.log(
      `[detach-role-emails] never-orphan guard: ${protect.rows} role emails on ${protect.people} real named ` +
      `sole-handle people would be FLAGGED (sole-identifier-review), not deleted`,
    );
    console.log(`[detach-role-emails] hard-detach set: ${rows.length - protect.rows} emails would be deleted`);
    console.log(`[detach-role-emails] would archive ${wouldArchive} now-zero-signal people`);
    console.log('[detach-role-emails] --dry-run (default): no writes performed. Pass --execute to detach.');
    process.exit(0);
  }

  const report = detachRoleEmails(db, { execute: true, batch, maxSeconds, log: (m) => console.log(m) });
  console.log(
    `[detach-role-emails] complete: detached=${report.detached}, protected=${report.protected}, archived=${report.archived}, ` +
    `uncertainEnqueued=${report.uncertainEnqueued}, completed=${report.completed}` +
    (report.backupPath ? `, backup=${report.backupPath}` : ''),
  );
  if (report.completed && report.residualZero === false) {
    console.error(`[detach-role-emails] WARNING: residual ${report.residual} after pass — re-run.`);
    process.exit(1);
  }
  if (!report.completed) {
    console.log('[detach-role-emails] --max-seconds budget reached — bounded-partial pass, safe to re-run to finish.');
  }
  process.exit(0);
}

// Run as CLI only (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => { console.error('[detach-role-emails] fatal:', err.message); process.exit(1); });
}
