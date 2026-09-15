/**
 * Embedding launch SLA policy.
 *
 * This is pure policy: no DB import, no model import, no network. The daemon and
 * status surfaces use it to keep first-use intelligence distinct from the full
 * historical backfill.
 */

export const EMBED_SLA_TARGETS = Object.freeze({
  firstIntelligentChatMs: 5 * 60_000,
  firstVectorBackedChatMs: 60 * 60_000,
  firstHourIntelligenceCoverage: 0.9,
  firstHourCoverageCapPerGroup: 2048,
  valuableChunksCompleteMs: 6 * 60 * 60_000,
  fullDrainCompleteMs: 24 * 60 * 60_000,
});

export const SLA_TIERS = Object.freeze({
  FIRST_VECTOR: 'first_vector',
  VALUABLE: 'valuable',
  BULK: 'bulk',
});

export const EMBED_SLA_DIRECT_SOURCE_TYPES = Object.freeze([
  'asana',
  'calendar',
  'conversation',
  'drive',
  'health',
  'imessage',
  'llm_export',
  'transcript',
  'user-fact',
  'workbench',
]);

export const EMBED_SLA_CHAT_HISTORY_SOURCE_TYPES = Object.freeze([
  'conversation',
]);

export const INTELLIGENCE_SOURCE_WEIGHTS = Object.freeze({
  conversation: 34,
  'user-fact': 24,
  workbench: 18,
  imessage: 18,
  transcript: 16,
  llm_export: 14,
  health: 12,
  calendar: 11,
  drive: 9,
  asana: 9,
  email: 1,
  default: 5,
});

const SLA_TIER_RANK = Object.freeze({
  [SLA_TIERS.FIRST_VECTOR]: 3,
  [SLA_TIERS.VALUABLE]: 2,
  [SLA_TIERS.BULK]: 1,
});

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function embeddingSlaTierRank(tier) {
  return SLA_TIER_RANK[tier] || SLA_TIER_RANK[SLA_TIERS.BULK];
}

/**
 * Classify a pending topic into the launch tier the daemon should prefer.
 *
 * FIRST_VECTOR is the small, fast, high-signal slice that makes the first vector
 * turn likely to know people, projects, and explicit user material. VALUABLE is
 * still important substrate, but can trail the first slice. BULK is historical
 * recall and long-tail material.
 */
export function classifyEmbeddingSlaTier({
  pending = 0,
  chatHistoryPending = 0,
  highValuePending = 0,
  entityLinkedPending = 0,
  directSourcePending = 0,
  emailPending = 0,
  shortPending = 0,
} = {}) {
  const total = nonNegativeInt(pending);
  if (total === 0) return SLA_TIERS.BULK;

  const chatHistory = nonNegativeInt(chatHistoryPending);
  const high = nonNegativeInt(highValuePending);
  const entity = nonNegativeInt(entityLinkedPending);
  const direct = nonNegativeInt(directSourcePending);
  const email = nonNegativeInt(emailPending);
  const short = nonNegativeInt(shortPending);
  const emailShare = email / total;

  if (short > 0 && chatHistory > 0) {
    return SLA_TIERS.FIRST_VECTOR;
  }
  if (short > 0 && (high > 0 || direct > 0 || entity > 0) && emailShare < 0.85) {
    return SLA_TIERS.FIRST_VECTOR;
  }
  if (high > 0 || direct > 0 || (entity > 0 && emailShare < 0.5)) {
    return SLA_TIERS.VALUABLE;
  }
  return SLA_TIERS.BULK;
}

export function requiredRatePerHour(totalChunks, targetMs) {
  const total = nonNegativeInt(totalChunks);
  const ms = Number(targetMs);
  if (total === 0) return 0;
  if (!Number.isFinite(ms) || ms <= 0) return Infinity;
  return total / (ms / 3_600_000);
}

function positiveRate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function projectedHoursForLengthMix({ short = 0, medium = 0, long = 0 } = {}, ratesPerHour = {}) {
  const shortRate = positiveRate(ratesPerHour.short);
  const mediumRate = positiveRate(ratesPerHour.medium);
  const longRate = positiveRate(ratesPerHour.long);
  if (!shortRate || !mediumRate || !longRate) return null;
  return (nonNegativeInt(short) / shortRate)
    + (nonNegativeInt(medium) / mediumRate)
    + (nonNegativeInt(long) / longRate);
}

export function intelligenceWeightForGroup({
  source_type = '',
  content_rank = 3,
  entity_linked = 0,
  recent = 0,
  direct_source = 0,
} = {}) {
  const source = String(source_type || '').toLowerCase();
  const base = INTELLIGENCE_SOURCE_WEIGHTS[source] ?? INTELLIGENCE_SOURCE_WEIGHTS.default;
  const rankRaw = Number(content_rank);
  const rank = Number.isFinite(rankRaw) ? Math.max(0, Math.min(3, Math.floor(rankRaw))) : 3;
  const sourceSignal = Math.max(0, 3 - rank) * 3;
  const entityBonus = Number(entity_linked) > 0 ? 12 : 0;
  const recentBonus = Number(recent) > 0 ? 8 : 0;
  const directBonus = Number(direct_source) > 0 ? 4 : 0;
  return base + sourceSignal + entityBonus + recentBonus + directBonus;
}

function groupTimeHours(group, ratesPerHour = {}) {
  const shortRate = positiveRate(ratesPerHour.short);
  const mediumRate = positiveRate(ratesPerHour.medium);
  const longRate = positiveRate(ratesPerHour.long);
  if (!shortRate || !mediumRate || !longRate) return null;
  return (nonNegativeInt(group.short) / shortRate)
    + (nonNegativeInt(group.medium) / mediumRate)
    + (nonNegativeInt(group.long) / longRate);
}

export function chatHistoryFirstLaneProjection(groups = [], ratesPerHour = {}, {
  maxHours = EMBED_SLA_TARGETS.firstIntelligentChatMs / 3_600_000,
} = {}) {
  const chatSources = new Set(EMBED_SLA_CHAT_HISTORY_SOURCE_TYPES);
  const rows = (Array.isArray(groups) ? groups : [])
    .filter((group) => chatSources.has(String(group.source_type || '').toLowerCase()))
    .map((group) => {
      const totalCount = nonNegativeInt(group.count);
      const pendingCountSource = Number.isFinite(Number(group.pending_count))
        ? group.pending_count
        : Number.isFinite(Number(group.pending))
          ? group.pending
          : group.count;
      const pendingCount = Math.min(totalCount || nonNegativeInt(pendingCountSource), nonNegativeInt(pendingCountSource));
      const hasPendingLengthMix = ['pending_short', 'pending_medium', 'pending_long']
        .some((field) => Number.isFinite(Number(group[field])));
      const pendingMix = hasPendingLengthMix
        ? {
            short: group.pending_short,
            medium: group.pending_medium,
            long: group.pending_long,
          }
        : {
            short: group.short,
            medium: group.medium,
            long: group.long,
          };
      const hours = pendingCount > 0 ? groupTimeHours(pendingMix, ratesPerHour) : 0;
      return {
        ...group,
        count: totalCount,
        pending_count: pendingCount,
        hours,
      };
    })
    .filter((group) => group.count > 0 && group.hours !== null);

  const totalCount = rows.reduce((sum, group) => sum + group.count, 0);
  const pendingCount = rows.reduce((sum, group) => sum + group.pending_count, 0);
  const hours = rows.reduce((sum, group) => sum + group.hours, 0);
  const max = Math.max(0, Number(maxHours) || 0);
  return {
    ok: pendingCount === 0 || (Number.isFinite(hours) && hours <= max),
    source_types: EMBED_SLA_CHAT_HISTORY_SOURCE_TYPES,
    target_hours: Number(max.toFixed(3)),
    total_count: totalCount,
    pending_count: pendingCount,
    projected_hours_to_drain: Number.isFinite(hours) ? Number(hours.toFixed(3)) : null,
    groups_considered: rows.length,
    pending_groups_considered: rows.filter((group) => group.pending_count > 0).length,
  };
}

export function intelligenceCoverageProjection(groups = [], ratesPerHour = {}, {
  targetCoverage = EMBED_SLA_TARGETS.firstHourIntelligenceCoverage,
  maxHours = EMBED_SLA_TARGETS.firstVectorBackedChatMs / 3_600_000,
  coverageCapPerGroup = EMBED_SLA_TARGETS.firstHourCoverageCapPerGroup,
} = {}) {
  const cap = nonNegativeInt(coverageCapPerGroup) || EMBED_SLA_TARGETS.firstHourCoverageCapPerGroup;
  const rows = (Array.isArray(groups) ? groups : [])
    .map((group) => {
      const count = nonNegativeInt(group.count);
      const coverageCount = Math.min(count, cap);
      const weight = Number.isFinite(Number(group.weight))
        ? Number(group.weight)
        : intelligenceWeightForGroup(group);
      const mass = coverageCount * weight;
      const hours = groupTimeHours(group, ratesPerHour);
      const coverageHours = count > 0 && hours !== null
        ? hours * (coverageCount / count)
        : hours;
      return {
        ...group,
        chat_history: EMBED_SLA_CHAT_HISTORY_SOURCE_TYPES.includes(String(group.source_type || '').toLowerCase()) ? 1 : 0,
        count,
        coverage_count: coverageCount,
        weight,
        mass,
        hours: coverageHours,
        full_group_hours: hours,
      };
    })
    .filter((group) => group.count > 0 && group.mass > 0 && group.hours !== null)
    .sort((a, b) => (
      (Number(b.chat_history || 0) - Number(a.chat_history || 0))
      || (b.weight - a.weight)
      || (Number(b.entity_linked || 0) - Number(a.entity_linked || 0))
      || (Number(b.recent || 0) - Number(a.recent || 0))
      || (Number(b.direct_source || 0) - Number(a.direct_source || 0))
      || (a.hours - b.hours)
    ));

  const totalMass = rows.reduce((sum, group) => sum + group.mass, 0);
  if (totalMass <= 0) {
    return {
      ok: false,
      target_coverage: targetCoverage,
      max_hours: maxHours,
      coverage_cap_per_group: cap,
      coverage_model: 'saturated_group_coverage',
      total_mass: 0,
      projected_hours_to_target: null,
      coverage_after_max_hours: null,
      meets_target: null,
      groups_considered: rows.length,
    };
  }

  const targetMass = totalMass * Math.max(0, Math.min(1, Number(targetCoverage) || 0));
  const maxTime = Math.max(0, Number(maxHours) || 0);
  let cumulativeMass = 0;
  let cumulativeHours = 0;
  let projectedHoursToTarget = null;
  let coverageAfterMax = null;

  for (const group of rows) {
    if (coverageAfterMax === null && cumulativeHours + group.hours > maxTime) {
      const remainingHours = Math.max(0, maxTime - cumulativeHours);
      const fraction = group.hours > 0 ? Math.max(0, Math.min(1, remainingHours / group.hours)) : 0;
      coverageAfterMax = (cumulativeMass + group.mass * fraction) / totalMass;
    }
    if (projectedHoursToTarget === null && cumulativeMass + group.mass >= targetMass) {
      const missingMass = Math.max(0, targetMass - cumulativeMass);
      const fraction = group.mass > 0 ? Math.max(0, Math.min(1, missingMass / group.mass)) : 0;
      projectedHoursToTarget = cumulativeHours + group.hours * fraction;
    }
    cumulativeMass += group.mass;
    cumulativeHours += group.hours;
  }
  if (coverageAfterMax === null) coverageAfterMax = 1;

  return {
    ok: true,
    target_coverage: targetCoverage,
    max_hours: maxHours,
    coverage_cap_per_group: cap,
    coverage_model: 'saturated_group_coverage',
    total_mass: Number(totalMass.toFixed(3)),
    projected_hours_to_target: projectedHoursToTarget === null ? null : Number(projectedHoursToTarget.toFixed(3)),
    coverage_after_max_hours: Number(coverageAfterMax.toFixed(4)),
    meets_target: projectedHoursToTarget === null ? null : projectedHoursToTarget <= maxTime,
    groups_considered: rows.length,
    top_groups: rows.slice(0, 12).map((group) => ({
      source_type: group.source_type,
      content_rank: group.content_rank,
      chat_history: Number(group.chat_history || 0) > 0,
      entity_linked: Number(group.entity_linked || 0) > 0,
      recent: Number(group.recent || 0) > 0,
      count: group.count,
      coverage_count: group.coverage_count,
      weight: group.weight,
      mass: Number(group.mass.toFixed(3)),
      hours: Number(group.hours.toFixed(3)),
      full_group_hours: Number(group.full_group_hours.toFixed(3)),
    })),
  };
}

export function freshUserCappedEmailMix({
  short = 0,
  medium = 0,
  long = 0,
  emailShort = 0,
  emailMedium = 0,
  emailLong = 0,
} = {}) {
  const emailLongCount = Math.min(nonNegativeInt(long), nonNegativeInt(emailLong));
  return {
    short: nonNegativeInt(short),
    medium: nonNegativeInt(medium) + emailLongCount,
    long: Math.max(0, nonNegativeInt(long) - emailLongCount),
    moved_email_long_to_medium: emailLongCount,
    email_short: nonNegativeInt(emailShort),
    email_medium: nonNegativeInt(emailMedium),
    email_long: nonNegativeInt(emailLong),
  };
}

export function embeddingSlaProjection({
  totalChunks = 0,
  pendingChunks = 0,
  valuableChunks = null,
  firstVectorSeedChunks = null,
  observedRatePerHour = null,
  projectedHours = null,
} = {}) {
  const total = nonNegativeInt(totalChunks);
  const pending = nonNegativeInt(pendingChunks);
  const valuable = valuableChunks === null ? null : nonNegativeInt(valuableChunks);
  const firstVectorSeed = firstVectorSeedChunks === null ? null : nonNegativeInt(firstVectorSeedChunks);
  const observedRate = positiveRate(observedRatePerHour);

  const fullRequired = requiredRatePerHour(total, EMBED_SLA_TARGETS.fullDrainCompleteMs);
  const valuableRequired = valuable === null
    ? null
    : requiredRatePerHour(valuable, EMBED_SLA_TARGETS.valuableChunksCompleteMs);
  const firstVectorRequired = firstVectorSeed === null
    ? null
    : requiredRatePerHour(firstVectorSeed, EMBED_SLA_TARGETS.firstVectorBackedChatMs);
  const projected = projectedHours && typeof projectedHours === 'object'
    ? {
        first_vector: Number.isFinite(Number(projectedHours.first_vector)) ? Number(projectedHours.first_vector) : null,
        valuable: Number.isFinite(Number(projectedHours.valuable)) ? Number(projectedHours.valuable) : null,
        full_drain: Number.isFinite(Number(projectedHours.full_drain)) ? Number(projectedHours.full_drain) : null,
      }
    : observedRate ? {
        first_vector: firstVectorSeed === null ? null : firstVectorSeed / observedRate,
        valuable: valuable === null ? null : valuable / observedRate,
        full_drain: total / observedRate,
      } : null;

  return {
    targets: EMBED_SLA_TARGETS,
    total_chunks: total,
    pending_chunks: pending,
    valuable_chunks: valuable,
    first_vector_seed_chunks: firstVectorSeed,
    observed_rate_per_hour: observedRate,
    required_rate_per_hour: {
      first_vector: firstVectorRequired,
      valuable: valuableRequired,
      full_drain: fullRequired,
    },
    projected_hours: projected,
    full_drain_meets_target: projected?.full_drain === null || projected?.full_drain === undefined
      ? null
      : projected.full_drain <= (EMBED_SLA_TARGETS.fullDrainCompleteMs / 3_600_000),
    valuable_meets_target: projected?.valuable === null || projected?.valuable === undefined
      ? null
      : projected.valuable <= (EMBED_SLA_TARGETS.valuableChunksCompleteMs / 3_600_000),
    first_vector_meets_target: projected?.first_vector === null || projected?.first_vector === undefined
      ? null
      : projected.first_vector <= (EMBED_SLA_TARGETS.firstVectorBackedChatMs / 3_600_000),
  };
}

export function embeddingSlaReadiness({
  totalChunks = 0,
  pendingChunks = 0,
  valuableChunks = null,
  firstVectorSeedChunks = null,
  observedRatePerHour = null,
} = {}) {
  return embeddingSlaProjection({
    totalChunks,
    pendingChunks,
    valuableChunks,
    firstVectorSeedChunks,
    observedRatePerHour,
  });
}
