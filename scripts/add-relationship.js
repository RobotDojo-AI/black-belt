/**
 * add-relationship.js — CLI for recording typed entity relationships.
 *
 * Usage:
 *   node scripts/add-relationship.js \
 *     --from "Alice Smith" \
 *     --from-type person \
 *     --to "Acme Corp" \
 *     --to-type company \
 *     --type employee \
 *     [--weight 1.0]
 *
 * --from           Name of the source entity (required)
 * --from-type      'person' | 'company' | 'place' (default: 'person')
 * --to             Name(s) of target entity (required; may be repeated)
 * --to-type        'person' | 'company' | 'place' (default: 'person')
 * --type           Relationship type (required; must be in APPROVED set)
 * --weight         Edge weight, 0..10 (default: 1.0)
 *
 * Source is always 'manual'. Exits 0 on success, 1 on validation error.
 *
 * Intelligence tier: extraction.
 */

export const INTELLIGENCE_TIER = 'extraction';

process.env.ROBOTDOJO_ALLOW_PLAINTEXT ??= '1';

import { APPROVED_RELATIONSHIP_TYPES, recordRelationship, findOrCreateCompany } from '../lib/entity-relationships.js';
import { default as db } from '../lib/db.js';

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flagValue(flag) {
  // Returns the last value for a single-value flag, or null if absent.
  const idx = args.lastIndexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function flagValues(flag) {
  // Returns all values for a repeated flag.
  const values = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) values.push(args[i + 1]);
  }
  return values;
}

const fromName     = flagValue('--from');
const fromType     = flagValue('--from-type') || 'person';
const toNames      = flagValues('--to');
const toType       = flagValue('--to-type') || 'person';
const relType      = flagValue('--type');
const weightRaw    = flagValue('--weight');
const weight       = weightRaw != null ? parseFloat(weightRaw) : 1.0;

// ── Validation ────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`[add-relationship] ERROR: ${msg}`);
  process.exit(1);
}

if (!fromName) fail('--from is required');
if (!toNames.length) fail('--to is required (may be repeated for multiple targets)');
if (!relType) fail('--type is required');

if (!APPROVED_RELATIONSHIP_TYPES.has(relType)) {
  fail(
    `Unknown type "${relType}". Approved types: ${[...APPROVED_RELATIONSHIP_TYPES].join(', ')}`,
  );
}

if (isNaN(weight) || weight < 0) {
  fail(`--weight must be a non-negative number (got "${weightRaw}")`);
}

// ── Entity resolution ─────────────────────────────────────────────────────────

/**
 * Resolve an entity by name + type to its DB row { id }.
 * For companies: findOrCreateCompany (creates if absent).
 * For persons: exact display_name match on non-archived people.
 * For places: exact name match.
 *
 * @param {string} name
 * @param {string} type - 'person' | 'company' | 'place'
 * @returns {{ id: string|number, display_name?: string, name?: string }}
 */
function resolveEntity(name, type) {
  if (type === 'company') {
    return findOrCreateCompany(db, name);
  }
  if (type === 'person') {
    const row = db.prepare(
      `SELECT id, display_name FROM people WHERE LOWER(TRIM(display_name)) = LOWER(TRIM(?)) AND archived = 0 LIMIT 1`,
    ).get(name);
    if (!row) fail(`Person not found: "${name}" (must match display_name of a non-archived person)`);
    return row;
  }
  if (type === 'place') {
    const row = db.prepare(
      `SELECT id, name FROM places WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1`,
    ).get(name);
    if (!row) fail(`Place not found: "${name}" (must match name in places table)`);
    return row;
  }
  fail(`Unknown entity type "${type}". Must be person, company, or place.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const fromEntity = resolveEntity(fromName, fromType);
const fromLabel  = fromEntity.display_name || fromEntity.name;

for (const toName of toNames) {
  const toEntity  = resolveEntity(toName, toType);
  const toLabel   = toEntity.display_name || toEntity.name;

  recordRelationship(
    db,
    fromEntity.id,
    fromType,
    toEntity.id,
    toType,
    relType,
    weight,
    'manual',
  );

  console.log(
    `[add-relationship] recorded: ${fromLabel} (${fromType}) --[${relType}, weight=${weight}]--> ${toLabel} (${toType})`,
  );
}

console.log(`[add-relationship] done — ${toNames.length} edge(s) written`);
process.exit(0);
