/**
 * Referral candidate scoring — qualified-customer signals for Robot Dojo.
 *
 * A good Robot Dojo customer is someone who:
 *   - Has a strong relationship with the user (we trust the user's network)
 *   - Is technical enough to value local-first AI (title, company, domain)
 *   - Spends money on knowledge tools (already pays for Claude/Notion/etc.)
 *   - Cares about privacy (vocal about it, uses Proton/Signal)
 *   - Shares content (newsletters, long-form emails — they're signal-generators)
 *
 * Scoring formula (weights sum to 1.0):
 *   0.25  relationship     — tier + existing network score
 *   0.30  technical        — title keywords + tech-domain email
 *   0.20  tool-spend       — uses Claude/ChatGPT/Notion/Linear/Superhuman/etc.
 *   0.15  privacy          — Proton/Signal/privacy keywords in messages
 *   0.10  sharing behavior — newsletters, forwards, long-form
 *
 * Total range: 0.0 to 1.0. Threshold for "qualified": >= 0.6.
 *
 * All scoring is local. No data is transmitted.
 */
import db from './db.js';
import {
  getPersonProfessional,
  technicalSignal,
  privacyDomainSignal,
  privacyKeywordSignal,
  sharingSignal,
  _domains,
} from './person-professional.js';
// st_b879a361 — YC + big-tech + VC + AI-content qualification. Hooked into
// scoreReferralCandidate so the new columns are materialized at write time,
// avoiding a per-query cost on the read path.
import { qualifyPerson } from './referral/yc-filter.js';

// Weights — adjust per campaign.
export const WEIGHTS = {
  relationship: 0.25,
  technical:    0.30,
  toolSpend:    0.20,
  privacy:      0.15,
  sharing:      0.10,
};

export const QUALIFIED_THRESHOLD = 0.6;

// Tool-spend signal: heuristic list of product names that indicate a person
// pays for modern knowledge tools. Check for mentions in the person's outbound
// emails (their signatures/body) — NOT in receipts sent to the user.
const TOOL_KEYWORDS = [
  // AI tools
  'claude.ai', 'chat.openai', 'chatgpt', 'anthropic', 'perplexity.ai',
  'cursor.sh', 'cursor.com',
  // Knowledge tools
  'notion.so', 'linear.app', 'superhuman.com', 'readwise', 'obsidian',
  'raycast', 'arc.net',
  // Dev tools
  'github.com', 'vercel.com', 'fly.io', 'supabase.com',
  // Communication (signal they care about tools)
  'signal.org', 'zoom.us',
];

// ---------------------------------------------------------------------------
// DB statements
// ---------------------------------------------------------------------------

const stmts = {
  activePeople: db.prepare(`
    SELECT p.id, p.display_name, p.tier, p.score, p.interaction_count,
           p.imessage_msg_count, p.consistency_score, p.first_seen, p.last_seen,
           p.relationship_origin, p.relation_tag,
           c.name as company_name
    FROM people p
    LEFT JOIN companies c ON p.company_id = c.id
    WHERE p.archived = 0
      AND p.tier IN ('core', 'network')
    ORDER BY p.score DESC
  `),
  personById: db.prepare(`
    SELECT p.id, p.display_name, p.tier, p.score, p.interaction_count,
           p.first_seen, p.last_seen, p.relation_tag, p.relationship_origin,
           c.name as company_name
    FROM people p
    LEFT JOIN companies c ON p.company_id = c.id
    WHERE p.id = ? AND p.archived = 0
  `),
  channelCounts: db.prepare(`
    SELECT channel, COUNT(*) as count
    FROM person_interactions
    WHERE person_id = ?
    GROUP BY channel
  `),
  primaryEmail: db.prepare(`
    SELECT value FROM person_identifiers
    WHERE person_id = ? AND type = 'email'
    ORDER BY is_primary DESC, id ASC LIMIT 1
  `),
  allEmails: db.prepare(`
    SELECT value FROM person_identifiers WHERE person_id = ? AND type = 'email'
  `),
  // st_b879a361 — INSERT shape extended with YC-filter qualification columns.
  // Backward-compat: existing callers still pass the 9 composite-scorer args
  // first; new columns come after.
  upsertScore: db.prepare(`
    INSERT INTO referral_scores (
      person_id, total_score, relationship_score, technical_score,
      tool_spend_score, privacy_score, sharing_score, top_signal, breakdown,
      computed_at,
      qualifies_for_referral, has_path_c_signal, path_c_weight,
      company_priority_tier, role_bucket_priority, detected_role,
      detected_role_source, company_type, qualified_domain_source,
      qualified_path, most_recent_prof_email_domain
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(person_id) DO UPDATE SET
      total_score = excluded.total_score,
      relationship_score = excluded.relationship_score,
      technical_score = excluded.technical_score,
      tool_spend_score = excluded.tool_spend_score,
      privacy_score = excluded.privacy_score,
      sharing_score = excluded.sharing_score,
      top_signal = excluded.top_signal,
      breakdown = excluded.breakdown,
      computed_at = datetime('now'),
      qualifies_for_referral = excluded.qualifies_for_referral,
      has_path_c_signal = excluded.has_path_c_signal,
      path_c_weight = excluded.path_c_weight,
      company_priority_tier = excluded.company_priority_tier,
      role_bucket_priority = excluded.role_bucket_priority,
      detected_role = excluded.detected_role,
      detected_role_source = excluded.detected_role_source,
      company_type = excluded.company_type,
      qualified_domain_source = excluded.qualified_domain_source,
      qualified_path = excluded.qualified_path,
      most_recent_prof_email_domain = excluded.most_recent_prof_email_domain
  `),
  topScores: db.prepare(`
    SELECT rs.person_id, rs.total_score, rs.relationship_score,
           rs.technical_score, rs.tool_spend_score, rs.privacy_score,
           rs.sharing_score, rs.top_signal, rs.breakdown,
           p.display_name, p.tier, p.relation_tag,
           pp.title, pp.company, pp.company_domain, pp.industry
    FROM referral_scores rs
    JOIN people p ON p.id = rs.person_id
    LEFT JOIN person_professional pp ON pp.person_id = rs.person_id
    WHERE p.archived = 0
    ORDER BY rs.total_score DESC
    LIMIT ?
  `),
};

// ---------------------------------------------------------------------------
// Signal computations
// ---------------------------------------------------------------------------

/**
 * Relationship signal 0..1 — based on tier + existing network score.
 * Core top-scorers = 1.0, network top = 0.75.
 */
function relationshipScore(person) {
  const base = person.tier === 'core' ? 0.75 : person.tier === 'network' ? 0.5 : 0.25;
  // Consistency is the "they actually stay in touch" multiplier.
  const consistency = Math.min(1, (person.consistency_score || 0));
  // Interaction count: log-scaled to 0..0.3 bonus.
  const interactionBonus = Math.min(0.3, Math.log10((person.interaction_count || 0) + 1) / 10);
  let score = base + interactionBonus * 0.5 + (consistency * 0.25);
  // Years known bonus (cap at 5 years = +0.1)
  if (person.first_seen) {
    const years = (Date.now() - new Date(person.first_seen).getTime()) / (365.25 * 86400000);
    score += Math.min(0.1, years * 0.02);
  }
  return Math.min(1, score);
}

/**
 * Tool-spend signal 0..1 — scan person's outbound email bodies for tool
 * keywords (links to Claude, Notion, Superhuman, GitHub, etc.).
 */
function toolSpendScore(personId) {
  const emails = stmts.allEmails.all(personId).map(r => r.value.toLowerCase());
  if (emails.length === 0) return 0;
  const placeholders = emails.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT body_text FROM emails
    WHERE sender_email IN (${placeholders})
      AND body_text != ''
    ORDER BY received_at DESC
    LIMIT 50
  `).all(...emails);
  if (rows.length === 0) return 0;

  const hitCounts = {};
  for (const r of rows) {
    const body = (r.body_text || '').toLowerCase();
    for (const kw of TOOL_KEYWORDS) {
      if (body.includes(kw)) hitCounts[kw] = (hitCounts[kw] || 0) + 1;
    }
  }
  const distinctTools = Object.keys(hitCounts).length;
  // 3+ distinct tools referenced = max signal
  return Math.min(1, distinctTools / 3);
}

/**
 * Privacy posture score — email domain + keywords.
 */
function privacyScore(personId) {
  const emailRow = stmts.primaryEmail.get(personId);
  const email = emailRow?.value || '';
  const dom = privacyDomainSignal(email);
  const kw = privacyKeywordSignal(personId);
  // Either signal can carry — take the max, bonus if both.
  return Math.min(1, Math.max(dom, kw) + Math.min(dom, kw) * 0.3);
}

/**
 * Compute all five sub-scores for a person + the YC-filter qualification
 * (st_b879a361). The qualification result is appended as `qualification`;
 * callers that don't need it can ignore the field.
 */
export function scoreReferralCandidate(personId) {
  const person = stmts.personById.get(personId);
  if (!person) return null;

  const pro = getPersonProfessional(personId);
  const relationship = relationshipScore(person);
  const technical = technicalSignal(pro);
  const toolSpend = toolSpendScore(personId);
  const privacy = privacyScore(personId);
  const sharing = sharingSignal(personId);

  const total =
    relationship * WEIGHTS.relationship +
    technical    * WEIGHTS.technical +
    toolSpend    * WEIGHTS.toolSpend +
    privacy      * WEIGHTS.privacy +
    sharing      * WEIGHTS.sharing;

  // "Top signal" = which sub-score (weighted) contributed most.
  const weighted = {
    relationship: relationship * WEIGHTS.relationship,
    technical:    technical    * WEIGHTS.technical,
    toolSpend:    toolSpend    * WEIGHTS.toolSpend,
    privacy:      privacy      * WEIGHTS.privacy,
    sharing:      sharing      * WEIGHTS.sharing,
  };
  const topSignal = Object.entries(weighted)
    .sort((a, b) => b[1] - a[1])[0][0];

  // st_b879a361 — YC + big-tech + VC + AI-content qualification.
  // Materialized at write time so the read path is a pure indexed SQL filter.
  // Wrapped in try/catch so a failure here never blocks composite scoring.
  let qualification = null;
  try {
    qualification = qualifyPerson(db, personId);
  } catch (err) {
    console.warn(`[referral] qualifyPerson failed for ${personId}: ${err.message}`);
  }

  return {
    personId,
    displayName: person.display_name,
    tier: person.tier,
    relationTag: person.relation_tag,
    company: pro?.company || person.company_name || null,
    title: pro?.title || null,
    companyDomain: pro?.company_domain || null,
    scores: { relationship, technical, toolSpend, privacy, sharing },
    weighted,
    total: Math.round(total * 1000) / 1000,
    topSignal,
    qualified: total >= QUALIFIED_THRESHOLD,
    qualification,
  };
}

/**
 * Score every Core + Network person and cache results.
 *
 * st_b879a361 — also writes the qualification columns produced by
 * qualifyPerson(). When qualification is null (e.g. yc-filter threw), the
 * new columns are written as defaults so the row remains valid.
 */
export function computeReferralScores() {
  const candidates = stmts.activePeople.all();
  let written = 0;
  for (const p of candidates) {
    // Personal/family contacts: keep them in the pool but scoring will
    // naturally deprioritize them if they have no tech signal.
    const s = scoreReferralCandidate(p.id);
    if (!s) continue;
    const q = s.qualification || {};
    stmts.upsertScore.run(
      s.personId, s.total,
      s.scores.relationship, s.scores.technical, s.scores.toolSpend,
      s.scores.privacy, s.scores.sharing,
      s.topSignal, JSON.stringify(s.weighted),
      // st_b879a361 columns:
      q.qualifies ? 1 : 0,
      q.has_path_c ? 1 : 0,
      q.path_c_weight ?? 0,
      q.company_priority_tier ?? null,
      q.role_priority ?? null,
      q.detected_role ?? null,
      q.detected_role_source ?? null,
      q.company_type ?? null,
      q.qualified_domain_source ?? null,
      q.qualified_path ?? null,
      q.prof_email_domain ?? null,
    );
    written++;
  }
  console.info(`[referral] scored ${written}/${candidates.length} candidates`);
  return written;
}

/**
 * Fetch the top-N candidates from cached scores.
 *
 * @param {number} n
 * @returns {Array<{...scoreFields, displayName, tier, title, company, topSignal}>}
 */
export function getTopReferralCandidates(n = 20) {
  const rows = stmts.topScores.all(n);
  return rows.map(r => ({
    personId: r.person_id,
    displayName: r.display_name,
    tier: r.tier,
    relationTag: r.relation_tag,
    title: r.title,
    company: r.company,
    companyDomain: r.company_domain,
    industry: r.industry,
    total: r.total_score,
    scores: {
      relationship: r.relationship_score,
      technical:    r.technical_score,
      toolSpend:    r.tool_spend_score,
      privacy:      r.privacy_score,
      sharing:      r.sharing_score,
    },
    topSignal: r.top_signal,
    breakdown: safeParse(r.breakdown, {}),
    qualified: r.total_score >= QUALIFIED_THRESHOLD,
  }));
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Legacy shim — old code paths call getReferralCandidates(5).
// Preserve behaviour by surfacing top-N from the cached scores.
// ---------------------------------------------------------------------------

export function getReferralCandidates(limit = 5) {
  return getTopReferralCandidates(limit).map(c => ({
    id: c.personId,
    name: c.displayName,
    tier: c.tier,
    company: c.company,
    reason: buildReasonFromScore(c),
    score: c.total,
  }));
}

function buildReasonFromScore(c) {
  const parts = [];
  if (c.title) parts.push(c.title + (c.company ? ` @ ${c.company}` : ''));
  else if (c.company) parts.push(c.company);
  const label = {
    relationship: 'long-standing relationship',
    technical:    'technical role',
    toolSpend:    'power tool user',
    privacy:      'privacy-conscious',
    sharing:      'content creator',
  }[c.topSignal] || 'strong fit';
  parts.push(label);
  if (c.qualified) parts.push('qualified');
  return parts.join(' · ');
}
