#!/usr/bin/env node
/**
 * verify-reresolve-separation.js — proves the whole-graph re-resolve (AC-13)
 * un-welded the distinct people (df_cbd30a5a). Run AFTER
 * `re-resolve-identity.js --execute`.
 *
 * Because ids CHURN on a --reset, this keys off stable identifier VALUES + the
 * structural detector, never old ids:
 *   1. Owner distinct + zero-shared: the person holding a declared owner email is
 *      a single active id, and NO other active person shares any of the owner's
 *      identifier values.
 *   2. No confirmed welds remain: detect-over-merges reports zero suspects — this
 *      subsumes "the 13 corporate-domain colleagues are ≥13 distinct records" and
 *      "the 28 detector suspects are gone" without embedding any PII.
 *   3. (optional) --expect-distinct v1,v2,…: the given identifier VALUES resolve to
 *      ≥N distinct active person ids sharing zero identifier — the owner can pass
 *      the 13 corporate addresses / 28-suspect values enumerated from resolve_audit
 *      at run time (no PII in the repo).
 *
 * INTELLIGENCE_TIER: extraction  (deterministic reads; no LLM.)
 *
 * Exit 0 = all assertions hold; 1 = a bridge / shared identifier / weld remains.
 *
 * Usage:
 *   cd ~/robotdojo && node scripts/qa/verify-reresolve-separation.js
 *   cd ~/robotdojo && node scripts/qa/verify-reresolve-separation.js --expect-distinct a@x.com,b@y.com,…
 */

export const INTELLIGENCE_TIER = 'extraction';

import { resolve } from 'node:path';
import { ownerEmails, ownerPersonId } from '../../lib/identity.js';
import { detectOverMerges } from '../../scripts/ingest/detect-over-merges.js';

/** Active person ids holding any of the given identifier values. */
function idsHolding(db, values) {
  if (!values.length) return [];
  const ph = values.map(() => '?').join(',');
  return db.prepare(`
    SELECT DISTINCT pi.person_id
    FROM person_identifiers pi
    JOIN people p ON p.id = pi.person_id
    WHERE LOWER(pi.value) IN (${ph}) AND COALESCE(p.archived,0) = 0
  `).all(...values.map((v) => String(v).toLowerCase())).map((r) => r.person_id);
}

/** Every identifier value carried by a person. */
function identifierValuesOf(db, personId) {
  return db.prepare("SELECT LOWER(value) v FROM person_identifiers WHERE person_id = ?").all(personId).map((r) => r.v);
}

/**
 * Run the separation checks. Returns { ok, failures[], checks{} } — pure reads.
 * @param {import('better-sqlite3').Database} db
 * @param {{ expectDistinct?: string[] }} [opts]
 */
export function verifyReresolveSeparation(db, { expectDistinct = [] } = {}) {
  const failures = [];
  const checks = {};

  // 1. Owner distinct + zero-shared.
  const emails = ownerEmails();
  const ownerIds = idsHolding(db, emails);
  const ownerId = ownerPersonId();
  checks.ownerIds = ownerIds;
  if (emails.length && ownerIds.length !== 1) {
    failures.push(`owner is not a single active record: ${ownerIds.length} ids hold a declared owner email`);
  }
  if (ownerIds.length === 1) {
    const oid = ownerIds[0];
    if (ownerId && String(ownerId) !== String(oid)) {
      failures.push(`declared owner_person_id (${ownerId}) does not hold a declared owner email (${oid} does)`);
    }
    const ownerValues = identifierValuesOf(db, oid);
    const shared = db.prepare(`
      SELECT DISTINCT pi.person_id
      FROM person_identifiers pi
      JOIN people p ON p.id = pi.person_id
      WHERE COALESCE(p.archived,0) = 0 AND pi.person_id <> ?
        AND LOWER(pi.value) IN (${ownerValues.map(() => '?').join(',') || "''"})
    `).all(oid, ...ownerValues).map((r) => r.person_id);
    checks.ownerSharedWith = shared;
    if (shared.length) failures.push(`owner shares ${shared.length} identifier(s) with another active person (must be zero)`);
  }

  // 2. No confirmed welds remain.
  const suspects = detectOverMerges(db);
  checks.weldSuspects = suspects.length;
  if (suspects.length) failures.push(`${suspects.length} weld-suspect(s) still flagged by the detector (expected 0)`);

  // 3. Optional value-keyed distinctness (owner enumerates the exact values).
  if (expectDistinct.length) {
    const holders = new Map(); // value -> [ids]
    for (const v of expectDistinct) holders.set(v, idsHolding(db, [v]));
    const distinctIds = new Set();
    for (const ids of holders.values()) for (const id of ids) distinctIds.add(id);
    checks.expectDistinctIds = distinctIds.size;
    if (distinctIds.size < expectDistinct.length) {
      failures.push(`expected ≥${expectDistinct.length} distinct records for the given values, found ${distinctIds.size} (some still welded)`);
    }
    // Zero-shared across the enumerated set: no id holds two of the values.
    for (const [v, ids] of holders) {
      for (const [v2, ids2] of holders) {
        if (v === v2) continue;
        if (ids.some((id) => ids2.includes(id))) {
          failures.push(`values ${v} and ${v2} still resolve to the SAME record (weld remains)`);
        }
      }
    }
  }

  return { ok: failures.length === 0, failures, checks };
}

async function main() {
  const argv = process.argv.slice(2);
  const edIdx = argv.indexOf('--expect-distinct');
  const expectDistinct = edIdx >= 0 && argv[edIdx + 1]
    ? argv[edIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const { default: db } = await import('../../lib/db.js');
  const { ok, failures, checks } = verifyReresolveSeparation(db, { expectDistinct });

  console.log(`[verify-reresolve] owner records=${(checks.ownerIds || []).length}, ` +
    `owner-shared=${(checks.ownerSharedWith || []).length}, weld-suspects=${checks.weldSuspects}` +
    (expectDistinct.length ? `, distinct-of-${expectDistinct.length}=${checks.expectDistinctIds}` : ''));
  if (!ok) {
    for (const f of failures) console.error(`[verify-reresolve] FAIL: ${f}`);
    process.exit(1);
  }
  console.log('[verify-reresolve] ok — owner distinct + zero-shared, no confirmed welds remain.');
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => { console.error('[verify-reresolve] fatal:', err.message); process.exit(1); });
}
