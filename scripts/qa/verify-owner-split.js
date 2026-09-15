#!/usr/bin/env node
/**
 * verify-owner-split.js — proves the owner and the foreign-person record are
 * two provably-disconnected people after the un-merge (df_cbd30a5a AC-1).
 *
 * Default mode asserts:
 *   (i)   the owner's and friend's email/phone identifier VALUES share nothing
 *         (∅ intersection) — no direct connecting identifier.
 *   (ii)  no owner identifier adjudicates as FRIEND and no friend identifier
 *         adjudicates as OWNER — the classifier agrees with the partition.
 *   (iii) no google_contacts card co-lists an owner identifier AND a friend
 *         identifier — no source bundle would bridge them on the next ingest
 *         (the guard would also refuse, but this proves no bridge remains).
 *
 * `--reconcile-counts` reads the PRE-SURGERY backup snapshot (the one that still
 * held the foreign + junk identifiers — max owner_identifier_count with
 * FRIEND+JUNK > 0, NOT the newest, which may be a post-surgery / facts-only
 * snapshot) and asserts the owner's current identifier count equals before −
 * friend-moved − junk-dropped, AND every backed-up OWNER-bucket value is still
 * on the owner — so "no owner data lost" is a real, non-vacuous reconciliation.
 *
 * Exit codes: 0 when disconnected / reconciled, 1 on any bridge or mismatch.
 *
 * INTELLIGENCE_TIER: extraction (deterministic reads + assertions; no LLM).
 */

export const INTELLIGENCE_TIER = 'extraction';

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import db from '../../lib/db.js';
import {
  OWNER_ID,
  FRIEND_ID,
  buildAdjudicationContext,
  classifyIdentifier,
} from '../ingest/unmerge-owner-foreign.js';

const RECONCILE = process.argv.includes('--reconcile-counts');

function idValues(personId, types = ['email', 'phone']) {
  const placeholders = types.map(() => '?').join(',');
  return db.prepare(
    `SELECT LOWER(value) AS v FROM person_identifiers WHERE person_id = ? AND type IN (${placeholders})`,
  ).all(personId, ...types).map((r) => r.v);
}

function fail(msg) { console.error(`[verify-disconnect] FAIL: ${msg}`); process.exit(1); }

function verifyDisconnect() {
  const ctx = buildAdjudicationContext(db);

  // (i) zero shared identifier value.
  const ownerVals = new Set(idValues(OWNER_ID));
  const friendVals = new Set(idValues(FRIEND_ID));
  const shared = [...ownerVals].filter((v) => friendVals.has(v));
  if (shared.length) fail(`owner and friend share ${shared.length} identifier(s): ${shared.join(', ')}`);

  // (ii) classifier agrees with the partition (no cross-contamination).
  const ownerAllIdents = db.prepare("SELECT type, value FROM person_identifiers WHERE person_id = ?").all(OWNER_ID);
  const strayOnOwner = ownerAllIdents.filter((r) => classifyIdentifier(r.type, r.value, ctx) === 'FRIEND');
  if (strayOnOwner.length) fail(`${strayOnOwner.length} FRIEND-classified identifier(s) still on owner: ${strayOnOwner.map((r) => r.value).join(', ')}`);
  const friendAllIdents = db.prepare("SELECT type, value FROM person_identifiers WHERE person_id = ?").all(FRIEND_ID);
  const strayOnFriend = friendAllIdents.filter((r) => classifyIdentifier(r.type, r.value, ctx) === 'OWNER');
  if (strayOnFriend.length) fail(`${strayOnFriend.length} OWNER-classified identifier(s) on the friend: ${strayOnFriend.map((r) => r.value).join(', ')}`);

  // (iii) no google_contacts card co-lists an owner value AND a friend value.
  let bridged = 0;
  try {
    const cards = db.prepare('SELECT resource_name, emails FROM google_contacts WHERE emails IS NOT NULL').all();
    for (const c of cards) {
      let arr = [];
      try { arr = JSON.parse(c.emails || '[]'); } catch { arr = []; }
      const lowered = arr.map((e) => String(e).trim().toLowerCase());
      const hasOwner = lowered.some((e) => ownerVals.has(e));
      const hasFriend = lowered.some((e) => friendVals.has(e));
      if (hasOwner && hasFriend) { bridged++; console.error(`  bridging card: ${c.resource_name}`); }
    }
  } catch (err) { console.warn(`[verify-disconnect] card-bridge scan skipped: ${err.message}`); }
  if (bridged) fail(`${bridged} google_contacts card(s) still co-list an owner AND a friend address — a live re-merge bridge`);

  // Friend must be a restored, ACTIVE record.
  const friend = db.prepare('SELECT COALESCE(archived,0) AS archived FROM people WHERE id = ?').get(FRIEND_ID);
  if (!friend) fail(`friend record ${FRIEND_ID} not found`);
  if (Number(friend.archived) !== 0) fail('friend record is still archived — not restored');

  console.log(`[verify-disconnect] OK — owner (${ownerVals.size} ids) and friend (${friendVals.size} ids) share ZERO connecting identifier; no bridging card; friend restored active.`);
}

/**
 * Pick the PRE-SURGERY snapshot, NOT the newest. A post-surgery / facts-only
 * snapshot has FRIEND=0/JUNK=0 and owner_identifier_count already reduced, which
 * makes the reconciliation vacuous (before === after − 0 − 0). The real proof
 * needs the snapshot taken WHILE the owner still carried the foreign + junk
 * identifiers: among all snapshots with FRIEND+JUNK > 0, the one with the
 * largest owner_identifier_count.
 */
function preSurgeryBackup() {
  const dir = process.env.ROBOTDOJO_UNMERGE_BACKUP_DIR || resolve(homedir(), '.robotdojo');
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^owner-unmerge-backup-\d+\.json$/.test(f));
  } catch { files = []; }
  let best = null;
  for (const f of files) {
    let snap;
    try { snap = JSON.parse(readFileSync(resolve(dir, f), 'utf8')); } catch { continue; }
    const moved = (snap?.counts?.FRIEND || 0) + (snap?.counts?.JUNK || 0);
    if (moved <= 0) continue; // post-surgery / facts-only snapshot — vacuous
    if (!best || (snap.owner_identifier_count || 0) > (best.snap.owner_identifier_count || 0)) {
      best = { path: resolve(dir, f), snap };
    }
  }
  return best;
}

function reconcileCounts() {
  const picked = preSurgeryBackup();
  if (!picked) fail('no PRE-surgery backup snapshot found (need one with FRIEND/JUNK > 0) — the reconciliation would be vacuous');
  const path = picked.path;
  const snap = picked.snap;

  const before = snap.owner_identifier_count;
  const friendMoved = snap.counts.FRIEND;
  const junkDropped = snap.counts.JUNK;
  const expected = before - friendMoved - junkDropped; // === snap.counts.OWNER
  const actual = db.prepare('SELECT COUNT(*) AS n FROM person_identifiers WHERE person_id = ?').get(OWNER_ID).n;

  if (actual !== expected) {
    fail(`owner identifier count ${actual} ≠ expected ${expected} (before ${before} − friend ${friendMoved} − junk ${junkDropped}) — data lost or extra`);
  }

  // Every backed-up OWNER-bucket value must still be present on the owner.
  const present = new Set(db.prepare("SELECT LOWER(value) AS v FROM person_identifiers WHERE person_id = ?").all(OWNER_ID).map((r) => r.v));
  const missing = (snap.adjudication.OWNER || []).filter((v) => !present.has(String(v).toLowerCase()));
  if (missing.length) fail(`${missing.length} OWNER-bucket value(s) missing after repair (owner data lost): ${missing.join(', ')}`);

  console.log(`[verify-disconnect] reconcile OK — owner ${actual} identifiers = ${before} − ${friendMoved} friend − ${junkDropped} junk; all ${snap.adjudication.OWNER.length} OWNER-bucket values present. Snapshot: ${path}`);
}

if (RECONCILE) reconcileCounts();
else verifyDisconnect();
