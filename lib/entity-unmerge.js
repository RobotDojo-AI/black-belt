/**
 * lib/entity-unmerge.js — the GENERAL symmetric un-merge core (df_cbd30a5a AC-9).
 *
 * Phase 1 delivered a one-time OWNER repair (scripts/ingest/unmerge-owner-foreign.js)
 * that splits the owner's welded identity back into two people. This module
 * generalizes that repair so ANY wrongly-fused pair A|B can be split — no owner
 * dependency — with persistent-ID survivorship (Zingg/Hakase): the survivor
 * KEEPS its stable id so no downstream reference breaks; only the extracted
 * sub-cluster gets a new/reused id. The owner script is refactored to a thin
 * caller over `executeUnmergePair`, and its owner tests + verify-owner-split.js
 * still pass unchanged.
 *
 * Split mechanics, in order (execute mode):
 *   1. resolve the extracted id (reuse-if-archived → un-archive; else mint a
 *      fresh crypto.randomUUID with a display_name from the extracted cluster).
 *   2. re-partition identifiers: A stays on the survivor, B → extracted, JUNK
 *      dropped (deterministic classify).
 *   3. optional bad-card clean (owner path) — strip B-bucket emails.
 *   4. scoped DELETE chunk_entities for both ids + linkChunkEntities() relink.
 *   5. reconcileIdentifierFacts([survivor, extracted]) — derived email/phone
 *      facts follow the re-partition (moved here from the owner script).
 *   6. refreshDerivedRelationCache + refreshEgoBlock.
 *   7. writeMustNotMerge(survivor, extracted) — the durable re-weld veto (AC-10).
 *   8. registerPrivateNameTokens([survivorName, extractedName]) — PII-gate
 *      coverage for the split names (AC-11a).
 *   9. regen both cards (the ONLY LLM step; writes a card, never a DB row).
 *
 * INTELLIGENCE_TIER: orchestration
 *   Every structural write is deterministic Tier-0; the only model call is the
 *   spawned regen-entities.js, which writes the prose card, never a DB row — the
 *   LLM-write boundary holds.
 */

export const INTELLIGENCE_TIER = 'orchestration';

import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { writeMustNotMerge } from './people-merge.js';

// ── Adjudication context + classifier (symmetric — no owner dependency) ───────

const emailDomain = (val) => {
  const s = String(val).toLowerCase();
  return s.includes('@') ? s.split('@')[1] : null;
};

/** Lowercased name tokens ≥3 chars — an email local-part / name can be matched. */
function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * Build the SYMMETRIC adjudication context for a pair (idA, idB) — both records
 * exist. For each side: name tokens (from display_name), the exact identifier
 * set, and the EXCLUSIVE email domains (that side's domains MINUS the other's,
 * so a shared domain never decides — it falls to name-token adjudication).
 *
 * @returns {{aTokens:string[], aIdentifierSet:Set, aDomains:Set,
 *            bTokens:string[], bIdentifierSet:Set, bDomains:Set}}
 */
export function buildPairAdjudicationContext(db, { idA, idB }) {
  const nameOf = (id) => {
    try { return db.prepare('SELECT display_name FROM people WHERE id = ?').get(id)?.display_name || ''; }
    catch { return ''; }
  };
  const identsOf = (id) => {
    try { return db.prepare("SELECT type, value FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')").all(id); }
    catch { return []; }
  };
  const aIdents = identsOf(idA);
  const bIdents = identsOf(idB);
  const setOf = (idents) => new Set(idents.map((r) => String(r.value).trim().toLowerCase()));
  const domainsOf = (idents) => new Set(idents.filter((r) => r.type === 'email').map((r) => emailDomain(r.value)).filter(Boolean));
  const aDomainsAll = domainsOf(aIdents);
  const bDomainsAll = domainsOf(bIdents);
  return {
    aTokens: nameTokens(nameOf(idA)),
    aIdentifierSet: setOf(aIdents),
    aDomains: new Set([...aDomainsAll].filter((d) => !bDomainsAll.has(d))),
    bTokens: nameTokens(nameOf(idB)),
    bIdentifierSet: setOf(bIdents),
    bDomains: new Set([...bDomainsAll].filter((d) => !aDomainsAll.has(d))),
  };
}

/**
 * Classify one identifier into 'A' (survivor) | 'B' (extracted) | 'JUNK',
 * deterministically. Precedence (symmetric): exact-identifier match on a side →
 * that side; then name-token match; then EXCLUSIVE-domain match. A phone with no
 * exact/token hit belongs to neither → JUNK; role/automated/unattributable →
 * JUNK. Ambiguous (matches both sides) → the survivor side A (deterministic
 * tiebreak — a shared domain is never decisive, so the ambiguous set is small).
 */
export function classifyIdentifierPair(type, value, ctx) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return 'JUNK';
  const hasAt = v.includes('@');
  const domain = hasAt ? v.split('@')[1] : '';

  const exactA = ctx.aIdentifierSet && ctx.aIdentifierSet.has(v);
  const exactB = ctx.bIdentifierSet && ctx.bIdentifierSet.has(v);
  if (exactA && !exactB) return 'A';
  if (exactB && !exactA) return 'B';
  if (exactA && exactB) return 'A';

  const tokA = ctx.aTokens.some((t) => v.includes(t));
  const tokB = ctx.bTokens.some((t) => v.includes(t));
  if (tokA && !tokB) return 'A';
  if (tokB && !tokA) return 'B';
  if (tokA && tokB) return 'A';

  if (domain) {
    const domA = ctx.aDomains.has(domain);
    const domB = ctx.bDomains.has(domain);
    if (domA && !domB) return 'A';
    if (domB && !domA) return 'B';
  }
  return 'JUNK';
}

/** Derive a display name for a minted extracted record from its email cluster. */
function deriveNameFromBucket(idents) {
  const counts = new Map();
  for (const id of idents) {
    if (id.type !== 'email') continue;
    const local = String(id.value).toLowerCase().split('@')[0];
    for (const t of local.split(/[^a-z]+/).filter((x) => x.length >= 3)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [t, n] of counts) if (n > bestN) { best = t; bestN = n; }
  return best ? best.charAt(0).toUpperCase() + best.slice(1) : null;
}

// ── Derived email/phone fact reconciliation (moved here from the owner script) ─

/**
 * Reconcile a person's email/phone entity_facts with their CURRENT
 * person_identifiers. email/phone facts are DERIVED from identifiers, so after
 * an identifier re-partition a survivor still carries moved/dropped values and
 * the extracted person is missing his own. DELETE the stale rows (merge
 * corruption, not a truth that expired) and INSERT the missing ones.
 *
 * Deterministic Tier-0. Idempotent: a clean re-run is 0 deleted / 0 inserted.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} entityIds
 * @returns {{ deleted:number, inserted:number }}
 */
export function reconcileIdentifierFacts(db, entityIds, { log = () => {} } = {}) {
  const report = { deleted: 0, inserted: 0 };
  const delStale = db.prepare(`
    DELETE FROM entity_facts
    WHERE entity_type = 'person' AND entity_id = ? AND fact_type IN ('email','phone')
      AND fact_value NOT IN (
        SELECT value FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')
      )
  `);
  const insMissing = db.prepare(`
    INSERT INTO entity_facts (entity_id, entity_type, fact_type, fact_value, source_event_ids, valid_at, model_tier)
    SELECT ?, 'person', pi.type, pi.value, '[]',
           (SELECT first_seen FROM people WHERE id = ?), 'free'
    FROM person_identifiers pi
    WHERE pi.person_id = ? AND pi.type IN ('email','phone')
      AND NOT EXISTS (
        SELECT 1 FROM entity_facts ef
        WHERE ef.entity_type = 'person' AND ef.entity_id = ?
          AND ef.fact_type = pi.type AND ef.fact_value = pi.value AND ef.invalid_at IS NULL
      )
  `);
  try {
    db.transaction(() => {
      for (const id of entityIds) {
        report.deleted += delStale.run(id, id).changes;
        report.inserted += insMissing.run(id, id, id, id).changes;
      }
    })();
  } catch (err) {
    log(`  entity_facts reconcile failed: ${err.message}`);
    return report;
  }
  log(`  entity_facts reconciled: ${report.deleted} stale deleted, ${report.inserted} inserted`);
  return report;
}

// ── Bad-card cleaning (generalized: strips B-bucket emails via the classifier) ─

/** Strip B-bucket ("extracted") emails from a google_contacts `emails` JSON array. */
export function cleanCardEmails(emailsJson, classifyFn) {
  let arr;
  try { arr = JSON.parse(emailsJson || '[]'); } catch { return emailsJson; }
  if (!Array.isArray(arr)) return emailsJson;
  return JSON.stringify(arr.filter((e) => classifyFn('email', e) !== 'B'));
}

/** Strip B-bucket emails from a google_contacts `raw` People-API payload. */
export function cleanCardRaw(rawJson, classifyFn) {
  if (!rawJson) return rawJson;
  let obj;
  try { obj = JSON.parse(rawJson); } catch { return rawJson; }
  if (!obj || !Array.isArray(obj.emailAddresses)) return rawJson;
  obj.emailAddresses = obj.emailAddresses.filter((e) => classifyFn('email', e && e.value) !== 'B');
  return JSON.stringify(obj);
}

// ── Private-name scanner registration (AC-11a) ────────────────────────────────

/** The repo root, resolving the same way gate-pii.sh does (git top-level). */
function repoRoot() {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(); }
  catch { return process.cwd(); }
}

/** The private-identity pattern file gate-pii.sh reads (env override else .git/info). */
function privatePatternFile() {
  return process.env.ROBOTDOJO_PRIVATE_IDENTITY_PATTERNS_FILE
    || resolve(repoRoot(), '.git', 'info', 'private-identity-patterns');
}

/**
 * Append each name's ≥3-char tokens to the private-identity pattern file so
 * scripts/gate-pii.sh gains coverage for a newly un-merged real person's name.
 * Deduped (skip tokens already present), one per line, regex-safe (tokens are
 * `[a-z]+`). The file lives under .git/ (untracked, per-clone) so nothing is
 * committed. Called only at executeUnmergePair's --execute tail.
 *
 * @returns {number} tokens appended
 */
export function registerPrivateNameTokens(names) {
  const file = privatePatternFile();
  let existingRaw = '';
  try { existingRaw = readFileSync(file, 'utf8'); } catch { existingRaw = ''; }
  const existing = new Set();
  for (const line of existingRaw.split('\n')) {
    const t = line.trim().toLowerCase();
    if (t && !t.startsWith('#')) existing.add(t);
  }
  const toAppend = [];
  for (const name of (Array.isArray(names) ? names : [names])) {
    for (const tok of nameTokens(name)) {
      if (!existing.has(tok) && !toAppend.includes(tok)) toAppend.push(tok);
    }
  }
  if (!toAppend.length) return 0;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const prefix = existingRaw && !existingRaw.endsWith('\n') ? '\n' : '';
    appendFileSync(file, prefix + toAppend.join('\n') + '\n');
  } catch {
    return 0;
  }
  return toAppend.length;
}

// ── The general split ─────────────────────────────────────────────────────────

/**
 * Split the welded `survivorId` into the survivor (keeps its id) and an
 * extracted record. Persistent-ID survivorship: the survivor's id never changes;
 * the extracted sub-cluster lands on `extractedId` (reused-if-archived, else
 * minted). Deterministic Tier-0 except the spawned card regen.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string}   opts.survivorId              the record that keeps its id (side A).
 * @param {string|null} [opts.extractedId=null]   reuse this id for side B (un-archived if archived).
 * @param {string|null} [opts.extractedName=null] display_name when minting the extracted record.
 * @param {boolean}  [opts.mintExtracted=false]   mint a fresh id when no extractedId is given.
 * @param {boolean}  [opts.execute=false]         dry-run (default) computes the plan; true writes.
 * @param {Function|null} [opts.classify=null]    (type,value)→'A'|'B'|'JUNK'; default uses ctx.
 * @param {object|null}   [opts.ctx=null]         adjudication context (default built from the pair).
 * @param {string|null}   [opts.badCardResource=null] google_contacts resource to strip B-emails from.
 * @param {boolean}  [opts.skipRelink=false]      skip the heavy linkChunkEntities() pass (tests).
 * @param {boolean}  [opts.skipRegen=false]       skip the regen-entities.js spawn (tests).
 * @param {boolean}  [opts.registerNames=true]    register both names into the PII scanner.
 * @param {boolean}  [opts.writeConstraint=true]  write the must-not-merge row.
 * @param {string}   [opts.reason]                must-not-merge reason.
 * @param {string}   [opts.source]                must-not-merge source.
 * @param {Function} [opts.log]                   progress logger.
 * @returns {Promise<object>} report
 */
export async function executeUnmergePair(db, opts = {}) {
  const {
    survivorId,
    extractedId: extractedIdOpt = null,
    extractedName = null,
    mintExtracted = false,
    execute = false,
    classify = null,
    ctx: ctxOpt = null,
    badCardResource = null,
    skipRelink = false,
    skipRegen = false,
    registerNames = true,
    writeConstraint = true,
    reason = 'unmerge-split',
    source = 'entity-unmerge',
    log = () => {},
  } = opts;
  if (!survivorId) throw new Error('executeUnmergePair: survivorId required');

  const ctx = ctxOpt || (extractedIdOpt ? buildPairAdjudicationContext(db, { idA: survivorId, idB: extractedIdOpt }) : null);
  const classifyFn = classify || ((type, value) => (ctx ? classifyIdentifierPair(type, value, ctx) : 'A'));

  const survivorIdents = db.prepare('SELECT type, value FROM person_identifiers WHERE person_id = ?').all(survivorId);
  const bucketList = { A: [], B: [], JUNK: [] };
  for (const id of survivorIdents) bucketList[classifyFn(id.type, id.value) || 'JUNK'].push(id);

  const report = {
    execute,
    survivorId,
    extractedId: extractedIdOpt,
    buckets: { A: bucketList.A.length, B: bucketList.B.length, JUNK: bucketList.JUNK.length },
    survivor_before: survivorIdents.length,
    extracted_restored: false,
    extracted_minted: false,
    moved_to_extracted: 0,
    junk_dropped: 0,
    card_cleaned: false,
    chunks_relinked: null,
    facts: null,
    constraint_written: false,
    names_registered: 0,
    regen_fired: false,
  };
  if (!execute) return report;

  // Idempotent no-op: nothing to extract or drop. Reconcile facts (idempotent)
  // so the report shape is complete; do NOT mint/un-archive/spawn/re-weld.
  if (bucketList.B.length === 0 && bucketList.JUNK.length === 0) {
    const ids = [survivorId];
    if (extractedIdOpt) {
      const ex = db.prepare('SELECT COALESCE(archived,0) a FROM people WHERE id = ?').get(extractedIdOpt);
      if (ex && Number(ex.a) === 0) ids.push(extractedIdOpt);
    }
    report.facts = reconcileIdentifierFacts(db, ids, { log });
    report.survivor_after = report.survivor_before;
    report.extracted_after = extractedIdOpt
      ? db.prepare('SELECT COUNT(*) n FROM person_identifiers WHERE person_id = ?').get(extractedIdOpt).n
      : 0;
    return report;
  }

  // Clear stale WAL reader marks before the write batch (Migration Protocol).
  try { db.pragma('wal_checkpoint(RESTART)'); } catch (err) { log(`  wal_checkpoint skipped: ${err.message}`); }

  // Resolve the extracted id — persistent-ID survivorship. The survivor keeps
  // its id; only the extracted sub-cluster gets a new/reused id.
  let extractedId = extractedIdOpt;
  const mintedName = extractedName || deriveNameFromBucket(bucketList.B) || 'Unmerged Person';
  if (extractedId) {
    const row = db.prepare('SELECT COALESCE(archived,0) a FROM people WHERE id = ?').get(extractedId);
    if (!row) {
      db.prepare("INSERT INTO people (id, display_name, archived) VALUES (?, ?, 0)").run(extractedId, mintedName);
      report.extracted_minted = true;
    } else if (Number(row.a) === 1) {
      db.prepare("UPDATE people SET archived = 0, updated_at = datetime('now') WHERE id = ?").run(extractedId);
      report.extracted_restored = true;
    }
  } else if (mintExtracted) {
    extractedId = crypto.randomUUID();
    db.prepare("INSERT INTO people (id, display_name, archived) VALUES (?, ?, 0)").run(extractedId, mintedName);
    report.extracted_minted = true;
  } else {
    throw new Error('executeUnmergePair: work to do but no extractedId and mintExtracted=false');
  }
  report.extractedId = extractedId;

  const tx = db.transaction(() => {
    const moveStmt = db.prepare('UPDATE OR IGNORE person_identifiers SET person_id = ? WHERE person_id = ? AND type = ? AND value = ?');
    const dropStmt = db.prepare('DELETE FROM person_identifiers WHERE person_id = ? AND type = ? AND value = ?');
    for (const id of bucketList.B) {
      const r = moveStmt.run(extractedId, survivorId, id.type, id.value);
      if (r.changes > 0) report.moved_to_extracted++;
      else { dropStmt.run(survivorId, id.type, id.value); report.moved_to_extracted++; } // extracted already had it — drop the survivor's dup
    }
    for (const id of bucketList.JUNK) report.junk_dropped += dropStmt.run(survivorId, id.type, id.value).changes;

    // Optional bad-card clean (owner path) — strip B-bucket emails so 01-extract
    // re-emits a bundle without the extracted person's forwarded addresses.
    if (badCardResource) {
      try {
        const card = db.prepare('SELECT emails, raw FROM google_contacts WHERE resource_name = ?').get(badCardResource);
        if (card) {
          db.prepare('UPDATE google_contacts SET emails = ?, raw = ? WHERE resource_name = ?')
            .run(cleanCardEmails(card.emails, classifyFn), cleanCardRaw(card.raw, classifyFn), badCardResource);
          report.card_cleaned = true;
        }
      } catch (err) { log(`  card clean skipped: ${err.message}`); }
    }

    // Re-derive chunk attribution — scoped DELETE of both person rows, then the
    // deterministic source→identifier→person join re-attaches exactly those.
    try { db.prepare("DELETE FROM chunk_entities WHERE entity_type = 'person' AND entity_id IN (?, ?)").run(survivorId, extractedId); }
    catch (err) { log(`  chunk_entities delete skipped: ${err.message}`); }
    try { db.prepare("UPDATE people SET needs_regen = 1, updated_at = datetime('now') WHERE id IN (?, ?)").run(survivorId, extractedId); }
    catch (err) { log(`  needs_regen mark skipped: ${err.message}`); }
  });
  tx();

  // Re-link chunks OUTSIDE the identifier transaction (linkChunkEntities runs
  // its own transactions). Scoped by the DELETE above.
  if (!skipRelink) {
    try {
      const { linkChunkEntities } = await import('../scripts/ingest/link-chunk-entities.js');
      report.chunks_relinked = linkChunkEntities();
    } catch (err) { log(`  chunk re-link skipped: ${err.message}`); }
  }

  // Reconcile derived email/phone facts to the re-partitioned identifiers.
  report.facts = reconcileIdentifierFacts(db, [survivorId, extractedId], { log });

  // Re-derive the owner-relative graph so ego block / "your ___" reflect the split.
  try { const { refreshDerivedRelationCache } = await import('./people-write.js'); refreshDerivedRelationCache(db); }
  catch (err) { log(`  relation cache refresh skipped: ${err.message}`); }
  try { const { refreshEgoBlock } = await import('./ego-render.js'); refreshEgoBlock(db); }
  catch (err) { log(`  ego refresh skipped: ${err.message}`); }

  // Durable must-not-merge constraint (AC-10) — the split records the pair or
  // the next 02-resolve re-welds via the shared/forwarded identifier.
  if (writeConstraint) {
    try { report.constraint_written = writeMustNotMerge(db, survivorId, extractedId, { reason, source }); }
    catch (err) { log(`  must-not-merge write skipped: ${err.message}`); }
  }

  // Register both names into the PII scanner (AC-11a) — execute tail only.
  if (registerNames) {
    try {
      const sName = db.prepare('SELECT display_name FROM people WHERE id = ?').get(survivorId)?.display_name || '';
      const eName = db.prepare('SELECT display_name FROM people WHERE id = ?').get(extractedId)?.display_name || '';
      report.names_registered = registerPrivateNameTokens([sName, eName]);
    } catch (err) { log(`  private-name register skipped: ${err.message}`); }
  }

  // Fire regen so entity_facts + the compiled card regenerate for both — the
  // ONLY LLM step; it writes the card, never a DB row. Non-blocking detached child.
  if (!skipRegen) {
    for (const id of [survivorId, extractedId]) {
      try {
        spawn(process.execPath, [resolve(homedir(), 'robotdojo', 'scripts', 'regen-entities.js'), '--entity', id], {
          detached: true, stdio: 'ignore',
        }).unref();
      } catch (err) { log(`  regen spawn skipped for ${id}: ${err.message}`); }
    }
    report.regen_fired = true;
  }

  report.survivor_after = db.prepare('SELECT COUNT(*) n FROM person_identifiers WHERE person_id = ?').get(survivorId).n;
  report.extracted_after = db.prepare('SELECT COUNT(*) n FROM person_identifiers WHERE person_id = ?').get(extractedId).n;
  return report;
}
