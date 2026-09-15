/**
 * Dual-track relationship scoring — restored from 1c2118d:lib/scoring.js
 * with the canonical corrections sealed in st_87a0d072 framing.
 *
 * Personal track: iMessage-anchored — sqrt(recent + lifetime amount) ×
 *   recency × trend × reciprocity × directness × mild duration boost.
 * Business track: email/calendar-anchored — sqrt(recent + lifetime amount) ×
 *   recency × active-contact cliff × trend × reciprocity × directness ×
 *   mild duration boost.
 *
 * Score selector: N1 sticky from origin. Personal-origin people use pScore;
 * Professional-origin people use bScore. NO max() — that was the rich
 * baseline's heuristic, the framing-canonical choice is N1-deterministic.
 *
 * Tier from natural breaks: core / network / acquaintance. NO extended tier.
 *
 * Current st_64ac91b0 contract:
 *   Ranking is an internal spend/order signal, not product truth. Keep the
 *   formula broad and high-confidence: communication amount, duration,
 *   recency, recent trend, reciprocity, and directness.
 *
 * Framing-canonical corrections vs. 1c2118d:
 *   1. classifyOrigin: drop 'mixed' return; only 'personal' or 'business'.
 *   2. Score: replace max(pScore,bScore) with N1-based selector.
 *   3. Remove LLM/content-depth and special-occasion bonuses from the active
 *      spend score.
 *   4. tierOf: 3 tiers only (core / network / acquaintance) — Extended folded in.
 *   5. Newsletter/list rows are not hard-excluded from entity existence or
 *      scoring. One-sided/directness penalties should make them low-value
 *      spend candidates without suppressing the underlying entity.
 *
 * Miyagi manual relation_tag overrides have already been applied to
 * people.relation_tag (confidence 1.0) by Phase 7 — this scoring pass reads
 * the tag from the row, never re-classifies.
 *
 * North-star comment: every non-trivial decision below has a WHY. Open
 * source is a teaching artifact.
 */
import db, { ENTITY_RANK_CAP } from './db.js';
import { ownerEmails, ownerPersonId, ownerDisplayNameMatch } from './identity.js';

const DAY_MS = 86400000;
function scoreClockNow() {
  const raw = process.env.ROBOTDOJO_SCORE_NOW;
  const d = raw ? new Date(raw) : new Date();
  if (!Number.isFinite(d.getTime())) return Date.now();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Scores decay by day, not by second. A pipeline rerun on the same corpus must
// be fixed-point; a continuously moving clock rewrites thousands of rows while
// adding no user-visible truth.
const NOW = scoreClockNow();
// Absolute floors keep tiny score distributions from declaring the lone weak
// row "core". Natural breaks sort within a real population; these gates make
// each bucket require enough raw communication signal to justify spend.
//
// st_2cd1af73 Phase 3 — THRESHOLD RE-SHAPE READINESS.
// These floors and the natural-break percentile targets below are the only
// two levers that set how wide the meaningful tiers (Core / Network) grow.
// The owner's target after re-score is a few thousand meaningful people
// (Core ≥250, Network ≥250, total meaningful ≥1500), not a few hundred.
// Lower floors + earlier percentile cuts admit more of a real population into
// the meaningful tiers; they do NOT invent signal — a person still needs a
// positive score to clear any floor. We make these ADJUSTABLE rather than
// re-hardcoding new magic numbers: the actual calibration happens in the
// re-score run (Miyagi triggers `computeAllScores` against the live DB and
// reads back the four-tier gradient), where the real distribution is visible.
// The defaults preserve the prior behavior exactly; an env override widens
// the tiers when the live distribution shows the breaks still collapsing.
//
// WHY env, not config/defaults.json: scoring is a hot inner loop run from the
// pipeline and from tests against an in-memory DB; an env read is zero-import,
// zero-IO, and overridable per-run by the calibration step without editing a
// committed file. A numeric parse with a finite fallback means a malformed
// override can never NaN-poison a tier boundary.
const envNum = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
};
// Defaults calibrated live 2026-06-10 (st_2cd1af73 AC-5): the owner's bar is a
// few thousand meaningful people across the tiers, not a few hundred. The old
// floors (5 / 1 / 0.25) collapsed the gradient to ~260 because multi-year
// recency decay pushes real-but-older relationships toward zero score. With
// these floors the live DB yields meaningful=1,668 (core 267 / network 1,401)
// over 15.8k active people — squarely in the owner's target band.
const MIN_CORE_SCORE = envNum('ROBOTDOJO_TIER_MIN_CORE', 0.5);
const MIN_NETWORK_SCORE = envNum('ROBOTDOJO_TIER_MIN_NETWORK', 0.01);
const MIN_EXTENDED_SCORE = envNum('ROBOTDOJO_TIER_MIN_EXTENDED', 0.001);
// Natural-break search targets: the percentile rank around which findBreaks
// looks for the largest score-ratio gap for each tier boundary. Earlier cuts
// (smaller percentiles) push the core/network boundaries up the distribution,
// widening the meaningful tiers. Defaults match the prior 0.05 / 0.15 / 0.50.
const BREAK_PCT_CORE = envNum('ROBOTDOJO_TIER_PCT_CORE', 0.05);
const BREAK_PCT_NETWORK = envNum('ROBOTDOJO_TIER_PCT_NETWORK', 0.15);
const BREAK_PCT_EXTENDED = envNum('ROBOTDOJO_TIER_PCT_EXTENDED', 0.50);

const FREE_PROVIDERS = new Set([
  'gmail.com','yahoo.com','hotmail.com','icloud.com','me.com','aol.com',
  'outlook.com','live.com','mac.com','msn.com','protonmail.com','pm.me','fastmail.com',
]);

// ── Math primitives ──
//   recency(ms, half) — exponential half-life decay; missing date → 0.01 (never zero, never one)
//   recip(out, tot)   — 0.7 base + 0.5 bonus peaking at 50% outbound; one-sided relationships lose 0.5
//   direct(d, g)      — group-message penalty (0.3–1.0); ≥50 direct interactions removes the gate
//   cliff(ms)         — business-relationship cliff: 1.0 for ≤2yr silence, 0.5 for 2–5yr, 0.2 for >5yr
//
// st_87a0d072 CHANGE 4 (tighten): durBonus DELETED. The original primitive lifted
// scores by up to +30% based on years-since-first-interaction, which actively
// rewarded long-known but currently-distant relationships (e.g. a sibling whose
// 5yr backlog ranked above a daily-contact spouse). The framing-canonical
// direction is the OPPOSITE: rank by who matters NOW, not who's known longest.
const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, v));
const recency = (ms, half) => ms ? Math.pow(0.5, (NOW - ms) / (half * DAY_MS)) : 0.01;
const recip = (out, tot) => tot ? 0.7 + clamp(0, 1 - Math.abs(out / tot - 0.5) * 2, 1) * 0.5 : 1;
function direct(d, g) {
  if (d + g === 0) return 1;
  if (d >= 50) return 1;
  const r = d / (d + g);
  return r >= 0.8 ? 1 : 0.3 + r * 0.875;
}
function cliff(ms) {
  if (!ms) return 0.3;
  const y = (NOW - ms) / (365 * DAY_MS);
  return y > 5 ? 0.2 : y > 2 ? 0.5 : 1;
}

// ── Prepared statements (lazy) ──
// WHY lazy: tests/scoring.test.js imports this module against an in-memory DB
// that hasn't yet seen the migration apply. db.prepare() at module-init would
// throw on missing tables. Cached after first call.
let _s = null;
function S() {
  if (_s) return _s;
  _s = {
    bd: db.prepare(`SELECT channel, direction, COUNT(*) as cnt, MAX(date) as last_date FROM person_interactions WHERE person_id = ? GROUP BY channel, direction`),
    bizOut: db.prepare(`SELECT COUNT(*) as c FROM person_interactions WHERE person_id = ? AND direction IN ('outbound','mutual') AND channel IN ('email','calendar')`),
    imsgOut: db.prepare(`SELECT COUNT(*) as c FROM person_interactions WHERE person_id = ? AND direction IN ('outbound','mutual','group_out') AND channel = 'imessage'`),
    // st_93fddaf0 Phase 4 (Onnela PNAS 2007): mutual-only iMessage count for
    // the logistics-cap reciprocity rule. mutual = same-day bidirectional
    // exchange. mutual=0 with high total interaction volume is the
    // logistics/service signature — Onnela strict says exclude entirely;
    // we use a soft cap to preserve genuinely-personal inbound-only rows.
    imsgMutual: db.prepare(`SELECT COUNT(*) as c FROM person_interactions WHERE person_id = ? AND channel = 'imessage' AND direction = 'mutual'`),
    cal: db.prepare(`SELECT COUNT(*) as c FROM person_interactions WHERE person_id = ? AND channel = 'calendar'`),
    // st_87a0d072 CHANGE 3 — recency-weighted base count.
    // Lifetime-only sqrt() let a sibling's 5yr iMessage backlog dominate a
    // spouse's daily-but-recent flow. These statements aggregate the same
    // signals (direct iMessage / weighted email+cal) but restricted to the
    // last 180 days, so the score formula can give recent activity
    // ~20× the weight of lifetime accumulation (see imsgRecent / bizRecent
    // call sites below).
    imsgRecent: db.prepare(`SELECT COUNT(*) as c FROM person_interactions WHERE person_id = ? AND channel = 'imessage' AND direction NOT IN ('group_in','group_out') AND date >= datetime('now','-180 days')`),
    bizRecent: db.prepare(`SELECT direction, channel, COUNT(*) as cnt FROM person_interactions WHERE person_id = ? AND channel IN ('email','calendar') AND date >= datetime('now','-180 days') GROUP BY direction, channel`),
    con: db.prepare(`SELECT COUNT(*) AS c FROM (SELECT strftime('%Y', date) || '-' || ((CAST(strftime('%m', date) AS INTEGER) - 1) / 3) AS q FROM person_interactions WHERE person_id = ? GROUP BY q HAVING COUNT(*) >= 3)`),
    r90: db.prepare(`SELECT COUNT(*) as c FROM person_interactions WHERE person_id = ? AND date >= ? AND channel IN (?, ?)`),
    r275: db.prepare(`SELECT COUNT(*) as c FROM person_interactions WHERE person_id = ? AND date < ? AND date >= ? AND channel IN (?, ?)`),
    // Owner-email lookup: prefer the identity.json person_id; else fall back to
    // display_name_match. Either way, the resulting statement takes person_id
    // placeholders at execution time.
    oeByPid: db.prepare(`SELECT LOWER(value) AS v FROM person_identifiers WHERE type='email' AND person_id = ?`),
    oeByName: db.prepare(`SELECT LOWER(value) AS v FROM person_identifiers WHERE type='email' AND person_id IN (SELECT id FROM people WHERE LOWER(display_name) LIKE ?)`),
    news: db.prepare(`SELECT SUM(CASE WHEN e.list_unsubscribe IS NOT NULL OR e.is_newsletter = 1 THEN 1 ELSE 0 END) AS news, COUNT(*) AS total FROM person_interactions pi JOIN emails e ON e.id = pi.source_id WHERE pi.person_id = ? AND pi.channel = 'email' AND pi.direction = 'inbound'`),
  };
  return _s;
}

function trend90(pid, ch) {
  const d90 = new Date(NOW - 90 * DAY_MS).toISOString();
  const d365 = new Date(NOW - 365 * DAY_MS).toISOString();
  const r = S().r90.get(pid, d90, ch[0], ch[1] || ch[0])?.c || 0;
  const o = S().r275.get(pid, d90, d365, ch[0], ch[1] || ch[0])?.c || 0;
  const n = o * (90 / 275);
  return n <= 0 ? (r > 0 ? 1.5 : 1) : clamp(0.5, r / n, 2);
}

// ── Origin classifier ──
// Owner email set: seed from identity.json (ownerEmails() imported above)
// and also union with any aliases recorded on the owner's person row in the DB.
let _oe = null;
function ownerEmailSet() {
  if (_oe) return _oe;
  const s = new Set(ownerEmails()); // from ~/robotdojo/config/identity.json
  const pid = ownerPersonId();
  if (pid) {
    for (const r of S().oeByPid.all(pid)) s.add(r.v);
  } else {
    const nameMatch = ownerDisplayNameMatch();
    if (nameMatch) for (const r of S().oeByName.all(`%${nameMatch}%`)) s.add(r.v);
  }
  _oe = s;
  return _oe;
}

function deriveOrigin(pid) {
  const first = db.prepare(`SELECT channel, source_id, direction FROM person_interactions WHERE person_id = ? ORDER BY date ASC LIMIT 1`).get(pid);
  if (!first) return 'business';
  if (first.channel === 'imessage') return 'personal';
  if (first.channel === 'calendar') return 'business';
  const own = ownerEmailSet();
  const ph = [...own].map(() => '?').join(',');
  const sql = own.size > 0
    ? `SELECT e.sender_email FROM person_interactions pi JOIN emails e ON e.id = pi.source_id WHERE pi.person_id = ? AND pi.channel = 'email' AND LOWER(e.sender_email) NOT IN (${ph}) ORDER BY pi.date ASC LIMIT 1`
    : `SELECT e.sender_email FROM person_interactions pi JOIN emails e ON e.id = pi.source_id WHERE pi.person_id = ? AND pi.channel = 'email' ORDER BY pi.date ASC LIMIT 1`;
  const row = own.size > 0 ? db.prepare(sql).get(pid, ...own) : db.prepare(sql).get(pid);
  if (!row?.sender_email) return 'business';
  const d = row.sender_email.split('@')[1]?.toLowerCase() || '';
  return FREE_PROVIDERS.has(d) ? 'personal' : 'business';
}

/**
 * Classify relationship origin.
 *
 * CORRECTION #1: 'mixed' return DROPPED. The original transcendence rule
 * lifted business-origin people to 'mixed' once they accumulated deep
 * personal signal (content_depth ≥ 6, ≥10 yrs known, etc.). The framing-canonical
 * choice is sticky N1: business-origin stays business, personal stays personal.
 * Manual override via Miyagi set-relation-tag is the user-controlled escape
 * hatch.
 *
 * @returns {'personal' | 'business'}
 */
export function classifyOrigin(personId) {
  const row = db.prepare(`SELECT relationship_origin FROM people WHERE id = ?`).get(personId);
  if (row?.relationship_origin) {
    // Existing stored origin wins — sticky from first computation. Normalise
    // any stale 'mixed' rows back to 'business' since 'mixed' is gone.
    return row.relationship_origin === 'mixed' ? 'business' : row.relationship_origin;
  }
  return deriveOrigin(personId);
}

/**
 * Fraction of this person's inbound emails that are newsletter-flagged.
 * Retained for tests / external introspection only; newsletter/list status is
 * no longer an entity or scoring hard-exclusion.
 */
export function newsletterRatio(personId) {
  const row = S().news.get(personId);
  if (!row?.total) return 0;
  return row.news / row.total;
}

// ── Natural break detection ──
// WHY exported: 05-score.js calls findBreaks against the score distributions
// (Personal vs Professional separately) to compute N2 tier bands.
// 3-break shape preserved for callers (core / network / extended). Extended
// is dead code inside this module after CORRECTION #6; 05-score.js uses it
// solely to compute the network band for Professional N2.
export function findBreaks(scores) {
  const n = scores.length;
  if (n < 10) {
    return {
      core: Math.max(scores[0] || 0, MIN_CORE_SCORE),
      network: MIN_NETWORK_SCORE,
      extended: MIN_EXTENDED_SCORE,
    };
  }
  const breaks = {};
  for (const { name, pct } of [{ name: 'core', pct: BREAK_PCT_CORE }, { name: 'network', pct: BREAK_PCT_NETWORK }, { name: 'extended', pct: BREAK_PCT_EXTENDED }]) {
    const ti = Math.floor(n * pct);
    const lo = Math.max(1, ti - Math.floor(n * 0.02)), hi = Math.min(n - 1, ti + Math.floor(n * 0.02));
    let bestGap = 0, bestScore = scores[ti];
    for (let i = lo; i <= hi; i++) { const g = scores[i - 1] / scores[i]; if (g > bestGap) { bestGap = g; bestScore = scores[i]; } }
    breaks[name] = bestScore;
  }
  breaks.core = Math.max(breaks.core, MIN_CORE_SCORE);
  breaks.network = Math.max(breaks.network, MIN_NETWORK_SCORE);
  breaks.extended = Math.max(breaks.extended, MIN_EXTENDED_SCORE);
  if (breaks.network >= breaks.core) breaks.network = breaks.core * 0.5;
  if (breaks.extended >= breaks.network) breaks.extended = breaks.network * 0.1;
  return breaks;
}

// ── Family tag set ──
// WHY exported: Phase 5 / N2 assignment guards against overwriting Family
// tier when the person has a family relation_tag. config/family.json members
// and Miyagi set-relation-tag calls populate relation_tag from this set.
// st_df0a8d71 — the CANONICAL definition moved to lib/relation-vocabulary.js
// (the single closed vocabulary module, deliberately db-free so the
// prompt-assembly import graph never opens the DB as an import side effect);
// imported + re-exported here so every existing consumer keeps its path.
// Gendered sub-labels (mother vs father) live in people.relation_label.
import { FAMILY_TAGS } from './relation-vocabulary.js';
export { FAMILY_TAGS };

// ── Main scoring ──
// CORRECTION #6: 3 tiers + family-tag — no 'extended'. acquaintance/network/core.
const TR = { acquaintance: 0, network: 1, core: 2 };

/**
 * Compute scores for every active person, assign N1-deterministic tiers,
 * write to people.score/personal_score/business_score/tier.
 *
 * @param {{dryRun?: boolean, verbose?: boolean}} opts
 * @returns {{results, tierCounts, breaks}}
 */
// st_f1a40461: set-based relationship_origin backfill. Replaces ~20K per-person
// deriveOrigin() email-join queries — the score-phase stall (~8 min at 20K people,
// deriveEmail measured >24ms/person) — with two windowed passes + one transaction.
// After this runs, the per-person classifyOrigin() reads a stored value (fast path)
// instead of the slow earliest-non-owner-email join. Faithful to deriveOrigin():
// imessage-first → personal; calendar-first → business; else earliest non-owner
// email domain (freemail → personal, else business; none → business).
function backfillOriginsSetBased(log = () => {}) {
  db.exec('CREATE INDEX IF NOT EXISTS idx_pi_person_date ON person_interactions(person_id, date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pi_person_chan_date ON person_interactions(person_id, channel, date)');
  db.exec('DROP TABLE IF EXISTS _origin_first; DROP TABLE IF EXISTS _origin_email;');
  db.exec(`
    CREATE TEMP TABLE _origin_first AS
      SELECT person_id, channel FROM (
        SELECT person_id, channel,
               ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY date ASC, id ASC) rn
        FROM person_interactions
      ) WHERE rn = 1;
  `);
  const owner = [...ownerEmailSet()];
  const notIn = owner.length ? `AND LOWER(e.sender_email) NOT IN (${owner.map(() => '?').join(',')})` : '';
  db.prepare(`
    CREATE TEMP TABLE _origin_email AS
      SELECT person_id, dom FROM (
        SELECT pi.person_id,
               LOWER(SUBSTR(e.sender_email, INSTR(e.sender_email, '@') + 1)) dom,
               ROW_NUMBER() OVER (PARTITION BY pi.person_id ORDER BY pi.date ASC) rn
        FROM person_interactions pi
        JOIN emails e ON e.id = pi.source_id
        WHERE pi.channel = 'email' AND e.sender_email IS NOT NULL ${notIn}
      ) WHERE rn = 1;
  `).run(...owner);
  const emailDom = new Map(
    db.prepare('SELECT person_id, dom FROM _origin_email').all().map((r) => [r.person_id, r.dom]),
  );
  const firsts = db.prepare('SELECT person_id, channel FROM _origin_first').all();
  const upd = db.prepare('UPDATE people SET relationship_origin = ? WHERE id = ? AND relationship_origin IS NULL');
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      let origin;
      if (r.channel === 'imessage') origin = 'personal';
      else if (r.channel === 'calendar') origin = 'business';
      else {
        const d = emailDom.get(r.person_id);
        origin = d ? (FREE_PROVIDERS.has(d) ? 'personal' : 'business') : 'business';
      }
      upd.run(origin, r.person_id);
    }
  });
  tx(firsts);
  db.exec('DROP TABLE IF EXISTS _origin_first; DROP TABLE IF EXISTS _origin_email;');
  log(`  Origins backfilled set-based: ${firsts.length} people`);
}

export function computeAllScores({ dryRun = false, verbose = false } = {}) {
  const log = verbose ? console.log.bind(console) : () => {};
  backfillOriginsSetBased(log);
  const allPeople = db.prepare(`
    SELECT id, display_name, short_name, interaction_count, first_seen, last_seen,
           tier, relation_tag, relationship_origin, archived,
           imessage_msg_count, imessage_group_count, primary_source
    FROM people WHERE COALESCE(archived, 0) = 0
    ORDER BY interaction_count DESC
  `).all();

  log(`Scoring ${allPeople.length} people`);
  const results = [];
  const excluded = { owner: 0 };

  // Resolve owner identifiers once for exclusion.
  const _ownerPid = ownerPersonId();
  const _ownerName = ownerDisplayNameMatch();

  for (const p of allPeople) {
    if (_ownerPid && p.id === _ownerPid) { excluded.owner++; continue; }
    if (_ownerName && p.display_name.toLowerCase().includes(_ownerName)) { excluded.owner++; continue; }

    const bd = S().bd.all(p.id);
    const firstMs = p.first_seen ? new Date(p.first_seen).getTime() : null;
    const origin = p.relationship_origin || classifyOrigin(p.id);
    // CORRECTION #1: no 'mixed' — normalise legacy rows.
    const n1 = origin === 'personal' ? 'personal' : 'business';
    const isFamily = p.relation_tag && FAMILY_TAGS.has(p.relation_tag);

    let eSent = 0, eRecv = 0, eCc = 0, calCnt = 0, iCnt = 0, iGrp = 0;
    let lastEC = null, lastOut = null, lastI = null;
    for (const r of bd) {
      const ts = r.last_date ? new Date(r.last_date).getTime() : 0;
      if (r.channel === 'imessage') {
        if (r.direction === 'group_in' || r.direction === 'group_out') iGrp += r.cnt; else iCnt += r.cnt;
        if (!lastI || ts > lastI) lastI = ts;
        if ((r.direction === 'outbound' || r.direction === 'group_out') && (!lastOut || ts > lastOut)) lastOut = ts;
      } else if (r.channel === 'email') {
        if (r.direction === 'outbound') { eSent += r.cnt; if (!lastOut || ts > lastOut) lastOut = ts; }
        else if (r.direction === 'inbound') eRecv += r.cnt; else eCc += r.cnt;
        if (!lastEC || ts > lastEC) lastEC = ts;
      } else if (r.channel === 'calendar') {
        calCnt += r.cnt;
        if (!lastEC || ts > lastEC) lastEC = ts;
      }
    }

    const eTotal = eSent + eRecv + eCc;
    const totalDirect = iCnt + eTotal + calCnt;
    if (totalDirect === 0 && iGrp === 0) {
      results.push({
        id: p.id,
        name: p.display_name,
        shortName: p.short_name,
        personalScore: 0,
        businessScore: 0,
        score: 0,
        origin: n1,
        isFamily,
        consistency: 0,
        totalDirect: 0,
        firstMs,
      });
      continue;
    }

    const totalQ = firstMs ? Math.max(1, Math.floor((NOW - firstMs) / (90 * DAY_MS))) : 0;
    const consistency = totalQ ? clamp(0, (S().con.get(p.id)?.c || 0) / totalQ, 1) : 0;
    const yearsKnown = firstMs ? (NOW - firstMs) / (365 * DAY_MS) : 0;
    // Duration matters, but it must not swamp current reality. A five-year
    // history can add up to 20%; amount, recency, trend, and directness still
    // dominate spend routing.
    const durationBoost = 1 + clamp(0, yearsKnown / 5, 1) * 0.2;

    // Personal track
    let pScore = 0;
    if (iCnt + iGrp > 0) {
      const tot = iCnt + iGrp;
      // st_87a0d072 CHANGE 3 — recency-weighted base.
      // WHY: lifetime sqrt(tot) made a sibling's multi-year backlog outscore
      // a spouse's daily flow — historical accumulation dominated currently
      // dense interaction. New formula: recent-180d direct iMessages × 2
      // (annualizes the window ≈ year of recent activity) + lifetime × 0.1
      // (10% floor so lifetime contribution survives but does not dominate).
      // Square root preserves the diminishing-returns shape of the prior formula.
      const iCntRecent = S().imsgRecent.get(p.id)?.c || 0;
      const base = Math.sqrt((iCntRecent * 2) + (iCnt * 0.1));
      // st_87a0d072 CHANGE 1 — personal half-life 365d → 90d.
      // WHY: 365d half-life retains 50% weight on a year-old conversation,
      // so an inactive sibling still appears "active enough" to outrank a
      // currently-engaged spouse. 90d (one quarter) puts the score on a
      // cadence that matches lived relationship rhythm.
      let rec = recency(lastI, 90);
      const tr = tot < 50 ? Math.min(trend90(p.id, ['imessage', 'imessage']), 1.2) : trend90(p.id, ['imessage', 'imessage']);
      // st_93fddaf0 Phase 4 — Onnela reciprocity logistics cap.
      // WHY: a person we've exchanged >30 iMessages with but NEVER on a
      // bidirectional same-day basis is the logistics signature (neighbor
      // texts about packages, service vendor schedule confirms). The
      // standard recip() multiplier ranges 0.7–1.2 and lets these volume
      // outliers dominate the personal-track ranking. Capping rp at 0.3
      // pins them at Acquaintance regardless of volume.
      // WHY not hard-exclude (Onnela strict): 29 live-DB rows are
      // inbound-only legitimate personal contacts. The cap floors them, the
      // exclusion would erase them.
      // Threshold: >30 interactions with zero mutual exchanges. Below 30,
      // the signal is too thin to penalize via this rule.
      // Reference: Onnela et al., PNAS 2007.
      const iMutual = S().imsgMutual.get(p.id)?.c || 0;
      const iOutCount = S().imsgOut.get(p.id)?.c || 0;
      const isLogisticsOnly = iMutual === 0 && tot > 30;
      const rp = isLogisticsOnly ? 0.3 : recip(iOutCount, tot);
      const yrs = firstMs ? (NOW - firstMs) / (365 * DAY_MS) : 0;
      // Long-history floor: 200+ DIRECT interactions AND 5+yrs of history →
      // recency floor of 0.6 prevents inactive close relationships from
      // sinking purely on the recency multiplier.
      //
      // st_87a0d072 refinement: the floor requires DIRECT interactions, not
      // group-only. A person you've been in 500 group threads with for 5
      // years but never directly messaged is a peripheral relationship and
      // must NOT benefit from the floor. (Original 1c2118d used `tot` —
      // including group; that produced the deceased-grandmother bug.)
      if (iCnt >= 200 && yrs >= 5) rec = Math.max(0.6, rec);
      pScore = base * rec * tr * rp * direct(iCnt, iGrp) * durationBoost;
    }

    // Business track
    let bScore = 0;
    if (eTotal > 0 || calCnt > 0) {
      const w = (eSent * 3) + eRecv + (eCc * 0.05) + (calCnt * 2);
      // st_87a0d072 CHANGE 3 — recency-weighted base for business track.
      // WHY: same lifetime-vs-recent imbalance as personal. Aggregate the
      // last-180d email+calendar rows by direction/channel, apply the same
      // (sent×3 + recv + cc×0.05 + cal×2) weighting, then combine with
      // ×2 recent + ×0.1 lifetime (mirrors personal formula).
      let eSentR = 0, eRecvR = 0, eCcR = 0, calCntR = 0;
      for (const r of (S().bizRecent.all(p.id) || [])) {
        if (r.channel === 'calendar') calCntR += r.cnt;
        else if (r.direction === 'outbound') eSentR += r.cnt;
        else if (r.direction === 'inbound') eRecvR += r.cnt;
        else eCcR += r.cnt;
      }
      const wRecent = (eSentR * 3) + eRecvR + (eCcR * 0.05) + (calCntR * 2);
      const baseB = Math.sqrt((wRecent * 2) + (w * 0.1));
      // st_87a0d072 CHANGE 2 — business half-life 730d → 180d.
      // WHY: 2yr half-life is far too forgiving — a former colleague you
      // haven't spoken to in a year still scores ~70% of an active client.
      // 180d (~6mo) matches business cadence: an actively-managed
      // relationship gets touched at least quarterly; anything older
      // legitimately decays.
      const rec = lastOut ? recency(lastOut, 180) : recency(lastEC, 180) * 0.3;
      const tr = totalDirect < 50 ? Math.min(trend90(p.id, ['email', 'calendar']), 1.2) : trend90(p.id, ['email', 'calendar']);
      const rp = recip(S().bizOut.get(p.id)?.c || 0, eTotal + calCnt);
      bScore = baseB * rec * cliff(lastOut) * tr * rp * direct(eSent + eRecv, eCc) * durationBoost;
    }

    // CORRECTION #2: N1-deterministic score selector — NOT max().
    // Personal-origin people are scored by their personal track.
    // Business-origin people are scored by their business track.
    // This makes the score reflect the relationship's true character,
    // not whichever signal happens to be louder for any given month.
    const score = n1 === 'personal' ? pScore : bScore;

    const listOnly = eRecv > 0 && eSent === 0 && eCc === 0 && calCnt === 0 && newsletterRatio(p.id) >= 0.8;

    results.push({ id: p.id, name: p.display_name, shortName: p.short_name,
      personalScore: pScore, businessScore: bScore, score,
      origin: n1, isFamily, consistency, totalDirect, firstMs, listOnly });
  }

  // Tier assignment
  // CORRECTION #6: 3 tiers — no extended. Acquaintance / Network / Core.
  // Family tag short-circuits to Core for personal-origin people; the n2
  // assignment in 05-score.js applies the Family/Partners/Customers label.
  results.sort((a, b) => b.score - a.score);
  const breaks = findBreaks(results.map(r => r.score).filter(s => s > 0));
  log(`Breaks: core=${breaks.core.toFixed(1)}, network=${breaks.network.toFixed(1)}`);

  const tierOf = (s) => s >= breaks.core ? 'core' : s >= breaks.network ? 'network' : 'acquaintance';
  for (const r of results) {
    let pT = tierOf(r.personalScore), bT = tierOf(r.businessScore);
    // Cross-track caps preserved from 1c2118d: business-origin people can't
    // ride into core via their personal track; personal-origin same with business.
    if (r.origin === 'business' && TR[pT] > TR.network) pT = 'network';
    if (r.origin === 'personal' && TR[bT] > TR.network) bT = 'network';
    r.personalTier = pT; r.businessTier = bT;
    // Tier is whichever single track dominates. Family-tagged people lift to
    // core regardless (they're in n2='Family' anyway via Phase 4 detection).
    r.tier = r.isFamily ? 'core' : (TR[pT] >= TR[bT] ? pT : bT);

    const yrs = r.firstMs ? (NOW - r.firstMs) / (365 * DAY_MS) : 0;
    // Spam-floor protection: a "core" person we've only had <5 direct
    // interactions with across 3+ years is too thin — drop to network.
    if (r.totalDirect < 5 && yrs >= 3 && r.tier === 'core' && !r.isFamily) r.tier = 'network';
    // Newsletter/list-only senders remain entities, but they are broadcast
    // sources, not relationships worth spend. Keep them queryable without
    // promoting them into the network tier in small score distributions.
    if (r.listOnly && !r.isFamily) r.tier = 'acquaintance';
  }

  const tierCounts = {};
  for (const r of results) tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
  console.log(`Scored: ${results.length} people`);
  console.log(`Excluded: owner=${excluded.owner}`);
  console.log('Tiers:', Object.entries(tierCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', '));

  if (dryRun) return { results, tierCounts, breaks };

  const update = db.prepare(`
    UPDATE people
       SET score=?, business_score=?, personal_score=?, tier=?, personal_tier=?,
           business_tier=?, relationship_origin=?, consistency_score=?,
           updated_at=datetime('now')
     WHERE id=?
       AND (
         score IS NOT ? OR business_score IS NOT ? OR personal_score IS NOT ?
         OR tier IS NOT ? OR personal_tier IS NOT ? OR business_tier IS NOT ?
         OR relationship_origin IS NOT ? OR consistency_score IS NOT ?
       )
  `);
  let updated = 0;
  db.transaction(() => {
    for (const r of results) {
      updated += update.run(
        r.score, r.businessScore, r.personalScore, r.tier, r.personalTier, r.businessTier, r.origin, r.consistency,
        r.id,
        r.score, r.businessScore, r.personalScore, r.tier, r.personalTier, r.businessTier, r.origin, r.consistency,
      ).changes;
    }
  })();
  console.log(`Updated ${updated}/${results.length} people in DB.`);

  const aliasStats = generateAliases(results.filter(r => r.tier !== 'acquaintance'));
  return { results, tierCounts, breaks, updated, aliases: aliasStats };
}

function generateAliases(people) {
  const desired = new Set();
  for (const p of people) {
    const lo = p.name.toLowerCase().trim();
    const aliases = new Set([lo, lo.replace(/\./g, '').replace(/\s+/g, ' ').trim()]);
    if (p.shortName?.length > 1) { aliases.add(p.shortName.toLowerCase()); aliases.add(p.shortName.toLowerCase().replace(/\./g, '').trim()); }
    const parts = lo.replace(/\./g, '').split(/\s+/).filter(Boolean);
    if (parts.length > 2) aliases.add(`${parts[0]} ${parts[parts.length - 1]}`);
    for (const a of aliases) if (a.length > 1) desired.add(`${p.id}\u0000${a}`);
  }

  const current = new Set(
    db.prepare('SELECT person_id, alias FROM person_aliases').all()
      .map((row) => `${row.person_id}\u0000${row.alias}`)
  );
  const ins = db.prepare('INSERT OR IGNORE INTO person_aliases (person_id, alias) VALUES (?, ?)');
  const del = db.prepare('DELETE FROM person_aliases WHERE person_id = ? AND alias = ?');
  const n = db.transaction(() => {
    let inserted = 0;
    let deleted = 0;
    for (const key of desired) {
      if (current.has(key)) continue;
      const [personId, alias] = key.split('\u0000');
      inserted += ins.run(personId, alias).changes;
    }
    for (const key of current) {
      if (desired.has(key)) continue;
      const [personId, alias] = key.split('\u0000');
      deleted += del.run(personId, alias).changes;
    }
    return { total: desired.size, inserted, deleted };
  })();
  console.log(`Generated ${n.total} aliases (${n.inserted} inserted, ${n.deleted} deleted).`);
  return n;
}

export function computePlaceScores() {
  const places = db.prepare(`SELECT id, place_type, frequency FROM places`).all();
  // st_f1a40461: precompute city → distinct-years in ONE indexed query.
  // The prior form ran a query PER city (1,079×), each joining the full
  // timeline_event_entities/timeline_events tables with a CAST that defeated
  // idx_tee_entity — it exploded to minutes once E4 populated those tables
  // (and worse against stale rows hardDelete left behind). This single GROUP BY
  // uses idx_tee_entity (verified ~1.1s) and is looked up from a Map.
  const yearsByCity = new Map();
  try {
    for (const r of db.prepare(`
      SELECT child.parent_place_id AS city_id,
             COUNT(DISTINCT strftime('%Y', te.event_date)) AS yrs
      FROM places child
      JOIN timeline_event_entities tee
        ON tee.entity_type = 'place' AND tee.entity_id = CAST(child.id AS TEXT)
      JOIN timeline_events te ON te.id = tee.event_id
      WHERE child.parent_place_id IS NOT NULL
      GROUP BY child.parent_place_id
    `).all()) {
      yearsByCity.set(r.city_id, r.yrs || 0);
    }
  } catch { /* timeline tables absent in minimal envs — non-fatal */ }
  const upd = db.prepare(`
    UPDATE places
       SET total_visits = ?, years_lived = ?
     WHERE id = ?
       AND (total_visits IS NOT ? OR years_lived IS NOT ?)
  `);
  let updated = 0;
  db.transaction(() => {
    for (const p of places) {
      const yrs = p.place_type === 'city' ? (yearsByCity.get(p.id) || 0) : 0;
      updated += upd.run(p.frequency, yrs, p.id, p.frequency, yrs).changes;
    }
  })();
  console.log(`Scored ${places.length} places (${updated} changed).`);
  return { scanned: places.length, updated };
}

/**
 * st_2d941f89 (gap 2) — assign entity_rank (1..ENTITY_RANK_CAP, prominence
 * order) to the top ENTITY_RANK_CAP rows of each entity class, clearing
 * entity_rank for any row that falls out of the top band on a re-run. Feeds
 * lib/db.js's VALUE_RANK_SQL_EXPR entity-rank-ordinal term (the embed-order
 * ask) — this is the ONLY writer of these three columns.
 *
 * Ranking key per class (revealed/actual over stated, matching this repo's
 * entity-extraction hierarchy):
 *   - people:    score DESC        (people.score — the live dual-track
 *                                    business+personal spend score
 *                                    computeAllScores already recomputes
 *                                    earlier in the same RESCORE phase)
 *   - companies: people_count DESC (companies has no aggregate score column;
 *                                    people_count — how many known people tie
 *                                    to it, kept fresh by phaseRescore right
 *                                    before this call — is the best available
 *                                    prominence proxy; no literal rank column
 *                                    exists on any of the three tables)
 *   - places:    total_visits DESC (this file's own computePlaceScores output
 *                                    — actual visit frequency over any
 *                                    stated/declared signal)
 * `id ASC` is the tiebreak on every class so a re-run with identical scores
 * is deterministic (no flapping rank assignment run to run).
 *
 * WHY reset-then-reassign per class in two bounded statements (not a per-row
 * loop): the reset is cheap (the partial index on entity_rank means it only
 * ever touches the PRIOR run's <= ENTITY_RANK_CAP ranked rows); the ROW_NUMBER()
 * window runs ONCE per class here, inside the daily RESCORE phase's already-
 * wide (900s) budget — never inside a per-chunk correlated subquery, which
 * would re-rank the whole class table on every chunk touched (see lib/db.js's
 * ENTITY_RANK_CAP WHY comment for the full architecture rationale).
 *
 * @param {object} [database] better-sqlite3 connection (defaults to db)
 * @returns {{person:number, company:number, place:number}} rows now carrying
 *   a non-NULL entity_rank per class (== min(CAP, live unarchived row count))
 */
export function computeEntityRanks(database = db) {
  const RANK_SPECS = [
    { table: 'people', orderBy: 'COALESCE(score, 0) DESC, id ASC', key: 'person' },
    { table: 'companies', orderBy: 'COALESCE(people_count, 0) DESC, id ASC', key: 'company' },
    { table: 'places', orderBy: 'COALESCE(total_visits, 0) DESC, id ASC', key: 'place' },
  ];
  const counts = {};
  for (const { table, orderBy, key } of RANK_SPECS) {
    // Reset first so a row that fell out of the top band on THIS pass (a
    // formerly-top-CAP row overtaken by another's rising score) never carries
    // a stale rank forward. Bounded — the partial index means this only ever
    // touches the prior run's <= ENTITY_RANK_CAP already-ranked rows.
    database.prepare(`UPDATE ${table} SET entity_rank = NULL WHERE entity_rank IS NOT NULL`).run();
    database.exec(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY ${orderBy}) AS rn
        FROM ${table}
        WHERE COALESCE(archived, 0) = 0
      )
      UPDATE ${table} SET entity_rank = (SELECT rn FROM ranked WHERE ranked.id = ${table}.id)
      WHERE id IN (SELECT id FROM ranked WHERE rn <= ${ENTITY_RANK_CAP})
    `);
    counts[key] = database.prepare(`SELECT COUNT(*) n FROM ${table} WHERE entity_rank IS NOT NULL`).get().n;
  }
  console.log(`[scoring] entity_rank: ${counts.person} people, ${counts.company} companies, ${counts.place} places ranked (cap ${ENTITY_RANK_CAP} each)`);
  return counts;
}
