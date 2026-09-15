/**
 * Phase 4 — Classification (tightened: never NULL).
 *
 * Strategy:
 *   1. Run existing deterministic classifier (high-confidence via tier 1-4)
 *   2. For remaining NULLs, apply domain-based fallback (never NULL)
 *      - work domain → business/prospect (0.4)
 *      - free-mail + iMessage → personal/acquaintance (0.4)
 *      - default → business/prospect (0.3) — most unclassified are email senders
 */
import db from '../../lib/db.js';
import { getBBModule } from '../../lib/module-loader.js';

function wbBackfillClassifications() { return { people: 0, places: 0 }; }

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
  'msn.com', 'live.com', 'yahoo.co.uk', 'comcast.net', 'verizon.net',
]);

export async function tightenedClassify(log) {
  const bb = getBBModule();
  const backfillClassifications = bb?.backfillClassifications ?? wbBackfillClassifications;
  log('\n=== Phase 4: Classification (tightened — never NULL) ===');

  // Step 1: run existing backfill (deterministic + Haiku LLM up to budget)
  // LLM cap set low — the fallback handles the rest without $
  const result = await backfillClassifications({ verbose: false, llmCap: 300 });
  log(`  Deterministic + LLM: ${JSON.stringify(result.people)}`);

  // Step 2: fallback for everyone still NULL (never leave NULL)
  const unclassified = db.prepare(`
    SELECT p.id, p.display_name,
           (SELECT GROUP_CONCAT(value, ',') FROM person_identifiers WHERE person_id = p.id AND type='email') AS emails,
           (SELECT COUNT(*) FROM person_interactions WHERE person_id=p.id AND channel='imessage') AS imsg,
           (SELECT COUNT(*) FROM person_interactions WHERE person_id=p.id AND channel='email') AS email
    FROM people p
    WHERE p.archived = 0 AND p.class IS NULL
  `).all();

  log(`  ${unclassified.length} people still unclassified — applying fallback`);

  const update = db.prepare(`
    UPDATE people SET class = ?, subcategory = ?, class_confidence = ?,
                      class_sources = ?, classified_at = datetime('now')
    WHERE id = ?
  `);

  let fallBiz = 0, fallPers = 0, excluded = 0;
  const arch = db.prepare('UPDATE people SET archived = 1 WHERE id = ?');

  db.transaction(() => {
    for (const p of unclassified) {
      const emails = (p.emails || '').split(',').filter(Boolean);
      const domains = emails
        .map(e => (e.split('@')[1] || '').toLowerCase())
        .filter(d => d && !FREEMAIL_DOMAINS.has(d));
      const hasWork = domains.length > 0;
      const hasFreemail = emails.some(e => FREEMAIL_DOMAINS.has((e.split('@')[1] || '').toLowerCase()));

      // EXCLUDE rule: no name (just raw email), no identifiers, no interactions
      const nameLooksLikeEmail = /.+@.+\..+/.test(p.display_name);
      const totalSig = (p.imsg || 0) + (p.email || 0);
      if (nameLooksLikeEmail && totalSig < 2 && !hasWork) {
        arch.run(p.id);
        excluded++;
        continue;
      }

      // Fallback classification
      if (hasWork) {
        update.run('business', 'prospect', 0.4, JSON.stringify(['fallback_work_domain']), p.id);
        fallBiz++;
      } else if (p.imsg > 0 || hasFreemail) {
        update.run('personal', 'acquaintance', 0.4, JSON.stringify(['fallback_freemail_or_imsg']), p.id);
        fallPers++;
      } else {
        // No strong signal either way — default to business/prospect (most noise is email senders)
        update.run('business', 'prospect', 0.3, JSON.stringify(['fallback_default']), p.id);
        fallBiz++;
      }
    }
  })();

  log(`  Fallback: ${fallBiz} → business/prospect, ${fallPers} → personal/acquaintance, ${excluded} EXCLUDED (archived as noise)`);

  // Final check
  const finalNull = db.prepare(
    `SELECT COUNT(*) AS n FROM people WHERE archived = 0 AND class IS NULL`
  ).get()?.n || 0;
  log(`  Remaining NULL after fallback: ${finalNull}`);

  // Final class distribution
  const dist = db.prepare(`
    SELECT class, subcategory, COUNT(*) as n
    FROM people WHERE archived = 0
    GROUP BY class, subcategory
    ORDER BY n DESC
  `).all();
  return { dist, finalNull, fallBiz, fallPers, excluded };
}
