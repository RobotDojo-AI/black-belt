/**
 * lib/relation-walk.js — derive the owner's view by walking the graph
 * (st_f67bc2eb D4).
 *
 * The truth source is atomic person-to-person kinship edges
 * (person_relations); how anyone relates to the OWNER is DERIVED here by a
 * bounded BFS and phrased by path ("wife's cousin") — in-law, step, and
 * grand-composite relations are never stored, always walked (GEDCOM's
 * 30-year-old rule).
 *
 * Design (each choice closes a failure mode):
 *   - JS BFS, not recursive SQL: cycle handling is a visited set (safe by
 *     construction), and in-law naming is label algebra over a closed rule
 *     table, not traversal.
 *   - One indexed read of active kinship edges into memory (~tens of rows) —
 *     never a per-turn query; callers memoize through the derived cache
 *     (lib/people-write.js applyDerivedRelationCache).
 *   - Depth ≤ 3, shortest-path wins: a direct edge beats any derived path;
 *     equal-depth ties break deterministically by relation order then name.
 *   - Gendered role names (mother vs father, wife vs husband) derive ONLY
 *     from the node's recorded gender; a NULL gender renders the genderless
 *     word — never a guess. Pets phrase by node species the same way.
 *   - Uncovered compositions render the honest path phrase ("your mother's
 *     brother") under a coarse tag — never a wrong single label.
 *
 * Tier 0 — deterministic SQL → structs. No LLM may ever touch the owner view.
 */

import {
  COMPOSITION_RULES,
  DIRECT_ROLE_TAGS,
  genderedRoleWord,
  labelInfo,
} from './relation-vocabulary.js';
import { ownerPersonId } from './identity.js';

// Deterministic tie-break order for equal-depth paths — closest relation
// classes first (mirrors the ego render's RELATION_ORDER intent).
const ROLE_RANK = new Map([
  'spouse', 'child', 'parent', 'sibling', 'grandparent', 'grandchild',
  'cousin', 'niece-nephew', 'aunt-uncle', 'pet',
].map((r, i) => [r, i]));

const MAX_DEPTH = 3;

/** The role of `other` as seen FROM `node`, for one edge — or null when the
 * edge does not traverse in that direction (pets are terminal). */
function roleFromEdge(edge, nodeId) {
  const { person_a: a, person_b: b, rel_type: t } = edge;
  if (t === 'spouse' || t === 'sibling' || t === 'cousin') {
    return nodeId === a ? { other: b, role: t } : { other: a, role: t };
  }
  if (t === 'parent') {
    return nodeId === b ? { other: a, role: 'parent' } : { other: b, role: 'child' };
  }
  if (t === 'grandparent') {
    return nodeId === b ? { other: a, role: 'grandparent' } : { other: b, role: 'grandchild' };
  }
  if (t === 'niece-nephew') {
    return nodeId === b ? { other: a, role: 'niece-nephew' } : { other: b, role: 'aunt-uncle' };
  }
  if (t === 'pet') {
    // A pet is reachable (owner's pet renders) but never traversed through,
    // and the pet→owner direction is not an owner-view role.
    return nodeId === b ? { other: a, role: 'pet' } : null;
  }
  return null;
}

/** Gendered label for a tag from node gender/species, constrained to the
 * closed label vocabulary (a label can never contradict its tag). */
function labelForTag(tag, node) {
  if (tag === 'pet') {
    const s = node?.species;
    return s && labelInfo(s)?.tag === 'pet' ? s : null;
  }
  // Genderless-but-labeled class: 'cousin' is its own closed label (parity
  // with the predecessor rows, which carried relation_label='cousin').
  if (tag === 'cousin') return 'cousin';
  const roleWordSource = {
    parent: 'parent', child: 'child', sibling: 'sibling', spouse: 'spouse',
    grandparent: 'grandparent', 'parent-in-law': 'parent', 'sibling-in-law': 'sibling',
  }[tag];
  if (!roleWordSource || !node?.gender) return null;
  const base = genderedRoleWord(roleWordSource, node.gender);
  const candidate = tag.endsWith('-in-law') ? `${base}-in-law` : base;
  const info = labelInfo(candidate);
  return info && info.tag === tag ? candidate : null;
}

/** The honest path phrase: per-hop role words gendered by each hop's node.
 * ['spouse','cousin'] over (wife-node, cousin-node) → "wife's cousin". */
function pathPhrase(path, nodes) {
  const words = path.map((role, i) => {
    const node = nodes[i];
    if (role === 'pet' && node?.species) return node.species;
    return genderedRoleWord(role, node?.gender);
  });
  return words.join("'s ");
}

/** Derive (tag, label, derived_phrase) for one BFS result. */
function deriveRole(path, nodes) {
  const target = nodes[nodes.length - 1];

  if (path.length === 1) {
    const role = path[0];
    const tag = DIRECT_ROLE_TAGS[role] || 'family';
    const label = labelForTag(tag, target);
    // When tag+label fully express the role the derived phrase is null (one
    // truth, two precisions). A coarse-tagged direct role (grandchild,
    // aunt-uncle) keeps its precise word in the phrase column.
    const precise = genderedRoleWord(role, target?.gender);
    const expressed = label || (DIRECT_ROLE_TAGS[role] && DIRECT_ROLE_TAGS[role] !== 'family');
    return { tag, label, derived_phrase: expressed ? null : precise };
  }

  if (path.length === 2) {
    const rule = COMPOSITION_RULES[`${path[0]}∘${path[1]}`];
    if (rule) {
      const tag = rule.tag;
      if (rule.phrase === 'label') {
        const label = labelForTag(tag, target);
        // A label-less gendered role (niece-nephew tag has no labels) keeps
        // its gendered word in the phrase column when it adds precision.
        const word = rule.atomic ? genderedRoleWord(rule.atomic, target?.gender) : null;
        const phrase = !label && word && word !== tag ? word : null;
        return { tag, label, derived_phrase: phrase };
      }
      if (rule.phrase === 'named') {
        return { tag, label: null, derived_phrase: rule.named };
      }
      return { tag, label: null, derived_phrase: pathPhrase(path, nodes) };
    }
    const tag = path[0] === 'spouse' ? 'IL' : 'family';
    return { tag, label: null, derived_phrase: pathPhrase(path, nodes) };
  }

  // Depth 3: left-fold — compress the first two hops to an atomic role when
  // the rule table knows one (parent∘parent → grandparent), then compose the
  // remainder; anything uncovered renders the honest full path phrase.
  const first = COMPOSITION_RULES[`${path[0]}∘${path[1]}`];
  if (first?.atomic) {
    const folded = COMPOSITION_RULES[`${first.atomic}∘${path[2]}`];
    if (folded) {
      const tag = folded.tag;
      if (folded.phrase === 'label') {
        const label = labelForTag(tag, target);
        return { tag, label, derived_phrase: label ? null : pathPhrase(path, nodes) };
      }
      if (folded.phrase === 'named') return { tag, label: null, derived_phrase: folded.named };
      return { tag, label: null, derived_phrase: pathPhrase(path, nodes) };
    }
  }
  const tag = path[0] === 'spouse' ? 'IL' : 'family';
  return { tag, label: null, derived_phrase: pathPhrase(path, nodes) };
}

/**
 * Walk the owner's kinship neighborhood and derive the owner view.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opts]
 * @param {string|null} [opts.ownerId] - test override for identity.json
 * @returns {Array<{person_id: string, display_name: string|null,
 *   relation_tag: string, relation_label: string|null,
 *   relation_derived_phrase: string|null, depth: number, path: string[]}>}
 */
export function walkOwnerView(db, { ownerId = null } = {}) {
  const owner = String(ownerId || ownerPersonId() || '');
  if (!owner) {
    console.warn('[relation-walk] owner_person_id missing — owner view cannot derive');
    return [];
  }

  // One indexed read: active, current (not ended) kinship edges.
  let edges;
  try {
    edges = db.prepare(`
      SELECT person_a, person_b, rel_type FROM person_relations
      WHERE status = 'active' AND domain = 'kinship' AND valid_until IS NULL
    `).all();
  } catch (err) {
    console.warn('[relation-walk] edge read failed:', err.message);
    return [];
  }
  if (!edges.length) return [];

  // Node metadata (gender/species/name) for every endpoint, one read.
  const ids = [...new Set(edges.flatMap((e) => [e.person_a, e.person_b]))];
  const nodeById = new Map();
  const nodeStmt = db.prepare('SELECT id, display_name, gender, species, COALESCE(archived, 0) AS archived FROM people WHERE id = ?');
  for (const id of ids) {
    const row = nodeStmt.get(String(id));
    if (row) nodeById.set(String(id), row);
  }

  // Adjacency with deterministic expansion order (role rank, then name).
  const adjacency = new Map();
  for (const e of edges) {
    for (const nodeId of [e.person_a, e.person_b]) {
      const hop = roleFromEdge(e, nodeId);
      if (!hop) continue;
      // Archived endpoints never enter the owner view (belt-and-braces on
      // top of the archive-deprecates-edges cleanup).
      if (nodeById.get(String(hop.other))?.archived) continue;
      if (!adjacency.has(nodeId)) adjacency.set(nodeId, []);
      adjacency.get(nodeId).push(hop);
    }
  }
  for (const list of adjacency.values()) {
    list.sort((x, y) => {
      const rx = ROLE_RANK.get(x.role) ?? 99;
      const ry = ROLE_RANK.get(y.role) ?? 99;
      if (rx !== ry) return rx - ry;
      const nx = nodeById.get(String(x.other))?.display_name || '';
      const ny = nodeById.get(String(y.other))?.display_name || '';
      return String(nx).localeCompare(String(ny));
    });
  }

  // BFS — visited set makes cycles (spouse loops) safe by construction;
  // breadth order makes shortest-path-wins structural, not checked.
  const visited = new Set([owner]);
  const results = [];
  let frontier = [{ id: owner, path: [], nodes: [] }];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const cur of frontier) {
      // Pets are terminal — never traversed through.
      if (cur.path[cur.path.length - 1] === 'pet') continue;
      for (const hop of adjacency.get(cur.id) || []) {
        const otherId = String(hop.other);
        if (visited.has(otherId)) continue;
        visited.add(otherId);
        const node = nodeById.get(otherId) || null;
        const path = [...cur.path, hop.role];
        const nodes = [...cur.nodes, node];
        const derived = deriveRole(path, nodes);
        results.push({
          person_id: otherId,
          display_name: node?.display_name || null,
          relation_tag: derived.tag,
          relation_label: derived.label,
          relation_derived_phrase: derived.derived_phrase,
          depth,
          path,
        });
        next.push({ id: otherId, path, nodes });
      }
    }
    frontier = next;
  }
  return results;
}
