/**
 * Contacts Extractor — reads Mac AddressBook SQLite database.
 * Signal #1: hand-disambiguated by the user. Highest trust source.
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolvePerson, normalizePhone, normalizeEmail } from './entity-resolve.js';

/**
 * Normalize Apple Contacts relationship labels.
 * Apple stores them as _$!<Label>!$_ format or plain text.
 */
function normalizeContactLabel(raw) {
  if (!raw) return null;
  // Strip Apple's _$!<...>!$_ wrapper
  const match = raw.match(/_\$!<(.+?)>!\$_/);
  const label = (match ? match[1] : raw).toLowerCase().trim();
  // Common contact names: Mom, Dad, etc. → relationship labels
  const MAP = {
    spouse: 'spouse', wife: 'spouse', husband: 'spouse', partner: 'spouse',
    mother: 'parent', father: 'parent', mom: 'parent', dad: 'parent', parent: 'parent',
    brother: 'sibling', sister: 'sibling', sibling: 'sibling',
    son: 'child', daughter: 'child', child: 'child',
    'mother-in-law': 'parent-in-law', 'father-in-law': 'parent-in-law',
    'brother-in-law': 'sibling-in-law', 'sister-in-law': 'sibling-in-law',
    aunt: 'aunt-uncle', uncle: 'aunt-uncle',
    cousin: 'cousin', niece: 'niece-nephew', nephew: 'niece-nephew',
    grandmother: 'grandparent', grandfather: 'grandparent', grandparent: 'grandparent',
    friend: 'friend',
  };
  return MAP[label] || label;
}

/**
 * Find the AddressBook SQLite database path.
 * Returns null if not found (graceful degradation).
 */
function findAddressBookPath() {
  const home = homedir();
  const sourcesDir = resolve(home, 'Library/Application Support/AddressBook/Sources');

  // Check Sources/*/AddressBook-v22.abcddb (modern macOS)
  if (existsSync(sourcesDir)) {
    try {
      const sources = readdirSync(sourcesDir);
      for (const src of sources) {
        const dbPath = resolve(sourcesDir, src, 'AddressBook-v22.abcddb');
        if (existsSync(dbPath)) return dbPath;
      }
    } catch (err) {
      console.warn(`[contacts] failed reading Sources dir: ${err.message}`);
    }
  }

  // Fallback: direct path (older macOS)
  const direct = resolve(home, 'Library/Application Support/AddressBook/AddressBook-v22.abcddb');
  if (existsSync(direct)) return direct;

  return null;
}

/**
 * Extract all contacts from Mac AddressBook database.
 * @returns {Array<{ name: string, emails: string[], phones: string[], organization: string|null, note: string|null }>}
 */
export function extractContacts() {
  const dbPath = findAddressBookPath();
  if (!dbPath) {
    console.warn('[contacts] AddressBook database not found — returning empty');
    return [];
  }

  let abDb;
  try {
    abDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.warn(`[contacts] failed to open AddressBook: ${err.message}`);
    return [];
  }

  try {
    // Get all person records
    const records = abDb.prepare(`
      SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZNOTE
      FROM ZABCDRECORD
      WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL
    `).all();

    // Build email and phone lookups keyed by owner Z_PK
    const emailRows = abDb.prepare(`
      SELECT ZOWNER, ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL
    `).all();

    const phoneRows = abDb.prepare(`
      SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL
    `).all();

    // Relationship labels (spouse, parent, child, sibling, Mom, Dad, etc.)
    let relationRows = [];
    try {
      relationRows = abDb.prepare(`
        SELECT ZOWNER, ZNAME, ZLABEL FROM ZABCDRELATEDNAME WHERE ZNAME IS NOT NULL
      `).all();
    } catch { /* table may not exist in older macOS */ }
    const relationsByOwner = new Map();
    for (const row of relationRows) {
      if (!relationsByOwner.has(row.ZOWNER)) relationsByOwner.set(row.ZOWNER, []);
      relationsByOwner.get(row.ZOWNER).push({
        name: row.ZNAME?.trim() || null,
        label: normalizeContactLabel(row.ZLABEL),
      });
    }

    const emailsByOwner = new Map();
    for (const row of emailRows) {
      const norm = normalizeEmail(row.ZADDRESS);
      if (!norm) continue;
      if (!emailsByOwner.has(row.ZOWNER)) emailsByOwner.set(row.ZOWNER, []);
      emailsByOwner.get(row.ZOWNER).push(norm);
    }

    const phonesByOwner = new Map();
    for (const row of phoneRows) {
      const norm = normalizePhone(row.ZFULLNUMBER);
      if (!norm) continue;
      if (!phonesByOwner.has(row.ZOWNER)) phonesByOwner.set(row.ZOWNER, []);
      phonesByOwner.get(row.ZOWNER).push(norm);
    }

    const contacts = [];
    for (const rec of records) {
      const first = rec.ZFIRSTNAME?.trim() || '';
      const last = rec.ZLASTNAME?.trim() || '';
      const name = [first, last].filter(Boolean).join(' ');
      const emails = emailsByOwner.get(rec.Z_PK) || [];
      const phones = phonesByOwner.get(rec.Z_PK) || [];

      // Skip records with no name AND no email
      if (!name && emails.length === 0) continue;

      contacts.push({
        name: name || null,
        emails,
        phones,
        organization: typeof rec.ZORGANIZATION === 'string' ? rec.ZORGANIZATION.trim() : null,
        note: typeof rec.ZNOTE === 'string' ? rec.ZNOTE.trim() : (rec.ZNOTE ? String(rec.ZNOTE) : null),
        relations: relationsByOwner.get(rec.Z_PK) || [],
      });
    }

    console.info(`[contacts] extracted ${contacts.length} contacts from AddressBook`);
    return contacts;
  } finally {
    abDb.close();
  }
}

/**
 * Ingest contacts into the people graph via person-resolver.
 * @returns {{ total: number, created: number, matched: number, skipped: number }}
 */
export function ingestContacts() {
  const contacts = extractContacts();
  const stats = { total: contacts.length, created: 0, matched: 0, skipped: 0 };

  for (const contact of contacts) {
    try {
      // Resolve once per email (primary first), or by name+phone if no email
      if (contact.emails.length > 0) {
        const result = resolvePerson({
          name: contact.name,
          email: contact.emails[0],
          phone: contact.phones[0] || null,
          source: 'contacts',
        });

        if (result.created) stats.created++;
        else stats.matched++;

        // Add additional emails/phones as identifiers
        // person-resolver handles INSERT OR IGNORE
        for (let i = 1; i < contact.emails.length; i++) {
          resolvePerson({ name: contact.name, email: contact.emails[i], source: 'contacts' });
        }
      } else if (contact.name) {
        const result = resolvePerson({
          name: contact.name,
          phone: contact.phones[0] || null,
          source: 'contacts',
        });
        if (result.created) stats.created++;
        else stats.matched++;
      } else {
        stats.skipped++;
      }
    } catch (err) {
      console.error(`[contacts] failed to resolve ${contact.name || contact.emails[0]}: ${err.message}`);
      stats.skipped++;
    }
  }

  console.info(`[contacts] ingested: ${stats.total} total, ${stats.created} created, ${stats.matched} matched, ${stats.skipped} skipped`);
  return stats;
}
