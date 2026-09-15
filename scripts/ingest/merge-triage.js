#!/usr/bin/env node
/**
 * merge-triage.js — the owner review surface for the AC-13 merge triage queue
 * (df_cbd30a5a). The precision merge rule (AC-12) diverts every case it cannot
 * decide confidently to `merge_triage` instead of guessing; this CLI reviews and
 * resolves those rows OFF the critical path. The resolver itself NEVER blocks on
 * triage — its default is keep-separate.
 *
 * INTELLIGENCE_TIER: orchestration
 *   Deterministic. `--merge` fuses via the product merge (lib/people-merge.js
 *   mergePeople with viaTriage — the owner just decided, so it bypasses the AC-12
 *   coherence re-block); `--separate` writes a durable must-not-merge row; neither
 *   calls an LLM (no getAnthropicClient / MODELS).
 *
 * Usage:
 *   cd ~/robotdojo && node scripts/ingest/merge-triage.js --list
 *   cd ~/robotdojo && node scripts/ingest/merge-triage.js --resolve <id> --merge
 *   cd ~/robotdojo && node scripts/ingest/merge-triage.js --resolve <id> --separate
 *   cd ~/robotdojo && node scripts/ingest/merge-triage.js --resolve <id> --dismiss
 */

export const INTELLIGENCE_TIER = 'orchestration';

import { resolve } from 'node:path';
import { mergePeople, writeMustNotMerge, resolveSurvivor } from '../../lib/people-merge.js';

/** Pending triage rows, newest first (the CLI --list hot path). */
export function listPendingTriage(db, { limit = 200 } = {}) {
  try {
    return db.prepare(`
      SELECT id, person_id_a, person_id_b, reason, bridge_type, bridge_value,
             name_a, name_b, detail, source, created_at
      FROM merge_triage
      WHERE status = 'pending'
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
  } catch {
    return [];
  }
}

/** Mark a triage row resolved (status + resolver stamp). */
function stampResolved(db, id, status, resolvedBy = 'owner') {
  return db.prepare(`
    UPDATE merge_triage
       SET status = ?, resolved_by = ?, resolved_at = datetime('now')
     WHERE id = ? AND status = 'pending'
  `).run(String(status), String(resolvedBy), id).changes > 0;
}

/**
 * Resolve one pending triage row three ways. BOTH sides are first mapped through
 * resolveSurvivor (lib/people-merge.js) so a pair naming an id that an earlier
 * merge already archived acts on that id's CURRENT active survivor — never
 * dismissed as stale. This is the fix for the 3+-way-split stale-dismissal bug:
 * resolving the pairs of an over-split person one at a time now converges to ONE
 * record with zero fragments left behind.
 *
 *   'merge'    → survivors sA,sB.
 *                  - both gone (no live survivor) → status='dismissed' (genuinely
 *                    hard-deleted; nothing to merge).
 *                  - sA === sB (already collapsed to one record) → status='merged'
 *                    (the merge already happened — NEVER dismissed), alreadyMerged.
 *                  - sA !== sB → owner-confirmed fuse via mergePeople({viaTriage});
 *                    status='merged'.
 *   'separate' → writeMustNotMerge on the SURVIVORS (durable veto); status='kept-separate'.
 *   'dismiss'  → status='dismissed' (explicit owner ignore; no structural change).
 *
 * @returns {{ ok:boolean, action?:string, status?:string, reason?:string,
 *             merge?:object, alreadyMerged?:boolean, winner?:string, loser?:string }}
 */
export function resolveTriageRow(db, id, action, { resolvedBy = 'owner' } = {}) {
  let row;
  try { row = db.prepare('SELECT * FROM merge_triage WHERE id = ?').get(id); }
  catch { return { ok: false, reason: 'merge_triage table absent' }; }
  if (!row) return { ok: false, reason: `no triage row #${id}` };
  if (row.status !== 'pending') return { ok: false, reason: `row #${id} already ${row.status}` };
  const a = row.person_id_a;
  const b = row.person_id_b;

  if (action === 'merge') {
    // Map each side to its current active survivor before acting — an earlier
    // pair may have archived a or b and moved the survivor to a third id.
    const sA = resolveSurvivor(db, a);
    const sB = resolveSurvivor(db, b);
    if (!sA || !sB) {
      // One or both sides are genuinely gone (hard-deleted / plain-archived with
      // no merge forwarding). There is nothing live to merge → dismiss.
      stampResolved(db, id, 'dismissed', resolvedBy);
      return { ok: true, action, status: 'dismissed', reason: 'no live survivor on one or both sides' };
    }
    if (sA === sB) {
      // Both sides already collapsed to the SAME active record — the merge this
      // row asks for already happened. Mark merged, never dismissed.
      stampResolved(db, id, 'merged', resolvedBy);
      return { ok: true, action, status: 'merged', alreadyMerged: true, winner: sA };
    }
    const res = mergePeople(db, sA, sB, { viaTriage: true, evidence: `triage #${id}` });
    if (!res.ok) return { ok: false, action, reason: res.reason, merge: res };
    stampResolved(db, id, 'merged', resolvedBy);
    return { ok: true, action, status: 'merged', merge: res, winner: sA, loser: sB };
  }
  if (action === 'separate') {
    const sA = resolveSurvivor(db, a);
    const sB = resolveSurvivor(db, b);
    if (sA && sB && sA !== sB) {
      // Durable veto on the CURRENT survivors so a later re-resolve can't re-weld
      // the two live records.
      writeMustNotMerge(db, sA, sB, { reason: 'triage-separate', source: 'merge-triage' });
      stampResolved(db, id, 'kept-separate', resolvedBy);
      return { ok: true, action, status: 'kept-separate', a: sA, b: sB };
    }
    if (sA && sB && sA === sB) {
      // The two records already merged into one before this row was reviewed —
      // there is nothing to keep separate. Record the resolution honestly (don't
      // leave it pending forever); un-splitting is entity-unmerge's job, not this CLI's.
      stampResolved(db, id, 'kept-separate', resolvedBy);
      return {
        ok: true, action, status: 'kept-separate', alreadyMerged: true,
        reason: 'already one record — separate is a no-op; use entity-unmerge to split',
      };
    }
    // One or both sides gone — no live pair to constrain; resolve so it doesn't linger.
    stampResolved(db, id, 'kept-separate', resolvedBy);
    return { ok: true, action, status: 'kept-separate', reason: 'no live survivor on one or both sides' };
  }
  if (action === 'dismiss') {
    stampResolved(db, id, 'dismissed', resolvedBy);
    return { ok: true, action, status: 'dismissed' };
  }
  return { ok: false, reason: `unknown action "${action}" (use --merge | --separate | --dismiss)` };
}

/** Current active-survivor id + display name for a (possibly-archived) person id. */
function survivorDisplay(db, personId) {
  const sid = resolveSurvivor(db, personId);
  if (!sid) return { id: null, name: '(no live survivor)' };
  let name = '';
  try { name = db.prepare('SELECT display_name FROM people WHERE id = ?').get(sid)?.display_name || ''; }
  catch { name = ''; }
  return { id: sid, name };
}

async function main() {
  const argv = process.argv.slice(2);
  const { default: db } = await import('../../lib/db.js');

  if (argv.includes('--list')) {
    const rows = listPendingTriage(db);
    console.log(`[merge-triage] ${rows.length} pending row(s):`);
    for (const r of rows) {
      // Show the CURRENT survivor of each side: an earlier merge may have archived
      // the id the row was written against and moved the person to a new record.
      const sA = survivorDisplay(db, r.person_id_a);
      const sB = survivorDisplay(db, r.person_id_b);
      const side = (orig, name, s) =>
        s.id && s.id !== String(orig) ? `${name || orig} → ${s.name || s.id}` : (name || orig);
      console.log(`  #${r.id}  ${r.reason}  ${side(r.person_id_a, r.name_a, sA)} <> ${side(r.person_id_b, r.name_b, sB)}` +
        (r.bridge_value ? `  bridge=${r.bridge_type}:${r.bridge_value}` : ''));
    }
    process.exit(0);
  }

  const rIdx = argv.indexOf('--resolve');
  if (rIdx >= 0) {
    const id = Number(argv[rIdx + 1]);
    const action = argv.includes('--merge') ? 'merge'
      : argv.includes('--separate') ? 'separate'
      : argv.includes('--dismiss') ? 'dismiss' : null;
    if (!Number.isFinite(id) || !action) {
      console.error('[merge-triage] usage: --resolve <id> --merge|--separate|--dismiss');
      process.exit(1);
    }
    const res = resolveTriageRow(db, id, action);
    if (!res.ok) { console.error(`[merge-triage] failed: ${res.reason}`); process.exit(1); }
    const note = res.alreadyMerged ? ' (already collapsed to one record)'
      : res.reason ? ` (${res.reason})` : '';
    console.log(`[merge-triage] row #${id} → ${res.status}${note}`);
    process.exit(0);
  }

  console.error('[merge-triage] usage: --list | --resolve <id> --merge|--separate|--dismiss');
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => { console.error('[merge-triage] fatal:', err.message); process.exit(1); });
}
