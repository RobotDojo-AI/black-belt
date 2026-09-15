/**
 * Invite targets — paginated professional leg + personal leg for the Invite
 * a Friend tab.
 *
 * HISTORY
 *   - st_d9fc573b — original 3 personal + 4 professional split.
 *   - st_b879a361 — professional leg is now paginated, filtered by the
 *     YC + big-tech + VC + AI-content qualification (materialized in
 *     referral_scores.qualifies_for_referral=1). 4-tier sort: has_path_c
 *     DESC, company_priority_tier ASC, role_bucket_priority ASC, last_seen
 *     DESC NULLS LAST. Hard cap: 30 rows total across all pages.
 *
 * SHAPE (new)
 *   getInviteTargets(db, { offset = 0, limit = 10 } = {})
 *     → { personal: [...legacy normalised rows], professional: { items,
 *         offset, has_more, total } }
 *
 *   `personal` keeps the legacy contract — 3 normalised rows shaped the same
 *   way the old UI expected. `professional.items` carries the full per-row
 *   shape needed by the new UI: person_id, name, qualified_path, detected_role,
 *   company_type, has_path_c_signal, company_priority_tier, role_bucket_priority,
 *   last_seen (for sort verification), plus the legacy normalised fields so
 *   downstream renderers can reuse mailto helpers.
 *
 * Backward-compat: callers that pass no args get `{ offset: 0, limit: 10 }`.
 */

const HARD_CAP = 30;
const DEFAULT_LIMIT = 10;

// ─── Personal leg (legacy behavior) ────────────────────────────────────

function fetchPersonal(db, recencyDays, limit) {
  return db.prepare(`
    SELECT
      p.display_name           AS name,
      p.last_seen              AS last_contact_at,
      COALESCE(rs.sharing_score, 0) AS share_frequency,
      COALESCE(pp.tech_signal, 0)   AS tech_interest_score
    FROM referral_scores rs
    JOIN people p ON p.id = rs.person_id
    LEFT JOIN person_professional pp ON pp.person_id = rs.person_id
    WHERE (p.relationship_origin = 'personal' OR p.personal_score > p.business_score)
      AND p.last_seen IS NOT NULL
      AND p.last_seen > date('now', ?)
      AND COALESCE(p.archived, 0) = 0
    ORDER BY rs.total_score DESC
    LIMIT ?
  `).all('-' + recencyDays + ' days', limit);
}

function fetchAnyHighScorePersonal(db, limit) {
  return db.prepare(`
    SELECT
      p.display_name           AS name,
      p.last_seen              AS last_contact_at,
      COALESCE(rs.sharing_score, 0) AS share_frequency,
      COALESCE(pp.tech_signal, 0)   AS tech_interest_score
    FROM referral_scores rs
    JOIN people p ON p.id = rs.person_id
    LEFT JOIN person_professional pp ON pp.person_id = rs.person_id
    WHERE p.last_seen IS NOT NULL
      AND COALESCE(p.archived, 0) = 0
    ORDER BY rs.total_score DESC
    LIMIT ?
  `).all(limit);
}

function normalisePersonal(row) {
  return {
    bucket: 'personal',
    name: row.name || 'Unknown',
    last_contact_at: row.last_contact_at
      ? String(row.last_contact_at)
      : new Date(0).toISOString(),
    share_frequency: Number(row.share_frequency) || 0,
    tech_interest_score: Number(row.tech_interest_score) || 0,
  };
}

function dedupByName(rows, seenNames) {
  const out = [];
  for (const r of rows) {
    if (!r || !r.name) continue;
    if (seenNames.has(r.name)) continue;
    seenNames.add(r.name);
    out.push(r);
  }
  return out;
}

function getPersonalLeg(db) {
  const seen = new Set();
  // 180-day pass, then 365-day fallback, then any-high-score fill.
  let personal = fetchPersonal(db, 180, 3);
  if (personal.length < 3) {
    const extra = fetchPersonal(db, 365, 3 - personal.length + 5);
    personal = [...personal, ...extra];
  }
  personal = dedupByName(personal.map(normalisePersonal), seen).slice(0, 3);
  if (personal.length < 3) {
    const filler = fetchAnyHighScorePersonal(db, 20);
    const fillerNorm = dedupByName(filler.map(normalisePersonal), seen);
    personal = [...personal, ...fillerNorm].slice(0, 3);
  }
  return personal;
}

// ─── Professional leg (st_b879a361: filter + paginate) ────────────────

function fetchQualifiedCount(db) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM referral_scores rs
    JOIN people p ON p.id = rs.person_id
    WHERE rs.qualifies_for_referral = 1
      AND COALESCE(p.archived, 0) = 0
  `).get();
  return row?.n || 0;
}

function fetchQualifiedPage(db, offset, limit) {
  // 4-tier sort:
  //   1. has_path_c_signal DESC — Path C qualifiers (AI/tech talkers) first
  //   2. company_priority_tier ASC NULLS LAST — 1=YC+VC, 2=hard-tech, 3=mega-cap
  //   3. role_bucket_priority ASC NULLS LAST — 0=founder, 1=c-level, 2=vp, ...
  //   4. last_seen DESC NULLS LAST — recency tiebreaker
  return db.prepare(`
    SELECT
      rs.person_id,
      p.display_name                   AS name,
      p.last_seen,
      rs.qualifies_for_referral,
      rs.has_path_c_signal,
      rs.path_c_weight,
      rs.company_priority_tier,
      rs.role_bucket_priority,
      rs.detected_role,
      rs.detected_role_source,
      rs.company_type,
      rs.qualified_domain_source,
      rs.qualified_path,
      rs.most_recent_prof_email_domain,
      COALESCE(rs.sharing_score, 0)    AS share_frequency,
      COALESCE(pp.tech_signal, 0)      AS tech_interest_score
    FROM referral_scores rs
    JOIN people p ON p.id = rs.person_id
    LEFT JOIN person_professional pp ON pp.person_id = rs.person_id
    WHERE rs.qualifies_for_referral = 1
      AND COALESCE(p.archived, 0) = 0
    ORDER BY rs.has_path_c_signal DESC,
             CASE WHEN rs.company_priority_tier IS NULL THEN 99 ELSE rs.company_priority_tier END ASC,
             CASE WHEN rs.role_bucket_priority  IS NULL THEN 99 ELSE rs.role_bucket_priority  END ASC,
             CASE WHEN p.last_seen IS NULL THEN 1 ELSE 0 END ASC,
             p.last_seen DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function normaliseProfessional(row) {
  return {
    bucket: 'professional',
    person_id: row.person_id,
    name: row.name || 'Unknown',
    last_seen: row.last_seen || null,
    last_contact_at: row.last_seen
      ? String(row.last_seen)
      : new Date(0).toISOString(),
    has_path_c_signal: row.has_path_c_signal ? 1 : 0,
    path_c_weight: Number(row.path_c_weight) || 0,
    company_priority_tier: row.company_priority_tier ?? null,
    role_bucket_priority: row.role_bucket_priority ?? null,
    detected_role: row.detected_role || null,
    detected_role_source: row.detected_role_source || null,
    company_type: row.company_type || null,
    qualified_domain_source: row.qualified_domain_source || null,
    qualified_path: row.qualified_path || null,
    most_recent_prof_email_domain: row.most_recent_prof_email_domain || null,
    share_frequency: Number(row.share_frequency) || 0,
    tech_interest_score: Number(row.tech_interest_score) || 0,
  };
}

function getProfessionalLeg(db, offset, limit) {
  // Clamp offset to [0, HARD_CAP). Limit is capped so a single page never
  // exceeds remaining-cap.
  const clampedOffset = Math.max(0, Math.min(HARD_CAP, Number(offset) || 0));
  const remainingCap = Math.max(0, HARD_CAP - clampedOffset);
  const clampedLimit = Math.max(1, Math.min(remainingCap, Number(limit) || DEFAULT_LIMIT));

  const qualifiedCount = fetchQualifiedCount(db);
  const total = Math.min(qualifiedCount, HARD_CAP);

  if (clampedOffset >= total || remainingCap === 0) {
    return { items: [], offset: clampedOffset, has_more: false, total };
  }

  const rows = fetchQualifiedPage(db, clampedOffset, clampedLimit);
  const items = rows.map(normaliseProfessional);
  const has_more = (clampedOffset + items.length) < total;

  return { items, offset: clampedOffset, has_more, total };
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Return paginated invite targets — personal leg (legacy 3 rows) + filtered
 * paginated professional leg (st_b879a361).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{offset?: number, limit?: number}} [opts]
 * @returns {{
 *   personal: Array<object>,
 *   professional: { items: Array<object>, offset: number, has_more: boolean, total: number }
 * }}
 */
export function getInviteTargets(db, opts = {}) {
  const offset = opts.offset ?? 0;
  const limit  = opts.limit  ?? DEFAULT_LIMIT;
  const personal = getPersonalLeg(db);
  const professional = getProfessionalLeg(db, offset, limit);
  return { personal, professional };
}
