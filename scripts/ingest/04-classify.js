/**
 * Phase 4 — Classify: LLM classification backfill + family detection.
 *
 * Steps:
 * 1. LinkedIn pre-seed: LinkedIn connections → Professional (deterministic, saves LLM budget)
 * 2. backfillClassifications: business/personal/mixed via heuristics + LLM cap
 * 3. Baseline N1 for companies and places
 * 4. Family detection: sets n2='Family' + relation_tag for known family members
 *
 * WHY family detection here (not Phase 5): family is a classification, not a score.
 * It must be set before Phase 5 reads N2 so the scoring pass preserves family tags.
 * Sources: config/family.json explicit list + surname patterns + birthday calendar events
 * + Apple Contacts cross-reference (Pass 4) for nickname-stored family.
 *
 * WHY no LLM for family: family identity is deterministic — we know who they are.
 * Score proximity does not make someone family. Apple Contacts labels are unreliable
 * (users don't set them intentionally). Deterministic sources only.
 *
 * Pass 4 — Apple Contacts cross-reference (added 2026-05-13 in st_87a0d072 cleanup):
 *   Family members commonly appear in the user's iMessage / iCloud data under
 *   nicknames or initials rather than their canonical names. The display_name
 *   match in Pass 1 fails for these — yet the user wants them tagged. Apple
 *   Contacts is the bridge: a contact stored as a nickname carries the email/
 *   phone identifiers of the underlying person, which we can trace through
 *   person_identifiers to a real `people` row. Fuzzy match by first-name prefix
 *   (3+ chars) + last name inside the contact's display name or email addresses.
 *
 * Pass 5a — Content-level family inference (added 2026-05-13 in st_87a0d072 cleanup):
 *   Passes 1–4b are STRUCTURAL — they read identifiers, contacts, and
 *   surname patterns. Statements like "person-x's mom is person-y" live in
 *   the user's identity cards, chat, and notes — invisible to those passes.
 *   Pass 5a (lib/family-from-content.js) regex-scans user profile/context markdown
 *   and Apple Contacts ZABCDRELATEDNAME, derives transitive in-law / grand-
 *   parent relations from config/family.json anchors, and tags un-tagged
 *   people. Tier 0, no LLM. See lib/family-from-content.js header for full
 *   semantics.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { setRelationTag } from '../../lib/people-write.js';

const FAMILY_CONFIG = resolve(process.cwd(), 'config', 'family.json');

// WHY first-name prefixes: a canonical first name (e.g. a long form) may appear in
// contact emails only as an abbreviated nickname. A 3-char prefix is short enough to
// catch most nickname variants while staying long enough to avoid spurious 1-2-letter
// collisions across the contacts list.
function firstNamePrefixes(name) {
  const first = name.toLowerCase().split(/\s+/)[0];
  const prefixes = new Set();
  if (first.length >= 3) prefixes.add(first.slice(0, 3));
  if (first.length >= 4) prefixes.add(first.slice(0, 4));
  prefixes.add(first); // full first name
  return [...prefixes];
}

// WHY normalize last name to lowercase concatenation: a family member's email may
// embed a married-name surname rather than the maiden name listed in config — the
// alternate-surname fallback scans the family's surname_patterns list to recover
// this case.
function lastNameToken(name) {
  const parts = name.toLowerCase().split(/\s+/);
  return parts.length >= 2 ? parts.slice(1).join('') : null;
}

export async function phaseClassify(log) {
  log('\n=== Phase 4: Classify (class → N1 + family) ===');

  const { default: db } = await import('../../lib/db.js');
  const { backfillClassifications } = await import('../../lib/network-classify.js');

  // WHY no LinkedIn pre-seed: Phase 5 (05-score.js) unconditionally overwrites N1 for
  // all people using origin-based rules (work domain → Professional, iMessage-only → Personal).
  // Pre-seeding LinkedIn as Professional before Phase 5 runs is redundant — Phase 5 would
  // overwrite it anyway. Removing it eliminates an extra DB write pass with no effect on output.

  // 1. Run LLM classification for unclassified people
  log('  Running classification backfill...');
  let classStats = { classified: 0, skipped: 0, llmUsed: 0 };
  try {
    classStats = await backfillClassifications({ verbose: false, llmCap: 300 });
    log(`  Classified: ${JSON.stringify(classStats)}`);
  } catch (err) {
    log(`  Classification skipped: ${err.message}`);
  }

  // 2. Ensure companies N1 = 'Company' baseline
  db.exec("UPDATE companies SET n1='Company' WHERE n1 IS NULL");

  // 3. Ensure places N1 = 'Place' baseline
  db.exec("UPDATE places SET n1='Place' WHERE n1 IS NULL");

  // 4. Family detection — async because Pass 4 (Apple Contacts cross-ref) dynamic-imports
  // lib/contacts-extractor.js. Dynamic import keeps the dependency optional: if the
  // user has no AddressBook DB, the import succeeds but extractContacts() returns [].
  const familyStats = await detectFamily(db, log);

  return { ...classStats, familyTagged: familyStats.tagged };
}

/**
 * Detect and tag family members using four deterministic sources:
 *   1. Explicit list from config/family.json (names + relation)
 *   2. Apple Contacts cross-reference for unmatched explicit names (Pass 4 below)
 *   3. Surname patterns from config/family.json (e.g., shared family surname = cousin)
 *   4. Birthday calendar events whose names match in-law surnames
 *
 * Sets n2='Family' and relation_tag. No LLM. No inference.
 * Phase 5 checks n2 IS NOT 'Family' before overwriting N2 — tags survive scoring.
 *
 * WHY config/family.json and not hardcoded: family varies per user.
 * This is the seed for the owner's data; users configure their own via chat.
 *
 * WHY Apple Contacts pass runs BEFORE surname patterns: explicit family.json
 * entries are higher-trust than surname inference. If a config entry has
 * relation='parent-in-law' but the surname is also a generic-cousin pattern,
 * the explicit relation must win. Pass 4 (Apple Contacts) supplies the
 * resolution for nickname-stored family before Pass 5 (surname patterns)
 * downgrades the row by surname.
 */
async function detectFamily(db, log) {
  if (!existsSync(FAMILY_CONFIG)) {
    log('  Family detection: no config/family.json — skipping');
    return { tagged: 0 };
  }

  const config = JSON.parse(readFileSync(FAMILY_CONFIG, 'utf8'));
  const members  = config.members  || [];
  const patterns = config.surname_patterns || [];

  const findByName = db.prepare("SELECT id FROM people WHERE LOWER(display_name)=? AND archived=0 LIMIT 1");
  const findBySurname = db.prepare(
    "SELECT id, display_name FROM people WHERE LOWER(display_name) LIKE ? AND archived=0"
  );

  // Track tagged ids so surname pass doesn't downgrade an explicit match.
  // Map id → relation for logging.
  const tagged = new Map();
  // st_df0a8d71 QA round 2 — per-pass provenance so the write below goes
  // through setRelationTag with an honest source class: config/family.json +
  // Apple resolution of config members = 'family-config' (owner-curated);
  // content scan = 'content-inference'; surname/birthday heuristics =
  // 'surname-inference'. Gendered labels from the content pass ride along.
  const taggedSource = new Map();
  const taggedLabel = new Map();
  // Track renames from Pass 4: nickname-stored rows that resolve to a config
  // member should display under the canonical config name. Map person_id → new
  // display_name. Written in the same transaction as the relation_tag updates.
  const renames = new Map();

  // ── Pass 1: explicit name list ──────────────────────────────────────────────
  // Direct LOWER(display_name) match against config/family.json members.
  // Captures the easy cases where the user's display_name already matches the
  // canonical name; leaves nickname-stored family (e.g. parent/sibling rows
  // labelled by initials or relation kinship) for Pass 4 to resolve.
  const unmatchedMembers = [];
  for (const m of members) {
    const row = findByName.get(m.name.toLowerCase().trim());
    if (row) {
      tagged.set(row.id, m.relation);
      taggedSource.set(row.id, 'family-config');
    } else {
      unmatchedMembers.push(m); // queue for Pass 4 Apple Contacts cross-ref
    }
  }

  // ── Pass 4: Apple Contacts cross-reference for unmatched explicit names ────
  // Family members commonly appear in the user's contact list under nicknames
  // (relation kinship terms or initials) while config/family.json lists their
  // canonical names. Use Apple Contacts as the bridge: a contact entry
  // associates a nickname with email/phone identifiers; those identifiers
  // appear in `person_identifiers` of the underlying `people` row, which is
  // what we want to tag.
  //
  // Matching rules (in order, first match wins):
  //   a) Contact.name exact-equals the member.name (covers married-name
  //      variants like "Barbara Doe" matching config "Barb Doe"
  //      via first-name prefix below).
  //   b) Contact.name contains member.lastName AND starts with one of
  //      firstNamePrefixes(member.name). Catches contacts stored under a
  //      longer-form first name with the same surname (e.g. "Barbara" vs.
  //      "Barb").
  //   c) Any contact.email matches BOTH a 3+ char firstNamePrefix AND the
  //      member.lastName. Catches nickname-stored family whose emails embed
  //      the canonical first name + surname.
  //   d) Any contact.email matches a 3+ char firstNamePrefix AND ANY config
  //      surname_pattern surname. Catches family with married-name email
  //      addresses (maiden surname in config, married surname in email).
  //
  // Once a contact matches, we walk every email/phone identifier on that
  // contact and look up `person_identifiers` for a person_id. If found and
  // the person isn't already tagged, tag them with the config relation.
  //
  // WHY Apple Contacts is the trust anchor: contacts are deliberately
  // curated by the user; relation labels mapped to contact identifiers are
  // stated truths, not inferred ones. Same trust tier as config/family.json.
  if (unmatchedMembers.length > 0) {
    let contacts = [];
    try {
      const { extractContacts } = await import('../../lib/contacts-extractor.js');
      contacts = extractContacts();
    } catch (err) {
      log(`  ? family Pass 4 (Apple Contacts): extractContacts failed: ${err.message}`);
    }
    if (contacts.length > 0) {
      const findPersonByIdent = db.prepare(
        "SELECT person_id FROM person_identifiers WHERE LOWER(value) = LOWER(?) LIMIT 1"
      );
      // Build surname pattern set for rule (d) fallback (maiden-vs-married name).
      // Combine declared surname_patterns AND any surname that appears in 2+
      // members rows — captures the owner's own surname (not in surname_patterns
      // because the user is the anchor, but the user's siblings/parents share it)
      // for the case where a config name has a maiden-name surname different
      // from the email surname.
      const familySurnames = new Set(patterns.map(p => p.surname.toLowerCase()));
      const memberSurnameCount = {};
      for (const mm of members) {
        const ln = lastNameToken(mm.name);
        if (ln) memberSurnameCount[ln] = (memberSurnameCount[ln] || 0) + 1;
      }
      for (const [s, n] of Object.entries(memberSurnameCount)) {
        if (n >= 2) familySurnames.add(s);
      }

      for (const m of unmatchedMembers) {
        const prefixes = firstNamePrefixes(m.name);
        const last = lastNameToken(m.name);
        let matchedContact = null;
        let matchedVia = null;

        // Iterate contacts; first match wins by rule order
        for (const c of contacts) {
          const cname = c.name ? c.name.toLowerCase() : '';
          // Rule (a): exact contact-name match
          if (cname && cname === m.name.toLowerCase()) {
            matchedContact = c; matchedVia = 'contact-name-exact'; break;
          }
        }
        if (!matchedContact && last) {
          // Rule (b): contact name starts with first-name prefix AND contains lastName
          for (const c of contacts) {
            if (!c.name) continue;
            const cname = c.name.toLowerCase();
            if (!cname.includes(last)) continue;
            if (prefixes.some(p => cname.startsWith(p))) {
              matchedContact = c; matchedVia = 'contact-name-prefix+last'; break;
            }
          }
        }
        if (!matchedContact && last) {
          // Rule (c): email contains first-name prefix AND lastName
          outer: for (const c of contacts) {
            for (const e of (c.emails || [])) {
              const lc = e.toLowerCase();
              if (!lc.includes(last)) continue;
              if (prefixes.some(p => p.length >= 3 && lc.includes(p))) {
                matchedContact = c; matchedVia = 'email:prefix+last'; break outer;
              }
            }
          }
        }
        if (!matchedContact) {
          // Rule (d): email contains first-name prefix AND any config family surname
          outer: for (const c of contacts) {
            for (const e of (c.emails || [])) {
              const lc = e.toLowerCase();
              if (![...familySurnames].some(s => lc.includes(s))) continue;
              if (prefixes.some(p => p.length >= 3 && lc.includes(p))) {
                matchedContact = c; matchedVia = 'email:prefix+family-surname'; break outer;
              }
            }
          }
        }

        if (!matchedContact) {
          log(`  ? family Pass 4: no contact match for "${m.name}" — needs Miyagi tag`);
          continue;
        }

        // Walk the contact's identifiers to find a person_id
        let resolvedPersonId = null;
        let resolvedVia = null;
        for (const e of (matchedContact.emails || [])) {
          const r = findPersonByIdent.get(e);
          if (r) { resolvedPersonId = r.person_id; resolvedVia = `email:${e}`; break; }
        }
        if (!resolvedPersonId) {
          for (const p of (matchedContact.phones || [])) {
            const r = findPersonByIdent.get(p);
            if (r) { resolvedPersonId = r.person_id; resolvedVia = `phone:${p}`; break; }
          }
        }

        if (!resolvedPersonId) {
          log(`  ? family Pass 4: contact "${matchedContact.name}" (${matchedVia}) → "${m.name}" has no matching person_identifier — needs Miyagi tag`);
          continue;
        }

        // Don't downgrade an existing tagged person (e.g., Pass 1 hit a
        // different config row first). Pass 4 only fills gaps.
        if (tagged.has(resolvedPersonId)) {
          log(`  ? family Pass 4: "${m.name}" resolves to person already tagged as ${tagged.get(resolvedPersonId)} — skipping`);
          continue;
        }
        tagged.set(resolvedPersonId, m.relation);
        taggedSource.set(resolvedPersonId, 'family-config');
        // Rename the resolved person to the canonical config name. WHY: the
        // user told us in config/family.json what they want this family
        // member called. Leaving a nickname/initials display_name in place
        // breaks downstream surfaces (Network UI, VC 10 display_name check,
        // Miyagi set_relation_tag override flow) and contradicts the
        // user's stated preference. The original nickname is preserved as
        // a `name`-type row in person_identifiers from the prior resolve
        // pass, so search-by-nickname still works.
        renames.set(resolvedPersonId, m.name);
        log(`  + family Pass 4: "${m.name}" matched via ${resolvedVia} → ${resolvedPersonId} (relation=${m.relation}, will rename)`);
      }
    } else if (unmatchedMembers.length > 0) {
      for (const m of unmatchedMembers) log(`  ? family: no match for "${m.name}"`);
    }
  }

  // ── Pass 4b: Apple Contacts NICKNAME → relation inverse lookup ──────────────
  // Pass 4 covers the case "I have a config entry for Mom; find her real
  // identifier". Pass 4b covers the inverse: the user saved Mom in Apple
  // Contacts literally as the name "Mom" (no first/last) with no config entry —
  // or the config entry exists but failed to resolve via Pass 4's prefix/email
  // heuristics. Pass 4b iterates every contact, normalizes the name, and if it
  // matches a known relationship nickname (lib/family-nicknames.js), tags the
  // underlying person via shared email/phone lookup in person_identifiers.
  //
  // WHY runs AFTER Pass 4: config/family.json is authoritative — an explicit
  // tag must always win. Pass 4b only fills gaps where (a) the config entry
  // resolved through Pass 4 (skip), (b) no config entry exists for a contact
  // labelled by nickname (tag from inference), or (c) Pass 4 failed to resolve
  // and Pass 4b's looser exact-nickname-match finds the person.
  //
  // WHY runs BEFORE surname patterns: explicit nickname inference (e.g. a
  // contact named "Pop Pop" → grandparent) is higher-trust than surname
  // pattern matching ("any person with last name 'Dempsey' is a cousin").
  // A grandfather whose surname matches a cousin pattern should be tagged
  // grandparent, not cousin.
  //
  // WHY no rename here: Pass 4 renames because the user wrote a canonical name
  // in config (high-trust statement of preference). Pass 4b's relation is
  // inferred from a contact label like "Mom" — we have no canonical name to
  // rename to, just a relation kind. Leave display_name as-is; downstream
  // canonical-name backfill (lib/canonical-name.js) will upgrade it from
  // identifier-derived sources.
  {
    let contacts = [];
    try {
      const { extractContacts } = await import('../../lib/contacts-extractor.js');
      contacts = extractContacts();
    } catch (err) {
      log(`  ? family Pass 4b (nickname): extractContacts failed: ${err.message}`);
    }
    if (contacts.length > 0) {
      const { nicknameToRelation } = await import('../../lib/family-nicknames.js');
      const findPersonByIdent = db.prepare(
        "SELECT person_id FROM person_identifiers WHERE LOWER(value) = LOWER(?) LIMIT 1"
      );
      let pass4bMatched = 0;
      for (const c of contacts) {
        const relation = nicknameToRelation(c.name);
        if (!relation) continue;
        // Walk identifiers to find the person row
        let resolvedPersonId = null;
        let via = null;
        for (const e of (c.emails || [])) {
          const r = findPersonByIdent.get(e);
          if (r) { resolvedPersonId = r.person_id; via = `email:${e}`; break; }
        }
        if (!resolvedPersonId) {
          for (const p of (c.phones || [])) {
            const r = findPersonByIdent.get(p);
            if (r) { resolvedPersonId = r.person_id; via = `phone:${p}`; break; }
          }
        }
        if (!resolvedPersonId) continue; // no person row → can't tag

        // Pass 4 (explicit config) wins — don't overwrite.
        if (tagged.has(resolvedPersonId)) continue;
        tagged.set(resolvedPersonId, relation);
        taggedSource.set(resolvedPersonId, 'family-config');
        pass4bMatched++;
        log(`  + family Pass 4b: nickname "${c.name}" → ${via} → ${resolvedPersonId} (relation=${relation})`);
      }
      if (pass4bMatched > 0) log(`  Pass 4b: matched ${pass4bMatched} family via Apple nickname inference`);
    }
  }

  // ── Pass 5a: content-level family inference ────────────────────────────────
  // Scan user profile/context markdown (~/robotdojo/user/) and Apple
  // Contacts ZABCDRELATEDNAME for explicit relation statements like
  // "<owner>'s mom is <name>" or "my wife's mom is <name>". Derive in-law
  // and grandparent relations from config/family.json anchors. Tier 0, no LLM.
  //
  // WHY here, between Pass 4b and Pass 2 (surname patterns): content is
  // higher trust than surname inference (an explicit "X's mom is Y"
  // sentence beats "Y has the same surname as a known cousin"), so Pass 5a
  // wins over the generic surname-pattern fallback. Pass 4 / 4b (config +
  // Apple nickname) still win over Pass 5a — we pass the existing `tagged`
  // map in so already-tagged people are skipped.
  try {
    const { inferFamilyFromContent } = await import('../../lib/family-from-content.js');
    const result = await inferFamilyFromContent({
      db,
      log,
      config,
      alreadyTagged: new Set(tagged.keys()),
    });
    for (const [pid, relation] of result.tags) {
      if (!tagged.has(pid)) {
        tagged.set(pid, relation);
        // st_f67bc2eb D6 — provenance split: a relation field the user
        // hand-tagged on the Apple contact card is CONTACT authority
        // ('contact-card' — writes an edge, never outranks the owner);
        // markdown content stays inference class ('content-inference' — the
        // firewall converts it into a queue question, never an edge).
        taggedSource.set(pid, result.vias?.get(pid) === 'apple-related' ? 'contact-card' : 'content-inference');
        taggedLabel.set(pid, result.labels?.get(pid) || null);
      }
    }
    for (const s of result.samples) {
      if (s.via === 'identity') {
        log(`  + family Pass 5a: "${s.possessor}'s ${s.relation}" → "${s.value}" → ${s.personId} (derived=${s.derived})`);
      } else {
        log(`  + family Pass 5a (apple-related): ${s.relation} → "${s.value}" → ${s.personId}`);
      }
    }
  } catch (err) {
    log(`  ? Pass 5a (family-from-content) failed: ${err.message}`);
  }

  // ── Pass 2: surname patterns ─────────────────────────────────────────────────
  const surnameMap = new Map(patterns.map(p => [p.surname.toLowerCase(), p.relation]));
  for (const [surname, relation] of surnameMap) {
    const rows = findBySurname.all(`% ${surname}`);
    for (const row of rows) {
      if (!tagged.has(row.id)) {
        tagged.set(row.id, relation);
        taggedSource.set(row.id, 'surname-inference');
      }
    }
  }

  // ── Pass 3: birthday calendar events whose last name matches a pattern ───────
  // Events look like "Devon Rivera birthday", "Jane Smith bday",
  // "Bella & Alex Smith birthday". We extract candidate names and check surnames.
  const bdayEvents = db.prepare(
    "SELECT DISTINCT summary FROM calendar_events WHERE LOWER(summary) LIKE '%birthday%' OR LOWER(summary) LIKE '%bday%'"
  ).all();

  for (const ev of bdayEvents) {
    const names = extractNamesFromBirthday(ev.summary);
    for (const name of names) {
      const lastName = name.split(' ').pop()?.toLowerCase();
      if (!lastName || !surnameMap.has(lastName)) continue;
      const row = findByName.get(name.toLowerCase());
      if (row && !tagged.has(row.id)) {
        tagged.set(row.id, surnameMap.get(lastName));
        taggedSource.set(row.id, 'surname-inference');
      }
    }
  }

  // ── Write ────────────────────────────────────────────────────────────────────
  // WHY one transaction: rename + tag must be atomic per row so a crash doesn't
  // leave a row tagged-but-not-renamed (or vice versa). Both writes target the
  // same `people` row.
  // st_df0a8d71 QA round 2 — the relation_tag write goes through
  // setRelationTag (the ONE write path: authority floor, no-inference-flip,
  // weak-evidence floor, supersede facts, graph-change). n2='Family' and the
  // canonical rename are NOT relationship truth and stay direct — but n2 is
  // only promoted when the tag write actually landed (a floor-refused row
  // must not be promoted to the Family tier on inference evidence).
  const setFamilyTier = db.prepare("UPDATE people SET n2='Family', updated_at=datetime('now') WHERE id=?");
  const setRename = db.prepare("UPDATE people SET display_name=?, updated_at=datetime('now') WHERE id=?");
  db.transaction(() => {
    for (const [id, relation] of tagged) {
      const source = taggedSource.get(id) || 'surname-inference';
      const label = taggedLabel.get(id) || null;
      let updated = null;
      try {
        updated = setRelationTag(db, id, relation, label, { source });
      } catch (err) {
        log(`  ? family write skipped for ${id}: ${err.message}`);
      }
      const landed = updated?.relation_tag === relation;
      if (landed) setFamilyTier.run(id);
      const newName = renames.get(id);
      if (newName) setRename.run(newName, id);
    }
  })();

  const byCat = {};
  for (const rel of tagged.values()) byCat[rel] = (byCat[rel] || 0) + 1;
  log(`  Family tagged: ${tagged.size} — ${Object.entries(byCat).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return { tagged: tagged.size };
}

/**
 * Extract candidate name(s) from a birthday calendar summary.
 *
 * "Devon Rivera birthday"         → ["Devon Rivera"]
 * "Barb Doe Birthday"         → ["Barb Doe"]
 * "Bella & Alex Smith birthday"     → ["Bella Smith", "Alex Smith"]
 * "Brett & Rachel Haywood Bday"     → ["Brett Haywood", "Rachel Haywood"]
 * "Ollie's 3rd Birthday"            → ["Ollie"] (no surname — won't match pattern)
 */
function extractNamesFromBirthday(summary) {
  if (!summary) return [];
  let s = summary
    .replace(/\b\d+(st|nd|rd|th)\b/gi, '')
    .replace(/\b(birthday|bday|b-day|party|dinner|bbq|bash|celebration|brunch|lunch|event)\b/gi, '')
    .replace(/'s\b/g, '')
    .replace(/[!?,.']/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s || s.length < 2) return [];

  // Compound: "Bella & Alex Smith" → shared last name appended to each first name
  if (s.includes(' & ')) {
    const parts = s.split(/\s*&\s*/);
    const sharedLastName = s.split(/\s+/).pop();
    return parts.map(p => {
      const firstName = p.trim().split(/\s+/)[0];
      // Don't return "Smith Smith" if last part already has the surname
      if (p.trim().toLowerCase().endsWith(sharedLastName.toLowerCase())) return p.trim();
      return `${firstName} ${sharedLastName}`.trim();
    }).filter(n => n && n !== sharedLastName);
  }

  return [s];
}
