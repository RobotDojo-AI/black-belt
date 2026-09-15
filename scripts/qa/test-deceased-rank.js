#!/usr/bin/env node
/**
 * QA script for AC 2 / VC 2 (st_87a0d072).
 *
 * "A deceased person (last_seen >5 years ago) with zero outbound interactions
 *  and historical group-iMessage volume ranks no higher than Acquaintance."
 *
 * Strategy:
 *   1. Seed a test person with the prefix `qa-st_87a0d072-deceased-`.
 *   2. Set first_seen 8 years ago, last_seen 6 years ago.
 *   3. Insert 500 group-iMessage interactions (group_in only — no outbound).
 *   4. Run computeAllScores() — purely in-memory dryRun.
 *   5. Assert the test person's tier is 'acquaintance' (or absent — also OK
 *      if they were excluded entirely).
 *   6. Clean up.
 *
 * The structural property under test:
 *   - direct() penalises group-only interactions (iCnt=0, iGrp=500 → ratio=0)
 *     yields direct(0,500) = 0.3
 *   - recency(6yr=2190d, 365d half-life) ≈ 0.001
 *   - The product collapses to a near-zero pScore — far below any tier break.
 *
 * The bug being prevented: pre-restoration WB stub used
 *   `score = totalInteractions * exp(-ageDays/365)`
 * with no group penalty and a soft decay that would put a 500-interaction
 * 5-year-old person at score ≈ 500 * 0.007 = 3.5 — well above acquaintance
 * if the breaks are tight.
 *
 * Exit 0 on pass, 1 on fail.
 */

import db from '../../lib/db.js';
import { computeAllScores } from '../../lib/scoring.js';

const PREFIX = 'qa-st_87a0d072-deceased-';
const ID = `${PREFIX}${Date.now()}`;

function cleanup() {
  db.prepare(`DELETE FROM person_interactions WHERE person_id LIKE '${PREFIX}%'`).run();
  db.prepare(`DELETE FROM people WHERE id LIKE '${PREFIX}%'`).run();
}

cleanup();

// 8 years ago first_seen, 6 years ago last_seen
const FIRST = new Date(Date.now() - 365 * 8 * 86400 * 1000).toISOString();
const LAST  = new Date(Date.now() - 365 * 6 * 86400 * 1000).toISOString();

db.prepare(`
  INSERT INTO people
    (id, display_name, tier, confidence, source_count, primary_source,
     interaction_count, first_seen, last_seen, content_depth, consistency_score,
     relation_tag, relationship_origin, archived, needs_regen,
     created_at, updated_at)
  VALUES (?, 'Test Deceased Grandmother', 'acquaintance', 1.0, 1, 'imessage',
          500, ?, ?, NULL, 0, NULL, 'personal', 0, 0,
          datetime('now'), datetime('now'))
`).run(ID, FIRST, LAST);

// 500 group-iMessage receives, all dated 6 years ago, no outbound.
const ins = db.prepare(`
  INSERT INTO person_interactions (person_id, channel, direction, date, source_id)
  VALUES (?, 'imessage', 'group_in', ?, ?)
`);
db.transaction(() => {
  for (let i = 0; i < 500; i++) {
    const d = new Date(Date.now() - (365 * 6 + i) * 86400 * 1000).toISOString();
    ins.run(ID, d, `${PREFIX}src-${i}`);
  }
})();

const { results } = computeAllScores({ dryRun: true });
const r = results.find(x => x.id === ID);

let failed = false;
if (!r) {
  // Excluded entirely — that's also acceptable per the AC ("no higher than Acquaintance").
  console.log('ok — deceased test person excluded from scoring entirely');
} else if (r.tier === 'core' || r.tier === 'network') {
  console.error(`FAIL — deceased person ranked ${r.tier} (score=${r.score.toFixed(3)})`);
  failed = true;
} else {
  console.log(`ok — deceased person tier=${r.tier} score=${r.score.toFixed(3)} (acquaintance or below)`);
}

cleanup();
process.exit(failed ? 1 : 0);
