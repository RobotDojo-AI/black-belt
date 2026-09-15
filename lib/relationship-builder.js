/**
 * relationship-builder.js — populate entity_relationships from 5 sources.
 *
 * Sources (in order):
 *   1. (RETIRED by st_f67bc2eb: relation_tag projection — kinship truth lives
 *      in person_relations; the tag columns are a walker-derived cache and
 *      projecting a cache would create a second truth)
 *   2. company_id on people   → colleague edges (pairwise within company)
 *   3. person_interactions    → interaction-weighted edges (owner ↔ contact)
 *   4. (RETIRED by st_87a0d072: person_edges co-occurrence — table dropped)
 *   5. email_participants (to/cc) → email_cc_copresence non-ego edges
 *      (design-unified-architecture.md §3.2, st_1b2ee2f0 chunk 6)
 *
 * Compute tier: 0 (free). Pure SQL + in-process logic. No LLM calls.
 *
 * INTELLIGENCE_TIER: extraction — deterministic SQL/derivation only, no LLM
 * anywhere in this file.
 *
 * Source 5 (email_cc_copresence) is the SAME signal class st_87a0d072
 * deliberately removed (`person_edges`/Phase 10 co-occurrence) after it
 * corrupted `people.score` ranking (the "grandmother ranked #36" defect).
 * It is safe to bring back here because: (a) it writes ONLY to
 * `entity_relationships`, never `person_relations` or `person_interactions`,
 * (b) `lib/scoring.js` never reads `entity_relationships` (verified by a
 * grep-regression test in tests/scoring.test.js — "the wall"), and (c) every
 * row is tagged `source='email_cc_copresence'`, which `lib/provenance.js`'s
 * `EDGE_SOURCE_TRUST` map discounts to 0.2 and `lib/entity-floor.js`'s
 * ranking applies as a multiplier — so it can surface as a "Top connections"
 * line but can never outrank a primary-source edge. Provenance-weighting,
 * not deletion.
 *
 * CLI: node lib/relationship-builder.js [--dry-run]
 *   --dry-run: print candidate counts, write nothing to DB, exit 0.
 */

export const INTELLIGENCE_TIER = 'extraction';

import { isRoleOrGenericEmail } from './identity-matching.js';

// ── Tunables (named consts, env-overridable — mirrors lib/entity-floor.js /
// lib/provenance.js's numEnv/intEnv convention; no buried literals) ─────────
function intEnv(name, dflt) {
  const n = Number.parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
function numEnv(name, dflt) {
  const n = Number.parseFloat(String(process.env[name] ?? ''));
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// Fan-out safety valve (st_87a0d072's lesson, applied structurally this time):
// a broadcast-sized thread (a 40-person company all-hands cc list) is not
// "these people know each other" — a 40-recipient thread must not emit 780
// dense pairs. Skip pairing ENTIRELY for any email whose resolved,
// non-owner, non-role participant set exceeds this cap, rather than
// truncating to an arbitrary subset.
//
// Per-person sparsity cap: a pair is kept only if EACH endpoint ranks it
// among their own top-N co-occurring counterparts by shared-thread count.
// This is a hard structural bound — a person cannot end up with more than N
// kept CC edges, because the AND-gate means the pair must appear in this
// person's OWN top-N list to survive at all.
//
// Weight formula: log-scaled by shared-thread count, capped well below the
// company_affiliation (1.0 fixed) / interaction_history (log(2)*2≈1.39+)
// baseline. This is belt-and-suspenders on top of the EDGE_SOURCE_TRUST
// multiplier lib/entity-floor.js applies at read time — even ignoring
// provenance weighting entirely, a CC edge's raw weight structurally cannot
// reach a primary-source edge's floor.
//
// WHY read at CALL time, not module-load time (unlike lib/entity-floor.js's
// top-level tunables): this function is exercised directly by unit tests
// that set the env var per-test to exercise the cap boundaries — a
// module-top-level const would freeze at whatever value was set on first
// import and never see a later test's override. Reading fresh per call costs
// nothing (env lookups are not a hot loop here) and makes the caps testable
// without a child-process reload per case.
function ccTunables() {
  return {
    maxParticipantsPerEmail: intEnv('ROBOTDOJO_CC_MAX_PARTICIPANTS_PER_EMAIL', 10),
    maxPairsPerPerson: intEnv('ROBOTDOJO_CC_MAX_PAIRS_PER_PERSON', 25),
    weightScale: numEnv('ROBOTDOJO_CC_WEIGHT_SCALE', 0.15),
    maxWeight: numEnv('ROBOTDOJO_CC_MAX_WEIGHT', 0.5),
  };
}

function ccWeight(count, { weightScale, maxWeight }) {
  return Math.min(maxWeight, Math.log(1 + count) * weightScale);
}

/**
 * Build entity_relationships from all sources.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ dryRun?: boolean, log?: Function }} opts
 * @returns {{ inserted: number, skipped: number, sources: Object }}
 */
export async function buildRelationships(db, opts = {}) {
  const { dryRun = false, log = console.log } = opts;
  // Allow up to 30s for write locks to clear when server holds a WAL reader snapshot
  db.pragma('busy_timeout = 30000');

  // Resolve owner entity: user_settings.email → person_identifiers
  // Fallback: first google/microsoft account email that resolves to a person
  const ownerEmailRow = db.prepare("SELECT value FROM user_settings WHERE key='email'").get();
  let ownerId = null;
  let resolvedEmail = ownerEmailRow?.value;

  if (resolvedEmail) {
    const ownerPI = db.prepare(
      "SELECT person_id FROM person_identifiers WHERE type='email' AND LOWER(value)=? LIMIT 1"
    ).get(resolvedEmail.toLowerCase());
    if (ownerPI) {
      ownerId = ownerPI.person_id;
    } else {
      log(`[relationship-builder] WARNING: owner email ${resolvedEmail} not found in person_identifiers — skipping relation_tag source`);
    }
  } else {
    // No user_settings email — try accounts table (google/microsoft)
    const accountEmails = db.prepare(
      "SELECT DISTINCT email FROM accounts WHERE email IS NOT NULL AND vendor IN ('google','microsoft') ORDER BY created_at ASC"
    ).all().map(r => r.email.toLowerCase());
    for (const email of accountEmails) {
      const ownerPI = db.prepare(
        "SELECT person_id FROM person_identifiers WHERE type='email' AND LOWER(value)=? LIMIT 1"
      ).get(email);
      if (ownerPI) {
        ownerId = ownerPI.person_id;
        resolvedEmail = email;
        break;
      }
    }
    if (!ownerId) {
      log('[relationship-builder] WARNING: no owner email found — skipping relation_tag and interaction_history sources');
    }
  }

  const stats = {
    relation_tag: 0,
    company_affiliation: 0,
    interaction_history: 0,
    co_occurrence: 0,
    email_cc_copresence: 0,
  };

  // ── Source 1: relation_tag (RETIRED by st_f67bc2eb) ─────────────────────────
  // The relation_tag → entity_relationships projection is retired. Kinship
  // truth now lives in `person_relations` (lib/relation-store.js) and the
  // relation_tag columns are a WALKER-DERIVED CACHE of that table — projecting
  // the cache back into a second edge table would fight the new source on
  // every rerun (two truths, the defect class this lineage exists to kill).
  // Kinship reads never touch entity_relationships anymore; the legacy family/
  // spouse rows in it are frozen history (OOS-1). stats.relation_tag stays 0.
  log('[relationship-builder] relation_tag: retired (kinship truth lives in person_relations — st_f67bc2eb)');

  // ── Source 2: company_affiliation ─────────────────────────────────────────
  // Companies with ≥2 non-archived people. Cap top-50 per company by score.
  const companies = db.prepare(`
    SELECT company_id, COUNT(*) as n
    FROM people
    WHERE company_id IS NOT NULL AND archived = 0
    GROUP BY company_id
    HAVING n >= 2
  `).all();

  if (dryRun) {
    // Estimate pair count
    let pairCount = 0;
    for (const co of companies) {
      const n = Math.min(co.n, 50);
      pairCount += (n * (n - 1)) / 2;
    }
    log(`[relationship-builder] dry-run: company_affiliation candidates: ${companies.length} companies, ~${pairCount} colleague pairs`);
    stats.company_affiliation = pairCount;
  } else {
    try {
      const now = new Date().toISOString();
      const upsertColleague = db.prepare(`
        INSERT INTO entity_relationships
          (entity_id_a, entity_id_b, entity_type_a, entity_type_b, relationship_type, weight, first_seen, last_seen, source)
        VALUES (?, ?, 'person', 'person', 'colleague', 1.0, ?, ?, 'company_affiliation')
        ON CONFLICT(entity_id_a, entity_id_b, relationship_type, source) DO UPDATE SET
          weight     = excluded.weight,
          last_seen  = excluded.last_seen,
          updated_at = excluded.updated_at
      `);

      const topPeopleStmt = db.prepare(`
        SELECT id FROM people
        WHERE company_id = ? AND archived = 0
        ORDER BY score DESC
        LIMIT 50
      `);

      const runBatch = db.transaction((coId) => {
        const people = topPeopleStmt.all(coId);
        let created = 0;
        for (let i = 0; i < people.length; i++) {
          for (let j = i + 1; j < people.length; j++) {
            const a = people[i].id;
            const b = people[j].id;
            // Store canonical order (a < b lexicographically) for consistency
            const [ea, eb] = a < b ? [a, b] : [b, a];
            upsertColleague.run(ea, eb, now, now);
            created++;
          }
        }
        return created;
      });

      for (const co of companies) {
        stats.company_affiliation += runBatch(co.company_id);
      }
      log(`[relationship-builder] company_affiliation: ${stats.company_affiliation} edges`);
    } catch (err) {
      log(`[relationship-builder] company_affiliation: skipped — ${err.code || err.message}`);
    }
  }

  // ── Source 3: interaction_history (bidirectional) ────────────────────────
  if (ownerId) {
    const interactions = db.prepare(`
      SELECT person_id,
        SUM(CASE WHEN direction = 'outbound' THEN n ELSE 0 END) as out_count,
        SUM(CASE WHEN direction = 'inbound'  THEN n ELSE 0 END) as in_count
      FROM (
        SELECT person_id, direction, COUNT(*) as n
        FROM person_interactions
        WHERE channel = 'email' AND direction IN ('outbound', 'inbound')
        GROUP BY person_id, direction
      )
      GROUP BY person_id
      HAVING out_count + in_count > 0
    `).all();

    if (dryRun) {
      log(`[relationship-builder] dry-run: interaction_history candidates: ${interactions.length}`);
      stats.interaction_history = interactions.length;
    } else {
      const now = new Date().toISOString();
      const upsert = db.prepare(`
        INSERT INTO entity_relationships
          (entity_id_a, entity_id_b, entity_type_a, entity_type_b, relationship_type, weight, first_seen, last_seen, source)
        VALUES (?, ?, 'person', 'person', 'colleague', ?, ?, ?, 'interaction_history')
        ON CONFLICT(entity_id_a, entity_id_b, relationship_type, source) DO UPDATE SET
          weight     = excluded.weight,
          last_seen  = excluded.last_seen,
          updated_at = excluded.updated_at
      `);

      const run = db.transaction(() => {
        for (const row of interactions) {
          const weight = Math.log(1 + row.out_count + row.in_count) * 2.0;
          const [ea, eb] = ownerId < row.person_id ? [ownerId, row.person_id] : [row.person_id, ownerId];
          upsert.run(ea, eb, weight, now, now);
          stats.interaction_history++;
        }
      });
      run();
      log(`[relationship-builder] interaction_history: ${stats.interaction_history} edges`);
    }
  }

  // ── Source 4: co_occurrence from person_edges ─────────────────────────────
  // st_87a0d072 Phase 6: person_edges has been DROPPED. Co-occurrence as a
  // signal source was retired — the rich-baseline restoration favours direct
  // interactions + family inference + manual relation_tag over inferred
  // colleague edges. We keep the source-4 hook so the entity_relationships
  // surface stays callable, but it's now a no-op. stats.co_occurrence stays 0.
  log('[relationship-builder] co_occurrence: skipped (person_edges dropped by st_87a0d072)');

  // ── Source 5: email_cc_copresence (st_1b2ee2f0 chunk 6) ───────────────────
  const ccResult = await buildEmailCcCopresenceEdges(db, { ownerId, dryRun, log });
  stats.email_cc_copresence = ccResult.count;

  const total = dryRun ? 0 : db.prepare('SELECT COUNT(*) as n FROM entity_relationships').get()?.n || 0;
  log(`[relationship-builder] done — total entity_relationships: ${dryRun ? '(dry-run, no writes)' : total}`);

  return {
    inserted: total,
    skipped: 0,
    sources: stats,
    dryRun,
  };
}

/**
 * Source 5 — email_cc_copresence: non-ego "these two people were on the same
 * email thread" edges, derived from email_participants (to/cc roles only —
 * bcc is invisible to co-recipients, so it carries no co-presence signal;
 * sender is excluded per the story brief's scope).
 *
 * "Non-ego": pairs including the owner are excluded. The owner↔contact
 * signal already has a dedicated, more precise source (source 3,
 * interaction_history) — this source exists purely to surface THIRD-PARTY
 * co-presence the owner couldn't otherwise see.
 *
 * Newsletter- and role-account-filtered: an email flagged is_newsletter or
 * carrying a List-Unsubscribe header never seeds a pair (build-conventions
 * Entity Extraction Hierarchy: "newsletters never seed"), and any
 * participant address classified role/generic by
 * lib/identity-matching.js's isRoleOrGenericEmail (the same blocklist used
 * by entity resolution) is dropped before pairing.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ ownerId?: string|null, dryRun?: boolean, log?: Function }} opts
 * @returns {{ emailsScanned:number, emailsSkippedDenseFanout:number,
 *   pairsBeforePersonCap:number, count:number }}
 */
export async function buildEmailCcCopresenceEdges(db, opts = {}) {
  const { ownerId = null, dryRun = false, log = console.log } = opts;
  const { maxParticipantsPerEmail, maxPairsPerPerson, weightScale, maxWeight } = ccTunables();

  // 1. Filtered (email_id -> Set<participant_email>) map for role IN
  //    ('to','cc'), newsletter/list-unsubscribe emails excluded.
  //    A per-row join into the multi-GB encrypted `emails` table (one lookup
  //    per email_participants row) is the exact anti-pattern
  //    scripts/ingest/01-extract.js's header documents blowing past 10 minutes
  //    at this scale — one sequential scan of `emails` into a small TEMP
  //    TABLE, then a join against that, is seconds instead.
  db.exec('DROP TABLE IF EXISTS _cc_email_ok');
  db.exec('CREATE TEMP TABLE _cc_email_ok (email_id TEXT PRIMARY KEY)');
  db.exec(`
    INSERT INTO _cc_email_ok (email_id)
    SELECT id FROM emails
    WHERE COALESCE(is_newsletter, 0) = 0 AND list_unsubscribe IS NULL
  `);
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT ep.email_id, ep.participant_email
      FROM email_participants ep
      JOIN _cc_email_ok ok ON ok.email_id = ep.email_id
      WHERE ep.role IN ('to', 'cc')
    `).all();
  } finally {
    db.exec('DROP TABLE IF EXISTS _cc_email_ok');
  }

  const byEmail = new Map();
  for (const r of rows) {
    const addr = String(r.participant_email || '').toLowerCase().trim();
    if (!addr) continue;
    if (!byEmail.has(r.email_id)) byEmail.set(r.email_id, new Set());
    byEmail.get(r.email_id).add(addr);
  }

  // 2. Resolve participant_email -> person_id, dropping role/generic
  //    addresses BEFORE resolution so a blocklisted address never seeds a
  //    pair even if it happens to also be a known person's alias.
  const candidateAddrs = new Set();
  for (const set of byEmail.values()) for (const a of set) candidateAddrs.add(a);
  const personAddrs = [...candidateAddrs].filter((a) => !isRoleOrGenericEmail(a));

  const emailToPerson = new Map();
  const CHUNK = 500; // SQLite bound parameter ceiling headroom
  for (let i = 0; i < personAddrs.length; i += CHUNK) {
    const slice = personAddrs.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const found = db.prepare(`
      SELECT LOWER(value) AS email, person_id FROM person_identifiers
      WHERE type = 'email' AND LOWER(value) IN (${placeholders})
    `).all(...slice);
    for (const f of found) if (!emailToPerson.has(f.email)) emailToPerson.set(f.email, f.person_id);
  }

  // 3. Per email: resolved, non-owner, deduped person_ids. Dense-fanout
  //    threads are skipped ENTIRELY (not truncated) — a broadcast list is not
  //    a relationship signal.
  const emailsScanned = byEmail.size;
  let emailsSkippedDenseFanout = 0;
  const pairCounts = new Map(); // "personA|personB" (canonical order) -> shared-thread count

  for (const addrs of byEmail.values()) {
    const personIds = new Set();
    for (const addr of addrs) {
      const pid = emailToPerson.get(addr);
      if (!pid) continue;
      if (ownerId && String(pid) === String(ownerId)) continue; // non-ego only
      personIds.add(String(pid));
    }
    if (personIds.size < 2) continue;
    if (personIds.size > maxParticipantsPerEmail) { emailsSkippedDenseFanout++; continue; }
    const list = [...personIds];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = list[i] < list[j] ? [list[i], list[j]] : [list[j], list[i]];
        const key = `${a}|${b}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }

  // 4. Per-person sparsity cap: keep a pair only if it ranks in BOTH
  //    endpoints' own top-N co-occurring counterparts by shared-thread
  //    count. The AND-gate is what makes this a hard structural bound —
  //    a person's kept-edge count from this source can never exceed N,
  //    because survival requires the pair to be in THIS person's own top-N.
  const byPerson = new Map(); // person -> [{counterparty, count}]
  for (const [key, count] of pairCounts) {
    const [a, b] = key.split('|');
    if (!byPerson.has(a)) byPerson.set(a, []);
    if (!byPerson.has(b)) byPerson.set(b, []);
    byPerson.get(a).push({ counterparty: b, count });
    byPerson.get(b).push({ counterparty: a, count });
  }
  const topSetByPerson = new Map();
  for (const [person, list] of byPerson) {
    const top = [...list].sort((x, y) => y.count - x.count).slice(0, maxPairsPerPerson);
    topSetByPerson.set(person, new Set(top.map((t) => t.counterparty)));
  }

  const keptPairs = [];
  for (const [key, count] of pairCounts) {
    const [a, b] = key.split('|');
    if (topSetByPerson.get(a)?.has(b) && topSetByPerson.get(b)?.has(a)) keptPairs.push({ a, b, count });
  }

  const stats = {
    emailsScanned,
    emailsSkippedDenseFanout,
    pairsBeforePersonCap: pairCounts.size,
  };

  if (dryRun) {
    log(`[relationship-builder] dry-run: email_cc_copresence candidates: ${emailsScanned} emails scanned, ${emailsSkippedDenseFanout} skipped (dense fan-out), ${pairCounts.size} raw pairs, ${keptPairs.length} pairs after per-person sparsity cap`);
    return { ...stats, count: keptPairs.length };
  }

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO entity_relationships
      (entity_id_a, entity_id_b, entity_type_a, entity_type_b, relationship_type, weight, first_seen, last_seen, source)
    VALUES (?, ?, 'person', 'person', 'acquaintance', ?, ?, ?, 'email_cc_copresence')
    ON CONFLICT(entity_id_a, entity_id_b, relationship_type, source) DO UPDATE SET
      weight     = excluded.weight,
      last_seen  = excluded.last_seen,
      updated_at = excluded.updated_at
  `);
  const run = db.transaction(() => {
    for (const { a, b, count } of keptPairs) upsert.run(a, b, ccWeight(count, { weightScale, maxWeight }), now, now);
  });
  run();
  log(`[relationship-builder] email_cc_copresence: ${keptPairs.length} edges`);
  return { ...stats, count: keptPairs.length };
}

// ── CLI entry point ──────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    process.env.ROBOTDOJO_ALLOW_PLAINTEXT ??= '1';
  }
  const { default: db } = await import('./db.js');
  const result = await buildRelationships(db, { dryRun, log: console.log });
  console.log('[relationship-builder] result:', JSON.stringify(result, null, 2));
  process.exit(0);
}
