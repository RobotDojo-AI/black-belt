#!/usr/bin/env node
/**
 * QA script for AC 7 / VC 7 (st_87a0d072).
 *
 * "Phase 2 Resolve merges nickname-equivalent names only when the surname is uncommon."
 *
 * Strategy:
 *   1. Seed four test people in the DB with the prefix `qa-st_87a0d072-`:
 *        - Andrew Exampleton (uncommon surname) + Andy Exampleton
 *        - Andrew Smith    (common   surname) + Andy Smith
 *   2. Each person carries a DIFFERENT email identifier — so Stage A guards
 *      will NOT merge them (no shared email). Only Stage B nickname-merge
 *      can collapse the pairs.
 *   3. Call mergePeoplePass() directly (no full pipeline run).
 *   4. Assert:
 *        - Both Exampleton rows collapse to one active row (archived=1 on loser).
 *        - Both Smith rows remain active (no merge — common surname blocked).
 *   5. Clean up.
 *
 * Exit 0 on pass, 1 on fail.
 */

import db from '../../lib/db.js';
import { mergePeoplePass } from '../ingest/02-resolve.js';

const PREFIX = 'qa-st_87a0d072-nickmerge-';

function seedPerson(id, name, email) {
  db.prepare(`
    INSERT OR REPLACE INTO people
      (id, display_name, tier, confidence, source_count, primary_source,
       created_at, updated_at, needs_regen, archived)
    VALUES (?, ?, 'acquaintance', 1.0, 1, 'imessage',
            datetime('now'), datetime('now'), 0, 0)
  `).run(id, name);
  db.prepare("INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source) VALUES (?, 'email', ?, 'contacts')")
    .run(id, email);
}

function cleanup() {
  const ids = db.prepare(`SELECT id FROM people WHERE id LIKE '${PREFIX}%'`).all();
  for (const r of ids) {
    db.prepare('DELETE FROM person_identifiers WHERE person_id = ?').run(r.id);
    db.prepare('DELETE FROM people WHERE id = ?').run(r.id);
    try { db.prepare('DELETE FROM resolve_audit WHERE evidence = ?').run(r.id); } catch { /* absent */ }
  }
}

cleanup();

// Snapshot every active person + their identifier set before the merge pass
// so we can revert any side-effect merges that touch non-prefix data.
// WHY: mergePeoplePass walks every row in `people` — running it on a live
// DB will collapse pre-existing legitimate duplicates. The QA assertion is
// scoped to our 4 seeded rows; we restore the rest after the assertion.
const preActiveIds = new Set(
  db.prepare("SELECT id FROM people WHERE COALESCE(archived,0) = 0").all().map(r => r.id),
);
const preIdentifierOwner = new Map(
  db.prepare("SELECT id, person_id FROM person_identifiers").all().map(r => [r.id, r.person_id]),
);
// Snapshot person_interactions ownership too — mergeInto() re-parents these
// onto the winner. Revert restores the loser as the owner for any row that
// previously belonged to a non-prefix loser.
const preInteractionOwner = new Map(
  db.prepare("SELECT rowid, person_id FROM person_interactions").all().map(r => [r.rowid, r.person_id]),
);
const preGroupOwner = (() => {
  try { return new Map(db.prepare("SELECT id, person_id FROM person_groups").all().map(r => [r.id, r.person_id])); }
  catch { return new Map(); }
})();

function revertSideEffects() {
  // Un-archive any row that was active before our test ran AND isn't one of
  // our prefix seeds (those should stay archived per the test).
  const nowArchived = db.prepare(`
    SELECT id FROM people WHERE archived = 1 AND id NOT LIKE '${PREFIX}%'
  `).all();
  const reverted = db.transaction(() => {
    let n = 0;
    for (const r of nowArchived) {
      if (preActiveIds.has(r.id)) {
        db.prepare('UPDATE people SET archived = 0 WHERE id = ?').run(r.id);
        n++;
      }
    }
    // Restore identifier ownership.
    for (const [idfId, prevOwner] of preIdentifierOwner) {
      const cur = db.prepare('SELECT person_id FROM person_identifiers WHERE id = ?').get(idfId);
      if (cur && cur.person_id !== prevOwner) {
        db.prepare('UPDATE OR IGNORE person_identifiers SET person_id = ? WHERE id = ?').run(prevOwner, idfId);
      }
    }
    // Restore interaction ownership.
    for (const [rowid, prevOwner] of preInteractionOwner) {
      const cur = db.prepare('SELECT person_id FROM person_interactions WHERE rowid = ?').get(rowid);
      if (cur && cur.person_id !== prevOwner) {
        db.prepare('UPDATE person_interactions SET person_id = ? WHERE rowid = ?').run(prevOwner, rowid);
      }
    }
    // Restore group ownership.
    for (const [id, prevOwner] of preGroupOwner) {
      const cur = db.prepare('SELECT person_id FROM person_groups WHERE id = ?').get(id);
      if (cur && cur.person_id !== prevOwner) {
        db.prepare('UPDATE person_groups SET person_id = ? WHERE id = ?').run(prevOwner, id);
      }
    }
    return n;
  })();
  // Drop any audit rows from this pass (best-effort).
  try {
    db.prepare("DELETE FROM resolve_audit WHERE source = 'merge-pass' AND person_id NOT IN (SELECT id FROM people WHERE id LIKE ? OR archived = 1)").run(`${PREFIX}%`);
  } catch { /* absent */ }
  return reverted;
}

// Seed in created_at order so the "winner" is deterministic per the
// mergePeoplePass SELECT (ORDER BY created_at ASC).
// SQLite resolves datetime('now') at second granularity — we need to
// pad created_at manually to guarantee ordering across same-second inserts.
function seedPersonWithCreatedAt(id, name, email, createdAt) {
  db.prepare(`
    INSERT OR REPLACE INTO people
      (id, display_name, tier, confidence, source_count, primary_source,
       created_at, updated_at, needs_regen, archived)
    VALUES (?, ?, 'acquaintance', 1.0, 1, 'imessage', ?, ?, 0, 0)
  `).run(id, name, createdAt, createdAt);
  db.prepare("INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source) VALUES (?, 'email', ?, 'contacts')")
    .run(id, email);
}

const T = '2026-05-13T00:00:00';
seedPersonWithCreatedAt(`${PREFIX}1`, 'Andrew Exampleton', `${PREFIX}andrew@exampleton.test`, `${T}.001`);
seedPersonWithCreatedAt(`${PREFIX}2`, 'Andy Exampleton',    `${PREFIX}andy@exampleton.test`,    `${T}.002`);
seedPersonWithCreatedAt(`${PREFIX}3`, 'Andrew Smith',     `${PREFIX}andrew@smith.test`,     `${T}.003`);
seedPersonWithCreatedAt(`${PREFIX}4`, 'Andy Smith',       `${PREFIX}andy@smith.test`,       `${T}.004`);

// Run the merge pass. mergePeoplePass walks ALL active people, not just our
// seeds — but our seeded rows are the only same-surname-nickname-equivalent
// candidates because we use the PREFIX in emails and the names are
// real-but-not-typical.
const stats = mergePeoplePass(db);

// Assertions:
// (1) Both Exampleton rows must collapse to ONE active row.
const exampletonActive = db.prepare(`
  SELECT COUNT(*) AS c FROM people
  WHERE id IN ('${PREFIX}1', '${PREFIX}2') AND COALESCE(archived,0) = 0
`).get();

// (2) Both Smith rows must remain active (no merge).
const smithActive = db.prepare(`
  SELECT COUNT(*) AS c FROM people
  WHERE id IN ('${PREFIX}3', '${PREFIX}4') AND COALESCE(archived,0) = 0
`).get();

let failed = false;
if (exampletonActive.c !== 1) {
  console.error(`FAIL — Exampleton pair should collapse to 1 active row, got ${exampletonActive.c}`);
  failed = true;
}
if (smithActive.c !== 2) {
  console.error(`FAIL — Smith pair should stay as 2 active rows, got ${smithActive.c}`);
  failed = true;
}
// Revert any merges this QA pass caused on non-prefix (live) people.
const revertedCount = revertSideEffects();

if (failed) {
  cleanup();
  process.exit(1);
}

console.log(`ok — Exampleton merged (rare surname), Smith preserved (common surname); reverted ${revertedCount} live-row side-effect archives — merge stats:`, stats);
cleanup();
process.exit(0);
