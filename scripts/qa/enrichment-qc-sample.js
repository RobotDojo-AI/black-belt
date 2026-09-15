#!/usr/bin/env node
/**
 * Enrichment QC sample selector (st_b50005df Phase 6, AC-4c — Manual QA helper).
 *
 * Owner waiver this implements (verbatim):
 *   "we can do like 10 of each type for me, randomly sampled from the top 100
 *    of each type. as QC."
 *
 * What it does: selects a random 10 of people, 10 of companies, 10 of places
 * from the TOP 100 of each type (by the per-type importance signal), and prints
 * each pick with the exact manual chat-mention steps to run before/after
 * enrichment. It then prints the cold fresh-user proof steps.
 *
 * What it does NOT do (by contract — this is a *selector*, not an enricher):
 *   - It never enriches anything and never spends a cent. Enrichment is a
 *     separate, owner-driven step (08-entity-enrich.js / the always-on worker).
 *   - It never writes to the DB. Every query is a SELECT. The DB is opened
 *     read-only by importing lib/db.js with no writes performed.
 *
 * Per-type importance signal (WHY these, not a single "score" column):
 *   - people:    `score` — the dual-track person score column exists and is the
 *                canonical importance rank.
 *   - companies: `people_count` — companies have NO score column; people_count
 *                is the materialized importance proxy maintenance keeps in sync.
 *   - places:    `total_visits` then `frequency` — places have NO score column;
 *                visit volume is the importance proxy computePlaceScores writes.
 *   The pool is further restricted to enrichment-eligible rows
 *   (`context_file_path IS NOT NULL`, not archived) so the before/after
 *   comparison is meaningful — there is an entity card to enrich, which is the
 *   AC-4c bar ("a visibly richer grounded reply", not merely that a card exists).
 *
 * Usage:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/qa/enrichment-qc-sample.js
 *   # options:
 *   #   --json        machine-readable sample (no manual steps narrative)
 *   #   --per-type N  sample size per type (default 10)
 *   #   --pool N      top-N pool to sample from per type (default 100)
 *   #   --seed S      deterministic shuffle seed (default: time-based)
 *
 * Live-DB pin: this is owner-box QC; point ROBOTDOJO_DB at the live encrypted DB
 * (`~/.robotdojo/robotdojo.db`). It is read-only, so it is safe against live data.
 */
import db from '../../lib/db.js';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
function argNum(flag, fallback) {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const PER_TYPE = argNum('--per-type', 10);
const POOL = argNum('--pool', 100);
const SEED = (() => {
  const i = args.indexOf('--seed');
  if (i < 0) return Date.now() >>> 0;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? (n >>> 0) : Date.now() >>> 0;
})();

// Deterministic (seedable) PRNG so a run is reproducible with --seed. mulberry32
// is small and good enough for a QC shuffle — this is not crypto.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates over a copy, picking the first `k`. */
function sample(rows, k, rng) {
  const a = rows.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

const rng = mulberry32(SEED);

// ── Top-100 pools (enrichment-eligible, ranked by per-type signal) ───────────

const peoplePool = db.prepare(`
  SELECT id, display_name AS name, score AS rank_value, tier, context_file_path
  FROM people
  WHERE COALESCE(archived, 0) = 0
    AND context_file_path IS NOT NULL
    AND display_name IS NOT NULL AND TRIM(display_name) != ''
  ORDER BY COALESCE(score, 0) DESC, id ASC
  LIMIT ?
`).all(POOL);

const companiesPool = db.prepare(`
  SELECT id, name, people_count AS rank_value, tier, context_file_path
  FROM companies
  WHERE COALESCE(archived, 0) = 0
    AND context_file_path IS NOT NULL
    AND name IS NOT NULL AND TRIM(name) != ''
  ORDER BY COALESCE(people_count, 0) DESC, id ASC
  LIMIT ?
`).all(POOL);

const placesPool = db.prepare(`
  SELECT id, name, COALESCE(total_visits, 0) AS rank_value,
         place_type, context_file_path
  FROM places
  WHERE COALESCE(archived, 0) = 0
    AND context_file_path IS NOT NULL
    AND name IS NOT NULL AND TRIM(name) != ''
  ORDER BY COALESCE(total_visits, 0) DESC, COALESCE(frequency, 0) DESC, id ASC
  LIMIT ?
`).all(POOL);

const sampleSet = {
  people: sample(peoplePool, PER_TYPE, rng),
  companies: sample(companiesPool, PER_TYPE, rng),
  places: sample(placesPool, PER_TYPE, rng),
};

const meta = {
  seed: SEED,
  per_type: PER_TYPE,
  pool: POOL,
  database: process.env.ROBOTDOJO_DB || '(default lib/db.js path)',
  pool_sizes: {
    people: peoplePool.length,
    companies: companiesPool.length,
    places: placesPool.length,
  },
};

// Surface a short, honest warning when a pool came back under POOL — the sample
// is still valid (it draws from whatever eligible rows exist) but the owner
// should know the "top 100" was actually "top N<100" for that type.
const poolWarnings = Object.entries(meta.pool_sizes)
  .filter(([, n]) => n < POOL)
  .map(([t, n]) => `${t}: only ${n} enrichment-eligible rows (pool < ${POOL})`);

if (jsonMode) {
  process.stdout.write(JSON.stringify({ meta, warnings: poolWarnings, sample: sampleSet }, null, 2) + '\n');
  process.exit(0);
}

// ── Human narrative + exact manual steps ─────────────────────────────────────

const line = (s = '') => process.stdout.write(s + '\n');

line('═══════════════════════════════════════════════════════════════════════');
line('  Enrichment QC sample — AC-4c manual quality check (st_b50005df)');
line('═══════════════════════════════════════════════════════════════════════');
line(`  DB:        ${meta.database}`);
line(`  Sample:    ${PER_TYPE} each of people / companies / places`);
line(`  Drawn from top ${POOL} by importance (people=score,`);
line(`             companies=people_count, places=total_visits→frequency),`);
line(`             restricted to enrichment-eligible rows (has a context card).`);
line(`  Seed:      ${SEED}  (re-run with --seed ${SEED} to reproduce this exact set)`);
if (poolWarnings.length) {
  line('  WARNING:');
  for (const w of poolWarnings) line(`    - ${w}`);
}
line('');

function printGroup(title, rows, rankLabel, mentionHint) {
  line(`── ${title} (${rows.length}) ${'─'.repeat(Math.max(0, 50 - title.length))}`);
  rows.forEach((r, i) => {
    line(`  ${String(i + 1).padStart(2)}. ${r.name}`);
    line(`      id=${r.id}  ${rankLabel}=${r.rank_value}${r.tier ? `  tier=${r.tier}` : ''}${r.place_type ? `  type=${r.place_type}` : ''}`);
    line(`      mention prompt: "${mentionHint(r.name)}"`);
  });
  line('');
}

printGroup('PEOPLE', sampleSet.people, 'score',
  (n) => `Tell me about ${n} — how do I know them and what should I remember?`);
printGroup('COMPANIES', sampleSet.companies, 'people_count',
  (n) => `What's my connection to ${n}?`);
printGroup('PLACES', sampleSet.places, 'visits',
  (n) => `What do you know about ${n} and my history there?`);

line('═══════════════════════════════════════════════════════════════════════');
line('  HOW TO RUN THE QC (manual, owner-driven — this script spends nothing)');
line('═══════════════════════════════════════════════════════════════════════');
line('  For EACH of the 30 entities above:');
line('');
line('  1) BEFORE — in the real chat app (apps/chat/ → routes/chat.js), send the');
line('     entity\'s "mention prompt" above as an ordinary message. Note whether');
line('     the reply is generic (no real specifics) or already grounded.');
line('');
line('  2) ENRICH — run enrichment for just that entity on YOUR keys, e.g.:');
line('       BELT=black node scripts/ingest/08-entity-enrich.js   # tier-then-score batch');
line('     (or let the always-on worker drain the entity_enrich backlog). This');
line('     script does NOT enrich — enrichment is the paid step you control.');
line('');
line('  3) AFTER — clear the 5-min context cache, then send the SAME mention');
line('     prompt again in the chat app. Confirm the reply is now VISIBLY RICHER');
line('     and grounded in real specifics — not merely that a context card exists.');
line('');
line('  PASS bar: a clear majority show a generic→enriched lift after step 3.');
line('  Record the before/after for each; flag any that did not improve.');
line('');
line('═══════════════════════════════════════════════════════════════════════');
line('  COLD FRESH-USER PROOF (AC-4b cold — the second of the dual proofs)');
line('═══════════════════════════════════════════════════════════════════════');
line('  1) On a clean-slate fresh user (own keys, Black Belt trial active so');
line('     enrichment is ON by default), connect data.');
line('  2) Within hours, in the chat app, mention real people/companies/places');
line('     from that user\'s own world in ordinary messages. Confirm chat cites');
line('     real specifics (not generic filler) — the highest-value content is');
line('     indexed and top entities enriched first, so depth lands early.');
line('  3) Confirm the queue has NO permanently-stuck jobs:');
line('       ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \\');
line('         node scripts/qa/passive-launch-chaos.js --live-db');
line('       ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \\');
line('         node scripts/qa/passive-data-plane-self-heal.js --live-db');
line('  4) Repeat the loaded-box proof on this machine (the ~66%-unembedded box).');
line('     Both proofs run against the live encrypted DB.');
line('');
process.exit(0);
