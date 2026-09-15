/**
 * entity-resolve.js — White Belt entity resolution utilities.
 *
 * Provides the same API surface as lib/entity-matcher.js and
 * lib/person-resolver.js for use by sync modules (gmail-sync, imessage,
 * contacts-extractor, calendar-extractor, etc.).
 *
 * White Belt: exact-match only (email, phone). No probabilistic matching.
 * Black Belt algorithms live behind the cohort entitlement gate.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync as fsReadFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import db from './db.js';
// Single source of truth for the role/generic-email rule (lib/identity-matching.js
// is a pure leaf — no db import, no cycle). isBlocklistedEmail delegates so the
// legacy resolver and the live pipeline share ONE robust classifier.
import { isRoleOrGenericEmail } from './identity-matching.js';

export const ENTITY_MATCH_THRESHOLD = 0.85;

// --- Normalized full-name comparison (E12, st_f1a40461) -------------------
// matchPerson must never collapse two people on a first-name-only match. The
// name guard requires an exact NORMALIZED FULL name with ≥2 tokens. The first
// token is canonicalized through config/nicknames.json so "Mike Smith" and
// "Michael Smith" compare equal, but "Mike" alone never matches "Mike Jones".

let _nicknameCanon = null;
/**
 * Build a first-token → canonical-first-token map from config/nicknames.json.
 * The config maps a name to its variant set; we canonicalize every variant to
 * the lexicographically smallest member of {name} ∪ variants so any two names
 * in the same equivalence cluster normalize to the same token. Lazy + cached.
 */
function nicknameCanon() {
  if (_nicknameCanon) return _nicknameCanon;
  const map = new Map();
  try {
    const raw = fsReadFileSync(pathResolve(process.cwd(), 'config/nicknames.json'), 'utf8');
    const data = JSON.parse(raw);
    for (const [name, variants] of Object.entries(data)) {
      const cluster = [name, ...(Array.isArray(variants) ? variants : [])]
        .map((v) => String(v).toLowerCase());
      const canon = cluster.slice().sort()[0];
      for (const v of cluster) {
        // Don't overwrite an already-assigned (smaller) canon.
        if (!map.has(v) || map.get(v) > canon) map.set(v, canon);
      }
    }
  } catch { /* no config — fall back to identity canonicalization */ }
  _nicknameCanon = map;
  return _nicknameCanon;
}

/**
 * Normalize a full name to a comparable token form: lowercased,
 * diacritics-stripped, punctuation removed, whitespace-collapsed, with the
 * first token canonicalized through the nickname table. Returns null when the
 * name has fewer than 2 tokens (single-token names are NEVER name-matched).
 */
export function normalizedFullName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics (combining marks)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')                      // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length < 2) return null;
  const canon = nicknameCanon();
  tokens[0] = canon.get(tokens[0]) || tokens[0];
  return tokens.join(' ');
}

/**
 * Returns true if the email address is a role account (not an individual).
 * Delegates to the shared, comprehensive classifier (local-part blocklist +
 * system/notification domains + machine-generated-local patterns); strips
 * plus-addressing before checking (support+ticket123@... → support).
 */
export function isBlocklistedEmail(email) {
  return isRoleOrGenericEmail(email);
}

export const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'msn.com',
  'live.com', 'aol.com', 'comcast.net', 'verizon.net',
]);

export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const e = email.toLowerCase().trim();
  return e.includes('@') ? e : null;
}

export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return digits.length >= 7 ? `+${digits}` : null;
}

export function resolvePerson({ name, email, phone, source }) {
  const normEmail = normalizeEmail(email);
  // WHY early return on blocklist: role accounts (noreply@, support@, etc.) are not
  // people. Creating an entity for them pollutes the graph with noise that cannot be
  // cleaned up without a full rebuild. Block before any DB lookup.
  if (normEmail && isBlocklistedEmail(normEmail)) return null;
  const normPhone = phone ? normalizePhone(phone) : null;

  const byEmail = normEmail
    ? db.prepare('SELECT person_id as id FROM person_identifiers WHERE type=? AND value=? LIMIT 1').get('email', normEmail)
    : null;
  if (byEmail) return { id: byEmail.id, personId: byEmail.id, created: false };

  const byPhone = normPhone
    ? db.prepare('SELECT person_id as id FROM person_identifiers WHERE type=? AND value=? LIMIT 1').get('phone', normPhone)
    : null;
  if (byPhone) return { id: byPhone.id, personId: byPhone.id, created: false };

  const id = `p_${Date.now()}_${randomBytes(3).toString('hex')}`;
  db.prepare('INSERT OR IGNORE INTO people (id, display_name, source_count) VALUES (?, ?, 1)').run(id, name || normEmail || 'Unknown');
  if (normEmail) db.prepare('INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source) VALUES (?, ?, ?, ?)').run(id, 'email', normEmail, source || 'unknown');
  if (normPhone) db.prepare('INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source) VALUES (?, ?, ?, ?)').run(id, 'phone', normPhone, source || 'unknown');
  return { id, personId: id, created: true };
}

export function linkPerson({ email, phone, source }) {
  const normEmail = normalizeEmail(email);
  // WHY blocklist in linkPerson: linking a role account to a person would corrupt
  // the graph — the same noreply@ address would appear in multiple people's identifiers.
  if (normEmail && isBlocklistedEmail(normEmail)) return null;
  if (normEmail) {
    const row = db.prepare('SELECT person_id as id FROM person_identifiers WHERE type=? AND value=? LIMIT 1').get('email', normEmail);
    if (row) return { id: row.id };
  }
  const normPhone = phone ? normalizePhone(phone) : null;
  if (normPhone) {
    const row = db.prepare('SELECT person_id as id FROM person_identifiers WHERE type=? AND value=? LIMIT 1').get('phone', normPhone);
    if (row) return { id: row.id };
  }
  return null;
}

export function matchPerson({ name, email, phone }) {
  // E12 (st_f1a40461): identifier resolution now includes ARCHIVED rows. A merge
  // target (or a person resurfaced by the re-derivable archive) may currently be
  // archived; restricting to active rows hid them and forced a spurious CREATE.
  // Identifiers are hard signals — an exact email/phone match is the same person
  // regardless of archived state.
  const normEmail = normalizeEmail(email);
  if (normEmail) {
    const row = db.prepare('SELECT person_id as id FROM person_identifiers WHERE type=? AND value=? LIMIT 1').get('email', normEmail);
    if (row) return { personId: row.id, confidence: 1.0, guard: 'email' };
  }
  const normPhone = phone ? normalizePhone(phone) : null;
  if (normPhone) {
    const row = db.prepare('SELECT person_id as id FROM person_identifiers WHERE type=? AND value=? LIMIT 1').get('phone', normPhone);
    if (row) return { personId: row.id, confidence: 1.0, guard: 'phone' };
  }
  // Name match: variant-tolerant NORMALIZED FULL name (≥2 tokens, nickname-
  // canonicalized first token). NEVER first-name-only — normalizedFullName
  // returns null for single-token names, so the loop simply skips them.
  // We compare in JS rather than SQL because normalization (diacritics +
  // nickname canonicalization) is not expressible in a plain LOWER() compare.
  const target = normalizedFullName(name);
  if (target) {
    // Prefer an active row; fall back to an archived one if that's all there is.
    const candidates = db.prepare(
      'SELECT id, display_name, archived FROM people WHERE display_name IS NOT NULL ORDER BY archived ASC'
    ).all();
    for (const c of candidates) {
      if (normalizedFullName(c.display_name) === target) {
        return { personId: c.id, confidence: 0.8, guard: 'name_exact' };
      }
    }
  }
  return null;
}
