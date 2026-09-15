/**
 * User identity — loads the current user's owner emails + canonical person_id
 * from `~/.robotdojo/identity.json`. Never hardcoded in the repo.
 *
 * Shape:
 *   {
 *     "emails": ["you@example.com", "you@work.com"],
 *     "owner_person_id": "<people.id in your DB>",
 *     "display_name_match": "your name"   // optional: used for legacy
 *                                          // LIKE '%name%' owner-row lookups
 *                                          // until owner_person_id is set.
 *   }
 *
 * Callers that need owner identity:
 *   - scripts/timeline-pipeline.js       (owner_person_id for extractions)
 *   - lib/family-inference.js            (owner row for sibling/surname logic)
 *   - lib/scoring.js                     (owner exclusion + owner email list)
 *   - scripts/tantei-rebuild.js          (owner person_id resolution)
 *
 * Fails loud: scripts that need identity throw if the file is missing,
 * with a clear remediation message. The file is created during first-run
 * onboarding (see scripts/onboard.js).
 */

import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import crypto from 'node:crypto';

const IDENTITY_PATH = process.env.ROBOTDOJO_IDENTITY_PATH
  || resolve(homedir(), 'robotdojo', 'config', 'identity.json');

let _cache = undefined;

function loadRaw() {
  if (_cache !== undefined) return _cache;
  if (!existsSync(IDENTITY_PATH)) {
    _cache = null;
    return null;
  }
  try {
    const raw = readFileSync(IDENTITY_PATH, 'utf8');
    _cache = JSON.parse(raw);
  } catch (err) {
    console.error(`[identity] parse failed at ${IDENTITY_PATH}: ${err.message}`);
    _cache = null;
  }
  return _cache;
}

/**
 * Returns the list of owner email addresses (lowercased, deduped).
 * Never throws — returns [] if identity is not configured.
 */
export function ownerEmails() {
  const raw = loadRaw();
  const list = Array.isArray(raw?.emails) ? raw.emails : [];
  return [...new Set(list.map(e => String(e).trim().toLowerCase()).filter(Boolean))];
}

/**
 * Returns the canonical owner person_id or null. Callers should treat
 * null as "owner not yet resolved" and skip owner-specific logic.
 */
export function ownerPersonId() {
  const raw = loadRaw();
  return raw?.owner_person_id || null;
}

/**
 * Optional display-name match string for legacy LIKE-based owner lookups.
 * Prefer ownerPersonId() when available. Returns null if not set.
 */
export function ownerDisplayNameMatch() {
  const raw = loadRaw();
  const v = raw?.display_name_match;
  return v ? String(v).trim().toLowerCase() : null;
}

/**
 * Owner's display name, suitable for embedding in LLM prompts / UI copy.
 * Prefers `name` (set by scripts/export-identity.js on first run), falls
 * back to the display_name_match hint. Returns the generic literal
 * `"the user"` when identity.json is missing or fields are empty — never
 * hardcode a real name here, that would leak one customer's identity into
 * every other customer's LLM prompt.
 */
export function ownerDisplayName() {
  const raw = loadRaw();
  const name = raw?.name && String(raw.name).trim();
  if (name) return name;
  const hint = raw?.display_name_match && String(raw.display_name_match).trim();
  if (hint) return hint;
  return 'the user';
}

/**
 * Throw if identity.json is missing or empty. Use from scripts that
 * cannot meaningfully proceed without owner identity.
 */
export function requireIdentity() {
  const raw = loadRaw();
  const emails = ownerEmails();
  if (!raw || emails.length === 0) {
    throw new Error(
      `[identity] missing or empty ${IDENTITY_PATH}. ` +
      `Create it with: {"emails":["you@example.com"], "owner_person_id":"<people.id>"}. ` +
      `See lib/identity.js for the shape, or run scripts/onboard.js.`
    );
  }
  return { emails, ownerPersonId: raw.owner_person_id || null, displayNameMatch: raw.display_name_match || null };
}

// ── Declared owner identity (df_cbd30a5a) ────────────────────────────────────
//
// Who "you" are is DECLARED, not derived. Before this story the owner was
// resolved from the graph (highest-interaction match, export-identity.js), so a
// bad contact card could rename the owner or weld a second real person into
// him. The declared block flips that: the installer / @miyagi chat tool write
// the owner's canonical name + hard identifiers here, and resolution keys its
// owner-anchor guard on this set (lib/people-merge.js).
//
// Design: ONE portable, human-editable, gitignored truth in identity.json — not
// a second SQL source that would need a boot-time sync (Stonebraker: one truth).
// An old identity.json with no `declared` key is treated as un-declared and
// derivation still gap-fills (back-compatible). The NOT-NULL analog lives at the
// write boundary: writeDeclaredOwner() throws unless name + ≥1 valid email are
// present, and resets the module cache so a stale owner can't be served for the
// rest of the process.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalize an email the same way the resolver stores it (lowercase+trim). */
function normOwnerEmail(s) {
  if (typeof s !== 'string') return null;
  const v = s.trim().toLowerCase();
  return v && EMAIL_RE.test(v) ? v : null;
}

/** Normalize a phone to match the resolver's person_identifiers value shape. */
function normOwnerPhone(s) {
  if (!s) return null;
  const digits = String(s).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return digits.length >= 7 ? `+${digits}` : null;
}

/**
 * True when identity.json carries a complete declared-owner block
 * (declared flag + name + ≥1 email). An incomplete or legacy file is treated
 * as un-declared so derivation still gap-fills.
 */
export function isOwnerDeclared() {
  const raw = loadRaw();
  return Boolean(
    raw
      && raw.declared === true
      && raw.name && String(raw.name).trim()
      && Array.isArray(raw.emails)
      && raw.emails.some((e) => normOwnerEmail(e)),
  );
}

/**
 * The declared owner's canonical name (only when a complete declared block is
 * present), lowercased and trimmed — the name-match half of the owner-anchor
 * guard. Returns null when un-declared, so the guard never name-matches on a
 * derived/placeholder name.
 */
export function declaredOwnerName() {
  if (!isOwnerDeclared()) return null;
  return String(loadRaw().name).trim().toLowerCase();
}

/**
 * The normalized email+phone set from the declared block — the owner's own
 * hard identifiers, the protective set the guard keys foreignness on. Empty
 * Set when un-declared. Values are normalized to match person_identifiers.value
 * exactly (lowercased emails; +E.164-ish phones) so membership tests compare
 * like-for-like against a colliding resolver identifier.
 */
export function declaredOwnerIdentifierSet() {
  const raw = loadRaw();
  const set = new Set();
  if (!raw || raw.declared !== true) return set;
  for (const e of Array.isArray(raw.emails) ? raw.emails : []) {
    const v = normOwnerEmail(e);
    if (v) set.add(v);
  }
  for (const p of Array.isArray(raw.phones) ? raw.phones : []) {
    const v = normOwnerPhone(p);
    if (v) set.add(v);
  }
  return set;
}

/** Is (type,value) one of the declared owner's own hard identifiers? */
export function isDeclaredOwnerIdentifier(type, value) {
  const norm = type === 'phone' ? normOwnerPhone(value) : normOwnerEmail(value);
  if (!norm) return false;
  return declaredOwnerIdentifierSet().has(norm);
}

/**
 * The current declared-owner fields for editors (the @miyagi chat tool). Reads
 * the raw block; returns declared:false + best-effort name/emails when the file
 * predates declaration, so a first chat edit can seed a complete block.
 */
export function readDeclaredOwner() {
  const raw = loadRaw() || {};
  return {
    declared: raw.declared === true,
    name: raw.name ? String(raw.name) : null,
    owner_person_id: raw.owner_person_id || null,
    emails: Array.isArray(raw.emails) ? raw.emails.slice() : [],
    phones: Array.isArray(raw.phones) ? raw.phones.slice() : [],
    declared_source: raw.declared_source || null,
  };
}

/** Is `personId` the canonical owner record? (=== owner_person_id) */
export function isOwner(personId) {
  const owner = ownerPersonId();
  return Boolean(owner && personId && String(personId) === String(owner));
}

/**
 * THE SINGLE WRITER of the declared block. The installer prompt and the
 * @miyagi chat tool both go through here — never a raw file write — so the
 * NOT-NULL analog (name + ≥1 valid email) and the cache reset are enforced in
 * exactly one place.
 *
 * Merges onto the existing identity.json (preserving derived extras like
 * timezone / primary_email / display_name_match), stamps declared:true +
 * declared_at + declared_source, and persists to the SAME path the readers
 * resolve (IDENTITY_PATH). Resets the module cache immediately after write so
 * ownerPersonId() / the guard can never serve a stale owner.
 *
 * @param {{ name: string, emails: string[], phones?: string[],
 *           owner_person_id?: string|null, declared_source?: string }} fields
 * @returns {object} the persisted declared block
 * @throws {Error} when name is missing/empty or fewer than one valid email
 */
export function writeDeclaredOwner(fields = {}) {
  const name = fields.name ? String(fields.name).trim() : '';
  if (!name) {
    throw new Error('[identity] writeDeclaredOwner requires a non-empty owner name');
  }
  const emails = [...new Set((Array.isArray(fields.emails) ? fields.emails : [])
    .map(normOwnerEmail)
    .filter(Boolean))];
  if (emails.length < 1) {
    throw new Error('[identity] writeDeclaredOwner requires at least one valid owner email');
  }
  const phones = [...new Set((Array.isArray(fields.phones) ? fields.phones : [])
    .map(normOwnerPhone)
    .filter(Boolean))];

  // Preserve everything already on disk (timezone/location/primary_email/…);
  // the declared block only OVERWRITES the declared fields.
  let existing = {};
  if (existsSync(IDENTITY_PATH)) {
    try { existing = JSON.parse(readFileSync(IDENTITY_PATH, 'utf8')) || {}; }
    catch { existing = {}; }
  }

  const owner_person_id = fields.owner_person_id != null
    ? String(fields.owner_person_id)
    : (existing.owner_person_id || null);

  const out = {
    ...existing,
    declared: true,
    name,
    owner_person_id,
    emails,
    phones,
    // display_name_match keeps legacy LIKE-based owner lookups working.
    display_name_match: name.toLowerCase(),
    declared_at: new Date().toISOString(),
    declared_source: fields.declared_source || existing.declared_source || 'unknown',
  };
  // primary_email defaults to the first declared email when absent.
  if (!out.primary_email) out.primary_email = emails[0];

  mkdirSync(dirname(IDENTITY_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(IDENTITY_PATH, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  _resetIdentityCache();
  return out;
}

/**
 * Golden-record consolidation (df_cbd30a5a follow-up, FIX 2). The DECLARED
 * identity is the authority: every ACTIVE record holding ANY declared-owner hard
 * identifier (email/phone) IS the owner — including the owner's Gmail send-as
 * aliases, which land as bare declared-email rows with NO name to match on, so
 * neither the name-based dedup nor the transitive-merge gate ever folds them.
 * Fold each such non-owner record into the owner through the SHARED product
 * merge with force:true (an explicit owner decision that bypasses shouldMerge;
 * the owner-anchor + must-not-merge vetoes still apply and correctly admit a row
 * whose identifiers are all owner-controlled). Deterministic Tier-0, audited by
 * the merge itself. Dynamic import keeps lib/identity.js a leaf — importing
 * people-merge statically would drag lib/scoring.js's eager DB open onto every
 * lightweight identity consumer.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} ownerId
 * @returns {Promise<{ merged: number, records: string[] }>}
 */
async function consolidateDeclaredAliases(db, ownerId) {
  const declaredSet = declaredOwnerIdentifierSet(); // normalized email+phone values
  if (!ownerId || declaredSet.size === 0) return { merged: 0, records: [] };
  let holders;
  try {
    const placeholders = [...declaredSet].map(() => '?').join(',');
    holders = db.prepare(`
      SELECT DISTINCT pi.person_id AS id
      FROM person_identifiers pi
      JOIN people p ON p.id = pi.person_id
      WHERE pi.type IN ('email','phone')
        AND pi.value IN (${placeholders})
        AND COALESCE(p.archived, 0) = 0
        AND pi.person_id != ?
    `).all(...declaredSet, String(ownerId));
  } catch {
    return { merged: 0, records: [] }; // person_identifiers absent in a minimal DB
  }
  if (holders.length === 0) return { merged: 0, records: [] };

  const { mergePeople } = await import('./people-merge.js');
  const merged = [];
  for (const h of holders) {
    try {
      mergePeople(db, String(ownerId), String(h.id), {
        force: true,
        evidence: 'declared-owner-consolidation',
      });
    } catch { /* one failed fold must not abort the rest */ }
    // Count only real archives — the owner-anchor guard may legitimately refuse a
    // row that also carries a FOREIGN established identifier, and mergePeople
    // does not surface that refusal.
    try {
      if (db.prepare('SELECT COALESCE(archived,0) AS a FROM people WHERE id = ?').get(String(h.id))?.a === 1) {
        merged.push(String(h.id));
      }
    } catch { /* ignore */ }
  }
  return { merged: merged.length, records: merged };
}

/**
 * Wire owner_person_id onto the declared block from the live graph — the fix
 * for the "guard is inert on first ingest" hole. `isOwner` is === ownerPersonId()
 * and nothing auto-invokes export-identity.js, so without this the owner anchor
 * is never set on a fresh install. Called from every real ingest tail
 * (onboard phaseScore, ingest-orchestrator, network rebuild).
 *
 * Idempotent + deterministic (Tier-0, no LLM writes a row):
 *   - already anchored to an active person → keep it.
 *   - else pick the richest ACTIVE person holding a declared owner email.
 *   - else create a minimal owner person + declared-email identifiers.
 * Then run the golden-record consolidation (fold every declared-identifier alias
 * into the owner) and persist the id through the single writer (writeDeclaredOwner).
 *
 * Async because the consolidation force-merges through lib/people-merge.js,
 * loaded via a dynamic import so identity.js stays a leaf (see
 * consolidateDeclaredAliases).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{ anchored: boolean, owner_person_id: string|null, reason?: string, created?: boolean, consolidated?: object }>}
 */
export async function anchorDeclaredOwner(db) {
  if (!db) return { anchored: false, owner_person_id: null, reason: 'no-db' };
  if (!isOwnerDeclared()) {
    return { anchored: false, owner_person_id: null, reason: 'not-declared' };
  }
  const raw = loadRaw();
  const emails = declaredOwnerIdentifierSet();
  const emailList = [...emails].filter((v) => v.includes('@'));
  const current = raw.owner_person_id ? String(raw.owner_person_id) : null;

  // Resolve the owner personId. Already anchored to an active person → keep it;
  // else pick the richest ACTIVE holder of a declared email; else create one.
  let personId = null;
  let created = false;
  let reason;

  if (current) {
    try {
      const row = db.prepare('SELECT COALESCE(archived,0) AS archived FROM people WHERE id = ?').get(current);
      if (row && Number(row.archived) === 0) { personId = current; reason = 'already-anchored'; }
    } catch { /* people table absent in minimal DBs — fall through to resolve */ }
  }

  if (!personId && emailList.length) {
    try {
      const placeholders = emailList.map(() => '?').join(',');
      const row = db.prepare(`
        SELECT p.id AS id, COALESCE(p.interaction_count, 0) AS ic
        FROM people p
        JOIN person_identifiers pi ON pi.person_id = p.id
        WHERE pi.type = 'email' AND pi.value IN (${placeholders})
          AND COALESCE(p.archived, 0) = 0
        GROUP BY p.id
        ORDER BY ic DESC, p.id ASC
        LIMIT 1
      `).get(...emailList);
      if (row) { personId = String(row.id); reason = 'resolved'; }
    } catch { /* schema mismatch — fall through to create */ }
  }

  if (!personId) {
    personId = crypto.randomUUID();
    try {
      db.prepare(`
        INSERT INTO people (id, display_name, source_count, primary_source, created_at, updated_at)
        VALUES (?, ?, 1, 'declared-owner', datetime('now'), datetime('now'))
      `).run(personId, String(raw.name));
      for (const e of emailList) {
        db.prepare("INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source, is_primary) VALUES (?, 'email', ?, 'declared-owner', 0)").run(personId, e);
      }
      created = true;
    } catch (err) {
      return { anchored: false, owner_person_id: current, reason: `create-failed: ${err.message}` };
    }
  }

  // Golden-record consolidation (FIX 2) — fold every active declared-identifier
  // alias into the resolved owner. Runs on EVERY anchor (idempotent: a no-op
  // when there are no aliases left to fold).
  const consolidated = await consolidateDeclaredAliases(db, personId);

  // Persist owner_person_id when it changed (the writer resets the module cache).
  if (String(personId) !== current) {
    writeDeclaredOwner({
      name: raw.name,
      emails: Array.isArray(raw.emails) ? raw.emails : emailList,
      phones: Array.isArray(raw.phones) ? raw.phones : [],
      owner_person_id: personId,
      declared_source: raw.declared_source || 'anchor',
    });
  }
  return { anchored: true, owner_person_id: personId, created, reason: reason || 'unchanged', consolidated };
}

/**
 * Test-only: reset the cache so a new identity.json is picked up.
 */
export function _resetIdentityCache() {
  _cache = undefined;
}

/** The resolved declared-store path (readers + the single writer agree). */
export { IDENTITY_PATH };
