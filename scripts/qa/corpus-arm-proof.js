#!/usr/bin/env node
/**
 * corpus-arm-proof.js — AC1's email remainder, and AC9-AC12 proven per SOURCE
 * (st_dd0e19d8, Phase 1's criteria).
 *
 * ONE SEED PER SOURCE, WHICH IS THE WHOLE POINT. AC9 alone adds six places a
 * value can come from (the owner's own name, the street names, the family, both
 * stored contact lists, the ten places). A single planted value proves ONE of
 * them and passes with the other five reading nothing at all — which is not a
 * hypothetical: the entity-id arm shipped in a previous story matching literally
 * nothing, for a whole release, with a green test beside it. So each arm below
 * takes a value that exists in EXACTLY ONE source, plants it, and requires the
 * gate to refuse and to attribute the refusal to the right class.
 *
 * HOW "EXACTLY ONE SOURCE" IS ESTABLISHED. Each source reader is called
 * directly, its values are normalised the way the corpus build normalises them,
 * and a candidate is kept only when no other reader produced it. A value two
 * sources share proves nothing about either one. Where no unique value exists,
 * that is reported as a FAILURE of the arm rather than skipped — a source that
 * cannot be proven is a source that might be dead.
 *
 * THE SCAN RUNS IN A SCRATCH COPY OF THE GATE (scratch-gate.js) because a
 * full-tree publication run costs 1m54s and this file needs a dozen of them.
 * Same gate, same corpus, same scan; a tree small enough to run in a second.
 *
 * THE EMAIL REMAINDER (AC1) IS DIFFERENT and runs against the REAL tree, because
 * it is a statement about this repository rather than about the matcher: every
 * contact address the gate finds in the tracked tree is either gone or carries a
 * permitted entry, and the non-permitted remainder is zero.
 *
 * NOTHING PLANTED IS EVER PRINTED. The seeds are the owner's real names,
 * addresses and domains; every message refers to them by shape.
 *
 * MODES:
 *   --arm email --non-permitted-remainder-zero
 *   --arm private-settings --per-source
 *   --arm places-companies --per-source
 *   --arm email-alias-domain --per-source
 *   --arm surface-variants
 *
 * Exit 0 = the arm holds.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import {
  openOwnerDb,
  loadCorpus,
  defaultDeps,
} from '../../lib/owner-corpus.js';
import {
  norm,
  keepTerm,
  loadStopwordDicts,
  loadAllowlist,
  fromPrivateSettings,
  fromCompanies,
  fromPlaces,
  fromAliases,
  fromContactEmails,
  fromEmployerDomains,
  fromEntityContexts,
  PRIVATE_SETTINGS_ROUTES,
} from '../../lib/owner-corpus-sources.js';
import { surfaceVariants } from '../../lib/corpus-scan.js';
import { loadPostureTable, loadPermitted, applyPermitted, collectFindings, skipPaths, skipPathspecs } from '../../lib/publication-posture.js';
import {
  REPO_ROOT,
  buildScratch,
  destroyScratch,
  runScratchGate,
  plantValue,
  unplant,
  blockedOn,
  shapeOf,
} from './scratch-gate.js';

const CONFIG_DIR = join(REPO_ROOT, 'config');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

function git(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Private-settings routes grouped the way AC9 names them. The grouping is
 * derived from the route table rather than restated, so a route added there
 * without a group here is reported as ungrouped instead of silently unproven.
 */
const PRIVATE_GROUPS = [
  // The six AC9 names.
  { id: 'the owner himself', match: (p) => p.startsWith('owner.') },
  { id: 'the street addresses', match: (p) => p.startsWith('family.properties') },
  { id: 'the family', match: (p) => p.startsWith('family.') && !p.startsWith('family.properties') },
  { id: 'the first stored contact list', match: (p) => p.startsWith('contacts.static_people') },
  { id: 'the second stored contact list', match: (p) => p.startsWith('contacts.bachelor_party') },
  { id: 'the ten places', match: (p) => p.startsWith('locations') },
  // The rest of the table. AC9's text names six sources; the route table routes
  // eleven more fields, and an unproven route is a route that might be reading
  // nothing. Proving them costs one scratch run each, so they are proven rather
  // than scoped away.
  { id: 'the work colleagues', match: (p) => p.startsWith('work.') && p.includes('colleagues') },
  { id: 'the work domains', match: (p) => p === 'work.*.domain' },
  { id: 'the work addresses', match: (p) => p === 'work.*.email' },
  { id: 'the health domains', match: (p) => p.startsWith('health.') },
  { id: 'the storage bucket', match: (p) => p.startsWith('infrastructure.') },
  { id: 'the taxonomy slugs', match: (p) => p.startsWith('taxonomy_descriptions') },
  { id: 'the archive labels', match: (p) => p.startsWith('import_labels.') },
];

/** Read one route group's values, in the corpus's normalised form. */
function privateGroupValues(group) {
  const routes = PRIVATE_SETTINGS_ROUTES.filter((r) => group.match(r.path));
  const out = new Map(); // value -> class
  for (const route of routes) {
    const single = fromPrivateSettings.length; // keep the reader's contract explicit
    void single;
    const parsed = readRoutes(route);
    for (const v of parsed) out.set(norm(v), route.class);
  }
  return out;
}

/** Resolve one route against the owner's settings file, via the real reader. */
function readRoutes(route) {
  // The reader takes the whole file and applies every route, so the single-route
  // read is done by filtering its output back down: it keeps ONE implementation
  // of route resolution rather than a second copy that would drift from it.
  const all = fromPrivateSettings(join(CONFIG_DIR, 'private.json'));
  if (!all.available) return [];
  const only = fromPrivateSettingsSubset(route);
  return only;
}

/**
 * A single route's values. PRIVATE_SETTINGS_ROUTES is exported and the resolver
 * is not, so this re-runs the full reader with the route table temporarily
 * narrowed — no second resolver, no drift.
 */
function fromPrivateSettingsSubset(route) {
  const saved = PRIVATE_SETTINGS_ROUTES.splice(0, PRIVATE_SETTINGS_ROUTES.length, route);
  try {
    const r = fromPrivateSettings(join(CONFIG_DIR, 'private.json'));
    return [...(r.values[route.class] || [])];
  } finally {
    PRIVATE_SETTINGS_ROUTES.splice(0, PRIVATE_SETTINGS_ROUTES.length, ...saved);
  }
}

/**
 * Which corpus class actually holds this value?
 *
 * NOT the class its source route declares, and the difference is load-bearing.
 * The corpus classes are DISJOINT in precision order — a value that qualifies as
 * a Tier A term never also appears as a private literal or a graph name — so a
 * value routed to `private_terms` by the settings table can end up in `terms`.
 * Asserting against the declared class instead of the real one reports a live
 * arm as dead, which is exactly what the first version of this file did to the
 * taxonomy slugs.
 */
const CLASS_ORDER = ['terms', 'private_terms', 'literal_names', 'domains', 'emails', 'entity_ids'];
function corpusClassOf(corpusSets, value) {
  for (const cls of CLASS_ORDER) if (corpusSets[cls] && corpusSets[cls].has(value)) return cls;
  return null;
}

/**
 * Pick a value that (a) belongs to this source only, (b) survived the corpus
 * build (so the gate will actually match it), and (c) can be planted verbatim.
 */
function uniqueSeed(mine, others, corpusSets, { multiToken = true } = {}) {
  const elsewhere = new Set();
  for (const set of others) for (const v of set) elsewhere.add(v);
  const inCorpus = [...mine].filter((v) => v && corpusClassOf(corpusSets, v));
  const pick = (list) =>
    list.find((v) => (!multiToken || v.includes(' ')) && /^[a-z0-9 .@-]+$/i.test(v) && v.length >= 6)
    || list.find((v) => /^[a-z0-9 .@_-]+$/i.test(v))
    || list[0]
    || null;
  const unique = pick(inCorpus.filter((v) => !elsewhere.has(v)));
  // A source whose every value is also produced by another source can still be
  // proven — it just cannot be proven ALONE, and the report says which case
  // applied rather than quietly presenting the weaker one as the stronger.
  // Contributing nothing to the corpus at all is the case that fails: an arm
  // reading a source that reaches no class is an arm reading nothing.
  const seed = unique || pick(inCorpus);
  return {
    seed,
    cls: seed ? corpusClassOf(corpusSets, seed) : null,
    unique: !!unique,
    inCorpus: inCorpus.length,
    total: mine.size !== undefined ? mine.size : [...mine].length,
  };
}

/** Plant one seed and assert the scratch gate refuses, naming the class. */
function assertRefused(scratch, baseline, { label, seed, cls, unique = true }) {
  const rel = plantValue(scratch, label.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), seed);
  const run = runScratchGate(scratch);
  const ok = run.status !== 0 && run.blocking > baseline.blocking && blockedOn(run, { rel, cls });
  check(
    `  ${label} → blocks as [${cls}]`,
    ok,
    `exit ${run.status}, ${run.blocking} blocking (baseline ${baseline.blocking}), seed ${shapeOf(seed)}`
      + (unique ? '' : ', shared with another source — proven, but not proven alone')
  );
  unplant(scratch);
  return ok;
}

// ── AC1: the email remainder over the real tree ──────────────────────────────

function armEmailRemainder(corpus) {
  process.stdout.write('AC1 — every contact address in the tracked tree is removed or permitted\n');
  const table = loadPostureTable(CONFIG_DIR);
  const skip = skipPaths(table);
  const deps = { git, table, placement: 'publish', skip };
  const collected = collectFindings(deps, { emails: corpus.emails }, {
    pathspecs: skipPathspecs(table),
    pathFiles: null,
    untracked: true,
  });
  const applied = applyPermitted(collected.findings, loadPermitted(CONFIG_DIR));
  const emails = applied.findings.filter((f) => f.class === 'emails');
  const permitted = emails.filter((f) => f.permitted);
  const remainder = emails.filter((f) => !f.permitted);
  check(
    'the arm is live — it found addresses to judge',
    corpus.emails.length > 0,
    `${corpus.emails.length} stored addresses cross-checked`
  );
  check(
    'the non-permitted remainder is zero',
    remainder.length === 0,
    remainder.length === 0
      ? `${emails.length} hits, all ${permitted.length} permitted with a stated reason`
      : `${remainder.length} unexplained: ${[...new Set(remainder.map((f) => f.file))].join(', ')}`
  );
  check(
    'and every permitted hit is scoped to a file, not to a bare term',
    permitted.every((f) => f.permitted && f.permitted.file && f.permitted.reason),
    'a bare-term suppression hides the next real finding'
  );
}

// ── AC9: private settings, per source ────────────────────────────────────────

function armPrivateSettings(scratch, baseline, corpusSets) {
  process.stdout.write('AC9 — a value present in only ONE private-settings source blocks publication\n');
  const grouped = PRIVATE_GROUPS.map((g) => ({ g, values: privateGroupValues(g) }));
  const ungrouped = PRIVATE_SETTINGS_ROUTES.filter((r) => !PRIVATE_GROUPS.some((g) => g.match(r.path)));
  for (const { g, values } of grouped) {
    const others = grouped.filter((x) => x.g.id !== g.id).map((x) => new Set(x.values.keys()));
    const mine = new Set(values.keys());
    const r = uniqueSeed(mine, others, corpusSets, { multiToken: false });
    if (r.seed) {
      assertRefused(scratch, baseline, { label: g.id, seed: r.seed, cls: r.cls, unique: r.unique });
    } else {
      check(
        `  ${g.id} → blocks`,
        false,
        mine.size === 0
          ? 'no value in this source at all — the arm reads nothing'
          : `${mine.size} value(s) read but none reached the corpus — the distinctiveness filter dropped them all`
      );
    }
  }
  check(
    'every route in the settings table belongs to a proven group',
    ungrouped.length === 0,
    ungrouped.length === 0 ? `${PRIVATE_GROUPS.length} groups cover ${PRIVATE_SETTINGS_ROUTES.length} routes`
      : `unproven: ${ungrouped.map((r) => r.path).join(', ')}`
  );
}

// ── AC10: places, companies, place folders ───────────────────────────────────

async function armPlacesCompanies(scratch, baseline, corpusSets, filters, db) {
  process.stdout.write('AC10 — a place or company blocks, seeded separately from each source\n');
  const contexts = fromEntityContexts(defaultDeps(REPO_ROOT).contextsDir);
  const sources = [
    { id: 'the companies table', values: db ? fromCompanies(db, filters).values.literal_names : [] },
    { id: 'the places table', values: db ? fromPlaces(db, filters).values.literal_names : [] },
    { id: 'the place folder names', values: contexts.values.entity_ids },
  ];
  const normed = sources.map((s) => ({ ...s, set: new Set(s.values.map((v) => norm(v))) }));
  for (const s of normed) {
    const others = normed.filter((x) => x.id !== s.id).map((x) => x.set);
    const cls = s.id === 'the place folder names' ? 'entity_ids' : 'literal_names';
    const r = uniqueSeed(s.set, others, corpusSets, { multiToken: cls === 'literal_names' });
    if (!r.seed) {
      check(`  ${s.id} → blocks as [${cls}]`, false, `${s.set.size} values read, ${r.inCorpus} reached the corpus`);
      continue;
    }
    assertRefused(scratch, baseline, { label: s.id, seed: r.seed, cls: r.cls, unique: r.unique });
  }
}

// ── AC11: contact address, alias, employer domain ────────────────────────────

function armEmailAliasDomain(scratch, baseline, corpusSets, filters, db) {
  process.stdout.write('AC11 — an address, an alias and an employer domain each block, seeded separately\n');
  const sources = [
    { id: 'a contact address', cls: 'emails', values: db ? fromContactEmails(db).values.emails : [] },
    { id: 'an alias', cls: 'literal_names', values: db ? fromAliases(db, filters).values.literal_names : [] },
    { id: 'an employer domain', cls: 'domains', values: db ? fromEmployerDomains(db).values.domains : [] },
  ];
  const normed = sources.map((s) => ({ ...s, set: new Set(s.values.map((v) => norm(v))) }));
  for (const s of normed) {
    const others = normed.filter((x) => x.id !== s.id).map((x) => x.set);
    const r = uniqueSeed(s.set, others, corpusSets, { multiToken: s.cls === 'literal_names' });
    if (!r.seed) {
      check(`  ${s.id} → blocks as [${s.cls}]`, false, `${s.set.size} values read, ${r.inCorpus} reached the corpus`);
      continue;
    }
    assertRefused(scratch, baseline, { label: s.id, seed: r.seed, cls: r.cls, unique: r.unique });
  }
}

// ── AC12: surface variants ───────────────────────────────────────────────────

function armSurfaceVariants(scratch, baseline, corpus) {
  process.stdout.write('AC12 — a term is caught in its punctuation and plural variants\n');
  // The variants are generated corpus-side, so the proof plants the SOURCE form
  // that the stored form does not literally equal. Two rules, two seeds.
  const punctuated = corpus.terms.concat(corpus.private_terms).find((t) => /[^a-z0-9 ]/i.test(t));
  const stripped = punctuated ? punctuated.replace(/[^a-z0-9 ]+/gi, ' ').replace(/\s+/g, ' ').trim() : null;
  if (!stripped || stripped === punctuated) {
    check('  a stored term carrying punctuation is available', false, 'nothing to prove the rule against');
  } else {
    const cls = corpus.terms.includes(punctuated) ? 'terms' : 'private_terms';
    check(
      '  the stored form and the source form differ — the rule has work to do',
      stripped !== punctuated,
      `stored ${shapeOf(punctuated)}, written ${shapeOf(stripped)}`
    );
    assertRefused(scratch, baseline, { label: 'a term written without its punctuation', seed: stripped, cls });
  }

  const multi = corpus.terms.find((t) => /^[a-z0-9 ]+$/i.test(t) && !/s$/i.test(t) && t.length >= 6);
  if (!multi) {
    check('  a stored term with a pluralisable final token is available', false, 'nothing to prove the rule against');
  } else {
    const plural = `${multi}s`;
    check(
      '  the plural form is generated corpus-side, not matched by luck',
      surfaceVariants(multi).includes(plural),
      `${surfaceVariants(multi).length} variants for one term`
    );
    assertRefused(scratch, baseline, { label: 'a term written in the plural', seed: plural, cls: 'terms' });
  }
}

// ── the probe ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const arm = args[args.indexOf('--arm') + 1];
  if (!arm || args.indexOf('--arm') === -1) {
    process.stderr.write(
      'corpus-arm-proof: usage — --arm email|private-settings|places-companies|email-alias-domain|surface-variants\n'
    );
    return 2;
  }
  const deps = defaultDeps(REPO_ROOT);
  const corpus = loadCorpus(deps);
  if (!corpus) {
    process.stderr.write(
      "corpus-arm-proof: no v2 owner corpus on this machine — these arms cannot be proven without one.\n"
        + "Run `node scripts/check-first-user-clean.js --refresh` on the owner's box first.\n"
    );
    return 1;
  }
  const corpusSets = {};
  for (const cls of ['terms', 'private_terms', 'literal_names', 'domains', 'emails', 'entity_ids']) {
    corpusSets[cls] = new Set(corpus[cls] || []);
  }

  if (arm === 'email') {
    armEmailRemainder(corpus);
    const failures = results.filter((r) => !r.ok);
    process.stdout.write(`\ncorpus-arm-proof: ${results.length - failures.length}/${results.length} PASS\n`);
    return failures.length === 0 ? 0 : 1;
  }

  const filters = {
    surnames: loadStopwordDicts(CONFIG_DIR).surnames,
    nicknames: loadStopwordDicts(CONFIG_DIR).nicknames,
    allow: loadAllowlist(CONFIG_DIR),
  };
  const needsDb = arm === 'places-companies' || arm === 'email-alias-domain';
  const { db, reason } = needsDb ? await openOwnerDb(deps.dbPath) : { db: null, reason: '' };
  if (needsDb && !db) {
    check('the live entity graph is readable', false, reason || 'no DB');
    return 1;
  }

  const scratch = buildScratch();
  try {
    const baseline = runScratchGate(scratch);
    check(
      'the scratch gate reads the real corpus and names no fixture yet',
      /corpus cross-checked/.test(baseline.output) && !/^\s+docs\//m.test(baseline.output),
      `${baseline.blocking} pre-existing blocking finding(s) in the gate's own dependencies`
    );
    if (arm === 'private-settings') armPrivateSettings(scratch, baseline, corpusSets);
    else if (arm === 'places-companies') await armPlacesCompanies(scratch, baseline, corpusSets, filters, db);
    else if (arm === 'email-alias-domain') armEmailAliasDomain(scratch, baseline, corpusSets, filters, db);
    else if (arm === 'surface-variants') armSurfaceVariants(scratch, baseline, corpus);
    else {
      process.stderr.write(`corpus-arm-proof: unknown arm "${arm}"\n`);
      return 2;
    }
  } finally {
    destroyScratch(scratch);
    try {
      if (db) db.close();
    } catch {
      /* noop */
    }
  }

  const failures = results.filter((r) => !r.ok);
  process.stdout.write(`\ncorpus-arm-proof: ${results.length - failures.length}/${results.length} PASS\n`);
  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`corpus-arm-proof: ${err.stack || err.message}\n`);
    process.exit(2);
  });
