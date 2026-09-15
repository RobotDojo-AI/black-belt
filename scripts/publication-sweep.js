#!/usr/bin/env node
/**
 * publication-sweep.js — AC5's one-time owner-cleared pass (st_dd0e19d8 Phase 3).
 *
 * THIS FILE IS A CLI FACADE. Parse, delegate, report. The arms, the carve-outs
 * and the document format live in lib/publication-sweep.js.
 *
 *   --count            enumerate, record the count to the receipt, print it.
 *                      Produces NO list. This is the mode the ceiling rule needs
 *                      to exist as a separate thing.
 *   --write <path>     count first, record it, and write the candidate document
 *                      ONLY if the count is within the ceiling.
 *   --grouped          with --write: bundle the candidates into group decisions
 *                      (owner decision 11) and judge the ceiling on DECISIONS
 *                      REQUIRED rather than on rows. See below.
 *   --ceiling <n>      override config/defaults.json ownerCorpus.sweepCeiling.
 *
 * ── WHY THERE ARE TWO MODES AND WHY THE FLAT ONE STILL HALTS ────────────────
 *
 * The owner asked for every entry of the three reference files to be enumerated
 * ("List every entry"), which takes the flat count past the ceiling. The flat
 * mode is NOT relaxed to accommodate that: run it and it still halts, still
 * records the count, still presents nothing. The halt is the ceiling working.
 *
 * What the owner changed is the unit of decision ("Group them"). --grouped shows
 * every candidate and asks him to decide GROUPS, so the ceiling is applied to the
 * number of decisions he has to make. Same bound, same purpose — it bounds his
 * attention, not the document's length — and it still fires: a grouping that
 * degenerated into hundreds of singletons would halt exactly as the flat list
 * does. The receipt records both numbers on every run so the two are never
 * confused for each other.
 *
 * WHAT THIS PROCESS MAY WRITE, exhaustively: the count receipt under
 * ~/.robotdojo/reports/, and the document path passed to --write. It never
 * writes a tracked file, the permitted list, or the corpus — AC5's boundary, and
 * scripts/qa/sweep-decisions-proof.js asserts it behaviourally by diffing
 * `git status` across a run rather than trusting this sentence.
 *
 * THE OUTPUT CONTAINS REAL NAMES. --write refuses a destination inside config/
 * or anywhere else that git tracks; the document belongs in the gitignored story
 * directory.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 *
 * Runnable from ~/robotdojo. Exit 0 = the sweep ran and stayed inside its bound.
 * Exit 3 = over the ceiling: counted, recorded, nothing presented.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCorpus, defaultDeps } from '../lib/owner-corpus.js';
import { loadPostureTable, collectFindings, normTerm } from '../lib/publication-posture.js';
import { loadManifest, resolveManifest } from '../lib/publication-manifest.js';
import {
  SWEEP_CARVE_OUTS,
  SWEEP_UNSKIP,
  sweptSet,
  sweepScanScope,
  corpusCandidates,
  inboxListCandidates,
  referenceListCandidates,
  mergeCandidates,
  assignGroups,
  decisionsRequired,
  renderDecisions,
  renderGroupedDecisions,
  ceilingVerdict,
} from '../lib/publication-sweep.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONFIG_DIR = join(REPO_ROOT, 'config');
const RECEIPT_PATH =
  process.env.ROBOTDOJO_SWEEP_RECEIPT
  || join(homedir(), '.robotdojo', 'reports', 'publication-sweep-count.json');

function git(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function trackedFiles() {
  const r = git(['ls-files', '-z']);
  if (r.status !== 0) throw new Error(`git ls-files failed: ${(r.stderr || '').trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}

function defaultCeiling() {
  try {
    const d = JSON.parse(readFileSync(join(CONFIG_DIR, 'defaults.json'), 'utf8'));
    const n = d && d.ownerCorpus && d.ownerCorpus.sweepCeiling;
    if (Number.isInteger(n) && n > 0) return n;
  } catch { /* fall through to the stated default */ }
  return 400;
}

/**
 * Read the three small reference files entry by entry (owner decision 10: "List
 * every entry"). Their shapes differ, so each is unpacked explicitly here rather
 * than through a generic walker — three readers that say what they read beat one
 * that guesses.
 *
 * The `detail` on each entry is what the owner needs to judge it: the domains a
 * company entry carries, or the bucket a keyword sits in.
 */
function readReferenceLists() {
  const read = (file) => JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8'));

  const bigTechFile = 'config/big-tech-domains.json';
  const bigTech = read(bigTechFile).companies || [];

  const vcFile = 'config/vc-firms-domains.json';
  const vc = read(vcFile).firms || [];

  const svkFile = 'config/service-vendor-keywords.json';
  const svk = read(svkFile);

  return [
    {
      name: 'big-tech-domains',
      file: bigTechFile,
      entries: bigTech.map((c) => ({ term: c.name, detail: (c.domains || []).join(' ') })),
    },
    {
      name: 'vc-firms-domains',
      file: vcFile,
      entries: vc.map((f) => ({ term: f.name, detail: (f.domains || []).join(' ') })),
    },
    {
      name: 'service-vendor-keywords',
      file: svkFile,
      entries: [
        ...(svk.general || []).map((k) => ({ term: k, detail: 'general' })),
        ...(svk.audited || []).map((k) => ({ term: k, detail: 'owner-audited' })),
      ],
    },
  ];
}

/**
 * The owner's gitignored half of the three inbox-derived vendor lists, as
 * normalised sets. Used to mark each Arm B entry with WHERE IT COMES FROM: an
 * entry that reaches the runtime union only from here is already out of the
 * tracked tree and needs no decision; an entry still in the tracked file does.
 *
 * Read here rather than in lib/ so the sweep module keeps its no-filesystem,
 * no-owner-data property.
 */
function overrideVendorLists() {
  const empty = { brands: new Set(), localTokens: new Set(), localSubstrings: new Set() };
  try {
    const cfg = JSON.parse(readFileSync(join(CONFIG_DIR, 'service-vendor-keywords.user.json'), 'utf8'));
    const set = (v) => new Set((Array.isArray(v) ? v : []).map(normTerm));
    return { brands: set(cfg.brands), localTokens: set(cfg.localTokens), localSubstrings: set(cfg.localSubstrings) };
  } catch {
    return empty; // absent on a fresh clone — every entry then reads as tracked
  }
}

/**
 * The repository's own first-name and surname dictionaries, as one token set.
 * Used ONLY to pull a candidate out of a group so the owner reads it
 * individually — never to decide, never to suppress. See personShaped().
 */
function nameTokens() {
  const out = new Set();
  for (const file of ['config/surnames-top-25K.json', 'config/nicknames.json']) {
    try {
      for (const k of Object.keys(JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf8')))) {
        const t = normTerm(k);
        if (t) out.add(t);
      }
    } catch { /* a missing dictionary weakens grouping, never correctness */ }
  }
  return out;
}

/**
 * Enumerate the candidates. Returns the candidate list AND the derivation, so
 * every number in the document can be traced to how it was produced rather than
 * asserted.
 */
async function enumerate() {
  const deps = defaultDeps(REPO_ROOT);
  const corpus = loadCorpus(deps);
  if (!corpus) {
    throw new Error(
      'the owner corpus is UNAVAILABLE (no v2 cache). A sweep seeded by an absent corpus surfaces '
        + 'nothing and reports a clean tree — the vacuous pass this story exists to close. '
        + 'Run scripts/check-first-user-clean.js --refresh first.'
    );
  }
  const table = loadPostureTable(CONFIG_DIR);
  const manifest = loadManifest(CONFIG_DIR);
  const published = resolveManifest({ trackedFiles }, manifest).paths;
  const swept = sweptSet(published);
  const scope = sweepScanScope(table);

  // Arm A — a REAL run of the expanded gate over the swept set. Not a prior
  // enumeration: the plan requires this because the corpus arms added in phase 1
  // surface leaks no earlier enumeration contains.
  const scanDeps = { git, table, placement: 'publish', skip: scope.skip };
  const { findings } = collectFindings(scanDeps, corpus, {
    pathspecs: [...swept, ...scope.pathspecs],
    pathFiles: swept,
  });
  const armA = corpusCandidates(findings);

  // Arm B — the inbox-derived lists, read from the module that owns them, with
  // each entry tagged tracked-vs-override so the ones already moved out do not
  // come back to the owner as fresh questions.
  const vendor = await import(join(REPO_ROOT, 'scripts', 'ingest', '03b-service-vendor.js'));
  const vendorFile = 'scripts/ingest/03b-service-vendor.js';
  const overrideFile = 'config/service-vendor-keywords.user.json (gitignored)';
  const ov = overrideVendorLists();
  const tag = (entries, overrideSet) =>
    [...entries].map((term) => ({ term, fromOverride: overrideSet.has(normTerm(term)) }));
  const armB = inboxListCandidates([
    { name: 'BRAND_SERVICE_NAMES', file: vendorFile, overrideFile, entries: tag(vendor.BRAND_SERVICE_NAMES, ov.brands) },
    { name: 'SYSTEM_LOCAL_TOKENS', file: vendorFile, overrideFile, entries: tag(vendor.SYSTEM_LOCAL_TOKENS, ov.localTokens) },
    { name: 'SYSTEM_LOCAL_SUBSTRINGS', file: vendorFile, overrideFile, entries: tag(vendor.SYSTEM_LOCAL_SUBSTRINGS, ov.localSubstrings) },
  ]);

  // Arm C — every entry of the three small reference files (owner decision 10).
  const lists = readReferenceLists();
  const armC = referenceListCandidates(lists);

  const candidates = mergeCandidates(armA, armB, armC);
  const groups = assignGroups(
    { nameTokens: nameTokens() },
    candidates,
    {
      inboxSystemWords:
        'recorded owner decision (2026-07-26): "Clear the group." These stay. Ordinary words — `account`, '
        + '`admin`, `alerts` — that entered the lists because senders used them as From-names. Nothing about '
        + 'you is disclosed by the word "admin". **Read this boundary before you accept it:** your decision '
        + 'named ~146 words; this group is the two email-local-part lists only, which is the largest set the '
        + 'code can identify without a hard-coded list of which company names count as public — and a '
        + 'hard-coded list of that kind is owner data in a tracked file, the thing this story removes. The '
        + 'named-brand entries are therefore presented as their own group below rather than folded in here.',
    }
  );

  return {
    candidates,
    groups,
    derivation: {
      published_files: published.length,
      swept_files: swept.length,
      carve_outs: SWEEP_CARVE_OUTS.map((c) => c.path),
      unskipped: SWEEP_UNSKIP.map((u) => u.path),
      corpus_finding_rows: findings.length,
      arm_corpus: armA.length,
      arm_inbox_list: armB.length,
      arm_reference_list: armC.length,
      reference_list_sizes: Object.fromEntries(lists.map((l) => [l.file, l.entries.length])),
      groups: groups.map((g) => ({ id: g.id, rows: g.rows.length, decision: g.decision || null })),
      decisions_required: decisionsRequired(groups),
      corpus_built_at: corpus.built_at || null,
      head: (git(['rev-parse', 'HEAD']).stdout || '').trim() || null,
    },
  };
}

/**
 * Record the count BEFORE anything is rendered. Written on every run including
 * the over-ceiling one — that is the run it exists for.
 */
function recordCount(count, ceiling, derivation, { grouped = false } = {}) {
  // BOTH numbers, on every run, whichever mode. The flat count is what the
  // ceiling judged before the owner re-scoped and it is the reason the re-scope
  // happened; the decision count is what it judges now. Recording only the one
  // that applied to this run would erase the halt from the record.
  const judged = grouped ? derivation.decisions_required : count;
  const receipt = {
    story: 'st_dd0e19d8',
    criterion: 'AC5',
    counted_at: new Date().toISOString(),
    mode: grouped ? 'grouped' : 'flat',
    candidates: count,
    decisions_required: derivation.decisions_required,
    judged_against_ceiling: judged,
    ceiling,
    within_ceiling: ceilingVerdict(judged, ceiling).within,
    flat_within_ceiling: ceilingVerdict(count, ceiling).within,
    presented: false, // flipped by the writer, only if it actually presents
    derivation,
  };
  mkdirSync(dirname(RECEIPT_PATH), { recursive: true });
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function markPresented(receipt, outPath) {
  const next = { ...receipt, presented: true, presented_at: new Date().toISOString(), document: outPath };
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(next, null, 2)}\n`);
}

function overCeiling(count, ceiling, unit = 'candidates') {
  process.stderr.write(
    `publication-sweep: HALTED — ${count} ${unit} against a ceiling of ${ceiling}.\n`
      + '  Nothing has been presented. A list this long is the file-by-file audit this story exists to\n'
      + '  remove, so the sweep stops and is re-scoped with the owner rather than executed.\n'
      + `  The count is recorded at ${RECEIPT_PATH}.\n`
  );
  return 3;
}

// ── modes ────────────────────────────────────────────────────────────────────

async function modeCount(ceiling, grouped) {
  const { candidates, derivation } = await enumerate();
  const receipt = recordCount(candidates.length, ceiling, derivation, { grouped });
  const armSum = derivation.arm_corpus + derivation.arm_inbox_list + derivation.arm_reference_list;
  process.stdout.write(
    `publication-sweep --count: ${candidates.length} candidate(s) — `
      + `${derivation.arm_corpus} from your own records, ${derivation.arm_inbox_list} from the inbox-derived lists, `
      + `${derivation.arm_reference_list} from the three reference files `
      + `(overlap ${armSum - candidates.length}).\n`
      + `  ${derivation.decisions_required} decision(s) required across ${derivation.groups.length} group(s); `
      + `swept ${derivation.swept_files} of ${derivation.published_files} published files; `
      + `ceiling ${ceiling}; recorded at ${RECEIPT_PATH}\n`
  );
  if (receipt.within_ceiling) return 0;
  return overCeiling(receipt.judged_against_ceiling, ceiling, grouped ? 'decisions' : 'candidates');
}

/**
 * Where the candidate list may be written.
 *
 * The rule is NOT "is it tracked today". That was the first version and it was
 * wrong in the way that matters: `config/publication-manifest.json` was untracked
 * at the moment it was written, so a tracked-only guard waved it through and the
 * sweep overwrote a config file destined for the public repository with 215 real
 * names. Being untracked is a fact about right now; being publishable is a fact
 * about the file.
 *
 * The rule is: the destination must be OUTSIDE the repository, or gitignored
 * inside it. Gitignored is the property that actually means "this can never be
 * committed", and it is the property the story directory has.
 */
function refuseUnlessUnpublishable(abs) {
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith('..')) return null; // outside the repo entirely
  const ignored = git(['check-ignore', '-q', '--', rel]).status === 0;
  if (ignored) return null;
  return (
    `publication-sweep --write: REFUSED — ${rel} is inside the repository and is not gitignored, so it `
    + 'can be committed and published. The candidate list is full of real names by construction; it belongs '
    + 'in the gitignored story directory.\n'
  );
}

async function modeWrite(outPath, ceiling, grouped) {
  const abs = resolve(REPO_ROOT, outPath);
  const refusal = refuseUnlessUnpublishable(abs);
  if (refusal) {
    process.stderr.write(refusal);
    return 2;
  }

  // COUNT FIRST, RECORD, THEN DECIDE. The ordering is the criterion.
  const { candidates, groups, derivation } = await enumerate();
  const receipt = recordCount(candidates.length, ceiling, derivation, { grouped });
  if (!receipt.within_ceiling) {
    return overCeiling(receipt.judged_against_ceiling, ceiling, grouped ? 'decisions' : 'candidates');
  }

  const provenance = [
    `- Run at \`${receipt.counted_at}\` against commit \`${derivation.head || 'unknown'}\`; `
      + `corpus built \`${derivation.corpus_built_at || 'unknown'}\`.`,
    `- **Swept set:** ${derivation.swept_files} files — the ${derivation.published_files} the publication `
      + 'manifest ships, less four carve-outs:',
    ...SWEEP_CARVE_OUTS.map((c) => `    - \`${c.path}\` — ${c.reason}`),
    '- **Un-skipped for this run** (the gate skips them; AC5 sweeps them):',
    ...SWEEP_UNSKIP.map((u) => `    - \`${u.path}\` — ${u.reason}`),
    `- **Arm A — your own records:** a real run of the expanded gate over the swept set, `
      + `${derivation.corpus_finding_rows} match(es) resolving to ${derivation.arm_corpus} distinct names.`,
    `- **Arm B — the inbox-derived lists:** every entry of BRAND_SERVICE_NAMES, SYSTEM_LOCAL_TOKENS and `
      + `SYSTEM_LOCAL_SUBSTRINGS in \`scripts/ingest/03b-service-vendor.js\` — ${derivation.arm_inbox_list} entries. `
      + 'These are candidates because of where the list came from, not because anything detected them.',
    `- **Arm C — the three reference files, entry by entry** (your decision, "List every entry"): `
      + `${derivation.arm_reference_list} entries — `
      + `${Object.entries(derivation.reference_list_sizes).map(([f, n]) => `${n} in \`${f}\``).join(', ')}. `
      + 'Un-skipping alone surfaced only the six that intersect your own records; this arm shows all of them.',
    `- **Ceiling:** ${receipt.ceiling}, applied to DECISIONS REQUIRED (${derivation.decisions_required}), not to `
      + `rows (${candidates.length}). The flat list of ${candidates.length} is `
      + `${receipt.flat_within_ceiling ? 'inside' : 'over'} the ceiling; the counts were recorded at `
      + `\`${RECEIPT_PATH}\` before this document existed.`,
    '- **Not covered here,** stated rather than implied: a real person\'s name that is absent from your records '
      + 'and outside those three lists. AC19 carries that as a residual class; closing it would need the standing '
      + 'detector the scope seals out.',
  ];

  const halt = grouped && !receipt.flat_within_ceiling
    ? `The flat, one-row-per-decision list came to ${candidates.length} against a ceiling of ${receipt.ceiling}, `
      + 'so it halted and presented nothing — the bound doing its job. Your re-scope ("Group them") changed the '
      + `unit of decision rather than lifting the bound: every one of the ${candidates.length} is still listed, `
      + `and the ${derivation.decisions_required} decisions are what the ceiling now judges.`
    : null;

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    grouped ? renderGroupedDecisions(groups, provenance, { halt }) : renderDecisions(candidates, provenance)
  );
  markPresented(receipt, abs);
  process.stdout.write(
    `publication-sweep --write${grouped ? ' --grouped' : ''}: ${candidates.length} candidate(s), `
      + `${derivation.decisions_required} decision(s) required → ${abs}\n`
      + '  Nothing was removed, kept, or permitted.\n'
  );
  return 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const valueOf = (f) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] || null : null;
  };
  const ceilingArg = valueOf('--ceiling');
  const ceiling = ceilingArg ? Number.parseInt(ceilingArg, 10) : defaultCeiling();
  if (!Number.isInteger(ceiling) || ceiling <= 0) {
    process.stderr.write(`publication-sweep: --ceiling must be a positive integer, got ${ceilingArg}\n`);
    return 2;
  }

  const grouped = has('--grouped');
  if (has('--count')) return modeCount(ceiling, grouped);
  if (has('--write')) {
    const out = valueOf('--write');
    if (!out) {
      process.stderr.write('publication-sweep --write: needs an output path\n');
      return 2;
    }
    return modeWrite(out, ceiling, grouped);
  }

  process.stderr.write('publication-sweep: usage — --count | --write <path> [--grouped] [--ceiling <n>]\n');
  return 2;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`publication-sweep: ${err.stack || err.message}\n`);
      process.exit(2);
    });
}

export { enumerate, RECEIPT_PATH, REPO_ROOT, CONFIG_DIR };
