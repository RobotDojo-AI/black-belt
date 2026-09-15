/**
 * check-quality.js — post-pipeline entity quality gate
 *
 * Runs quality assertions against the entity pipeline output.
 * Exits 0 only when all pass. Exits 1 on first failure (stop-fast).
 *
 * Usage: ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/ingest/check-quality.js
 * Must be invoked from ~/robotdojo (CWD required for module resolution).
 */

import db from '../../lib/db.js';
import { isSystemArtifact } from './03b-service-vendor.js';

const AMBIGUOUS_SINGLE_TOKEN_NAMES = new Set([
  'alex', 'alexander', 'alice', 'alison', 'allison', 'amanda', 'amelia',
  'andrew', 'andy', 'anna', 'anne', 'anthony', 'ashley', 'ben', 'beth', 'bill',
  'bob', 'brad', 'brian', 'bruce', 'carol', 'charlie', 'chris', 'christian',
  'christopher', 'dan', 'dave', 'david', 'debbie', 'derek', 'ed', 'eric',
  'erin', 'frank', 'george', 'greg', 'hani', 'james', 'jane', 'jason', 'jeff',
  'jennifer', 'jenny', 'jeremy', 'jesse', 'jim', 'joe', 'john', 'jon',
  'jonathan', 'jordan', 'joseph', 'josh', 'julia', 'justin', 'kasia', 'kate',
  'katie', 'kevin', 'lauren', 'leanna', 'lisa', 'mark', 'matt', 'matthew',
  'michael', 'mike', 'nick', 'nicole', 'oren', 'paul', 'peter', 'pin', 'rich',
  'rob', 'robert', 'roman', 'ryan', 'sam', 'sarah', 'scott', 'steve', 'tom',
  'will', 'william',
]);

const GENERIC_SINGLE_TOKEN_NAMES = new Set([
  'account', 'accounts', 'admin', 'alert', 'appleid', 'billing', 'calendar',
  'claim', 'client', 'concierge', 'contact', 'customer', 'customerservice',
  'discover', 'donotreply', 'email', 'events', 'feedback', 'hello', 'help',
  'info', 'invoice', 'leadership', 'marketing', 'news', 'notification',
  'office', 'orders', 'payment', 'pin', 'qbepay', 'receipt', 'sales',
  'security', 'service', 'support', 'team', 'ticket', 'travel', 'updates',
  'welcome', 'workspace',
]);

function normalizedNameTokens(raw) {
  return String(raw || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function dropMiddleInitialTokens(tokens) {
  if (tokens.length <= 2) return tokens;
  return tokens.filter((token, idx) => idx === 0 || idx === tokens.length - 1 || token.length > 1);
}

function clusterKey(raw) {
  const tokens = dropMiddleInitialTokens(normalizedNameTokens(raw));
  return tokens.length >= 2 ? tokens.join(' ') : null;
}

function compactEmailLocalKey(raw) {
  const cleaned = String(raw || '').trim();
  if (!/^[A-Z][A-Za-z]{4,}$/.test(cleaned)) return null;
  const key = cleaned.toLowerCase();
  if (AMBIGUOUS_SINGLE_TOKEN_NAMES.has(key)) return null;
  if (GENERIC_SINGLE_TOKEN_NAMES.has(key)) return null;
  return key;
}

function emailLocalCompactKey(email) {
  const raw = String(email || '').toLowerCase();
  if (!raw.includes('@')) return null;
  const local = raw.split('@')[0].split('+')[0];
  return local
    .replace(/^\d+/, '')
    .replace(/\d+$/, '')
    .replace(/[^a-z]/g, '') || null;
}

function emailStronglyEncodesFullName(email, firstTok, lastTok) {
  const local = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  return Boolean(lastTok?.length >= 3 && (local.includes(lastTok) || local.includes(firstTok[0] + lastTok)));
}

function hasPhoneConflict(a = [], b = []) {
  const aPhones = a.filter((r) => r.type === 'phone').map((r) => r.value);
  const bPhones = b.filter((r) => r.type === 'phone').map((r) => r.value);
  if (!aPhones.length || !bPhones.length) return false;
  return aPhones.some((ap) => bPhones.some((bp) => bp !== ap));
}

const identifiersByPerson = new Map();
try {
  for (const ident of db.prepare(`
    SELECT pi.person_id, pi.type, pi.value, pi.source
    FROM person_identifiers pi
    JOIN people p ON p.id = pi.person_id
    WHERE p.archived = 0
      AND COALESCE(p.service_vendor, 0) = 0
      AND pi.type IN ('email', 'phone', 'name')
  `).all()) {
    if (!identifiersByPerson.has(ident.person_id)) identifiersByPerson.set(ident.person_id, []);
    identifiersByPerson.get(ident.person_id).push(ident);
  }
} catch { /* small test DBs may omit tables; quality script runs on live DB */ }

function groupHasActionableDuplicate(group) {
  const tokens = normalizedNameTokens(group[0]?.display_name);
  const compactKey = tokens.length === 1 ? compactEmailLocalKey(group[0].display_name) : null;
  const actionableName = tokens.length >= 2 || Boolean(compactKey);
  if (!actionableName) return false;

  for (let i = 0; i < group.length; i++) {
    const aIdents = identifiersByPerson.get(group[i].id) || [];
    if (compactKey && !aIdents.some((ident) => ident.type === 'email' && emailLocalCompactKey(ident.value) === compactKey)) {
      continue;
    }
    for (let j = i + 1; j < group.length; j++) {
      const bIdents = identifiersByPerson.get(group[j].id) || [];
      if (compactKey && !bIdents.some((ident) => ident.type === 'email' && emailLocalCompactKey(ident.value) === compactKey)) {
        continue;
      }
      if (!hasPhoneConflict(aIdents, bIdents)) return true;
    }
  }
  return false;
}

function groupHasActionableEncodedDuplicate(group, nameKey) {
  const tokens = nameKey.split(' ');
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const candidates = group.filter((row) => {
    const idents = identifiersByPerson.get(row.id) || [];
    return idents.some((ident) => ident.type === 'email' && emailStronglyEncodesFullName(ident.value, first, last));
  });
  if (candidates.length < 2) return false;
  for (let i = 0; i < candidates.length; i++) {
    const aIdents = identifiersByPerson.get(candidates[i].id) || [];
    for (let j = i + 1; j < candidates.length; j++) {
      const bIdents = identifiersByPerson.get(candidates[j].id) || [];
      if (!hasPhoneConflict(aIdents, bIdents)) return true;
    }
  }
  return false;
}

function pass(label) {
  console.log(`[check-quality] ✓ ${label}`);
}

function fail(label, details) {
  console.error(`[check-quality] ✗ ${label}: ${details}`);
  process.exit(1);
}

// 1. No active email-address display names. Archived rows are forensic residue;
// the product contract is the active graph chat/network reads.
const emailDNCount = db.prepare(
  "SELECT count(*) AS c FROM people WHERE archived=0 AND display_name LIKE '%@%'"
).get().c;
if (emailDNCount > 0) {
  fail('no email-address display names', `${emailDNCount} found`);
} else {
  pass('no email-address display names');
}

// 1b. No active non-human system/org artifacts in the people graph. These rows
// poison chat and network search because they rank beside humans.
const systemArtifactRows = db.prepare(`
  SELECT id, display_name, primary_source, n2, score, interaction_count
  FROM people
  WHERE archived = 0
    AND COALESCE(service_vendor, 0) = 0
    AND verified = 0
    AND tier_override IS NULL
    AND relation_tag IS NULL
    AND display_name IS NOT NULL
`).all();
const activeSystemArtifacts = systemArtifactRows
  .filter((row) => isSystemArtifact(row, identifiersByPerson.get(row.id) || []));
if (activeSystemArtifacts.length > 0) {
  const sample = activeSystemArtifacts
    .sort((a, b) => {
      const aTop = ['Family', 'Partners', 'Customers', 'Core', 'Network'].includes(a.n2) ? 1 : 0;
      const bTop = ['Family', 'Partners', 'Customers', 'Core', 'Network'].includes(b.n2) ? 1 : 0;
      return bTop - aTop || (b.score || 0) - (a.score || 0) || String(a.display_name).localeCompare(String(b.display_name));
    })
    .slice(0, 10)
    .map((row) => `${row.display_name}${row.n2 ? ` (${row.n2})` : ''}`)
    .join('; ');
  fail('no active system/org artifacts in people graph', `${activeSystemArtifacts.length} found; sample: ${sample}`);
} else {
  pass('no active system/org artifacts in people graph');
}

// 2. No orphaned company FKs
const orphanFKCount = db.prepare(
  'SELECT count(*) AS c FROM people WHERE company_id IS NOT NULL AND company_id NOT IN (SELECT id FROM companies)'
).get().c;
if (orphanFKCount > 0) {
  fail('no orphaned company FKs', `${orphanFKCount} found`);
} else {
  pass('no orphaned company FKs');
}

// 3. No active actionable duplicate entity pairs. Exact duplicate names at the
// same company are actionable when they are full names, or compact email-local
// artifacts whose email locals agree. Common first-name-only groups are not
// identity evidence and must not force unsafe merges.
const duplicateRows = db.prepare(`
  SELECT id, display_name, company_id
  FROM people
  WHERE archived = 0
    AND COALESCE(service_vendor, 0) = 0
    AND display_name NOT LIKE '%@%'
    AND display_name != 'Unknown'
    AND company_id IS NOT NULL
  ORDER BY display_name, company_id
`).all();
const duplicateGroups = new Map();
for (const row of duplicateRows) {
  const key = `${row.display_name}|${row.company_id}`;
  if (!duplicateGroups.has(key)) duplicateGroups.set(key, []);
  duplicateGroups.get(key).push(row);
}
const actionableDuplicateCount = [...duplicateGroups.values()]
  .filter((group) => group.length > 1 && groupHasActionableDuplicate(group))
  .length;

const encodedRows = db.prepare(`
  SELECT id, display_name
  FROM people
  WHERE archived = 0
    AND COALESCE(service_vendor, 0) = 0
    AND display_name NOT LIKE '%@%'
    AND display_name != 'Unknown'
`).all();
const encodedGroups = new Map();
for (const row of encodedRows) {
  const key = clusterKey(row.display_name);
  if (!key) continue;
  if (!encodedGroups.has(key)) encodedGroups.set(key, []);
  encodedGroups.get(key).push(row);
}
const actionableEncodedDuplicateCount = [...encodedGroups.entries()]
  .filter(([, group]) => group.length > 1)
  .filter(([nameKey, group]) => groupHasActionableEncodedDuplicate(group, nameKey))
  .length;

if (actionableDuplicateCount > 0 || actionableEncodedDuplicateCount > 0) {
  fail('no active actionable near-duplicate entity pairs', `${actionableDuplicateCount} exact groups, ${actionableEncodedDuplicateCount} encoded groups`);
} else {
  pass('no active actionable near-duplicate entity pairs');
}

// 4. All Partners/Core/Family entities have context files
const noContextCount = db.prepare(
  "SELECT count(*) AS c FROM people WHERE n2 IN ('Partners','Core','Family') AND archived=0 AND context_file_path IS NULL"
).get().c;
if (noContextCount > 0) {
  fail('all Partners/Core/Family entities have context files', `${noContextCount} missing`);
} else {
  pass('all Partners/Core/Family entities have context files');
}

// 5. All Partners/Core/Family entities have evidence coverage. Chunk matches,
// structured interactions, and explicit owner/contacts relationship tags are
// valid evidence surfaces for context.
const noEvidenceCount = db.prepare(
  "SELECT count(*) AS c FROM people p WHERE n2 IN ('Partners','Core','Family') AND archived=0 AND relation_tag IS NULL AND NOT EXISTS (SELECT 1 FROM chunk_entities ce WHERE ce.entity_id = p.id) AND NOT EXISTS (SELECT 1 FROM person_interactions pi WHERE pi.person_id = p.id)"
).get().c;
if (noEvidenceCount > 0) {
  fail('all Partners/Core/Family entities have evidence coverage', `${noEvidenceCount} with no chunks or interactions`);
} else {
  pass('all Partners/Core/Family entities have evidence coverage');
}

// 6. No orphaned needs_regen flags (needs_regen without context_file_path)
const orphanRegenCount = db.prepare(
  'SELECT count(*) AS c FROM people WHERE needs_regen=1 AND context_file_path IS NULL AND archived=0'
).get().c;
if (orphanRegenCount > 0) {
  fail('no orphaned needs_regen flags (needs_regen without context_file_path)', `${orphanRegenCount} found`);
} else {
  pass('no orphaned needs_regen flags (needs_regen without context_file_path)');
}

// 7. No live rows are waiting for the deterministic archive predicate. This is
// 6b. No active dirty flags outside the enrichment-eligible tiers. The post-link
// marker is only meaningful for people the enrichment worker can actually drain.
const nonEnrichmentRegenCount = db.prepare(`
  SELECT count(*) AS c
  FROM people
  WHERE archived = 0
    AND needs_regen = 1
    AND context_file_path IS NOT NULL
    AND context_file_path != ''
    AND (n2 IS NULL OR n2 NOT IN ('Family', 'Partners', 'Customers', 'Core', 'Network'))
`).get().c;
if (nonEnrichmentRegenCount > 0) {
  fail('no non-enrichment needs_regen backlog', `${nonEnrichmentRegenCount} found`);
} else {
  pass('no non-enrichment needs_regen backlog');
}

const archivedRegenCount = db.prepare(
  'SELECT count(*) AS c FROM people WHERE archived=1 AND needs_regen=1'
).get().c;
if (archivedRegenCount > 0) {
  fail('no archived needs_regen backlog', `${archivedRegenCount} found`);
} else {
  pass('no archived needs_regen backlog');
}

// 7. No live rows are waiting for the deterministic archive predicate. This is
// the partial-slice guard: chat must not see post-extract/pre-archive residue.
const pendingArchiveCount = db.prepare(`
  SELECT count(*) AS c FROM people
  WHERE archived = 0
    AND primary_source = 'email'
    AND interaction_count = 0
    AND verified = 0
    AND tier_override IS NULL
    AND relation_tag IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM person_identifiers pi
      WHERE pi.person_id = people.id AND pi.source IN ('contacts', 'google_contacts')
    )
`).get().c;
if (pendingArchiveCount > 0) {
  fail('no live rows pending deterministic archive cleanup', `${pendingArchiveCount} found`);
} else {
  pass('no live rows pending deterministic archive cleanup');
}

const pendingUnresolvableArchiveCount = db.prepare(`
  SELECT count(*) AS c FROM people
  WHERE archived = 0
    AND interaction_count = 0
    AND verified = 0
    AND tier_override IS NULL
    AND relation_tag IS NULL
    AND context_file_path IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM person_identifiers pi
      WHERE pi.person_id = people.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM person_interactions px
      WHERE px.person_id = people.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM chunk_entities ce
      WHERE ce.entity_id = people.id AND ce.entity_type = 'person'
    )
`).get().c;
if (pendingUnresolvableArchiveCount > 0) {
  fail('no live zero-signal unresolvable rows', `${pendingUnresolvableArchiveCount} found`);
} else {
  pass('no live zero-signal unresolvable rows');
}
