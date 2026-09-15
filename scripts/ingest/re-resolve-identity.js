#!/usr/bin/env node
/**
 * re-resolve-identity.js — full graph re-resolve over the PRESERVED raw source
 * through the fixed precision merge rule (df_cbd30a5a AC-13), then divert the
 * ambiguous cases to the owner triage queue.
 *
 * A thin wrapper over the PROVEN `scripts/ingest/index.js --reset --skip-context`
 * pipeline — NOT a from-scratch partial orchestrator. Verified facts that drive
 * the choice:
 *   - Every ingest phase except Phase 7 context is LLM-FREE; `--skip-context`
 *     makes the whole re-resolve genuinely structural-only, ~$0, reading only the
 *     already-synced LOCAL raw tables. No external re-pull, no LLM.
 *   - `--reset` already solves id churn (snapshot → hardDelete → rebuild;
 *     interactions restored by email+name; chunks re-attached by the deterministic
 *     join). The AC-12 `shouldMerge` rule — already wired into
 *     attachIdentifierOrMerge — makes the rebuild UN-weld rather than re-weld.
 *   - `index.js run()` does NOT call anchorDeclaredOwner, so bare `--reset` would
 *     strand owner_person_id on a deleted row; the wrapper re-anchors after.
 *
 * SAFE BY DEFAULT: `--dry-run` (the default) reports the current weld state +
 * pending triage and writes NOTHING. `--execute` (owner-gated) runs the live
 * structural re-resolve after the owner reviews the dry-run report.
 *
 * Execute sequence (each step deterministic, ~$0):
 *   1. Pre-run per-person JSONL snapshot + a filesystem DB-file copy (rollback).
 *   2. Clear stale pending `source='resolve'` triage (the run repopulates fresh).
 *   3. Spawn `index.js --reset --skip-context` (re-resolve through the AC-12 rule).
 *   4. anchorDeclaredOwner(db) — re-anchor the owner on the new rows.
 *   5. reapArchivedEndpoints — edge/chunk hygiene after the churn.
 *   6. reattachUnchangedCards — an unchanged identity keeps its card (no regen);
 *      only genuinely-changed identities are marked needs_regen=1 (bounded, OOS-1).
 *   7. Fire regen for the bounded needs_regen set only + verify/report.
 *
 * INTELLIGENCE_TIER: orchestration
 *   Coordinates deterministic structural passes + one spawned card regen (writes
 *   a card, never a DB row). The child pipeline is LLM-free (`--skip-context`).
 *
 * Usage:
 *   cd ~/robotdojo && node scripts/ingest/re-resolve-identity.js            # dry-run
 *   cd ~/robotdojo && node scripts/ingest/re-resolve-identity.js --execute  # owner-gated
 */

export const INTELLIGENCE_TIER = 'orchestration';

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { anchorDeclaredOwner } from '../../lib/identity.js';
import { detectOverMerges } from './detect-over-merges.js';
import { reapArchivedEndpoints } from './reap-archived-endpoints.js';

/** The untracked runtime dir the snapshot + DB backup land in (rollback state). */
function stateDir() {
  return process.env.ROBOTDOJO_RERESOLVE_DIR || resolve(homedir(), '.robotdojo');
}

/** Expand a leading `~` in a stored context_file_path to the home dir. */
function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? resolve(homedir(), p.slice(1).replace(/^\/+/, '')) : p;
}

/** Deterministic fingerprint of a person's identifier SET (order-independent). */
export function identifierFingerprint(values) {
  const sorted = [...new Set((values || []).map((v) => String(v).toLowerCase()))].sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

/**
 * Snapshot every ACTIVE person's identity + card provenance so (a) the run is
 * reversible and (b) an unchanged identity can reattach its existing card with no
 * regen. Pure reads.
 * @returns {Array<object>} one record per active person
 */
export function snapshotPeople(db) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT id, display_name, context_file_path,
             card_signal_score, card_derived_hash, card_generated_at, card_model_tier
      FROM people WHERE COALESCE(archived, 0) = 0
    `).all();
  } catch {
    return [];
  }
  const identStmt = db.prepare("SELECT value FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')");
  return rows.map((r) => {
    const values = identStmt.all(r.id).map((x) => String(x.value).toLowerCase());
    return {
      id: r.id,
      display_name: r.display_name,
      identifier_values: values.slice().sort(),
      fingerprint: identifierFingerprint(values),
      context_file_path: r.context_file_path || null,
      card_signal_score: r.card_signal_score ?? null,
      card_derived_hash: r.card_derived_hash ?? null,
      card_generated_at: r.card_generated_at ?? null,
      card_model_tier: r.card_model_tier ?? null,
    };
  });
}

/** Append the per-person snapshot as JSONL (one object per line). */
export function writePresnapshotJSONL(path, snapshot) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, snapshot.map((s) => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
  return path;
}

/**
 * Build the fingerprint → card-fields map used to reattach unchanged cards. Only
 * snapshot records that actually carried a card file are candidates.
 */
export function buildReattachMap(snapshot) {
  const map = new Map();
  for (const s of snapshot) {
    if (!s.context_file_path) continue;
    if (!map.has(s.fingerprint)) map.set(s.fingerprint, s);
  }
  return map;
}

/**
 * Bounded card reattach (df_cbd30a5a AC-13, satisfies OOS-1). For each active
 * person after the reset: if its identifier-set fingerprint matches a pre-run
 * fingerprint whose card FILE still exists, restore the card fields and set
 * needs_regen=0 (no LLM — the human is unchanged, only the id moved); otherwise
 * mark needs_regen=1 so only genuinely-changed identities regenerate. Deterministic
 * Tier-0.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Map<string,object>} reattachMap  fingerprint → card fields (buildReattachMap)
 * @param {{log?:Function}} [opts]
 * @returns {{ reattached:number, marked:number }}
 */
export function reattachUnchangedCards(db, reattachMap, { log = () => {} } = {}) {
  const report = { reattached: 0, marked: 0 };
  let people;
  try {
    people = db.prepare("SELECT id FROM people WHERE COALESCE(archived,0) = 0").all();
  } catch {
    return report;
  }
  const identStmt = db.prepare("SELECT value FROM person_identifiers WHERE person_id = ? AND type IN ('email','phone')");
  const restore = db.prepare(`
    UPDATE people
       SET context_file_path = @cfp, card_signal_score = @css, card_derived_hash = @cdh,
           card_generated_at = @cga, card_model_tier = @cmt, needs_regen = 0,
           updated_at = datetime('now')
     WHERE id = @id
  `);
  const markDirty = db.prepare("UPDATE people SET needs_regen = 1, updated_at = datetime('now') WHERE id = ?");
  const tx = db.transaction(() => {
    for (const p of people) {
      const fp = identifierFingerprint(identStmt.all(p.id).map((x) => x.value));
      const card = reattachMap.get(fp);
      if (card && card.context_file_path && existsSync(expandHome(card.context_file_path))) {
        restore.run({
          id: p.id, cfp: card.context_file_path, css: card.card_signal_score,
          cdh: card.card_derived_hash, cga: card.card_generated_at, cmt: card.card_model_tier,
        });
        report.reattached++;
      } else {
        markDirty.run(p.id);
        report.marked++;
      }
    }
  });
  tx();
  log(`  reattach: ${report.reattached} unchanged card(s) restored, ${report.marked} changed identity(ies) marked for regen`);
  return report;
}

/** Count pending triage rows (the owner-review backlog). */
function countPendingTriage(db) {
  try { return db.prepare("SELECT COUNT(*) n FROM merge_triage WHERE status='pending'").get().n; }
  catch { return 0; }
}

/**
 * Default chunk→entity relink driver: the proven linkChunkEntities pass, loaded
 * via a dynamic import so a dry-run (or a test that stubs it) never pulls in the
 * live-DB module. index.js --reset rebuilds people + chunks but does NOT relink
 * them (that lives in run-all.js), so this is the step that repopulates every
 * person's chunk_entities after the churn.
 */
async function defaultLinkChunk({ log = () => {} } = {}) {
  const { linkChunkEntities } = await import('./link-chunk-entities.js');
  const inserted = linkChunkEntities();
  log(`  linkChunkEntities: ${inserted} chunk-entity row(s) relinked`);
  return inserted;
}

/** Default child-pipeline driver: spawn the proven `--reset --skip-context` run. */
function defaultSpawnPipeline({ log = () => {} } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(
      process.execPath,
      [resolve(homedir(), 'robotdojo', 'scripts', 'ingest', 'index.js'), '--reset', '--skip-context'],
      { stdio: 'inherit', env: { ...process.env, ROBOTDOJO_ALLOW_PLAINTEXT: process.env.ROBOTDOJO_ALLOW_PLAINTEXT || '1' } },
    );
    child.on('exit', (code) => (code === 0 ? res({ code }) : rej(new Error(`index.js --reset --skip-context exited ${code}`))));
    child.on('error', rej);
  });
}

/**
 * The re-resolve driver. Dry-run reports + writes nothing. Execute runs the full
 * sequence. Dependencies are injectable for tests (spawnPipeline, runReap,
 * fireRegen).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @returns {Promise<object>} report
 */
export async function runReResolve(db, opts = {}) {
  const {
    execute = false,
    spawnPipeline = defaultSpawnPipeline,
    linkChunk = defaultLinkChunk,
    runReap = true,
    fireRegen = true,
    log = () => {},
  } = opts;

  const suspects = detectOverMerges(db);
  const report = {
    execute,
    weldSuspectsBefore: suspects.length,
    suspects: suspects.slice(0, 20).map((s) => ({ id: s.person_id, name: s.display_name, idents: s.identifier_count, dense: s.dense_component_count, score: Number(s.score.toFixed(1)) })),
    pendingTriageBefore: countPendingTriage(db),
  };

  if (!execute) {
    report.wroteNothing = true;
    return report;
  }

  // 1. Pre-run snapshot + DB file-copy backup (reversibility).
  const ts = Date.now();
  const snap = snapshotPeople(db);
  report.presnapshotPath = writePresnapshotJSONL(resolve(stateDir(), `re-resolve-presnapshot-${ts}.jsonl`), snap);
  try {
    const dbFile = db.name;
    if (dbFile && dbFile !== ':memory:' && existsSync(dbFile)) {
      const backup = resolve(stateDir(), `re-resolve-db-backup-${ts}.db`);
      mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
      copyFileSync(dbFile, backup);
      report.dbBackupPath = backup;
    }
  } catch (err) { log(`  DB file-copy backup skipped: ${err.message}`); }

  // 2. Clear stale pending resolve-sourced triage (the run repopulates fresh
  //    with new ids; owner-resolved rows are historical and kept).
  try { report.clearedPendingTriage = db.prepare("DELETE FROM merge_triage WHERE source='resolve' AND status='pending'").run().changes; }
  catch { report.clearedPendingTriage = 0; }

  // 3. Drive the proven pipeline through the AC-12 rule.
  await spawnPipeline({ log });

  // 4. Re-anchor the owner (index.js does not) + fold declared-identifier aliases
  //    into the owner (golden-record consolidation, df_cbd30a5a FIX 2).
  report.anchor = await anchorDeclaredOwner(db);

  // 5. Re-link the text chunks to the rebuilt people (df_cbd30a5a FIX 3).
  //    index.js --reset rebuilds people + chunks but never runs linkChunkEntities
  //    (that lives in run-all.js), so every person's chunk_entities is empty after
  //    the reset and entity-aware RAG has nothing to read. Run it AFTER
  //    anchor+consolidate so the folded owner is the join target, BEFORE the reaper.
  try { report.chunkLinks = await linkChunk({ log }); }
  catch (err) { log(`  linkChunkEntities skipped: ${err.message}`); }

  // 6. Reap archived-endpoint debris the churn produced.
  if (runReap) {
    try { report.reap = reapArchivedEndpoints(db, { execute: true, log }); }
    catch (err) { log(`  reap skipped: ${err.message}`); }
  }

  // 7. Bounded card reattach (unchanged identities keep their card, no regen).
  report.reattach = reattachUnchangedCards(db, buildReattachMap(snap), { log });

  // 8. Fire regen for the bounded needs_regen set only + verify.
  report.regenTargets = (() => {
    try { return db.prepare("SELECT COUNT(*) n FROM people WHERE COALESCE(archived,0)=0 AND needs_regen=1").get().n; }
    catch { return 0; }
  })();
  if (fireRegen && report.regenTargets > 0) {
    try {
      spawn(process.execPath, [resolve(homedir(), 'robotdojo', 'scripts', 'regen-entities.js')], { detached: true, stdio: 'ignore' }).unref();
      report.regenFired = true;
    } catch (err) { log(`  regen spawn skipped: ${err.message}`); }
  }
  report.weldSuspectsAfter = detectOverMerges(db).length;
  report.pendingTriageAfter = countPendingTriage(db);
  return report;
}

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const { default: db } = await import('../../lib/db.js');

  if (!execute) {
    const report = await runReResolve(db, { execute: false, log: (m) => console.log(m) });
    console.log(`[re-resolve] DRY-RUN — pre-run weld state (writes nothing):`);
    console.log(`[re-resolve] weld-suspects on the live graph (owner excluded): ${report.weldSuspectsBefore}`);
    for (const s of report.suspects) {
      console.log(`  ${s.id}  "${s.name}"  idents=${s.idents} dense=${s.dense} score=${s.score}`);
    }
    console.log(`[re-resolve] pending merge_triage rows: ${report.pendingTriageBefore}`);
    console.log('[re-resolve] to apply (OWNER-GATED): node scripts/ingest/re-resolve-identity.js --execute');
    process.exit(0);
  }

  console.log('[re-resolve] --execute: live structural re-resolve of the whole graph (owner-gated).');
  const report = await runReResolve(db, { execute: true, log: (m) => console.log(m) });
  console.log(`[re-resolve] complete.`);
  console.log(`  pre-run snapshot: ${report.presnapshotPath}`);
  if (report.dbBackupPath) console.log(`  DB backup: ${report.dbBackupPath}`);
  console.log(`  weld-suspects: ${report.weldSuspectsBefore} → ${report.weldSuspectsAfter}`);
  console.log(`  pending triage: ${report.pendingTriageBefore} → ${report.pendingTriageAfter}`);
  console.log(`  owner anchored: ${report.anchor?.owner_person_id || '(none)'}`);
  console.log(`  cards reattached: ${report.reattach?.reattached}, marked for regen: ${report.reattach?.marked}`);
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => { console.error('[re-resolve] fatal:', err.message); process.exit(1); });
}
