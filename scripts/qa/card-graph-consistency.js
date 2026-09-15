#!/usr/bin/env node
/**
 * scripts/qa/card-graph-consistency.js — generated-card vs entity-graph
 * relationship consistency gate (st_df0a8d71 AC-3, Phase 4).
 *
 * Compute tier: Tier 0 only — deterministic regex/SQL scan. No LLM.
 *
 * WHAT IT CATCHES: the defect's artifact class — a generated document whose
 * injected surface carries a relationship claim that contradicts the graph
 * (the known first hit: the owner's spouse's card describing a "cohabitating"
 * dating relationship while people.relation_tag='spouse'). Cards lost
 * who-is-who authority in this story; this gate is defense-in-depth that
 * finds stale/contradicting derived documents so they get regenerated.
 *
 * SCOPE: the INJECTED surface only — each entity context file's `## Summary`
 * section (legacy files with no marker: the whole body, which is what the
 * legacy injector slices) and every user_topics.context_md Summary. The
 * `## History` archive is deliberately not scanned: it legitimately preserves
 * superseded prose and is never injected.
 *
 * MECHANISM: for every first-degree (family-tagged) person, look for
 * closed-vocabulary relation claims ADJACENT to that person's name (±window
 * chars; the person's OWN card is whole-Summary scope) whose structural class
 * contradicts the graph class. Conservative class-level rules only:
 *
 *   - spouse-tagged person + unmarried-romance or non-family claim
 *     (girlfriend/boyfriend/dating/cohabitating/live-in/colleague/…)
 *   - blood-tagged person + the corresponding in-law claim, and vice versa
 *     (mother vs mother-in-law)
 *   - family-tagged person + explicit non-family claim (colleague/coworker/
 *     acquaintance/classmate)
 *
 * False positives cost one regen cycle and no truth damage (cards are derived
 * artifacts); false negatives cost nothing structural — the gate is
 * defense-in-depth, not the wall (prompt paths already outrank cards).
 *
 * CLI:
 *   node scripts/qa/card-graph-consistency.js --all           # scan, exit 1 on hits
 *   node scripts/qa/card-graph-consistency.js --all --regen   # + flag people
 *     needs_regen=1 and regenerate flagged topic cards, then exit 1 (a re-scan
 *     after the regen pass is the green proof)
 */
export const INTELLIGENCE_TIER = 'extraction';

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
const REGEN = args.includes('--regen');
// --all is the documented scan-everything mode (and the only mode today).
const JSON_OUT = args.includes('--json');

const { default: db } = await import('../../lib/db.js');
const { FAMILY_TAGS } = await import('../../lib/scoring.js');
const { relationPhrase } = await import('../../lib/relation-vocabulary.js');
const { USER_CONTEXTS_DIR } = await import('../../lib/robotdojo-paths.js');

// ── Claim lexicon → structural class ─────────────────────────────────────────
// Longest-first so "mother-in-law" wins over "mother". Word-boundary matched.
const CLAIM_CLASSES = [
  // in-law claims
  ['mother-in-law', 'in-law'], ['father-in-law', 'in-law'],
  ['sister-in-law', 'in-law'], ['brother-in-law', 'in-law'],
  // unmarried-romance claims (contradict a spouse tag). Single adverb/noun
  // forms included deliberately — the known first hit said "began
  // romantically" and "live-in or closely cohabitating couple"; a lexicon of
  // only two-word phrases missed both. FP cost is one regen (accepted).
  ['romantically involved', 'romance'], ['romantic partner', 'romance'],
  ['romantically', 'romance'], ['romantic relationship', 'romance'],
  ['live-in partner', 'romance'], ['live-in', 'romance'],
  ['cohabitating', 'romance'], ['cohabiting', 'romance'],
  ['girlfriend', 'romance'], ['boyfriend', 'romance'],
  ['dating', 'romance'],
  // explicit non-family claims
  ['co-worker', 'non-family'], ['coworker', 'non-family'],
  ['colleague', 'non-family'], ['acquaintance', 'non-family'],
  ['classmate', 'non-family'],
  // spouse claims
  ['wife', 'spouse'], ['husband', 'spouse'], ['spouse', 'spouse'],
  // blood claims
  ['grandmother', 'blood'], ['grandfather', 'blood'],
  ['mother', 'blood'], ['father', 'blood'],
  ['brother', 'blood'], ['sister', 'blood'],
  ['daughter', 'blood'], ['son', 'blood'], ['cousin', 'blood'],
];

// Graph tag → its structural class for comparison.
function graphClass(tag) {
  if (tag === 'spouse') return 'spouse';
  if (tag === 'parent-in-law' || tag === 'sibling-in-law' || tag === 'IL') return 'in-law';
  if (tag === 'pet') return 'pet';
  return 'blood'; // parent, sibling, child, grandparent, cousin, niece-nephew, family
}

/**
 * Does a claim of `claimClass` contradict a graph relationship of `gClass`?
 * Conservative: only the rules named in the module header return true.
 */
function contradicts(gClass, claimClass) {
  if (claimClass === 'non-family') return gClass !== 'pet'; // any family member described as colleague/acquaintance
  if (claimClass === 'romance') return gClass === 'spouse'; // married person framed as dating/cohabitating
  if (claimClass === 'in-law') return gClass === 'blood' || gClass === 'spouse';
  if (claimClass === 'blood') return gClass === 'in-law';
  if (claimClass === 'spouse') return gClass === 'in-law' || gClass === 'blood';
  return false;
}

const ADJACENCY_WINDOW = 160;

// ── Load the first-degree graph ──────────────────────────────────────────────
const firstDegree = db.prepare(`
  SELECT id, display_name, relation_tag, relation_label, relation_derived_phrase
  FROM people
  WHERE relation_tag IS NOT NULL AND COALESCE(archived, 0) = 0
`).all().filter((p) => FAMILY_TAGS.has(p.relation_tag) && String(p.display_name || '').trim());

// Owner first name for the possessive claim anchor ("<owner-first>'s colleague").
const { ownerPersonId } = await import('../../lib/identity.js');
let ownerFirstName = null;
try {
  const ownerRow = db.prepare('SELECT display_name FROM people WHERE id = ?').get(String(ownerPersonId() || ''));
  ownerFirstName = String(ownerRow?.display_name || '').trim().split(/\s+/)[0] || null;
} catch { /* generic anchors still apply */ }

// Name matching uses the FULL display name only (word-boundary, multi-token).
// First-name variants were tried and produced a false-positive storm on the
// live corpus (a short family first name prefix-hit every longer name that
// starts with it, and common first names hit hundreds of unrelated cards).
// Full-name-only loses some recall on first-name-only prose in OTHER
// documents; the own-card whole-surface rule still covers the primary defect
// class, and the gate is defense-in-depth by design (false negatives cost
// nothing structural).

// A contradicting claim must be OWNER-ANCHORED: relationship words about
// third parties ("person-b's husband", "her colleague") are not claims about
// the owner's relationship. Anchors, checked in the ~48 chars before the
// claim: "your X" / "the user's X" / "<owner-first>'s X" / the free-template
// line "…relationship currently reads as X".
const anchorParts = [
  String.raw`\byour\s+`,
  String.raw`\bthe\s+user(?:['’]s)?\s+`,
  String.raw`\breads\s+as\s+`,
];
if (ownerFirstName) {
  anchorParts.push(`\\b${ownerFirstName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:['’]s)\\s+`);
}
const CLAIM_ANCHOR_RE = new RegExp(`(?:${anchorParts.join('|')})(?:[\\w-]+\\s+){0,2}$`, 'i');
const ANCHOR_LOOKBEHIND_CHARS = 48;

function claimIsOwnerAnchored(lowerText, claimIndex) {
  const before = lowerText.slice(Math.max(0, claimIndex - ANCHOR_LOOKBEHIND_CHARS), claimIndex);
  return CLAIM_ANCHOR_RE.test(before);
}

// ── Document surface extraction ──────────────────────────────────────────────
function stripFrontmatter(markdown) {
  let body = String(markdown || '').trim();
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) body = body.slice(end + 4).trim();
  }
  return body;
}
const SUMMARY_HEADING_RE = /^[ \t]*##[ \t]+Summary[ \t]*$/im;
const SECTION_END_RE = /^[ \t]*(?:---[ \t]*|##[ \t]+\S.*)$/m;
function injectedSurface(markdown) {
  const body = stripFrontmatter(markdown);
  const m = SUMMARY_HEADING_RE.exec(body);
  if (!m) return body; // legacy files: whole body is the injectable region
  const rest = body.slice(m.index + m[0].length);
  const end = SECTION_END_RE.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim();
}

// ── Scan one document surface for contradictions ─────────────────────────────
// NEAREST-NAME ATTRIBUTION: a claim word is attributed to the closest
// first-degree name occurrence within the adjacency window, and only that
// person's graph is compared. Without attribution, "your wife <spouse-name>"
// inside an in-law's card flags the in-law (cross-name false positive — the
// exact residue the first live sweep left behind).
function scanSurface(surface, { docLabel, ownEntityId = null }) {
  const hits = [];
  const lower = surface.toLowerCase();

  // 1. Name occurrences for every first-degree person (word-boundary, full
  //    display name only — never substring or bare first names; both were
  //    tried and produced false-positive storms on the live corpus).
  const occurrences = []; // { person, center }
  let ownPerson = null;
  for (const person of firstDegree) {
    if (ownEntityId != null && String(ownEntityId) === String(person.id)) ownPerson = person;
    const full = String(person.display_name).trim();
    if (full.split(/\s+/).length < 2 && !(ownPerson === person)) continue;
    const nameRe = new RegExp(`\\b${full.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'g');
    let m;
    while ((m = nameRe.exec(lower)) !== null) {
      occurrences.push({ person, center: m.index + m[0].length / 2 });
    }
  }
  if (!occurrences.length && !ownPerson) return hits;

  // 2. Attribute each claim occurrence to the nearest name (or to the card's
  //    own entity when no name is in range), then compare classes.
  const seen = new Set(); // `${personId}:${claim}` — one hit per pair per doc
  for (const [claim, claimClass] of CLAIM_CLASSES) {
    const claimRe = new RegExp(`\\b${claim.replace(/[-\s]/g, '[-\\s]')}\\b`, 'gi');
    let m;
    while ((m = claimRe.exec(lower)) !== null) {
      // Longest-first guard: a "mother" match inside "mother-in-law" is not
      // a blood claim — skip when the match is followed by "-in-law".
      if ((claimClass === 'blood' || claimClass === 'spouse')
        && /^[-\s]in[-\s]law/.test(lower.slice(m.index + m[0].length))) continue;
      // st_f67bc2eb — possessive-chain guard: in a walk-derived phrase
      // ("your wife's cousin", "your wife's mother's house") the token before
      // the apostrophe is a POSSESSOR, not a claim about the adjacent person.
      // Without this, every regenerated wife-side card false-positives on its
      // own correct phrasing.
      if (/^['’]s\b/.test(lower.slice(m.index + m[0].length))) continue;
      // Preceding-possessive guard: "<name>'s wife" states whose relative the
      // CLAIM WORD's subject is — a claim about the possessive phrase's
      // object, not about whichever third person happens to sit nearby
      // (live false positive: "person-a, who is owner's wife" flagged on an
      // unrelated card because that card's person was the nearest full name).
      const preceding = lower.slice(Math.max(0, m.index - 24), m.index);
      if (/[a-z]['’]s\s+$/.test(preceding)) continue;
      const pos = m.index;
      // Derived-phrase consistency: a claim that appears INSIDE the
      // attributed person's own walk-derived phrase is the graph truth
      // restated, never a contradiction ("cousin" within "wife's cousin").
      const derivedGuard = (person) => {
        const phrase = String(person?.relation_derived_phrase || '').toLowerCase();
        if (!phrase || !phrase.includes(claim)) return false;
        const start = Math.max(0, m.index - (phrase.length + 8));
        return lower.slice(start, m.index + m[0].length + 2).includes(phrase);
      };

      // Attribution 1 — appositive first name: "…sister Sarah…" names the
      // claim's subject directly. If the word immediately after (or the
      // capitalized word right before) the claim is the first token of a
      // first-degree person's name, that person owns the claim.
      let attributed = null;
      const afterWord = (lower.slice(m.index + m[0].length).match(/^[\s,]*([a-z][a-z'’-]+)/) || [])[1] || null;
      const beforeWord = (lower.slice(Math.max(0, m.index - 40), m.index).match(/([a-z][a-z'’-]+)[\s,]*$/) || [])[1] || null;
      for (const person of firstDegree) {
        const first = String(person.display_name).trim().split(/\s+/)[0].toLowerCase();
        if (first.length >= 3 && (afterWord === first || beforeWord === first)) { attributed = person; break; }
      }

      // Attribution 2 — nearest in-window full-name occurrence; else the
      // card's own entity.
      if (!attributed) {
        let best = Infinity;
        for (const occ of occurrences) {
          const d = Math.abs(occ.center - pos);
          if (d <= ADJACENCY_WINDOW && d < best) { best = d; attributed = occ.person; }
        }
      }
      if (!attributed && ownPerson) attributed = ownPerson;
      if (!attributed) continue;

      const gClass = graphClass(attributed.relation_tag);
      if (!contradicts(gClass, claimClass)) continue;
      if (derivedGuard(attributed)) continue;

      // Anchor policy: romance claims on a spouse-tagged person's OWN card
      // count anywhere (the defect card's "began romantically… cohabitating
      // couple" carries no possessive anchor); every other claim must be
      // owner-anchored, or it is a statement about a third party.
      const own = ownPerson === attributed;
      const requireAnchor = !(own && gClass === 'spouse' && claimClass === 'romance');
      if (requireAnchor && !claimIsOwnerAnchored(lower, pos)) continue;

      const key = `${attributed.id}:${claim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        doc: docLabel,
        person: attributed.display_name,
        person_id: attributed.id,
        // st_f67bc2eb reader-precedence rule: the walk-derived phrase is the
        // graph truth shown in the report ("wife's cousin", not "in-law").
        graph: attributed.relation_derived_phrase || relationPhrase(attributed.relation_tag, attributed.relation_label),
        claim: m[0],
        claim_class: claimClass,
      });
    }
  }
  return hits;
}

// ── Walk every entity context file + every topic card ────────────────────────
// Entity cards live at user/contexts/{people,companies,places}/{slug}/context.md
// (one directory per entity, every file named context.md) — the walk must
// RECURSE and identity must key on the FULL resolved path, never the basename.
const contradictionsAll = [];
const orphanDocs = [];
const flaggedPeople = new Set();
const flaggedTopics = new Set();

function resolveCardPath(raw) {
  const p = String(raw || '').trim();
  if (!p) return null;
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p.startsWith('/')) return p;
  return resolve(homedir(), 'robotdojo', p);
}

// Map each first-degree person's OWN card (full resolved path) so the
// whole-surface adjacency rule applies to it.
const ownCardByPath = new Map();
for (const p of firstDegree) {
  try {
    const row = db.prepare('SELECT context_file_path FROM people WHERE id = ?').get(p.id);
    const abs = resolveCardPath(row?.context_file_path);
    if (abs) ownCardByPath.set(abs, p.id);
  } catch { /* non-fatal */ }
}

function walkMarkdown(root, out = []) {
  let entries = [];
  try { entries = readdirSync(root); } catch { return out; }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkMarkdown(full, out);
    else if (st.isFile() && name.endsWith('.md')) out.push(full);
  }
  return out;
}

let entityFilesScanned = 0;
for (const sub of ['people', 'companies', 'places']) {
  const dir = resolve(USER_CONTEXTS_DIR, sub);
  if (!existsSync(dir)) continue;
  for (const file of walkMarkdown(dir)) {
    let raw;
    try { raw = readFileSync(file, 'utf8'); } catch { continue; }
    const surface = injectedSurface(raw);
    if (!surface) continue;
    entityFilesScanned++;
    const docOwner = ownCardByPath.get(file) ?? null;
    const hits = scanSurface(surface, {
      docLabel: `entity:${file.split('/').slice(-3).join('/')}`,
      ownEntityId: docOwner,
    });
    if (!hits.length) continue;

    // ORPHAN GUARD: a person card whose entity row no longer exists (merged/
    // deleted duplicate) and that no people.context_file_path references has
    // ZERO injection surface — no prompt path can ever read it. It is dead
    // residue for the nightly orphan lint, not a chat-truth contradiction; a
    // regen cannot fix a row that does not exist. Reported loudly, tracked
    // separately, never blocks the gate.
    let docEntityId = null;
    if (sub === 'people') {
      const dirShortId = (file.split('/').slice(-2, -1)[0].match(/--([0-9a-f]{8,16})$/) || [])[1];
      if (dirShortId) {
        try {
          docEntityId = db.prepare(`SELECT id FROM people WHERE REPLACE(id, '-', '') LIKE ? || '%'`).get(dirShortId)?.id || null;
        } catch { /* non-fatal */ }
      }
      if (!docEntityId) {
        let referenced = 0;
        try {
          referenced = db.prepare('SELECT COUNT(*) n FROM people WHERE context_file_path LIKE ?')
            .get(`%${file.split('/').slice(-2).join('/')}`)?.n || 0;
        } catch { /* non-fatal */ }
        if (!referenced) {
          for (const h of hits) orphanDocs.push({ ...h, doc: `orphan:${h.doc}` });
          continue;
        }
      }
    }

    for (const h of hits) {
      contradictionsAll.push(h);
      // The card that needs regenerating is the DOCUMENT's entity (a
      // duplicate un-merged row's card must flag ITSELF, not only the graph
      // person the claim is about); flag the claim-subject person too so
      // their own card refreshes.
      if (docOwner) flaggedPeople.add(docOwner);
      if (docEntityId) flaggedPeople.add(docEntityId);
      flaggedPeople.add(h.person_id);
    }
  }
}

let topicRows = [];
try {
  topicRows = db.prepare(`
    SELECT slug, context_md FROM user_topics
    WHERE context_md IS NOT NULL AND length(context_md) > 0
  `).all();
} catch { /* user_topics absent on minimal installs */ }
for (const t of topicRows) {
  const surface = injectedSurface(t.context_md);
  if (!surface) continue;
  const hits = scanSurface(surface, { docLabel: `topic:${t.slug}` });
  for (const h of hits) {
    contradictionsAll.push(h);
    flaggedTopics.add(t.slug);
  }
}

// ── Report + optional regen ──────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ contradictions: contradictionsAll, orphans: orphanDocs }, null, 2));
} else {
  for (const h of contradictionsAll) {
    console.log(`[card-graph-consistency] CONTRADICTION ${h.doc} — "${h.claim}" near ${h.person}, graph says: ${h.graph}`);
  }
  for (const h of orphanDocs) {
    console.log(`[card-graph-consistency] ORPHAN (no entity row, no injection surface) ${h.doc} — "${h.claim}" near ${h.person}; candidate for the orphan lint / manual cleanup`);
  }
}

if (REGEN && (flaggedPeople.size || flaggedTopics.size)) {
  for (const id of flaggedPeople) {
    try {
      db.prepare('UPDATE people SET needs_regen = 1 WHERE id = ?').run(id);
    } catch (err) {
      console.warn(`[card-graph-consistency] needs_regen flag failed for ${id}: ${err.message}`);
    }
  }
  console.log(`[card-graph-consistency] flagged ${flaggedPeople.size} person card(s) needs_regen=1 (regenerated by regen-entities)`);
  if (flaggedTopics.size) {
    const { generateTopicContext } = await import('../../lib/topic-context.js');
    for (const slug of flaggedTopics) {
      try {
        await generateTopicContext(slug, db);
        console.log(`[card-graph-consistency] regenerated topic card: ${slug}`);
      } catch (err) {
        console.warn(`[card-graph-consistency] topic regen failed for ${slug}: ${err.message}`);
      }
    }
  }
}

const scannedTopics = topicRows.length;
console.log(`[card-graph-consistency] first-degree people=${firstDegree.length} entity files scanned=${entityFilesScanned} topics scanned=${scannedTopics} contradictions=${contradictionsAll.length} orphan-docs=${orphanDocs.length}`);
// A populated first-degree graph with ZERO scannable entity files means the
// walk is broken, not that the corpus is clean — fail loud, never
// silently-green (the exact bug this line was added after).
if (firstDegree.length && entityFilesScanned === 0) {
  console.error('[card-graph-consistency] FAIL — no entity context files found to scan; the walk or paths are broken');
  process.exit(1);
}
process.exit(contradictionsAll.length ? 1 : 0);
