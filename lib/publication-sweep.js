/**
 * lib/publication-sweep.js — AC5: the one-time, owner-cleared pass over the
 * published file set (st_dd0e19d8 Phase 3).
 *
 * THE AGENT PROPOSES; THE OWNER DISPOSES. Key Design Principle 3 — identity is
 * never trusted to an LLM, and it is not trusted to a heuristic either. Nothing
 * in this module removes, keeps, edits or permits anything. It produces ONE
 * artifact: a written candidate list with an empty decision column. Every edit
 * that follows is applied by the build AFTER the owner has decided, which is why
 * this module has no write path to a tracked file, to the permitted list, or to
 * the corpus, and why it takes no `--fix` of any kind.
 *
 * ONE PASS, NOT A DETECTOR. Scope OOS 1 seals out a standing general-purpose
 * name detector. What keeps this inside that seal is not its precision but its
 * PLACEMENT: nothing invokes it on commit or during publication, its interface is
 * a document, and it terminates in a person's decisions. Design §8.
 *
 * ── THE CEILING, AND WHY IT IS COUNTED FIRST ────────────────────────────────
 *
 * The framing this story serves removes "auditing every file myself". A
 * candidate list of a thousand rows IS that audit, handed back with extra steps.
 * So the run is bounded: count first, write the count down, and present NOTHING
 * when the count exceeds the ceiling. The ordering is the whole point — a run
 * that renders the list and then reports "that was 900, sorry" has already spent
 * the owner's attention. Counting first is what makes the bound protect him on
 * the run that breaches it rather than after he has seen it.
 *
 * ── THE TWO ARMS, AND WHY THEY ARE DIFFERENT KINDS OF THING ─────────────────
 *
 *   A. CORPUS — every finding the expanded gate produces over the swept set,
 *      with the three small reference dictionaries UN-SKIPPED (AC5 sweeps them;
 *      the gate normally skips them because scanning a dictionary you match
 *      against matches itself, and for the sweep that self-match is the point).
 *      These are terms from the owner's own graph: high precision, and they are
 *      the reason the plan requires the sweep to be seeded by a REAL gate run
 *      rather than by a prior enumeration.
 *
 *   B. INBOX-DERIVED LISTS — every entry of the three hardcoded lists in
 *      scripts/ingest/03b-service-vendor.js. These are candidates by PROVENANCE,
 *      not by detection: the lists were built by reading the owner's own inbox,
 *      so `jewelersmutual` and `ayrheads` sit beside `billing` and `support` and
 *      no measurable property separates them. AC1 says this list "still holds
 *      specific-firm-shaped entries" and "goes through the owner-cleared sweep
 *      rather than being assumed clean"; design §6.2 extends that from
 *      BRAND_SERVICE_NAMES to all three, which is the extension a natural
 *      reading of AC1 alone would have missed.
 *
 * WHAT DELIBERATELY IS NOT AN ARM: a general capitalized-name-shape detector
 * over the swept files. Two reasons, and the second is the honest one. It would
 * be the standing detector OOS 1 seals out, applied once; and AC19's first
 * residual class already concedes, in the sealed scope, that a real person's
 * name absent from the owner's data may never be surfaced to him. Adding the arm
 * here would be building past the plan. MEASURED, so the concession is not
 * hand-waved: over the six names AC1 removes, the AND rule ("a known given name
 * AND a known surname") catches 0 of 6 — each of the six satisfies exactly one
 * of the two dictionaries and neither satisfies both. Relaxing to OR catches all
 * six and turns 1,492 files into a different order of noise, and it still misses
 * a name whose tokens are in neither dictionary — the two mentor names in the
 * persona files are the standing counterexample.
 *
 * THE MEASUREMENT IS STATED WITHOUT ITS INPUTS, ON PURPOSE. Naming the six here
 * to "show the working" would publish them from inside the file that removes
 * them — this module ships in the published set, and a comment ships as surely
 * as code. The inputs live in the story's gitignored sweep record; what belongs
 * in tracked source is the count. QA st_dd0e19d8 caught exactly that leak here.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 *
 * NO OWNER DATA LIVES IN THIS FILE. Every term arrives at runtime from the
 * corpus or from the module being swept. The OUTPUT is full of owner data by
 * construction, which is why it is written only into the gitignored story
 * directory and never into config/.
 */

import { normTerm } from './publication-posture.js';

/**
 * AC5's four carve-outs, with the sealed scope's own reason for each. The proof
 * script re-derives this list from the criterion text independently — two
 * statements of the same fact, so a silent edit to one is visible against the
 * other.
 */
export const SWEEP_CARVE_OUTS = [
  {
    path: 'config/surnames-top-25K.json',
    reason: 'bulk dictionary — 25,005 surnames. A list that size defeats any candidate list a person can actually read.',
  },
  {
    path: 'config/nicknames.json',
    reason: 'bulk dictionary — 2,164 nicknames, same argument.',
  },
  {
    path: 'config/yc-domains.json',
    reason: 'bulk dictionary — 5,862 startup domains, same argument.',
  },
  {
    path: 'config/owner-corpus-allowlist.json',
    reason: 'handled separately by AC22, which splits it rather than sweeping it.',
  },
];

/**
 * The three small reference files the gate skips but AC5 sweeps. The gate skips
 * them because a scanner cannot scan the dictionary it matches against without
 * matching itself; the sweep wants exactly that self-match, because an entry of
 * one of these files that intersects the owner's graph is the signal.
 */
export const SWEEP_UNSKIP = [
  { path: 'config/big-tech-domains.json', reason: 'AC5: 129 large-employer domains are swept, not carved out' },
  { path: 'config/vc-firms-domains.json', reason: 'AC5: 52 investor domains are swept' },
  { path: 'config/service-vendor-keywords.json', reason: 'AC5: the 28-entry service-vendor keyword file is swept' },
];

/**
 * ── ARM C, AND THE OWNER DECISION THAT CREATED IT ──────────────────────────
 *
 * Un-skipping the three reference files (SWEEP_UNSKIP above) only surfaces the
 * entries that INTERSECT the owner's graph — six of the 209. The owner read that
 * and decided the enumeration goes further: "List every entry (451, halts)."
 * Every entry of all three files is a candidate, whether or not anything matched
 * it, because "the owner has been shown the list" is the property AC5 is really
 * about and a detector-filtered list does not have it.
 *
 * The entries are read from the files by the facade and injected here as
 * `[{ name, file, entries: [{ term, detail }] }]`, so this module keeps its
 * no-filesystem, no-owner-data property.
 */
export function referenceListCandidates(lists) {
  const out = new Map();
  for (const list of lists) {
    for (const entry of list.entries) {
      const key = `term:${normTerm(entry.term)}`;
      if (!out.has(key)) {
        out.set(key, {
          key,
          term: entry.term,
          arm: 'reference-list',
          classes: new Set(),
          sites: [],
          lists: [],
          details: [],
        });
      }
      const c = out.get(key);
      c.lists.push(list.name);
      c.details.push(entry.detail || '');
      // `ref` (not `list`) tags a reference-list site. The inbox arm also stamps
      // `list`, so a term carried by BOTH arms would otherwise be routed by
      // whichever site happened to be first in the merged array — which sent
      // five reference entries to the individual pile on the first run.
      c.sites.push({ file: list.file, line: entry.line || null, ref: list.name });
    }
  }
  return [...out.values()];
}

/**
 * The ceiling decision, as a pure function so it can be proven at the exact
 * boundary without running a 20-second gate pass. `count > ceiling` rather than
 * `>=`: a run that lands exactly on the ceiling is inside its bound.
 */
export function ceilingVerdict(count, ceiling) {
  return { within: count <= ceiling, halt: count > ceiling, count, ceiling };
}

/** The swept set: the manifest's published set, less the four carve-outs. */
export function sweptSet(publishedPaths, carveOuts = SWEEP_CARVE_OUTS) {
  const carved = new Set(carveOuts.map((c) => c.path));
  return publishedPaths.filter((p) => !carved.has(p));
}

/**
 * The posture inputs for a sweep run: the gate's own skip set, less the three
 * reference files the sweep un-skips. Returned as both a Set (for `posture()`)
 * and as git pathspec exclusions, derived from one list so they cannot disagree.
 */
export function sweepScanScope(table, unskip = SWEEP_UNSKIP) {
  const unskipped = new Set(unskip.map((u) => u.path));
  const rows = (table.skip_paths || []).filter((e) => !unskipped.has(e.path));
  return { skip: new Set(rows.map((e) => e.path)), pathspecs: rows.map((e) => `:!${e.path}`) };
}

/**
 * Arm A — turn gate findings into candidates, one per distinct term, carrying
 * every site it was seen at.
 *
 * ONE ROW PER TERM, NOT PER SITE. AC1's own worked example is a single person's
 * name appearing at three sites: one name, one decision, three edits. A row per
 * site would ask the owner the same question three times and inflate the count
 * against the ceiling for no added information.
 *
 * A finding whose term could not be resolved still becomes a candidate, keyed by
 * its file and line. Dropping it would be the gate quietly deciding that
 * something it flagged does not need a decision.
 */
export function corpusCandidates(findings) {
  const out = new Map();
  for (const f of findings) {
    const term = f.term || null;
    const key = term ? `term:${normTerm(term)}` : `site:${f.file}:${f.line}`;
    if (!out.has(key)) {
      out.set(key, {
        key,
        term: term || `(unresolved match in ${f.file}:${f.line})`,
        arm: 'corpus',
        classes: new Set(),
        sites: [],
      });
    }
    const c = out.get(key);
    c.classes.add(f.class);
    c.sites.push({ file: f.file, line: f.line });
  }
  return [...out.values()];
}

/**
 * Arm B — the inbox-derived lists, one candidate per entry.
 *
 * `lists` is `[{ name, file, entries }]`, injected rather than imported so this
 * module has no dependency on the ingest pipeline and the proof can drive it
 * with a fixture.
 */
export function inboxListCandidates(lists) {
  const out = new Map();
  for (const list of lists) {
    for (const raw of list.entries) {
      // An entry is `{term, fromOverride}` or a bare string. `fromOverride` says
      // the entry reaches the runtime set from the owner's GITIGNORED override
      // rather than from the tracked file — i.e. it has already been moved out
      // of the published tree and there is nothing left for him to decide.
      const entry = typeof raw === 'string' ? { term: raw, fromOverride: false } : raw;
      const key = `term:${normTerm(entry.term)}`;
      if (!out.has(key)) {
        out.set(key, {
          key,
          term: entry.term,
          arm: 'inbox-list',
          classes: new Set(),
          sites: [],
          lists: [],
          origins: [],
        });
      }
      const c = out.get(key);
      c.lists.push(list.name);
      c.origins.push(entry.fromOverride ? 'override' : 'tracked');
      c.sites.push({
        file: entry.fromOverride ? list.overrideFile || list.file : list.file,
        line: null,
        list: list.name,
      });
    }
  }
  return [...out.values()];
}

/**
 * Merge the arms into one list, deduped by term. A term found by both arms keeps
 * both provenances — that a corpus term ALSO sits in an inbox-derived list is
 * information the owner needs, because it changes the fix: AC1 routes a live
 * classification entry to his local settings rather than replacing it.
 */
export function mergeCandidates(...arms) {
  const out = new Map();
  for (const candidate of arms.flat()) {
    const existing = out.get(candidate.key);
    if (!existing) {
      out.set(candidate.key, {
        ...candidate,
        arms: new Set([candidate.arm]),
        classes: new Set(candidate.classes),
        lists: [...(candidate.lists || [])],
        details: [...(candidate.details || [])],
        origins: [...(candidate.origins || [])],
      });
      continue;
    }
    existing.arms.add(candidate.arm);
    for (const c of candidate.classes) existing.classes.add(c);
    existing.sites.push(...candidate.sites);
    existing.lists.push(...(candidate.lists || []));
    existing.details.push(...(candidate.details || []));
    existing.origins.push(...(candidate.origins || []));
  }
  return [...out.values()].sort((a, b) => normTerm(a.term).localeCompare(normTerm(b.term)));
}

// ── GROUPING (owner decision 11: "Group them (~8 decisions)") ────────────────
//
// THE PROBLEM THE GROUPS SOLVE. Enumerating every entry of the three reference
// files (owner decision 10) puts the candidate count over the ceiling, and the
// ceiling is not a formality — a 400-row list handed back one row at a time IS
// the file-by-file audit this story exists to remove. The owner's re-scope keeps
// the coverage and changes the UNIT: every candidate is still shown, but the
// thing he has to decide is a group.
//
// SO THE CEILING MOVES WITH IT. It is applied to DECISIONS REQUIRED, not to
// rows. That is the same bound doing the same job — it bounds his attention —
// and it still fires: a grouping that degenerated into 400 singleton groups
// would halt exactly as the flat list did.
//
// EVERY RULE BELOW IS STRUCTURAL. Which arm produced the candidate, which file
// or list it came from, which corpus class matched, and which zone of the tree
// its sites are in. NOTHING keys off what a term MEANS, because a rule that
// knows "Apple is public and this other name is not" is owner data written into
// a tracked file — the exact leak this story is closing. Where the structure
// cannot separate two candidates, they are NOT grouped: the row goes to the
// individual list and the owner decides it himself.

/** Site zones. Used only to keep a group homogeneous, never to decide anything. */
export function siteZone(file) {
  if (/(^|\/)tests\//.test(file) || /\.(test|spec)\.js$/.test(file) || file.startsWith('scripts/qa/')) return 'tests';
  if (file.startsWith('apps/')) return 'web';
  return 'source';
}

/**
 * Person-shaped: any word of the term is a key in the repository's own first-name
 * or surname dictionaries.
 *
 * THIS IS AN ORDERING SIGNAL, NOT A DETECTOR, and the distinction is the one OOS
 * 1 turns on. It never decides that something IS a person and it never suppresses
 * a candidate — every candidate is presented either way. All it does is pull a
 * row OUT of a group so the owner reads it individually. Erring toward "person"
 * costs one more row on his list; erring the other way would bury a real name
 * inside a group decision, which is the failure that matters.
 *
 * The OR (not AND) is measured, not chosen: of the six names AC1 removes, each
 * has exactly one of its two words in these dictionaries, so requiring both
 * catches none of them.
 */
export function personShaped(term, nameTokens) {
  return normTerm(term).split(' ').some((w) => w.length > 1 && nameTokens.has(w));
}

/**
 * Classes that always get an individual row. An address, an id, a Tier A term, a
 * private-settings term, an employer domain or a path term is owner-specific by
 * the definition of its own class — there is no group in which one word is a
 * sound decision for all of them.
 */
export const ALWAYS_INDIVIDUAL_CLASSES = new Set(['emails', 'entity_ids', 'terms', 'private_terms', 'domains', 'paths']);

/**
 * The group catalogue. `decision` non-null means the decision is already
 * recorded — either the owner made it (decision 13) or the tree already carries
 * the evidence (the term is in a gitignored override, so it has been moved).
 * A group with a recorded decision costs the owner nothing and is not counted
 * against the ceiling.
 */
export function groupCatalogue(ownerDecisions = {}) {
  return [
    {
      id: 'already-moved',
      label: 'Already moved to your local settings — nothing left to decide',
      decision: 'move',
      why: 'these reach the live classification lists only from your gitignored settings; the tracked copy is already gone. Listed for completeness, not for a decision.',
    },
    {
      id: 'inbox-system-words',
      label: 'Ordinary system and role words from your two email-local-part lists',
      decision: 'clear',
      why: ownerDecisions.inboxSystemWords
        || 'recorded owner decision: these stay. Ordinary words that entered the lists because senders used them as From-names.',
    },
    { id: 'inbox-brands', label: 'Named third-party services in your inbox-derived brand list', decision: null },
    { id: 'reference-employers', label: 'Large-employer reference list — every entry', decision: null },
    { id: 'reference-investors', label: 'Investor reference list — every entry', decision: null },
    { id: 'reference-trade-keywords', label: 'Service trade-keyword reference list — every entry', decision: null },
    { id: 'corpus-tests', label: 'Words from your records that appear only in test and QA fixtures', decision: null },
    { id: 'corpus-web', label: 'Words from your records that appear only in the public web copy', decision: null },
    { id: 'corpus-source', label: 'Words from your records that appear only in product and script source', decision: null },
    { id: 'individual', label: 'Decide these one at a time', decision: null },
  ];
}

/**
 * Place one candidate. `deps.nameTokens` is the first-name/surname dictionary
 * key set, injected so this module reads no files and holds no owner data.
 *
 * ALREADY-MOVED IS A NARROW CLAIM, deliberately. It applies only to an
 * inbox-list entry that reaches the runtime set exclusively from the gitignored
 * override — that entry is, by construction, no longer in any tracked file. It
 * must NOT be inferred from "the term appears in some local override", which was
 * the first version and was wrong in a way that would have hidden real work: a
 * reference-list entry is read OUT of a tracked file, so its presence in an
 * override says nothing about whether the tracked copy is still there.
 */
export function groupOf(deps, c) {
  const origins = c.origins || [];
  if (
    c.arms.size === 1
    && c.arms.has('inbox-list')
    && origins.length > 0
    && origins.every((o) => o === 'override')
  ) {
    return 'already-moved';
  }

  if (c.arms.has('reference-list')) {
    const ref = (c.sites.find((s) => s.ref) || {}).ref || '';
    if (ref === 'big-tech-domains') return 'reference-employers';
    if (ref === 'vc-firms-domains') return 'reference-investors';
    if (ref === 'service-vendor-keywords') return 'reference-trade-keywords';
    return 'individual';
  }

  if (c.arms.has('corpus')) {
    for (const cls of c.classes) if (ALWAYS_INDIVIDUAL_CLASSES.has(cls)) return 'individual';
    if (personShaped(c.term, deps.nameTokens || new Set())) return 'individual';
    // A term the corpus found AND an inbox list carries is two different kinds of
    // fix (AC1 routes a live classification rule to local settings rather than
    // replacing it), so it is never folded into a single-word group decision.
    if (c.arms.has('inbox-list')) return 'individual';
    const zones = new Set(c.sites.filter((s) => s.file).map((s) => siteZone(s.file)));
    if (zones.size !== 1) return 'individual';
    return `corpus-${[...zones][0]}`;
  }

  if (c.arms.has('inbox-list')) {
    const lists = new Set(c.lists || []);
    const systemOnly = [...lists].every((l) => l === 'SYSTEM_LOCAL_TOKENS' || l === 'SYSTEM_LOCAL_SUBSTRINGS');
    return systemOnly ? 'inbox-system-words' : 'inbox-brands';
  }
  return 'individual';
}

/** Bucket every candidate. Empty groups are dropped; order follows the catalogue. */
export function assignGroups(deps, candidates, ownerDecisions = {}) {
  const catalogue = groupCatalogue(ownerDecisions);
  const byId = new Map(catalogue.map((g) => [g.id, { ...g, rows: [] }]));
  for (const c of candidates) {
    const id = groupOf(deps, c);
    (byId.get(id) || byId.get('individual')).rows.push(c);
  }
  return [...byId.values()].filter((g) => g.rows.length > 0);
}

/**
 * What the owner actually has to decide: one per group without a recorded
 * decision, plus one per row in the individual list. This is the number the
 * ceiling judges.
 */
export function decisionsRequired(groups) {
  return groups.reduce((n, g) => {
    if (g.decision) return n;
    return n + (g.id === 'individual' ? g.rows.length : 1);
  }, 0);
}

/** Where a candidate came from, in words the owner can act on. */
function provenanceOf(c) {
  const parts = [];
  if (c.arms.has('corpus')) parts.push(`your own records (${[...c.classes].sort().join(', ')})`);
  if (c.arms.has('inbox-list')) parts.push(`built from your inbox (${[...new Set(c.lists)].join(', ')})`);
  if (c.arms.has('reference-list')) {
    const detail = (c.details || []).filter(Boolean)[0];
    parts.push(`reference list entry${detail ? ` (${detail})` : ''}`);
  }
  return parts.join('; ');
}

/** Where it appears, bounded so one noisy term cannot swamp the document. */
function sitesOf(c, limit = 6) {
  const seen = [];
  for (const s of c.sites) {
    const label = s.line ? `${s.file}:${s.line}` : `${s.file}`;
    if (!seen.includes(label)) seen.push(label);
  }
  const shown = seen.slice(0, limit).join('<br>');
  return seen.length > limit ? `${shown}<br>… ${seen.length - limit} more` : shown;
}

/**
 * Render the decision document. The decision column is EMPTY by construction —
 * this module never proposes a verdict, because a pre-filled column is a default
 * the owner has to argue with rather than a question he answers.
 */
export function renderDecisions(candidates, provenance) {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const lines = [];
  lines.push('# AC5 — owner-cleared sweep: candidate list');
  lines.push('');
  lines.push(`**${candidates.length} candidates.** One row per distinct name. Fill the Decision column:`);
  lines.push('`clear` (it is generic or public and stays), `replace` (swap for a placeholder), or');
  lines.push('`move` (it is a live classification rule — route it to your local settings instead).');
  lines.push('');
  lines.push('Nothing has been changed. No entry has been removed, kept, or permitted automatically.');
  lines.push('');
  lines.push('## Decisions');
  lines.push('');
  lines.push('| # | Candidate | Where it came from | Where it appears | Decision |');
  lines.push('|---|---|---|---|---|');
  candidates.forEach((c, i) => {
    lines.push(`| ${i + 1} | \`${esc(c.term)}\` | ${esc(provenanceOf(c))} | ${esc(sitesOf(c))} |  |`);
  });
  lines.push('');
  lines.push('## Provenance');
  lines.push('');
  for (const line of provenance) lines.push(line);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Render the GROUPED decision document (owner decision 11).
 *
 * THE SHAPE IS THE CONTRACT. Every candidate is still printed, numbered
 * continuously across the whole document — the owner asked for every entry and
 * a group that hides its members would be a summary, not an enumeration. What
 * changes is where the decision goes: each group carries ONE `Group decision`
 * field that governs every row beneath it, and a row's own Decision cell is an
 * override for the rare member that does not follow its group.
 *
 * A group whose decision is already recorded prints that decision AND the
 * evidence for it, in the same place the owner would have written it. Recording
 * it silently on the rows — or dropping those rows because they are settled —
 * would be the sweep deciding, which is the one thing it may not do.
 */
export function renderGroupedDecisions(groups, provenance, meta = {}) {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const open = decisionsRequired(groups);
  const lines = [];
  lines.push('# AC5 — owner-cleared sweep: candidate list');
  lines.push('');
  lines.push(`**${total} candidates.** One row per distinct name, every one listed.`);
  lines.push('');
  lines.push(
    `They are bundled into **${groups.length} groups**, of which `
      + `**${open} need a decision from you** (${groups.filter((g) => g.decision).length} are already recorded, `
      + 'with the evidence stated under each).'
  );
  lines.push('');
  lines.push('Write one word in the **Group decision** field and it governs every row in that group:');
  lines.push('`clear` (generic or public — it stays), `replace` (swap for a placeholder), or');
  lines.push('`move` (a live classification rule — route it to your local settings instead).');
  lines.push('A row\'s own Decision cell overrides its group, for the odd member that does not follow.');
  lines.push('');
  lines.push('Nothing has been changed. No entry has been removed, kept, or permitted automatically.');
  lines.push('');

  let n = 0;
  for (const g of groups) {
    lines.push(`## ${g.label} (${g.rows.length})`);
    lines.push('');
    lines.push(`**Group decision:** ${g.decision ? `\`${g.decision}\`` : '`____`'}`);
    if (g.why) lines.push(`> ${g.why}`);
    if (g.id === 'individual') {
      lines.push('');
      lines.push(
        '> No structural property groups these with anything else — each is an address, an id, a term '
          + 'from your own settings, a word that reads as somebody\'s name, or a word that appears in more '
          + 'than one part of the tree. The Group decision field above is unused here; fill the Decision '
          + 'column row by row.'
      );
    }
    lines.push('');
    lines.push('| # | Candidate | Where it came from | Where it appears | Decision |');
    lines.push('|---|---|---|---|---|');
    for (const c of g.rows) {
      n += 1;
      lines.push(
        `| ${n} | \`${esc(c.term)}\` | ${esc(provenanceOf(c))} | ${esc(sitesOf(c))} | `
          + `${g.decision && g.id === 'already-moved' ? `\`${g.decision}\`` : ''} |`
      );
    }
    lines.push('');
  }

  lines.push('## Provenance');
  lines.push('');
  for (const line of provenance) lines.push(line);
  if (meta.halt) {
    lines.push('');
    lines.push(`- **The flat list halted, and that is recorded rather than undone.** ${meta.halt}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
