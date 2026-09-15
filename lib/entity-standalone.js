/**
 * entity-standalone.js — the single source of truth for "is this entity a
 * genuine signal-less stub that hygiene may prune?"
 *
 * Owner directive (st_483361e2): "people, places, companies all stand on their
 * own. and are linked via graph edges. that's all. simple." Having no people /
 * links / connections is NOT grounds for deleting or archiving an entity. An
 * entity is prunable only when it carries NO standalone signal of any kind:
 *   - a research/promotion marker (the natural-key `uuid`),
 *   - facts (`entity_facts`),
 *   - relationship edges (`entity_relationships`),
 *   - and, per type, a real identity signal (company: a website domain;
 *     person: a non-email phone identifier).
 * A researched or real entity ALWAYS survives regardless of connections.
 *
 * WHY one shared guard: the routine cleanup pruned entities in MULTIPLE places
 * (scripts/clean-entities.js AND scripts/maintenance-phases.js), each keying on
 * people/links alone. A narrow patch to one leaves the other silently re-wiping
 * every research-promoted entity — exactly the failure this repairs. Every
 * hygiene/cleanup path that considers deleting or archiving an entity MUST
 * compose the matching guard so the rule can never drift between call sites. The
 * rebuild full-wipe (routes/network.js runRebuild, scripts/rebuild/*) is a
 * deliberate complete re-derivation and is intentionally NOT gated — its
 * re-projection step restores promoted entities afterward.
 *
 * Each helper returns an AND-composable SQL fragment that is TRUE only when the
 * aliased entity is a prunable no-signal stub. Compose into a WHERE clause that
 * already carries the type's "no connections" condition:
 *
 *   DELETE FROM companies WHERE <no-active-people> AND ${companyStandaloneGuardSql('companies')}
 *   UPDATE people SET archived=1 WHERE <no-contacts-identifier> AND ${personStandaloneGuardSql('p')}
 *
 * Tier 0 — deterministic SQL only.
 */

export const INTELLIGENCE_TIER = 'extraction';

/** Companies stand alone: a website domain, a research marker, facts, or edges all keep it. */
export function companyStandaloneGuardSql(alias) {
  const a = String(alias || 'companies');
  return `${a}.uuid IS NULL
      AND NOT EXISTS (SELECT 1 FROM company_domains d WHERE d.company_id = ${a}.id)
      AND NOT EXISTS (SELECT 1 FROM entity_facts ef WHERE ef.entity_type = 'company' AND ef.entity_id = ${a}.id)
      AND NOT EXISTS (
        SELECT 1 FROM entity_relationships er
        WHERE (er.entity_type_a = 'company' AND er.entity_id_a = ${a}.id)
           OR (er.entity_type_b = 'company' AND er.entity_id_b = ${a}.id)
      )`;
}

// Person keep-signals are DISCRIMINATING ones only. entity_facts (~29k people)
// and entity_relationships (5.7M rows, ~all `company_affiliation` co-occurrence)
// are pipeline-auto-generated for nearly every person, so protecting on them
// would silently disable the person noise-archival entirely (11,643 → 0) — the
// exact "don't blanket-disable" the owner warned against. So a person stands
// alone on: a research/promotion marker (uuid), a real phone identity, or a
// CURATED relationship edge (owner-tagged / manual / promote — not the
// auto-affiliation graph). If the owner later wants auto facts/edges to protect
// people too, that fully disables person noise-cleanup — a separate decision.
const CURATED_EDGE_SOURCES = "('relation_tag', 'manual', 'workbench-promote')";

export function personStandaloneGuardSql(alias) {
  const a = String(alias || 'people');
  return `${a}.uuid IS NULL
      AND NOT EXISTS (SELECT 1 FROM person_identifiers pi WHERE pi.person_id = ${a}.id AND pi.type = 'phone')
      AND NOT EXISTS (
        SELECT 1 FROM entity_relationships er
        WHERE er.source IN ${CURATED_EDGE_SOURCES}
          AND ((er.entity_type_a = 'person' AND er.entity_id_a = ${a}.id)
            OR (er.entity_type_b = 'person' AND er.entity_id_b = ${a}.id))
      )`;
}
