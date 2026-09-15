#!/usr/bin/env node
/**
 * unmerge-owner-foreign.js — the ONE-TIME repair that splits the owner's welded
 * identity back into two people (df_cbd30a5a AC-1).
 *
 * The owner (57d44b6f…) and an archived foreign-person record (7609a628…) were
 * welded when a Google Contact in the OWNER's own data co-listed that person's
 * forwarded addresses; the transitive-email merge pulled their separate record
 * into the owner. This script undoes that DETERMINISTICALLY — by re-partitioning
 * identifiers and re-running the deterministic chunk join — never by a blind
 * UPDATE that guesses.
 *
 * SAFE BY DEFAULT: `--dry-run` (the default) prints the full identifier
 * adjudication table and writes NOTHING. `--execute` runs the repair. The live
 * un-merge is OWNER-GATED: Miyagi shows the owner the dry-run adjudication, and
 * only then runs `--execute`. `--facts-only --execute` reconciles derived
 * email/phone facts on an already-partitioned DB without the heavy chunk relink.
 *
 * NO HARDCODED PII: the owner's name tokens + hard identifiers come from the
 * DECLARED identity (lib/identity.js) at runtime; the foreign person's name
 * tokens, exact identifiers, and EXCLUSIVE email domains are all derived from
 * the archived foreign record in the DB at runtime. Only opaque record ids and
 * the Google resource id are literals.
 *
 * INTELLIGENCE_TIER: orchestration
 *   Deterministic structural writes (identifier re-partition, chunk re-link,
 *   fact reconcile) are Tier-0; the ONLY LLM step is regen-entities.js, which
 *   writes the prose card, never a DB row — the write boundary holds.
 *
 * Operational discipline (mirrors scripts/ingest/backfill-merge-loser-cleanup.js):
 *   - writes through lib/db.js (the encrypted pipeline connection), never raw.
 *   - wal_checkpoint(RESTART) before the batch writes (clears stale reader marks).
 *   - a full backup snapshot is written before any mutation.
 *   - idempotent: a second --execute finds nothing to move and is a clean no-op.
 *
 * Usage:
 *   cd ~/robotdojo && node scripts/ingest/unmerge-owner-foreign.js            # dry-run
 *   cd ~/robotdojo && node scripts/ingest/unmerge-owner-foreign.js --execute  # owner-gated
 *
 * Exit codes: 0 success (incl. nothing-to-do / dry-run), 1 on error.
 */

export const INTELLIGENCE_TIER = 'orchestration';

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  declaredOwnerName,
  ownerDisplayName,
  declaredOwnerIdentifierSet,
} from '../../lib/identity.js';
import { executeUnmergePair, reconcileIdentifierFacts } from '../../lib/entity-unmerge.js';

// reconcileIdentifierFacts now lives in lib/entity-unmerge.js (the general split
// core, AC-9); re-exported here so existing callers/tests keep importing it from
// the owner script.
export { reconcileIdentifierFacts };

// ── Repair constants (opaque ids only — no name/email literals) ──────────────
export const OWNER_ID = '57d44b6f-6e41-4575-a0a3-cc6f0a2d82e0';
export const FRIEND_ID = '7609a628-37b3-4b51-bc51-8a17f4c45e46';
export const BAD_CARD_RESOURCE = 'people/c5719147126289558651';

/** Lowercased name tokens ≥3 chars, so an email local-part / name can be matched. */
function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * Build the adjudication context from live truth — NOTHING third-party is
 * hardcoded:
 *   - owner tokens + initials from the DECLARED owner name (fallback to the
 *     current owner name so the repair is runnable before re-declaration).
 *   - owner identifier set from the declared block.
 *   - foreign tokens from the archived foreign record's display_name (from DB).
 *   - foreign EXACT identifiers from the foreign record (from DB).
 *   - foreign EXCLUSIVE email domains = the foreign record's email domains MINUS
 *     the owner's email domains. Shared domains (ones the owner also uses) are
 *     excluded so an owner address on a shared domain is never misclassified;
 *     the foreign person's NAME tokens carry those cases. (Pre-execute the
 *     foreign row is stripped bare, so the derived sets are empty and the name
 *     tokens do the whole job; post-execute the exact sets make re-verification
 *     precise.)
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ownerId?:string, friendId?:string}} [ids]
 */
export function buildAdjudicationContext(db, { ownerId = OWNER_ID, friendId = FRIEND_ID } = {}) {
  const nameForTokens = declaredOwnerName() || (ownerDisplayName() === 'the user' ? '' : ownerDisplayName());
  const ownerTokens = nameTokens(nameForTokens);
  const ownerInitials = ownerTokens.map((t) => t[0]).join('');

  let friendName = '';
  let friendIdents = [];
  let ownerEmailIdents = [];
  try { friendName = db.prepare('SELECT display_name FROM people WHERE id = ?').get(friendId)?.display_name || ''; } catch { friendName = ''; }
  try { friendIdents = db.prepare("SELECT type, value FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')").all(friendId); } catch { friendIdents = []; }
  try { ownerEmailIdents = db.prepare("SELECT value FROM person_identifiers WHERE person_id = ? AND type = 'email'").all(ownerId); } catch { ownerEmailIdents = []; }

  const emailDomain = (val) => { const s = String(val).toLowerCase(); return s.includes('@') ? s.split('@')[1] : null; };
  const friendIdentifierSet = new Set(friendIdents.map((r) => String(r.value).trim().toLowerCase()));
  const ownerEmailDomains = new Set(ownerEmailIdents.map((r) => emailDomain(r.value)).filter(Boolean));
  const friendDomains = new Set(
    friendIdents
      .filter((r) => r.type === 'email')
      .map((r) => emailDomain(r.value))
      .filter((d) => d && !ownerEmailDomains.has(d)), // EXCLUSIVE to the foreign person
  );

  return {
    ownerTokens,
    ownerInitials,
    ownerIdentifierSet: declaredOwnerIdentifierSet(),
    friendTokens: nameTokens(friendName),
    friendIdentifierSet,
    friendDomains,
  };
}

/**
 * Adjudicate one identifier into OWNER | FRIEND | JUNK, deterministically by
 * value, against a runtime context. FRIEND is tested first (most specific: an
 * exact foreign identifier, a foreign name token, or a foreign-EXCLUSIVE
 * domain). OWNER is the declared set OR the owner's name-token / initial
 * patterns. Everything else — role/automated addresses and stray phones that
 * belong to neither identity — is JUNK.
 *
 * Validated against the live welded record: 11 FRIEND, and OWNER/JUNK per the
 * owner's declared identifier set.
 */
export function classifyIdentifier(type, value, ctx) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return 'JUNK';
  const hasAt = v.includes('@');
  const local = hasAt ? v.split('@')[0] : v;
  const domain = hasAt ? v.split('@')[1] : '';

  // FRIEND — exact identifier, name token, or a foreign-exclusive domain.
  if (ctx.friendIdentifierSet && ctx.friendIdentifierSet.has(v)) return 'FRIEND';
  if (ctx.friendTokens.some((t) => v.includes(t))) return 'FRIEND';
  if (domain && ctx.friendDomains.has(domain)) return 'FRIEND';

  // OWNER — declared identifier, then name-token / initial patterns.
  if (ctx.ownerIdentifierSet.has(v)) return 'OWNER';
  // Phones carry no name signal; a declared owner phone would already be in the
  // set above, so any remaining phone is a stray number → JUNK.
  if (type === 'phone') return 'JUNK';
  if (ctx.ownerTokens.some((t) => local.startsWith(t) || local.includes(t))) return 'OWNER';
  if (ctx.ownerInitials.length >= 2
      && (local === ctx.ownerInitials || new RegExp(`^${ctx.ownerInitials}\\d`).test(local))) return 'OWNER';

  // Unattributable / role / automated (jobs@, do_not_reply@, office365@, …).
  return 'JUNK';
}

/** Bucket a list of {type,value,...} identifiers by adjudication. */
export function adjudicate(identifiers, ctx) {
  const buckets = { OWNER: [], FRIEND: [], JUNK: [] };
  for (const id of identifiers) buckets[classifyIdentifier(id.type, id.value, ctx)].push(id);
  return buckets;
}

/** Read both records + all owner identifiers + the adjudication for the backup snapshot. */
export function buildSnapshot(db, { ownerId = OWNER_ID, friendId = FRIEND_ID, ctx = null } = {}) {
  const context = ctx || buildAdjudicationContext(db, { ownerId, friendId });
  const owner = db.prepare('SELECT id, display_name, short_name, COALESCE(archived,0) AS archived FROM people WHERE id = ?').get(ownerId) || null;
  const friend = db.prepare('SELECT id, display_name, short_name, COALESCE(archived,0) AS archived FROM people WHERE id = ?').get(friendId) || null;
  const ownerIdentifiers = db.prepare('SELECT type, value, source, is_primary FROM person_identifiers WHERE person_id = ? ORDER BY type, value').all(ownerId);
  const friendIdentifiers = db.prepare('SELECT type, value FROM person_identifiers WHERE person_id = ?').all(friendId);
  const buckets = adjudicate(ownerIdentifiers, context);
  let ownerChunks = 0; let friendChunks = 0;
  try { ownerChunks = db.prepare("SELECT COUNT(*) n FROM chunk_entities WHERE entity_id=? AND entity_type='person'").get(ownerId).n; } catch { /* absent */ }
  try { friendChunks = db.prepare("SELECT COUNT(*) n FROM chunk_entities WHERE entity_id=? AND entity_type='person'").get(friendId).n; } catch { /* absent */ }
  // Capture the email/phone entity_facts for BOTH records so the delete in the
  // facts reconciliation is reversible from the backup snapshot.
  let ownerIdFacts = []; let friendIdFacts = [];
  try { ownerIdFacts = db.prepare("SELECT id, fact_type, fact_value, valid_at, invalid_at, model_tier FROM entity_facts WHERE entity_type='person' AND entity_id=? AND fact_type IN ('email','phone')").all(ownerId); } catch { /* absent */ }
  try { friendIdFacts = db.prepare("SELECT id, fact_type, fact_value, valid_at, invalid_at, model_tier FROM entity_facts WHERE entity_type='person' AND entity_id=? AND fact_type IN ('email','phone')").all(friendId); } catch { /* absent */ }
  return {
    captured_at: new Date().toISOString(),
    owner,
    friend,
    owner_identifier_count: ownerIdentifiers.length,
    friend_identifier_count: friendIdentifiers.length,
    owner_chunk_count: ownerChunks,
    friend_chunk_count: friendChunks,
    owner_identifier_facts: ownerIdFacts,
    friend_identifier_facts: friendIdFacts,
    owner_identifiers: ownerIdentifiers,
    adjudication: {
      OWNER: buckets.OWNER.map((r) => r.value),
      FRIEND: buckets.FRIEND.map((r) => r.value),
      JUNK: buckets.JUNK.map((r) => r.value),
    },
    counts: { OWNER: buckets.OWNER.length, FRIEND: buckets.FRIEND.length, JUNK: buckets.JUNK.length },
  };
}

/**
 * The owner repair — now a THIN CALLER over lib/entity-unmerge.js
 * executeUnmergePair (AC-9). When `execute` is false this only reads
 * (buildSnapshot + returns the plan). When true it delegates the general split
 * mechanics to the lib: owner = survivor side A, friend = extracted side B, with
 * an owner-flavored classifier mapping OWNER→A / FRIEND→B / JUNK→JUNK.
 *
 * Injectable ids so the fixture test can drive a synthetic weld; defaults are
 * the live pair. `skipRelink` / `skipRegen` keep the fixture test deterministic.
 * `factsOnly` reconciles derived facts on an already-partitioned DB.
 *
 * @returns {Promise<object>} report — buckets, moved/dropped counts, before/after.
 */
export async function executeUnmerge(db, opts = {}) {
  const {
    ownerId = OWNER_ID,
    friendId = FRIEND_ID,
    badCardResource = BAD_CARD_RESOURCE,
    execute = false,
    log = () => {},
    skipRelink = false,
    skipRegen = false,
    factsOnly = false,
  } = opts;

  const ctx = opts.ctx || buildAdjudicationContext(db, { ownerId, friendId });
  const before = buildSnapshot(db, { ownerId, friendId, ctx });
  const report = {
    execute,
    factsOnly,
    owner_before: before.owner_identifier_count,
    buckets: before.counts,
    friend_moved: 0,
    junk_dropped: 0,
    card_cleaned: false,
    friend_restored: false,
    chunks_relinked: null,
    facts: null,
  };

  if (!execute) return { ...report, snapshot: before };

  // FACTS-ONLY mode — runnable on the ALREADY-EXECUTED live DB: reconcile
  // entity_facts to the current identifiers WITHOUT re-doing the heavy chunk
  // re-link (identifiers/chunks are already correct). Idempotent.
  if (factsOnly) {
    report.facts = reconcileIdentifierFacts(db, [ownerId, friendId], { log });
    const after = buildSnapshot(db, { ownerId, friendId, ctx });
    report.owner_after = after.owner_identifier_count;
    report.friend_after = after.friend_identifier_count;
    return report;
  }

  // Delegate to the general split. The owner-flavored classifier keeps the
  // exact owner bucketing (FRIEND tested before OWNER; declared set + owner
  // name tokens) so verify-owner-split.js + the owner tests hold. friendId is
  // reused (un-archived) as the extracted id, preserving resolve_audit lineage.
  //
  // registerNames:false — the owner's identity protection is the declared
  // anchor (Phase 1), a stronger structural guarantee than the PII denylist;
  // registering split names is the GENERAL-split concern (detector path, AC-11a).
  const classify = (type, value) => {
    const b = classifyIdentifier(type, value, ctx);
    return b === 'OWNER' ? 'A' : b === 'FRIEND' ? 'B' : 'JUNK';
  };
  const pair = await executeUnmergePair(db, {
    survivorId: ownerId,
    extractedId: friendId,
    classify,
    execute: true,
    badCardResource,
    skipRelink,
    skipRegen,
    registerNames: false,
    reason: 'unmerge-owner-foreign',
    source: 'unmerge-owner-foreign',
    log,
  });

  report.friend_restored = pair.extracted_restored;
  report.friend_moved = pair.moved_to_extracted;
  report.junk_dropped = pair.junk_dropped;
  report.card_cleaned = pair.card_cleaned;
  report.chunks_relinked = pair.chunks_relinked;
  report.facts = pair.facts;
  if (pair.regen_fired) report.regen_fired = true;
  report.owner_after = pair.survivor_after;
  report.friend_after = pair.extracted_after;
  return report;
}

// ── Backup path (untracked runtime dir; dry-run writes nothing) ──────────────
function backupDir() {
  return process.env.ROBOTDOJO_UNMERGE_BACKUP_DIR || resolve(homedir(), '.robotdojo');
}
export function backupPathFor(ts = Date.now()) {
  return resolve(backupDir(), `owner-unmerge-backup-${ts}.json`);
}

function printAdjudication(snapshot, ctx) {
  const rows = snapshot.owner_identifiers.map((r) => ({ bucket: classifyIdentifier(r.type, r.value, ctx), type: r.type, value: r.value }));
  const order = { OWNER: 0, FRIEND: 1, JUNK: 2 };
  rows.sort((a, b) => order[a.bucket] - order[b.bucket] || a.type.localeCompare(b.type) || String(a.value).localeCompare(String(b.value)));
  console.log('\n  BUCKET  TYPE    VALUE');
  console.log('  ' + '-'.repeat(70));
  for (const r of rows) console.log(`  ${r.bucket.padEnd(6)}  ${String(r.type).padEnd(6)}  ${r.value}`);
  console.log('  ' + '-'.repeat(70));
  console.log(`  OWNER=${snapshot.counts.OWNER}  FRIEND=${snapshot.counts.FRIEND}  JUNK=${snapshot.counts.JUNK}  (total ${snapshot.owner_identifiers.length})`);
}

async function main() {
  const execute = process.argv.includes('--execute');
  const factsOnly = process.argv.includes('--facts-only');
  const { default: db } = await import('../../lib/db.js');

  const ctx = buildAdjudicationContext(db);
  const snapshot = buildSnapshot(db, { ctx });
  if (!snapshot.owner) {
    console.error(`[unmerge-owner-foreign] owner ${OWNER_ID} not found — nothing to do`);
    process.exit(1);
  }
  if (!ctx.ownerTokens.length) {
    console.error('[unmerge-owner-foreign] no DECLARED owner name — run the installer / set_owner_identity first so the owner tokens are known');
    process.exit(1);
  }

  console.log(`[unmerge-owner-foreign] owner="${snapshot.owner.display_name}" (${snapshot.owner_identifier_count} identifiers), ` +
    `friend="${snapshot.friend ? snapshot.friend.display_name : 'MISSING'}" archived=${snapshot.friend ? snapshot.friend.archived : '?'} ` +
    `(owner chunks=${snapshot.owner_chunk_count}, friend chunks=${snapshot.friend_chunk_count})`);
  printAdjudication(snapshot, ctx);

  if (!execute) {
    console.log('\n[unmerge-owner-foreign] --dry-run (default): no writes performed. Review the adjudication above.');
    console.log('[unmerge-owner-foreign] to apply (OWNER-GATED): node scripts/ingest/unmerge-owner-foreign.js --execute');
    process.exit(0);
  }

  // Backup before any mutation.
  const backupPath = backupPathFor();
  try {
    mkdirSync(backupDir(), { recursive: true, mode: 0o700 });
    writeFileSync(backupPath, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
    console.log(`[unmerge-owner-foreign] backup written: ${backupPath}`);
  } catch (err) {
    console.error(`[unmerge-owner-foreign] FATAL: could not write backup (${err.message}) — aborting before any mutation`);
    process.exit(1);
  }

  const report = await executeUnmerge(db, { execute: true, factsOnly, ctx, log: (m) => console.log(m) });
  if (factsOnly) {
    console.log(`[unmerge-owner-foreign] facts-only complete: ${report.facts.deleted} stale email/phone facts deleted, ${report.facts.inserted} inserted (identifiers/chunks untouched).`);
    console.log('[unmerge-owner-foreign] verify: node scripts/qa/verify-owner-split.js');
    process.exit(0);
  }
  console.log(`[unmerge-owner-foreign] complete: friend_restored=${report.friend_restored} friend_moved=${report.friend_moved} ` +
    `junk_dropped=${report.junk_dropped} card_cleaned=${report.card_cleaned} ` +
    `owner ${report.owner_before}→${report.owner_after} idents, friend now ${report.friend_after} idents, ` +
    `chunks_relinked=${report.chunks_relinked}, facts(${report.facts ? report.facts.deleted + ' del/' + report.facts.inserted + ' ins' : 'n/a'})`);
  console.log('[unmerge-owner-foreign] verify: node scripts/qa/verify-owner-split.js && node scripts/qa/verify-owner-split.js --reconcile-counts');
  process.exit(0);
}

// Run as CLI only (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => { console.error('[unmerge-owner-foreign] fatal:', err.message); process.exit(1); });
}
