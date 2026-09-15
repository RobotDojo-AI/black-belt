/**
 * Phase 5 — Score: recompute interaction counts, score, assign N1/N2.
 *
 * Order:
 * 1. Recompute interaction_count, first/last_seen, imessage counts on people
 * 2. computeAllScores (dual-track personal/business, tier assignment)
 * 3. N2 assignment using findBreaks on score distributions
 * 4. Companies N2 from aggregated business scores
 * 5. Places N2 from place_type
 * 6. computePlaceScores
 *
 * WHY N2 is a separate pass after scoring: N2 depends on the full distribution
 * of scores (findBreaks needs all scores to compute breaks). We can't assign N2
 * until every person has a score. Natural breaks prevent hardcoded thresholds
 * from rotting as the graph grows.
 *
 * WHY exported pure functions (assignPersonalN2, assignProfessionalN2, assignPlaceN2):
 * They take (person, breaks) and return a string — no DB side effects.
 * This enables unit testing in pipeline-n2.test.js without a real DB.
 */

import { findBreaks, FAMILY_TAGS } from '../../lib/scoring.js';

// st_93fddaf0 Phase 3: family-tag override invariant. relation_tag values
// matching these mean the person IS family — Personal/Family bucket, no email
// domain or scoring decision can override. Mirrors scoring.js FAMILY_TAGS.
// Family override is order-sensitive (must run BEFORE the email-domain N1
// rules) and idempotent (runs every rebuild, same outcome).
// Exported so the family override and dormancy logic share one source.
const FAMILY_TAG_LIST = [...FAMILY_TAGS];
const FAMILY_TAGS_PLACEHOLDERS = FAMILY_TAG_LIST.map(() => '?').join(',');

const SQLITE_BUSY_RETRY_MS = [250, 500, 1000, 2000, 5000, 10000, 20000, 30000];

function isSqliteBusy(err) {
  return err?.code === 'SQLITE_BUSY' || /database is locked|database locked/i.test(String(err?.message || ''));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithSqliteBusyRetry(label, fn, log) {
  for (let attempt = 0; attempt <= SQLITE_BUSY_RETRY_MS.length; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusy(err) || attempt >= SQLITE_BUSY_RETRY_MS.length) throw err;
      const waitMs = SQLITE_BUSY_RETRY_MS[attempt];
      log(`  SQLITE_BUSY during ${label}; retry ${attempt + 1}/${SQLITE_BUSY_RETRY_MS.length} in ${waitMs}ms`);
      await delay(waitMs);
    }
  }
}

// WHY these are defined as pure exported functions:
// The N2 logic is algorithmically interesting (Partner threshold, Family override)
// and must be testable in isolation. DB writes happen in phaseScore, not here.

/**
 * Assign N2 tier for a Personal person.
 *
 * Family is NOT assigned here — it requires explicit family detection signals,
 * not score proximity. Score proximity does not make someone family.
 *
 * st_2cd1af73 Phase 3 VERIFY: the dedicated Family-assignment pass IS built and
 * live — it runs in Phase 4 (scripts/ingest/04-classify.js `detectFamily`),
 * which already folds EVERY available deterministic family signal into one
 * `tagged` map and writes n2='Family' + relation_tag together in a single
 * transaction:
 *   Pass 1  — config/family.json explicit names
 *   Pass 4  — Apple Contacts cross-reference (+ canonical rename)
 *   Pass 4b — Apple Contacts nickname labels (lib/family-nicknames.js)
 *   Pass 5a — content statements + ZABCDRELATEDNAME (lib/family-from-content.js)
 *   Pass 2  — config surname patterns
 *   Pass 3  — birthday calendar surnames
 * Every path sets n2='Family' AND relation_tag, and assigns n2 ONLY — it never
 * merges person rows, so identity resolution stays exact (the owner's hard
 * constraint). Live-DB verification at build time: 31 family-tagged people, all
 * 31 carry n2='Family'; zero rows have a family relation_tag without n2='Family'
 * and zero have n2='Family' without a tag — the path is fully wired, not a gap.
 * The standalone lib/family-inference.js `inferFamilyRelationships` is dead in
 * the pipeline (no ingest caller; referenced only in comments) — detectFamily
 * supersedes it. This N2 pass therefore PRESERVES Family (every Personal/
 * Professional query below carries `n2 IS NOT 'Family'`) and never reassigns it
 * by score.
 *
 * @param {{ personal_score: number }} person
 * @param {{ core: number, network: number }} breaks
 * @returns {'Core'|'Network'|'Acquaintance'}
 */
export function assignPersonalN2(person, breaks) {
  const s = person.personal_score || 0;
  if (s >= breaks.core) return 'Core';
  if (s >= breaks.network) return 'Network';
  return 'Acquaintance';
}

/**
 * Assign N2 tier for a Professional person.
 * Uses all three breaks so all four tiers are populated:
 *   Partners     — score >= core break    (top tier, analog of Family for Personal)
 *   Core         — score >= network break
 *   Network      — score >= extended break
 *   Acquaintance — below extended break
 * @param {{ business_score: number }} person
 * @param {{ core: number, network: number, extended: number }} breaks
 * @returns {'Partners'|'Core'|'Network'|'Acquaintance'}
 */
export function assignProfessionalN2(person, breaks) {
  const s = person.business_score || 0;
  if (s >= breaks.core)     return 'Partners';
  if (s >= breaks.network)  return 'Core';
  if (s >= breaks.extended) return 'Network';
  return 'Acquaintance';
}

/**
 * Preserve the dormancy cap during primary N2 assignment.
 *
 * The safety cap later in phaseScore still exists, but without this helper a
 * rerun promotes dormant rows by score and demotes them again every time.
 *
 * @param {string} n2
 * @param {string|null} relationPhase
 * @param {string|null} relationTag
 * @returns {string}
 */
export function capDormantN2(n2, relationPhase, relationTag = null) {
  if (relationPhase === 'dormant' && !relationTag && ['Partners', 'Customers', 'Core'].includes(n2)) {
    return 'Network';
  }
  return n2;
}

/**
 * Assign N2 for a place.
 * City/country/region → 'City'. Everything else → 'Place'.
 * @param {{ place_type: string|null }} place
 * @returns {'City'|'Place'}
 */
export function assignPlaceN2(place) {
  const t = (place.place_type || '').toLowerCase();
  if (t === 'city' || t === 'country' || t === 'region') return 'City';
  return 'Place';
}

/**
 * Phase 5 main: score all entities and assign N1/N2.
 * @param {Function} log
 * @returns {{ people: number, companies: number, places: number }}
 */
export async function phaseScore(log) {
  log('\n=== Phase 5: Score + N2 ===');

  const { default: db } = await import('../../lib/db.js');
  const { computeAllScores, computePlaceScores } = await import('../../lib/scoring.js');

  // 1. Recompute interaction counts from person_interactions table.
  //    WHY: after wipe+rebuild, counts on the people row are stale.
  // st_f1a40461: set-based recompute. The prior form ran 5 correlated subqueries
  // per archived=0 person (~20K people incl. those with zero interactions) and
  // stalled for minutes. A single GROUP BY pass computes every aggregate in ~135ms;
  // a bulk UPDATE...FROM join applies them.
  log('  Recomputing interaction counts...');
  db.exec(`
    DROP TABLE IF EXISTS _ic_agg;
    DROP TABLE IF EXISTS _ic_target;
    CREATE TEMP TABLE _ic_agg AS
      SELECT person_id,
        -- st_f1a40461: interaction_count = DISTINCT DAYS with any interaction, not
        -- raw event count. Fixes the channel asymmetry (email counted per-message
        -- inbound / per-thread outbound; iMessage already per-day) so the number is
        -- a consistent "days you were in contact" cadence signal across all channels.
        COUNT(DISTINCT substr(date,1,10)) AS ic,
        SUM(CASE WHEN channel='imessage' AND direction IN ('inbound','outbound') THEN 1 ELSE 0 END) AS im,
        SUM(CASE WHEN channel='imessage' AND direction IN ('group_in','group_out') THEN 1 ELSE 0 END) AS img,
        MIN(date) AS fs, MAX(date) AS ls
      FROM person_interactions
      GROUP BY person_id;
    CREATE TEMP TABLE _ic_target AS
      SELECT p.id,
        COALESCE(a.ic, 0) AS ic,
        COALESCE(a.im, 0) AS im,
        COALESCE(a.img, 0) AS img,
        a.fs AS fs,
        a.ls AS ls
      FROM people p
      LEFT JOIN _ic_agg a ON a.person_id = p.id
      WHERE p.archived = 0;
    UPDATE people SET
      interaction_count   = (SELECT ic FROM _ic_target WHERE id = people.id),
      imessage_msg_count  = (SELECT im FROM _ic_target WHERE id = people.id),
      imessage_group_count= (SELECT img FROM _ic_target WHERE id = people.id),
      first_seen          = (SELECT fs FROM _ic_target WHERE id = people.id),
      last_seen           = (SELECT ls FROM _ic_target WHERE id = people.id)
    WHERE archived = 0
      AND EXISTS (
        SELECT 1 FROM _ic_target t
        WHERE t.id = people.id
          AND (
            COALESCE(people.interaction_count, 0) IS NOT t.ic
            OR COALESCE(people.imessage_msg_count, 0) IS NOT t.im
            OR COALESCE(people.imessage_group_count, 0) IS NOT t.img
            OR people.first_seen IS NOT t.fs
            OR people.last_seen IS NOT t.ls
          )
      );
    DROP TABLE _ic_agg;
    DROP TABLE _ic_target;
  `);

  // 2. Score all people
  log('  Computing scores...');
  const scoreResult = computeAllScores({ verbose: false });
  const { tierCounts } = scoreResult;
  log('  Tier counts:', JSON.stringify(tierCounts));

  // 4. N1 assignment — origin-based classification.
  //
  // Rules (in precedence order):
  //   1. Has iMessage interactions → Personal  (iMessage is always personal)
  //   2. Has LinkedIn identifier → Professional (LinkedIn is a professional network)
  //   3. Has a work-domain email identifier → Professional
  //   4. Has only freemail/personal-domain email → Personal
  //   5. Default → Professional
  //
  // Work domain = not in FREEMAIL_DOMAINS and not an owner personal domain.
  // This replaces the old class-based heuristic (class='business'/'personal'/'mixed')
  // which used email domain patterns and produced wrong results.
  log('  Assigning N1 (origin-based)...');
  const { FREEMAIL_DOMAINS } = await import('../../lib/person-resolver.js');
  const { ownerEmails: ownerEmailsFn } = await import('../../lib/identity.js');

  // Classification rules (precedence order):
  //   1. Has any non-freemail email identifier → Professional
  //      (work domain beats iMessage — colleagues with both work email AND iMessage → Professional)
  //   2. Has iMessage interactions, no work email → Personal
  //   3. Has freemail-only email, no iMessage → Personal
  //   4. No signal → NULL N1. The person still exists/searches; spend routing treats it as low signal.
  //
  // LinkedIn is NOT used for classification — many personal friends are LinkedIn connections.
  // Work domain = any non-freemail domain. Period.
  const allPeople = db.prepare("SELECT id, n1 FROM people WHERE archived = 0").all();

  const iMessagePeople = new Set(
    db.prepare("SELECT DISTINCT person_id FROM person_interactions WHERE channel='imessage'").all().map(r => r.person_id)
  );
  // Per-person: does any email domain fall outside FREEMAIL_DOMAINS?
  const workDomainPeople  = new Set();
  const freemailOnlyPeople = new Set();
  const domainGroups = new Map(); // person_id → {hasWork, hasPersonal}
  for (const r of db.prepare("SELECT person_id, value FROM person_identifiers WHERE type='email'").all()) {
    const domain = r.value.split('@')[1]?.toLowerCase();
    if (!domain) continue;
    if (!domainGroups.has(r.person_id)) domainGroups.set(r.person_id, { hasWork: false, hasPersonal: false });
    if (FREEMAIL_DOMAINS.has(domain)) {
      domainGroups.get(r.person_id).hasPersonal = true;
    } else {
      domainGroups.get(r.person_id).hasWork = true;
    }
  }
  for (const [pid, g] of domainGroups) {
    if (g.hasWork)          workDomainPeople.add(pid);
    else if (g.hasPersonal) freemailOnlyPeople.add(pid);
  }

  // st_93fddaf0 Phase 3: build the family-tag person set FIRST so the
  // domain-rules loop below can skip them. Family is non-negotiable Personal
  // regardless of email domain or interaction signal.
  // WHY a Set, not a query inside the loop: 5K-person walks need O(1) lookup.
  const familyTaggedRows = db.prepare(
    `SELECT id FROM people WHERE archived=0 AND relation_tag IN (${FAMILY_TAGS_PLACEHOLDERS})`
  ).all(...FAMILY_TAG_LIST);
  const familyPeople = new Set(familyTaggedRows.map(r => r.id));

  // Build the contacts-source-only fallback set: contacts-sourced people with
  // no email/iMessage/work-domain signal at all. We want them visible as
  // Personal/Acquaintance instead of invisible (n1=NULL).
  // WHY contacts are personally known: a user only saves contacts they care
  // about. Even with zero digital interaction, they belong in the network.
  const contactsOnlyPeople = new Set(
    db.prepare(
      "SELECT id FROM people WHERE archived=0 AND primary_source='contacts' AND interaction_count=0"
    ).all().map(r => r.id)
  );

  const setN1 = db.prepare("UPDATE people SET n1=? WHERE id=? AND n1 IS NOT ?");
  let n1Changed = 0;
  db.transaction(() => {
    for (const p of allPeople) {
      let n1;
      // FAMILY OVERRIDE — runs first, beats every other rule.
      // WHY first: a sibling with a work email is not a Professional contact
      // because their employer uses a work-domain MX. The fact that they're
      // family is a stronger truth than their email domain.
      if (familyPeople.has(p.id)) {
        n1 = 'Personal';
      } else if (workDomainPeople.has(p.id)) {
        n1 = 'Professional';                      // non-freemail email → Professional
      } else if (iMessagePeople.has(p.id)) {
        n1 = 'Personal';                          // iMessage, no work email → Personal
      } else if (freemailOnlyPeople.has(p.id)) {
        n1 = 'Personal';                          // Gmail/freemail only → Personal
      } else if (contactsOnlyPeople.has(p.id)) {
        // CONTACTS-ONLY FALLBACK — st_93fddaf0 Phase 3.
        // Contacts-sourced rows with no email/phone/iMessage signal still
        // belong somewhere. The user saved them, so they're at least Personal.
        n1 = 'Personal';
      } else {
        n1 = null;                                // no N1 bucket yet; not an identity filter
      }
      if (p.n1 !== n1) n1Changed += setN1.run(n1, p.id, n1).changes;
    }
  })();
  log(`  N1 assigned to ${allPeople.length} people (${n1Changed} changed; family override: ${familyPeople.size}, contacts-only: ${contactsOnlyPeople.size})`);

  // 5. N2 assignment for Personal people
  // n2 IS NOT 'Family' — preserve tags set by Phase 4 family detection.
  // Family members may have any n1; protecting both Personal and Professional loops.
  //
  // st_93fddaf0 Phase 3: use `score` (the N1-deterministic selector) not
  // `personal_score`. Rationale (Kaustubh Joshi pattern, 54 people affected):
  // some people have n1='Personal' but a stored relationship_origin='business'
  // because their first interaction was a calendar event. The scoring formula
  // selects bScore for them — written into `score`. But the prior N2 logic
  // used `personal_score=0` and routed them to Acquaintance, divorcing
  // sidebar position from their actual score. Reading from `score` aligns
  // both. The assignPersonalN2 helper is updated below to accept `score`.
  const personalPeople = db.prepare(`
    SELECT id, score AS personal_score, relation_phase, relation_tag, n2
    FROM people WHERE archived=0 AND n1='Personal' AND score > 0 AND n2 IS NOT 'Family'
  `).all();
  const personalScores = personalPeople.map(p => p.personal_score).sort((a, b) => b - a);
  const personalBreaks = findBreaks(personalScores);
  log(`  Personal breaks: core=${personalBreaks.core?.toFixed(2)}, network=${personalBreaks.network?.toFixed(2)}, extended=${personalBreaks.extended?.toFixed(2)}`);

  const setN2 = db.prepare("UPDATE people SET n2=? WHERE id=? AND n2 IS NOT ?");
  let personalN2Changed = 0;
  db.transaction(() => {
    for (const p of personalPeople) {
      const n2 = capDormantN2(assignPersonalN2(p, personalBreaks), p.relation_phase, p.relation_tag);
      if (p.n2 !== n2) personalN2Changed += setN2.run(n2, p.id, n2).changes;
    }
    personalN2Changed += db.prepare("UPDATE people SET n2='Acquaintance' WHERE archived=0 AND n1='Personal' AND (score IS NULL OR score = 0) AND n2 IS NOT 'Family' AND n2 IS NOT 'Acquaintance'").run().changes;
  })();
  log(`  Personal N2 changes: ${personalN2Changed}`);

  // 6. N2 assignment for Professional people — symmetric with Personal (score-only)
  const profPeople = db.prepare(`
    SELECT id, business_score, relation_phase, relation_tag, n2
    FROM people
    WHERE archived=0 AND n1='Professional' AND business_score > 0 AND n2 IS NOT 'Family'
  `).all();
  const profScores = profPeople.map(p => p.business_score).sort((a, b) => b - a);
  const profBreaks = findBreaks(profScores);
  log(`  Professional breaks: core=${profBreaks.core?.toFixed(2)}, network=${profBreaks.network?.toFixed(2)}, extended=${profBreaks.extended?.toFixed(2)}`);

  let professionalN2Changed = 0;
  db.transaction(() => {
    for (const p of profPeople) {
      const n2 = capDormantN2(assignProfessionalN2(p, profBreaks), p.relation_phase, p.relation_tag);
      if (p.n2 !== n2) professionalN2Changed += setN2.run(n2, p.id, n2).changes;
    }
    professionalN2Changed += db.prepare("UPDATE people SET n2='Acquaintance' WHERE archived=0 AND n1='Professional' AND (business_score IS NULL OR business_score = 0) AND n2 IS NOT 'Family' AND n2 IS NOT 'Acquaintance'").run().changes;
  })();
  log(`  Professional N2 changes: ${professionalN2Changed}`);

  // 7. Companies N1/N2
  log('  Computing company N1/N2...');
  const companyN1 = db.prepare("UPDATE companies SET n1='Company' WHERE n1 IS NULL").run();
  if (companyN1.changes) log(`  Company N1 changes: ${companyN1.changes}`);

  const { ownerEmails } = await import('../../lib/identity.js');
  const ownerDomains = ownerEmails().map(e => e.split('@')[1]).filter(Boolean);

  const companies = db.prepare("SELECT id, n2 FROM companies WHERE people_count > 0 OR id IN (SELECT DISTINCT company_id FROM people WHERE company_id IS NOT NULL AND archived=0)").all();
  const companyScores = [];
  for (const c of companies) {
    const agg = db.prepare("SELECT SUM(business_score) as total, COUNT(*) as cnt FROM people WHERE company_id=? AND archived=0").get(c.id);
    const score = (agg.cnt || 0) > 0 ? ((agg.total || 0) / Math.sqrt(agg.cnt || 1)) : 0;
    companyScores.push({ id: c.id, score });
  }
  companyScores.sort((a, b) => b.score - a.score);

  const compScoreValues = companyScores.map(c => c.score).filter(s => s > 0);
  const compBreaks = findBreaks(compScoreValues);

  const setCompN2 = db.prepare("UPDATE companies SET n2=? WHERE id=? AND n2 IS NOT ?");
  let companyN2Changed = 0;
  await runWithSqliteBusyRetry('company N2 assignment', () => db.transaction(() => {
    for (const c of companyScores) {
      const domainRow = db.prepare("SELECT domain FROM company_domains WHERE company_id=? LIMIT 1").get(c.id);
      const domain = domainRow?.domain;
      let n2;
      if (domain && ownerDomains.includes(domain)) {
        n2 = 'Employer';
      } else if (c.score >= compBreaks.core) {
        n2 = 'Customers';
      } else if (c.score >= compBreaks.network) {
        n2 = 'Core';
      } else if (c.score >= compBreaks.extended) {
        n2 = 'Network';
      } else {
        n2 = 'Acquaintance';
      }
      if (c.n2 !== n2) companyN2Changed += setCompN2.run(n2, c.id, n2).changes;
    }
  })(), log);
  log(`  Companies N2 assigned: ${companyScores.length} (${companyN2Changed} changed)`);

  // 8. Places N2
  log('  Assigning places N1/N2...');
  const placeN1 = db.prepare("UPDATE places SET n1='Place' WHERE n1 IS NULL OR n1 = 'Venue'").run();
  if (placeN1.changes) log(`  Place N1 changes: ${placeN1.changes}`);
  const allPlaces = db.prepare("SELECT id, place_type, n2 FROM places").all();
  const setPlaceN2 = db.prepare("UPDATE places SET n2=? WHERE id=? AND n2 IS NOT ?");
  let placeN2Changed = 0;
  await runWithSqliteBusyRetry('place N2 assignment', () => db.transaction(() => {
    for (const p of allPlaces) {
      const n2 = assignPlaceN2(p);
      if (p.n2 !== n2) placeN2Changed += setPlaceN2.run(n2, p.id, n2).changes;
    }
  })(), log);
  log(`  Places N2 assigned: ${allPlaces.length} (${placeN2Changed} changed)`);

  // 9. computePlaceScores
  const placeScores = computePlaceScores();

  // ── st_93fddaf0 Phase 3: family tier-floor (zero-interaction-family pattern) ─
  // computeAllScores() gives interaction_count=0 people a zero score and
  // acquaintance tier. For configured immediate family (spouse, child, parent,
  // sibling) this is wrong: a child with zero digital footprint is family
  // regardless of signal. Lift them to 'core' so they rank with the rest of
  // Personal/Family.
  // WHY 'core' not a special tier: 'core' is the highest tier name in use;
  // Phase 4 family detection already sets n2='Family'. Aligning tier='core'
  // makes the family rows look like every other top-tier person.
  // Runs AFTER computeAllScores so any score-derived tier is set first.
  const tierFloor = db.prepare(`
    UPDATE people SET tier='core', updated_at=datetime('now')
    WHERE archived=0
      AND relation_tag IN ('spouse','child','parent','sibling')
      AND (tier='acquaintance' OR tier IS NULL)
  `).run();
  log(`  Family tier-floor lifted ${tierFloor.changes} family members to core`);

  // ── st_93fddaf0 Phase 5: service-vendor N2 cap ──────────────────────────────
  // Service-vendor flag is written by scripts/ingest/03b-service-vendor.js
  // earlier in the pipeline. Cap them to Acquaintance regardless of
  // interaction volume — Hakase's Gordian Knot: service contacts and personal
  // friends are incommensurable by interaction signals, so categorical
  // pre-sort beats score discrimination.
  // WHY skip Family: a family member who incidentally matched a service
  // keyword stays Family. relation_tag IS NULL guard is implicit because
  // family rows shouldn't be service_vendor=1 (Phase 5 predicate skips them).
  let svCapChanges = 0;
  try {
    const svCap = db.prepare(
      "UPDATE people SET n2='Acquaintance' WHERE archived=0 AND service_vendor=1 AND n2 IS NOT 'Family' AND n2 IS NOT 'Acquaintance'"
    ).run();
    svCapChanges = svCap.changes;
    log(`  Service-vendor N2 cap: ${svCap.changes} rows pinned to Acquaintance`);
  } catch (err) {
    log(`  Service-vendor cap failed (non-fatal): ${err.message}`);
  }

  // ── st_93fddaf0 Phase 6: dormancy detection (Saramäki α/β cliff) ────────────
  // Tag people whose interaction pattern shows the dormancy cliff:
  //   prior_180d >= 30 (had real interaction history)
  //   AND recent_180d * 10 < prior_180d (cliff drop — recent < 10% of prior)
  // These are people who used to be in active contact but aren't anymore.
  // Write `relation_phase='dormant'` and cap n2 to Network (not Core).
  //
  // WHY 30-interaction floor: low-volume relationships have noisy ratios; a
  // person with 2 prior interactions and 0 recent would falsely flag.
  // WHY service_vendor=0 + relation_tag IS NULL: family + service vendors
  // already have authoritative classifications; don't override.
  // WHY channels filtered to imessage/email: calendar events are recurrence-
  // heavy and noisy as a dormancy signal.
  //
  // Saramäki Royal Society Proceedings B 2021 — frequency-cliff detection.
  let dormancyChanges = 0;
  let dormantCapChanges = 0;
  let serviceVendorPhaseChanges = 0;
  try {
    const dormancyUpdate = db.prepare(`
      UPDATE people SET relation_phase='dormant', updated_at=datetime('now')
      WHERE archived = 0
        AND service_vendor = 0
        AND relation_tag IS NULL
        AND relation_phase IS NOT 'dormant'
        AND id IN (
          SELECT person_id FROM (
            SELECT
              person_id,
              SUM(CASE WHEN date >= date('now','-180 days') THEN 1 ELSE 0 END) AS recent_180d,
              SUM(CASE WHEN date >= date('now','-365 days')
                       AND date < date('now','-180 days') THEN 1 ELSE 0 END) AS prior_180d
            FROM person_interactions
            WHERE channel IN ('imessage','email')
            GROUP BY person_id
          )
          WHERE prior_180d >= 30 AND recent_180d * 10 < prior_180d
        )
    `).run();
    dormancyChanges = dormancyUpdate.changes;
    log(`  Dormancy detection: ${dormancyUpdate.changes} people marked dormant`);

    // Cap dormant people to Network (or below) so the cliff is visible in the
    // sidebar. relation_tag IS NULL guard means family is never demoted.
    const dormantCap = db.prepare(
      "UPDATE people SET n2='Network' WHERE archived=0 AND relation_phase='dormant' AND n2 IN ('Core','Partners','Customers') AND relation_tag IS NULL"
    ).run();
    dormantCapChanges = dormantCap.changes;
    log(`  Dormancy N2 cap: ${dormantCap.changes} dormant rows capped to Network`);

    // Also mark service vendors with relation_phase='service' for UI use.
    const svPhase = db.prepare(
      "UPDATE people SET relation_phase='service' WHERE archived=0 AND service_vendor=1 AND relation_phase IS NULL"
    ).run();
    serviceVendorPhaseChanges = svPhase.changes;
    log(`  Service-vendor relation_phase: ${svPhase.changes} rows`);
  } catch (err) {
    log(`  Dormancy detection failed (non-fatal): ${err.message}`);
  }

  return {
    people: allPeople.length,
    companies: companies.length,
    places: allPlaces.length,
    changes: {
      scoreRows: scoreResult.updated || 0,
      aliasInserted: scoreResult.aliases?.inserted || 0,
      aliasDeleted: scoreResult.aliases?.deleted || 0,
      n1: n1Changed,
      personalN2: personalN2Changed,
      professionalN2: professionalN2Changed,
      companyN1: companyN1.changes,
      companyN2: companyN2Changed,
      placeN1: placeN1.changes,
      placeN2: placeN2Changed,
      placeScores: placeScores?.updated || 0,
      familyTierFloor: tierFloor.changes,
      serviceVendorCap: svCapChanges,
      dormancy: dormancyChanges,
      dormantCap: dormantCapChanges,
      serviceVendorPhase: serviceVendorPhaseChanges,
    },
  };
}
