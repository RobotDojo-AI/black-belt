#!/usr/bin/env node
/**
 * export-identity — build `~/.robotdojo/identity.json` from a Robot Dojo DB.
 *
 * Resolves the canonical "DB owner" person and pulls their emails + phone
 * from `person_identifiers`. Writes a portable JSON shape the customer-side
 * `lib/identity.js` can load directly (plus a few helpful metadata fields).
 *
 * Owner resolution (in order):
 *   1. `users` row where `id = 1` (oldest user = first created) — ignored if
 *      zero rows or no matching person.
 *   2. The people row with the highest `interaction_count` whose identifiers
 *      overlap the `users.email` values. Picks the canonical person over
 *      email-as-display-name fragments.
 *   3. Falls back to the highest-interaction person identified by the
 *      `accounts` table (type='email', vendor='google', status active/connected).
 *
 * If none of the above resolves, the script prints a helpful error
 * directing the user to copy `identity.example.json` and fill it in manually.
 *
 * Usage:
 *   node scripts/export-identity.js --from ~/.robotdojo/robotdojo.db \
 *                                   --to   ~/.robotdojo/identity.json
 *
 * Output matches lib/identity.js expectations plus extra fields the customer
 * install uses for user-friendly greetings / timezone defaults:
 *   {
 *     "name": "...",                  // display_name
 *     "primary_email": "...",
 *     "emails": ["...", ...],         // canonical set — what lib/identity.js reads
 *     "phone": "+1-...",              // normalized E.164-ish if available
 *     "owner_person_id": "uuid",      // what lib/identity.js reads
 *     "display_name_match": "...",    // lowercased — legacy LIKE match
 *     "timezone": "America/New_York", // defaultable; customer edits locally
 *     "location": null,               // left null — never inferred
 *     "_meta": { version, exported_at, source_db }
 *   }
 *
 * Exit codes:
 *   0 — success
 *   1 — source DB missing, unresolvable owner, or write failure
 */

import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

// --- Args -----------------------------------------------------------------

function parseArgs(argv) {
  const out = { from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return resolve(p);
}

function usage() {
  console.info('Usage: node scripts/export-identity.js --from <src.db> --to <dest.json>');
  console.info('');
  console.info('Resolves DB owner person + identifiers and writes identity.json.');
  console.info('Source DB is opened read-only.');
}

// --- Helpful error message -----------------------------------------------

function printManualFallbackHelp(destPath) {
  console.error('');
  console.error('[export-identity] could not determine the DB owner automatically.');
  console.error('');
  console.error('Copy identity.example.json to ~/.robotdojo/identity.json and fill it in manually:');
  console.error('');
  console.error('  cp ~/robotdojo/agents.example.json ' + destPath);
  console.error(`  $EDITOR ${destPath}`);
  console.error('');
  console.error('Minimum required fields: emails[], owner_person_id.');
}

// --- Owner resolution -----------------------------------------------------

/** Normalize phone to a compact E.164-ish string. Returns null on empty. */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  // If already E.164, pass through.
  if (digits.startsWith('+')) return digits;
  // 10-digit US — prepend +1.
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return digits;
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return Boolean(row);
}

function collectOwnerEmailHints(db) {
  const hints = new Set();

  if (tableExists(db, 'users')) {
    const row = db
      .prepare('SELECT email FROM users WHERE id = 1')
      .get();
    if (row && row.email) hints.add(String(row.email).toLowerCase());
    // Also any rows at all — oldest first.
    const all = db
      .prepare('SELECT email FROM users ORDER BY created_at ASC')
      .all();
    for (const r of all) if (r.email) hints.add(String(r.email).toLowerCase());
  }

  if (tableExists(db, 'accounts')) {
    const rows = db
      .prepare(
        `SELECT email FROM accounts
         WHERE type='email' AND status IN ('active', 'connected') AND email IS NOT NULL AND email != ''`,
      )
      .all();
    for (const r of rows) hints.add(String(r.email).toLowerCase());
  }

  return [...hints];
}

/**
 * Given a set of candidate emails, find the people row best matching an
 * "owner". Strategy: each email links to a person_identifiers row; pick the
 * person with the highest interaction_count among those. Tie-break by
 * non-empty short_name, then by id string.
 */
function resolveOwnerByEmails(db, emailHints) {
  if (emailHints.length === 0) return null;
  const placeholders = emailHints.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT p.id, p.display_name, p.short_name, p.interaction_count
       FROM people p
       JOIN person_identifiers pi ON pi.person_id = p.id
       WHERE pi.type = 'email' AND lower(pi.value) IN (${placeholders})`,
    )
    .all(...emailHints.map((e) => e.toLowerCase()));
  if (rows.length === 0) return null;
  rows.sort((a, b) => {
    if ((b.interaction_count || 0) !== (a.interaction_count || 0)) {
      return (b.interaction_count || 0) - (a.interaction_count || 0);
    }
    const aHas = a.short_name ? 1 : 0;
    const bHas = b.short_name ? 1 : 0;
    if (bHas !== aHas) return bHas - aHas;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows[0];
}

function collectIdentifiersForPerson(db, personId) {
  const rows = db
    .prepare(
      `SELECT type, value, is_primary
       FROM person_identifiers
       WHERE person_id = ?
       ORDER BY is_primary DESC, type, value`,
    )
    .all(personId);
  const emails = [];
  const phones = [];
  let primaryEmail = null;
  let primaryPhone = null;
  const seenEmail = new Set();
  const seenPhone = new Set();
  for (const r of rows) {
    if (r.type === 'email' && r.value) {
      const v = String(r.value).trim().toLowerCase();
      if (v && !seenEmail.has(v)) {
        seenEmail.add(v);
        emails.push(v);
        if (!primaryEmail && r.is_primary) primaryEmail = v;
      }
    } else if (r.type === 'phone' && r.value) {
      const p = normalizePhone(r.value);
      if (p && !seenPhone.has(p)) {
        seenPhone.add(p);
        phones.push(p);
        if (!primaryPhone && r.is_primary) primaryPhone = p;
      }
    }
  }
  if (!primaryEmail && emails.length) primaryEmail = emails[0];
  if (!primaryPhone && phones.length) primaryPhone = phones[0];
  return { emails, phones, primaryEmail, primaryPhone, seenEmail, seenPhone };
}

/**
 * Union authoritative owner emails from the `accounts` table (active email
 * accounts the user themselves authenticated). Dev DBs often have
 * the canonical person row fragmented across dedup clusters — the
 * maintainer's dojo is a good example — so `person_identifiers` alone
 * undercounts owner emails. The `accounts` table is where the user has
 * *themselves* authenticated, so it's the strongest owner-email signal
 * in the DB.
 */
function unionAccountEmails(db, ids) {
  if (!tableExists(db, 'accounts')) return;
  const rows = db
    .prepare(
      `SELECT email FROM accounts
       WHERE type='email'
         AND email IS NOT NULL
         AND email != ''
         AND status != 'disabled'`,
    )
    .all();
  for (const r of rows) {
    const v = String(r.email).trim().toLowerCase();
    if (!v || ids.seenEmail.has(v)) continue;
    ids.seenEmail.add(v);
    ids.emails.push(v);
  }
  // Also sweep the `users` table — the DB-owner username email is canonical.
  if (tableExists(db, 'users')) {
    const userRows = db.prepare('SELECT email FROM users').all();
    for (const r of userRows) {
      if (!r.email) continue;
      const v = String(r.email).trim().toLowerCase();
      if (!v || ids.seenEmail.has(v)) continue;
      ids.seenEmail.add(v);
      ids.emails.push(v);
    }
  }
}

// --- Main -----------------------------------------------------------------

function exportIdentity(sourcePath) {
  if (!existsSync(sourcePath)) {
    throw new Error(`source DB not found: ${sourcePath}`);
  }

  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    // Sanity: people + person_identifiers must exist.
    if (!tableExists(db, 'people') || !tableExists(db, 'person_identifiers')) {
      throw new Error('source DB missing people/person_identifiers — not a Miyagi DB?');
    }

    const hints = collectOwnerEmailHints(db);

    let owner = resolveOwnerByEmails(db, hints);

    // Final fallback: take the highest-interaction verified person. Never
    // "invent" an owner silently; we only use this if there's clear signal.
    if (!owner) {
      const fallback = db
        .prepare(
          `SELECT id, display_name, short_name, interaction_count
           FROM people
           WHERE verified = 1
           ORDER BY interaction_count DESC
           LIMIT 1`,
        )
        .get();
      if (fallback && fallback.interaction_count > 1000) {
        owner = fallback;
      }
    }

    if (!owner) {
      return { owner: null };
    }

    const ids = collectIdentifiersForPerson(db, owner.id);
    // Union owner-authored emails from accounts/users tables — in dev DBs the
    // canonical person row is often missing work/alt emails that show up in
    // authenticated accounts. This is the strongest owner-email signal.
    unionAccountEmails(db, ids);
    if (!ids.primaryEmail && ids.emails.length) ids.primaryEmail = ids.emails[0];

    if (ids.emails.length === 0) {
      // Empty identifiers means we can't build a useful identity.json.
      return { owner: null, reason: 'no emails linked to resolved owner' };
    }

    return { owner, ids };
  } finally {
    db.close();
  }
}

function buildOutput({ owner, ids, sourcePath, existing = {} }) {
  // df_cbd30a5a — DECLARATION WINS OVER DERIVATION. When identity.json already
  // carries a declared-owner block (installer / @miyagi wrote name +
  // owner_person_id + emails through lib/identity.js writeDeclaredOwner),
  // export-identity is GAP-FILL ONLY: it must never overwrite the declared
  // name, owner_person_id, or emails. It may only fill derived extras
  // (timezone, primary_email, phone, location) when absent. This reconciles the
  // circular identity Tantei found: the owner is declared, not derived, so a
  // graph re-resolution can never rename the owner or re-point the anchor.
  const declared = existing && existing.declared === true
    && existing.name && Array.isArray(existing.emails) && existing.emails.length >= 1;

  const derivedName = owner.display_name || '';
  const name = declared ? existing.name : derivedName;
  const owner_person_id = declared ? existing.owner_person_id : owner.id;
  const emails = declared ? existing.emails : ids.emails;

  const out = {
    ...existing,
    name,
    // Gap-fill: keep an existing primary_email; else the derived one.
    primary_email: existing.primary_email || ids.primaryEmail,
    emails,
    phone: existing.phone || ids.primaryPhone,
    owner_person_id,
    display_name_match: (name || '').toLowerCase(),
    // Customer-editable — we default to ET (maintainer's TZ as a
    // dev hint), but the customer-side install flow prompts to confirm.
    // Never hardcode location.
    timezone: existing.timezone || 'America/New_York',
    location: existing.location || null,
    _meta: {
      version: '1.0',
      exported_at: new Date().toISOString().split('T')[0],
      source_db: sourcePath,
    },
  };
  if (declared) out.declared = true;
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.from || !args.to) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const fromPath = expandHome(args.from);
  const toPath = expandHome(args.to);

  let result;
  try {
    result = exportIdentity(fromPath);
  } catch (err) {
    console.error(`[export-identity] FAILED: ${err.message}`);
    printManualFallbackHelp(toPath);
    process.exit(1);
  }

  if (!result.owner) {
    console.error('[export-identity] could not resolve DB owner.');
    if (result.reason) console.error(`[export-identity] reason: ${result.reason}`);
    printManualFallbackHelp(toPath);
    process.exit(1);
  }

  // Preserve the whole prior identity.json on a re-run — never clobber manual
  // customizations, and (df_cbd30a5a) never overwrite a declared-owner block.
  let existing = {};
  if (existsSync(toPath)) {
    try {
      existing = JSON.parse(readFileSync(toPath, 'utf8')) || {};
    } catch {
      // ignore malformed prior file
    }
  }

  const output = buildOutput({
    owner: result.owner,
    ids: result.ids,
    sourcePath: fromPath,
    existing,
  });

  try {
    mkdirSync(dirname(toPath), { recursive: true, mode: 0o700 });
    writeFileSync(toPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error(`[export-identity] failed to write ${toPath}: ${err.message}`);
    process.exit(1);
  }

  const { size } = statSync(toPath);
  console.info(`[export-identity] wrote ${toPath} (${size} bytes)`);
  console.info(`[export-identity] owner_person_id=${output.owner_person_id} emails=${output.emails.length} phone=${output.phone ? 'yes' : 'no'}`);
}

main();
