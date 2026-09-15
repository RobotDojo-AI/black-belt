#!/usr/bin/env node
/**
 * ac2-equivalence.js — AC2: the owner's product behaves exactly as it did
 * before this story (st_dd0e19d8 Phase 3).
 *
 * WHAT THIS PROVES. Four owner-facing surfaces produce byte-identical output
 * before and after the leak-removal edits, compared AS DATA rather than by eye:
 *
 *   topic_routing      lib/topic-source-routing.js  topicForSourceAccount()
 *   chat_context       lib/chat-context.js          resolveEntitiesFromText()
 *   entity_resolution  lib/entity-resolve.js        matchPerson()
 *   ingest_vendor      scripts/ingest/03b-service-vendor.js  isSystemArtifact()
 *
 * WHY A COMMIT, NOT A MOMENT. A baseline captured by "running it before I
 * started" is only as trustworthy as the claim that nothing had been edited
 * yet — and by Phase 3 of this story, plenty had. So the baseline is not taken
 * from the working tree at all. `--capture-baseline` extracts the story
 * branch's MERGE-BASE with the default branch into a scratch directory
 * (`git archive`, read-only — no worktree, no branch mutation, per the
 * session-bus git discipline), copies this script in, and runs the probes
 * THERE. The recorded `source_commit` is therefore a commit that by
 * construction pre-dates every change in this story, and the baseline can be
 * re-derived at any time without ever becoming "post-edit".
 *
 * That is what `--require-pre-edit` checks: the baseline's source commit still
 * equals today's merge-base. It also refuses to run on the default branch
 * itself, where the merge-base moves with every commit and a post-edit
 * baseline would satisfy the identity check vacuously (plan, Test strategy).
 *
 * THE INPUTS ARE PINNED BY THE BASELINE, NOT RE-DERIVED. Capture writes the
 * exact probe inputs into the baseline file; compare reads them back and runs
 * the same inputs through today's code. A person row created by a background
 * ingest between the two runs therefore cannot move the comparison. The one
 * surface whose input IS the whole table (ingest_vendor, which classifies every
 * person row — the design's own falsifiable check) stores an input digest
 * instead, so a drifted table is reported as DRIFT and never silently read as a
 * classification regression.
 *
 * THE DATABASE IS AN INPUT TOO. Three of the four surfaces read the live
 * database: chat_context resolves against `people`, entity_resolution scans it,
 * ingest_vendor classifies all of it. Pinning the probe ARGUMENTS does not pin
 * that. A background ingest between capture and compare moves those surfaces
 * for a reason that has nothing to do with this story's edits, and a diff
 * reported as CHANGED would be dismissed as "just drift" — which is how a real
 * regression gets waved through. So capture records a database watermark and
 * compare REFUSES (exit 2) when it has moved, rather than reporting a
 * comparison it cannot interpret. Re-capture is always available: the baseline
 * is derived from a commit, not from a moment.
 *
 * WHERE THE BASELINE LIVES: ~/.robotdojo/reports/ — the owner's private
 * directory, alongside owner-corpus.cache.json and first-user-baseline.json. It
 * holds real names and addresses by construction and must never enter the
 * repository.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 *
 * USAGE
 *   --capture-baseline            derive + write the baseline from the merge-base tree
 *   --capture [--out <path>]      run the probes in THIS tree (used inside the scratch tree)
 *   --compare                     re-run against the baseline inputs and diff
 *     --require-complete-baseline  refuse an absent/empty/partial baseline
 *     --require-pre-edit           refuse a baseline not built at today's merge-base
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * UNDER reports/, not at the root of ~/.robotdojo/. The dot-directory has its own
 * allowlist in config/root-allowlist.lock.json and a new top-level entry there is
 * a protected architecture change needing the owner's countersign. `reports/` is
 * already allowlisted and is what this file is — a run artifact. Writing to the
 * root instead put a stop-the-line structure violation in front of every commit.
 */
export const BASELINE_PATH =
  process.env.ROBOTDOJO_AC2_BASELINE
  || join(homedir(), '.robotdojo', 'reports', 'st_dd0e19d8-ac2-baseline.json');

/** The four surfaces AC2 names. A baseline covering fewer is incomplete by definition. */
export const SURFACES = ['topic_routing', 'chat_context', 'entity_resolution', 'ingest_vendor'];

// Probe sizes. Large enough that a real behaviour change cannot hide in the gap
// between samples; small enough that capture and compare each run in seconds.
//
// N_RESOLVE_NAME_ONLY is the one that is small for a MEASURED reason, not for
// convenience: matchPerson()'s name guard has no index behind it — it pulls
// every `people` row (646,220 here) and normalizes each display_name in JS.
// Measured 2.4s per call on the live database. Fifteen calls is ~36s, which is
// the most that path can be exercised without making capture and compare cost
// minutes each. Every other stratum short-circuits on an identifier and is
// effectively free, so they are sized for coverage instead.
const N_ROUTING_EMAILS = 200;
const N_CHAT_MEANINGFUL = 40;   // score-ranked real people — the resolving path
const N_CHAT_LEXICAL = 15;      // display_name-ordered rows — mostly system shapes, the non-resolving path
const N_RESOLVE_EMAIL = 60;     // exercises the email guard
const N_RESOLVE_PHONE = 30;     // exercises the phone guard
const N_RESOLVE_NAME_ONLY = 15; // exercises the normalized-full-name guard (see above)
const N_RESOLVE_SINGLE_TOKEN = 20; // exercises the <2-token refusal

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function git(args, cwd = REPO_ROOT) {
  return sh('git', args, { cwd });
}

/** Canonical JSON digest — the comparison unit. Key order is fixed by construction. */
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// ── branch topology ──────────────────────────────────────────────────────────

/** The default branch ref, preferring the remote HEAD symref over a guess. */
export function defaultBranchRef(cwd = REPO_ROOT) {
  const symref = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd);
  if (symref.status === 0) {
    const ref = symref.stdout.trim().replace(/^refs\/remotes\//, '');
    if (ref) return ref;
  }
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], cwd).status === 0) return candidate;
  }
  return null;
}

export function currentBranch(cwd = REPO_ROOT) {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The merge-base of HEAD with the default branch: the commit that by
 * construction pre-dates every change on this story branch.
 *
 * Refuses on the default branch itself — there the merge-base is HEAD, it moves
 * with every commit, and a baseline captured after the edits would satisfy the
 * identity check while proving nothing.
 */
export function mergeBaseCommit(cwd = REPO_ROOT) {
  const ref = defaultBranchRef(cwd);
  if (!ref) return { commit: null, reason: 'no default branch ref found (no origin/HEAD, no main, no master)' };
  const branch = currentBranch(cwd);
  const bare = ref.replace(/^origin\//, '');
  if (branch === bare || branch === ref) {
    return {
      commit: null,
      reason:
        `HEAD is on the default branch (${branch}). The merge-base there is HEAD itself and moves with every `
        + 'commit, so a post-edit baseline would satisfy the identity check vacuously. Run this from the story branch.',
    };
  }
  const r = git(['merge-base', 'HEAD', ref], cwd);
  if (r.status !== 0) return { commit: null, reason: `git merge-base HEAD ${ref} failed: ${(r.stderr || '').trim()}` };
  return { commit: r.stdout.trim(), ref, branch };
}

// ── the database as an input ─────────────────────────────────────────────────

/**
 * A watermark over every table the probes read. Cheap (four aggregates) and
 * sufficient: an insert moves a count, an in-place edit moves a max(updated_at).
 * Recorded at capture; re-read at compare. A move means the comparison cannot
 * be interpreted and the run refuses rather than guessing.
 */
export function dbState(db) {
  const one = (sql) => {
    try {
      return db.prepare(sql).get();
    } catch {
      return null;
    }
  };
  const people = one('SELECT COUNT(*) AS rows, MAX(updated_at) AS watermark FROM people') || {};
  const idents = one('SELECT COUNT(*) AS rows FROM person_identifiers') || {};
  return {
    people_rows: people.rows ?? null,
    people_watermark: people.watermark ?? null,
    identifier_rows: idents.rows ?? null,
  };
}

/** Human-readable list of what moved, or [] when the database is where it was. */
export function dbStateDrift(before, after) {
  if (!before) return ['the baseline records no database watermark — re-capture with --capture-baseline'];
  const moved = [];
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) moved.push(`${key}: ${before[key]} → ${after[key]}`);
  }
  return moved;
}

// ── probe inputs ─────────────────────────────────────────────────────────────

/**
 * Derive the probe inputs from the live data, deterministically ordered so the
 * same tree and the same database always yield the same list. Called ONLY at
 * capture; compare replays the inputs the baseline recorded.
 */
async function deriveInputs(db, routingConfig) {
  // topic_routing — every configured routing domain (so each rule is exercised,
  // including the owner's gitignored overrides) plus real addresses from his graph.
  const domains = Object.keys(routingConfig.domains || {}).sort();
  const realEmails = db
    .prepare("SELECT DISTINCT value FROM person_identifiers WHERE type='email' AND value IS NOT NULL ORDER BY value LIMIT ?")
    .all(N_ROUTING_EMAILS)
    .map((r) => r.value);
  const senders = [
    ...domains.flatMap((d) => [`probe@${d}`, `probe@mail.${d}`]),
    ...realEmails,
  ];
  // Account side: null (no mailbox signal) plus one mailbox per configured
  // domain, so the account-wins-over-sender priority is exercised in both directions.
  const accounts = [null, ...domains.map((d) => `owner@${d}`)];
  const topicRouting = [];
  for (const senderEmail of senders) {
    for (const accountEmail of accounts) topicRouting.push({ senderEmail, accountEmail });
  }

  // chat_context — real display names, which is what the span resolver actually
  // walks. Two strata, because one alone proves half the surface:
  //   - score-ranked multi-token people: the path that RESOLVES. Ordering by
  //     display_name instead puts punctuation-leading rows first — mailing-list
  //     and label artefacts that resolve to nothing, so every result would be []
  //     and the digest could not move for any edit this story makes.
  //   - display_name-ordered rows: the path that must KEEP resolving to
  //     nothing. A change that starts matching these is a regression too.
  // (The examples that used to be spelled out here were two real rows from the
  // owner's own people table. The AC5 sweep caught them in this file — a QA
  // script is a tracked file like any other. st_dd0e19d8.)
  const meaningful = db
    .prepare(
      "SELECT display_name AS n FROM people WHERE COALESCE(archived,0)=0 AND COALESCE(service_vendor,0)=0 "
        + "AND display_name LIKE '% %' AND display_name NOT LIKE '%@%' AND COALESCE(score,0) > 0 "
        + 'ORDER BY score DESC, id ASC LIMIT ?'
    )
    .all(N_CHAT_MEANINGFUL)
    .map((r) => r.n);
  const lexical = db
    .prepare(
      'SELECT DISTINCT p.display_name AS n FROM people p JOIN person_identifiers i ON i.person_id = p.id '
        + 'WHERE p.display_name IS NOT NULL AND length(p.display_name) >= 4 ORDER BY p.display_name LIMIT ?'
    )
    .all(N_CHAT_LEXICAL)
    .map((r) => r.n);
  const chatContext = [...meaningful, ...lexical].map(
    (n) => `What did ${n} say about the project last week?`
  );
  // One email-shaped query too: that path resolves identifiers rather than spans.
  if (realEmails.length > 0) chatContext.push(`Find the thread with ${realEmails[0]} about scheduling.`);

  // entity_resolution — real (name, email, phone) triples, the exact shape
  // matchPerson() takes from the ingest path.
  //
  // STRATIFIED ON PURPOSE. matchPerson has three guards and returns on the
  // first that hits. A flat `ORDER BY p.id LIMIT 200` draws overwhelmingly from
  // rows with no identifier and a single-token display_name — measured: 6 of the
  // first 200 have an email, 2 a phone. That sample exercises the email guard
  // six times and the name guard never on most rows, so a break in either could
  // not move the digest. One stratum per guard, each seeded from rows that
  // reach it.
  const q = (sql) => db.prepare(sql);
  const withEmail = q(
    "SELECT p.display_name AS name, "
      + "(SELECT value FROM person_identifiers WHERE person_id=p.id AND type='email' ORDER BY value LIMIT 1) AS email "
      + "FROM people p JOIN person_identifiers pi ON pi.person_id = p.id AND pi.type='email' "
      + 'WHERE p.display_name IS NOT NULL GROUP BY p.id ORDER BY p.id LIMIT ?'
  )
    .all(N_RESOLVE_EMAIL)
    .map((r) => ({ name: r.name, email: r.email, phone: null }));
  const withPhone = q(
    "SELECT p.display_name AS name, "
      + "(SELECT value FROM person_identifiers WHERE person_id=p.id AND type='phone' ORDER BY value LIMIT 1) AS phone "
      + "FROM people p JOIN person_identifiers pi ON pi.person_id = p.id AND pi.type='phone' "
      + "WHERE p.display_name IS NOT NULL "
      + "AND NOT EXISTS (SELECT 1 FROM person_identifiers e WHERE e.person_id=p.id AND e.type='email') "
      + 'GROUP BY p.id ORDER BY p.id LIMIT ?'
  )
    .all(N_RESOLVE_PHONE)
    .map((r) => ({ name: r.name, email: null, phone: r.phone }));
  const nameOnly = q(
    "SELECT display_name AS name FROM people WHERE display_name LIKE '% %' AND display_name NOT LIKE '%@%' "
      + 'AND NOT EXISTS (SELECT 1 FROM person_identifiers i WHERE i.person_id = people.id) '
      + 'ORDER BY id LIMIT ?'
  )
    .all(N_RESOLVE_NAME_ONLY)
    .map((r) => ({ name: r.name, email: null, phone: null }));
  const singleToken = q(
    "SELECT display_name AS name FROM people WHERE display_name NOT LIKE '% %' AND display_name NOT LIKE '%@%' "
      + 'AND NOT EXISTS (SELECT 1 FROM person_identifiers i WHERE i.person_id = people.id) '
      + 'ORDER BY id LIMIT ?'
  )
    .all(N_RESOLVE_SINGLE_TOKEN)
    .map((r) => ({ name: r.name, email: null, phone: null }));
  const entityResolution = [...withEmail, ...withPhone, ...nameOnly, ...singleToken];

  return { topic_routing: topicRouting, chat_context: chatContext, entity_resolution: entityResolution };
}

// ── probes ───────────────────────────────────────────────────────────────────

/**
 * Every probe returns `{ inputs, results, digest, meta }`. `results` is the raw
 * per-input output, kept in the baseline so a mismatch can be shown as the
 * specific input that moved rather than as two different hashes.
 */

async function probeTopicRouting(inputs) {
  const { topicForSourceAccount, loadSourceTopicRoutingConfig } = await import(
    join(REPO_ROOT, 'lib', 'topic-source-routing.js')
  );
  const config = loadSourceTopicRoutingConfig();
  const results = inputs.map((i) => topicForSourceAccount(i, config) || null);
  return { inputs, results, digest: digest(results), meta: { rules: Object.keys(config.domains || {}).length } };
}

async function probeChatContext(inputs) {
  const { resolveEntitiesFromText } = await import(join(REPO_ROOT, 'lib', 'chat-context.js'));
  const results = inputs.map((text) =>
    resolveEntitiesFromText(text, { limit: 8 }).map((e) => `${e.type || ''}:${e.id || ''}:${e.name || ''}`)
  );
  return { inputs, results, digest: digest(results), meta: { texts: inputs.length } };
}

async function probeEntityResolution(inputs) {
  const { matchPerson } = await import(join(REPO_ROOT, 'lib', 'entity-resolve.js'));
  const byGuard = {};
  const results = inputs.map((c) => {
    const m = matchPerson(c);
    // Which guard fired is recorded per run, so a baseline where one guard
    // never fires is visible in the artifact rather than hidden in a digest.
    const guard = m ? m.guard : 'none';
    byGuard[guard] = (byGuard[guard] || 0) + 1;
    return m ? `${m.personId}|${m.confidence}|${m.guard}` : null;
  });
  return { inputs, results, digest: digest(results), meta: { candidates: inputs.length, by_guard: byGuard } };
}

/**
 * ingest_vendor — the design's own falsifiable check (§6.1): the service-vendor
 * predicate run over EVERY person row with the same input, before and after.
 *
 * The input is the whole table, so it is summarised as a digest rather than
 * copied into the baseline. Compare recomputes that digest first: an input
 * mismatch means the table moved under us and is reported as DRIFT, never as a
 * classification change.
 */
async function probeIngestVendor() {
  const { isSystemArtifact } = await import(join(REPO_ROOT, 'scripts', 'ingest', '03b-service-vendor.js'));
  const { default: db } = await import(join(REPO_ROOT, 'lib', 'db.js'));
  const people = db.prepare('SELECT id, display_name FROM people ORDER BY id').all();
  const idents = db
    .prepare('SELECT person_id, type, value FROM person_identifiers ORDER BY person_id, type, value')
    .all();
  const byPerson = new Map();
  for (const i of idents) {
    if (!byPerson.has(i.person_id)) byPerson.set(i.person_id, []);
    byPerson.get(i.person_id).push({ type: i.type, value: i.value });
  }
  const inputHash = createHash('sha256');
  const outputHash = createHash('sha256');
  let flagged = 0;
  const flaggedSample = [];
  for (const p of people) {
    const identifiers = byPerson.get(p.id) || [];
    inputHash.update(`${p.id} ${p.display_name || ''} `);
    for (const i of identifiers) inputHash.update(`${i.type} ${i.value} `);
    const verdict = isSystemArtifact(p, identifiers) ? 1 : 0;
    outputHash.update(`${p.id}=${verdict};`);
    if (verdict) {
      flagged += 1;
      // A bounded sample so a mismatch names rows, not just a hash. Ordered by
      // id, so it is stable and comparable.
      if (flaggedSample.length < 200) flaggedSample.push(p.id);
    }
  }
  return {
    inputs: { mode: 'all-people', order: 'id ASC', rows: people.length, identifiers: idents.length },
    results: { flagged, sample: flaggedSample },
    digest: outputHash.digest('hex'),
    meta: { input_digest: inputHash.digest('hex'), rows: people.length },
  };
}

// ── capture ──────────────────────────────────────────────────────────────────

/**
 * Run all four probes in THIS tree. `pinnedInputs` (from a baseline) replays a
 * recorded input set; absent, the inputs are derived from live data.
 */
export async function capture({ pinnedInputs = null } = {}) {
  const { default: db } = await import(join(REPO_ROOT, 'lib', 'db.js'));
  const { loadSourceTopicRoutingConfig } = await import(join(REPO_ROOT, 'lib', 'topic-source-routing.js'));
  const inputs = pinnedInputs || (await deriveInputs(db, loadSourceTopicRoutingConfig()));

  const surfaces = {};
  surfaces.topic_routing = await probeTopicRouting(inputs.topic_routing);
  surfaces.chat_context = await probeChatContext(inputs.chat_context);
  surfaces.entity_resolution = await probeEntityResolution(inputs.entity_resolution);
  surfaces.ingest_vendor = await probeIngestVendor();
  // Read AFTER the probes: the watermark must cover the whole window the
  // probes read across, so a write landing mid-run is caught rather than
  // straddling the measurement.
  return { surfaces, db_state: dbState(db) };
}

/**
 * Extract the merge-base commit into a scratch directory and capture there.
 *
 * `git archive` rather than `git worktree add`: it is read-only, it mutates no
 * branch and writes nothing under .git/, and the build conventions' session-bus
 * rule makes any branch-mutating git op on a shared checkout a hazard. The
 * scratch tree has no node_modules of its own, so the repo's is symlinked in —
 * the modules are the same on both sides by design; the CODE is what differs.
 */
export async function captureBaseline({ out = BASELINE_PATH } = {}) {
  const base = mergeBaseCommit();
  if (!base.commit) throw new Error(`cannot resolve a pre-edit commit: ${base.reason}`);

  const scratch = mkdtempSync(join(tmpdir(), 'rd-ac2-'));
  try {
    const archive = sh('sh', ['-c', `git -C ${JSON.stringify(REPO_ROOT)} archive ${base.commit} | tar -x -C ${JSON.stringify(scratch)}`]);
    if (archive.status !== 0) throw new Error(`git archive ${base.commit} failed: ${(archive.stderr || '').trim()}`);
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(scratch, 'node_modules'));
    mkdirSync(join(scratch, 'scripts', 'qa'), { recursive: true });
    copyFileSync(fileURLToPath(import.meta.url), join(scratch, 'scripts', 'qa', 'ac2-equivalence.js'));

    const run = sh(process.execPath, ['scripts/qa/ac2-equivalence.js', '--capture', '--out', out, '--source-commit', base.commit], {
      cwd: scratch,
      env: { ...process.env },
    });
    process.stdout.write(run.stdout || '');
    if (run.status !== 0) {
      process.stderr.write(run.stderr || '');
      throw new Error(`baseline capture inside the merge-base tree failed (exit ${run.status})`);
    }
    return { out, commit: base.commit, ref: base.ref };
  } finally {
    // Build conventions: no probe fixture outlives the check that created it.
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── compare ──────────────────────────────────────────────────────────────────

export function readBaseline(path = BASELINE_PATH) {
  if (!existsSync(path)) return { ok: false, reason: `baseline is ABSENT at ${path}` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `baseline at ${path} does not parse: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.surfaces) {
    return { ok: false, reason: `baseline at ${path} has no surfaces — it is EMPTY` };
  }
  return { ok: true, baseline: parsed };
}

/** A recorded result carries signal when it is not null, not '' and not []. */
function hasSignal(result) {
  if (result === null || result === undefined) return false;
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === 'string') return result.length > 0;
  return true;
}

/**
 * Validate a baseline before it is allowed to certify anything. Each refusal is
 * one of the four the criterion names: absent, empty, built against another
 * commit, or covering fewer than four surfaces.
 */
export function validateBaseline(baseline, { requireComplete = false, requirePreEdit = false } = {}) {
  const errors = [];
  const present = Object.keys(baseline.surfaces || {});
  if (requireComplete) {
    for (const s of SURFACES) {
      const surface = (baseline.surfaces || {})[s];
      if (!surface) {
        errors.push(`baseline covers only ${present.length} surface(s) — "${s}" is missing`);
        continue;
      }
      if (!surface.digest) errors.push(`baseline surface "${s}" has no digest`);
      const n = Array.isArray(surface.results) ? surface.results.length : surface.results ? 1 : 0;
      if (n === 0) errors.push(`baseline surface "${s}" is EMPTY — it recorded no results`);
      // A surface that recorded 200 nulls is EMPTY in the only sense that
      // matters: its digest cannot move, so comparing it certifies nothing.
      // "Empty" is a property of the signal, not of the array length.
      else if (Array.isArray(surface.results) && !surface.results.some((r) => hasSignal(r))) {
        errors.push(
          `baseline surface "${s}" recorded ${n} results and every one is empty — the probe resolved `
            + 'nothing, so its digest cannot move for any change. Re-derive the probe inputs.'
        );
      } else if (s === 'ingest_vendor' && !(surface.results && surface.results.flagged > 0)) {
        // The same vacuity rule in the shape this surface reports: a classifier
        // that flags nothing proves nothing about a classification change.
        errors.push('baseline surface "ingest_vendor" flagged 0 rows — the classifier proved nothing');
      }
    }
    if (present.length < SURFACES.length) {
      errors.push(`baseline covers ${present.length} of the ${SURFACES.length} surfaces AC2 names`);
    }
  }
  if (requirePreEdit) {
    const base = mergeBaseCommit();
    if (!base.commit) errors.push(`cannot verify the baseline is pre-edit: ${base.reason}`);
    else if (baseline.source_commit !== base.commit) {
      errors.push(
        `baseline was built against ${baseline.source_commit || '(none recorded)'} but today's merge-base with `
          + `${base.ref} is ${base.commit}. Re-capture with --capture-baseline.`
      );
    }
  }
  return errors;
}

/** Diff one surface. Reports the first differing inputs, not just two hashes. */
function diffSurface(name, before, after) {
  const out = { surface: name, ok: true, notes: [] };
  if (name === 'ingest_vendor') {
    const beforeInput = (before.meta || {}).input_digest;
    const afterInput = (after.meta || {}).input_digest;
    if (beforeInput !== afterInput) {
      out.ok = false;
      out.drift = true;
      out.notes.push(
        `INPUT DRIFT — the people table changed between capture and compare `
          + `(${before.meta.rows} rows then, ${after.meta.rows} now). The classification comparison is not `
          + 'meaningful against a moved table; re-run --capture-baseline and compare again.'
      );
      return out;
    }
  }
  if (before.digest === after.digest) return out;
  out.ok = false;
  const b = before.results;
  const a = after.results;
  if (Array.isArray(b) && Array.isArray(a)) {
    if (b.length !== a.length) out.notes.push(`result count moved: ${b.length} → ${a.length}`);
    let shown = 0;
    for (let i = 0; i < Math.min(b.length, a.length) && shown < 5; i += 1) {
      if (JSON.stringify(b[i]) !== JSON.stringify(a[i])) {
        const input = (before.inputs || [])[i];
        out.notes.push(`input #${i} ${JSON.stringify(input)}: ${JSON.stringify(b[i])} → ${JSON.stringify(a[i])}`);
        shown += 1;
      }
    }
  } else {
    out.notes.push(`flagged ${b && b.flagged} → ${a && a.flagged}`);
    const bs = new Set((b && b.sample) || []);
    const as = new Set((a && a.sample) || []);
    const added = [...as].filter((x) => !bs.has(x)).slice(0, 5);
    const gone = [...bs].filter((x) => !as.has(x)).slice(0, 5);
    if (added.length) out.notes.push(`newly flagged (sample): ${added.join(', ')}`);
    if (gone.length) out.notes.push(`no longer flagged (sample): ${gone.join(', ')}`);
  }
  return out;
}

export async function compare({ requireComplete = false, requirePreEdit = false, path = BASELINE_PATH } = {}) {
  const read = readBaseline(path);
  if (!read.ok) return { ok: false, fatal: [read.reason] };
  const errors = validateBaseline(read.baseline, { requireComplete, requirePreEdit });
  if (errors.length > 0) return { ok: false, fatal: errors };

  const pinned = {
    topic_routing: read.baseline.surfaces.topic_routing.inputs,
    chat_context: read.baseline.surfaces.chat_context.inputs,
    entity_resolution: read.baseline.surfaces.entity_resolution.inputs,
  };
  const now = await capture({ pinnedInputs: pinned });

  // The database is an input to three of the four surfaces. If it moved, the
  // diff is uninterpretable — refuse rather than report a difference the owner
  // would reasonably dismiss as drift.
  const moved = dbStateDrift(read.baseline.db_state, now.db_state);
  if (moved.length > 0) {
    return {
      ok: false,
      fatal: [
        'the database moved between capture and compare, so the comparison cannot be interpreted:',
        ...moved.map((m) => `  ${m}`),
        're-capture with --capture-baseline (the baseline derives from a commit, so it stays pre-edit) and compare again',
      ],
    };
  }

  const diffs = SURFACES.map((s) => diffSurface(s, read.baseline.surfaces[s], now.surfaces[s]));
  return { ok: diffs.every((d) => d.ok), diffs, baseline: read.baseline };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };

  if (flag('--capture-baseline')) {
    const res = await captureBaseline({ out: value('--out') || BASELINE_PATH });
    process.stdout.write(
      `ac2-equivalence: baseline captured from ${res.commit} (merge-base with ${res.ref}) → ${res.out}\n`
    );
    return 0;
  }

  if (flag('--capture')) {
    const out = value('--out') || BASELINE_PATH;
    const { surfaces, db_state: dbSnapshot } = await capture();
    const payload = {
      story: 'st_dd0e19d8',
      criterion: 'AC2',
      captured_at: new Date().toISOString(),
      source_commit: value('--source-commit') || (git(['rev-parse', 'HEAD']).stdout || '').trim() || null,
      db_state: dbSnapshot,
      surfaces,
    };
    // A baseline that cannot certify anything must never be written — a written
    // one gets trusted later. Same rules the comparison enforces, applied at the
    // point the artifact is created.
    const problems = validateBaseline(payload, { requireComplete: true });
    if (problems.length > 0) {
      process.stderr.write('ac2-equivalence: REFUSED to write a baseline that cannot certify anything:\n');
      for (const p of problems) process.stderr.write(`  ! ${p}\n`);
      return 2;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    for (const s of SURFACES) {
      const meta = JSON.stringify(surfaces[s].meta);
      process.stdout.write(`  ${s}: digest ${surfaces[s].digest.slice(0, 16)}… ${meta}\n`);
    }
    process.stdout.write(`ac2-equivalence: captured ${SURFACES.length} surfaces → ${out}\n`);
    return 0;
  }

  if (flag('--compare')) {
    const res = await compare({
      requireComplete: flag('--require-complete-baseline'),
      requirePreEdit: flag('--require-pre-edit'),
      path: value('--baseline') || BASELINE_PATH,
    });
    if (res.fatal) {
      process.stderr.write('ac2-equivalence: REFUSED — the baseline cannot certify anything:\n');
      for (const e of res.fatal) process.stderr.write(`  ! ${e}\n`);
      return 2;
    }
    for (const d of res.diffs) {
      process.stdout.write(`  ${d.ok ? 'identical' : 'CHANGED  '}  ${d.surface}\n`);
      for (const n of d.notes) process.stdout.write(`      ${n}\n`);
    }
    if (res.ok) {
      process.stdout.write(
        `ac2-equivalence: all ${SURFACES.length} surfaces identical to the baseline captured at `
          + `${res.baseline.source_commit}\n`
      );
      return 0;
    }
    process.stderr.write('ac2-equivalence: at least one owner-facing surface moved. AC2 is not satisfied.\n');
    return 1;
  }

  process.stderr.write(
    'ac2-equivalence: usage — --capture-baseline | --capture [--out <path>] | '
      + '--compare [--require-complete-baseline] [--require-pre-edit]\n'
  );
  return 2;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`ac2-equivalence: ${err.stack || err.message}\n`);
      process.exit(2);
    });
}
