#!/usr/bin/env node
/**
 * rerun-owner-to-perfect.js — the owner "make my data perfect" rerun
 * (df_cbd30a5a AC-6), LIVE and OWNER-GATED.
 *
 * Option A (targeted re-derive) + the AC-8 reaper — NEVER Option B full
 * re-ingest (OOS 1; the verified 100x anti-pattern). Runs as a
 * dry-run → owner-approval → execute gate that mirrors the Phase-1 owner un-merge:
 * it is NOT an unattended write to the live DB.
 *
 * Runbook (owner-scoped, in order — the reaper MUST precede buildRelationships
 * because buildRelationships is upsert-only and never reaps the stale edges):
 *   1. reap owner debris (scoped)         scripts/ingest/reap-archived-endpoints.js
 *   2. targeted re-derive:
 *        linkChunkEntities()              rebuild owner chunk attribution
 *        bulkExtractFacts(db)             owner facts
 *        buildRelationships(db)           re-add correct edges (upsert-only)
 *        regen-entities.js --entity <o>   one card (the ONLY LLM step)
 *   3. split any OWNER-CONFIRMED weld     via --split-weld <id> (owner reviews first)
 *   4. refreshDerivedRelationCache + refreshEgoBlock
 *
 * INTELLIGENCE_TIER: orchestration
 *   Deterministic structural passes + one spawned card synthesis (regen-entities),
 *   which writes a card, never a DB row — the LLM-write boundary holds.
 *
 * SAFE BY DEFAULT: `--dry-run` (the default) prints the reaper debris counts +
 * any weld-suspects and writes NOTHING. `--execute` runs the reap + targeted
 * re-derive against the LIVE DB after the owner approves the dry-run.
 * `--split-weld <id>` (repeatable) folds an owner-confirmed weld split into the
 * execute pass; absent it, execute never auto-splits (weld-suspects are surfaced
 * for the owner to split via `detect-over-merges.js --split`).
 *
 * Usage:
 *   cd ~/robotdojo && node scripts/ingest/rerun-owner-to-perfect.js            # dry-run
 *   cd ~/robotdojo && node scripts/ingest/rerun-owner-to-perfect.js --execute  # owner-gated
 */

export const INTELLIGENCE_TIER = 'orchestration';

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { ownerPersonId } from '../../lib/identity.js';
import { countReapTargets, reapArchivedEndpoints } from './reap-archived-endpoints.js';
import { detectOverMerges, buildSplitPlanForPerson } from './detect-over-merges.js';
import { executeUnmergePair } from '../../lib/entity-unmerge.js';

/** Count the owner's relationship edges pointing to an archived person (the AC-6 live proof). */
function ownerEdgesToArchived(db, ownerId) {
  return db.prepare(`
    SELECT COUNT(*) n FROM entity_relationships er
    WHERE (er.entity_id_a = @o OR er.entity_id_b = @o)
      AND EXISTS (SELECT 1 FROM people p WHERE p.id IN (er.entity_id_a, er.entity_id_b) AND p.id <> @o AND p.archived = 1)
  `).get({ o: ownerId }).n;
}

function backupPathFor(ts = Date.now()) {
  return resolve(process.env.ROBOTDOJO_REAP_BACKUP_DIR || resolve(homedir(), '.robotdojo'), `owner-rerun-backup-${ts}.json`);
}

async function main() {
  const argv = process.argv.slice(2);
  const execute = argv.includes('--execute');
  const entIdx = argv.indexOf('--entity');
  const ownerOverride = entIdx >= 0 ? argv[entIdx + 1] : null;
  const splitWelds = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--split-weld' && argv[i + 1]) splitWelds.push(argv[i + 1]);

  const { default: db } = await import('../../lib/db.js');
  const ownerId = ownerOverride || ownerPersonId();
  if (!ownerId) {
    console.error('[rerun-owner] no declared owner_person_id — run the installer / set_owner_identity, or pass --entity <id>.');
    process.exit(1);
  }

  const debris = countReapTargets(db, { entityId: ownerId });
  const edgesToArchived = ownerEdgesToArchived(db, ownerId);
  const suspects = detectOverMerges(db, { ownerId });

  console.log(`[rerun-owner] owner=${ownerId}`);
  console.log(`[rerun-owner] reaper debris (owner-scoped): stale edges=${debris.edges}, owner edges→archived=${edgesToArchived}`);
  console.log(`[rerun-owner] weld-suspects on the graph (owner excluded): ${suspects.length}`);
  for (const s of suspects.slice(0, 10)) {
    console.log(`  ${s.person_id}  "${s.display_name}"  idents=${s.identifier_count} dense=${s.dense_component_count} score=${s.score.toFixed(1)}`);
  }

  if (!execute) {
    console.log('\n[rerun-owner] --dry-run (default): no writes performed. Review the debris + suspects above.');
    console.log('[rerun-owner] to apply (OWNER-GATED): node scripts/ingest/rerun-owner-to-perfect.js --execute');
    console.log('[rerun-owner] to split an owner-confirmed weld into the rerun: add --split-weld <id> (dry-run it first via detect-over-merges.js --split <id>).');
    process.exit(0);
  }

  // ── Execute (owner-approved) ──────────────────────────────────────────────
  const backupPath = backupPathFor();
  try {
    mkdirSync(resolve(backupPath, '..'), { recursive: true, mode: 0o700 });
    const ownerEdges = db.prepare('SELECT * FROM entity_relationships WHERE entity_id_a = ? OR entity_id_b = ?').all(ownerId, ownerId);
    writeFileSync(backupPath, JSON.stringify({ captured_at: new Date().toISOString(), ownerId, debris, edgesToArchived, owner_edges: ownerEdges }, null, 2) + '\n', { mode: 0o600 });
    console.log(`[rerun-owner] pre-mutation backup written: ${backupPath}`);
  } catch (err) {
    console.error(`[rerun-owner] FATAL: could not write backup (${err.message}) — aborting before any mutation`);
    process.exit(1);
  }

  // 1. Reap owner debris (scoped) — MUST precede buildRelationships (upsert-only).
  const reap = reapArchivedEndpoints(db, { execute: true, entityId: ownerId, log: (m) => console.log(m) });
  console.log(`[rerun-owner] reaped owner edges: ${reap.edgesDeleted} (residualZero=${reap.residualZero})`);

  // 2. Targeted re-derive (the free structural half of phaseEntities).
  try {
    const { linkChunkEntities } = await import('./link-chunk-entities.js');
    linkChunkEntities();
    console.log('[rerun-owner] linkChunkEntities complete');
  } catch (err) { console.warn(`[rerun-owner] linkChunkEntities skipped: ${err.message}`); }
  try {
    const { bulkExtractFacts } = await import('../../lib/entity-facts.js');
    bulkExtractFacts(db, (m) => console.log(m));
    console.log('[rerun-owner] bulkExtractFacts complete');
  } catch (err) { console.warn(`[rerun-owner] bulkExtractFacts skipped: ${err.message}`); }
  try {
    const { buildRelationships } = await import('../../lib/relationship-builder.js');
    await buildRelationships(db);
    console.log('[rerun-owner] buildRelationships complete');
  } catch (err) { console.warn(`[rerun-owner] buildRelationships skipped: ${err.message}`); }
  try {
    spawn(process.execPath, [resolve(homedir(), 'robotdojo', 'scripts', 'regen-entities.js'), '--entity', ownerId], { detached: true, stdio: 'ignore' }).unref();
    console.log('[rerun-owner] regen-entities spawned for the owner card');
  } catch (err) { console.warn(`[rerun-owner] regen spawn skipped: ${err.message}`); }

  // 3. Split OWNER-CONFIRMED welds only (never auto-split — Tantei RISK 8).
  for (const weldId of splitWelds) {
    const plan = buildSplitPlanForPerson(db, weldId);
    if (!plan) { console.warn(`[rerun-owner] --split-weld ${weldId}: not a weld-suspect, skipped`); continue; }
    const r = await executeUnmergePair(db, { survivorId: weldId, mintExtracted: true, classify: plan.classify, extractedName: plan.extractedName, execute: true, source: 'over-merge-detector', log: (m) => console.log(m) });
    console.log(`[rerun-owner] split ${weldId}: extracted=${r.extractedId} moved=${r.moved_to_extracted}`);
  }

  // 4. Re-derive the owner-relative graph (ego / "your ___").
  try {
    const { refreshDerivedRelationCache } = await import('../../lib/people-write.js');
    refreshDerivedRelationCache(db, { ownerId });
  } catch (err) { console.warn(`[rerun-owner] relation cache refresh skipped: ${err.message}`); }
  try {
    const { refreshEgoBlock } = await import('../../lib/ego-render.js');
    refreshEgoBlock(db);
  } catch (err) { console.warn(`[rerun-owner] ego refresh skipped: ${err.message}`); }

  const after = ownerEdgesToArchived(db, ownerId);
  console.log(`[rerun-owner] complete. owner edges→archived: ${edgesToArchived} → ${after} (target 0).`);
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => { console.error('[rerun-owner] fatal:', err.message); process.exit(1); });
}
