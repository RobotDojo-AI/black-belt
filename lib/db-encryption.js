/**
 * At-rest encryption for the Robot Dojo SQLite DB.
 *
 * Every user's DB is encrypted. The key lives in the macOS Keychain
 * (service `robotdojo-LOCAL_DB_KEY`, account = current user). On first boot
 * the key is generated and stored; on every subsequent boot it is read
 * back and handed to the encrypted SQLite binding.
 *
 * The binding is `better-sqlite3-multiple-ciphers`, a fork of
 * `better-sqlite3` that adds SQLCipher-4 support. It is a drop-in
 * replacement — same sync API, same prepared statements — so `lib/db.js`
 * changes only where the binding is imported.
 *
 * Why not `@journeyapps/sqlcipher`? It is a fork of `node-sqlite3`
 * (async, callback-based) and is NOT API-compatible with
 * `better-sqlite3`. Swapping it in would require rewriting every
 * `db.prepare().run()` call site to async. That is the wrong tradeoff.
 *
 * Threat model
 *   - Laptop stolen / disk imaged cold: DB file useless without Keychain.
 *   - Cloud-sync accident (iCloud Drive, Time Machine to a network
 *     volume): Keychain does not sync to iCloud by default, so the DB
 *     travels with its owner.
 *   - Malware at user-level: equivalent to any home-dir secret. Out of
 *     scope (accepted per the product's threat model).
 *
 * See docs/encryption-at-rest.md for the full matrix.
 */

import { readFileSync, renameSync } from 'node:fs';
import crypto from 'node:crypto';
import { readKeychainSecret, writeKeychainSecret } from './keychain.js';

const KEYCHAIN_SERVICE = 'robotdojo-LOCAL_DB_KEY';

/**
 * Read the local DB key from macOS Keychain. Returns hex (64 chars) or
 * null if unset. Env override wins for CI/test environments where the
 * Keychain is unreachable.
 */
export function readKey() {
  if (process.env.ROBOTDOJO_LOCAL_DB_KEY) {
    return normaliseKey(process.env.ROBOTDOJO_LOCAL_DB_KEY);
  }
  try {
    const v = readKeychainSecret(KEYCHAIN_SERVICE);
    return v ? normaliseKey(v) : null;
  } catch {
    return null;
  }
}

/**
 * Write the local DB key to macOS Keychain. Overwrites silently if
 * present. The caller is responsible for ensuring the key is fresh
 * (see `loadOrGenerateLocalKey`).
 */
export function writeKey(keyHex) {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) {
    throw new Error('writeKey: expected 32-byte hex key');
  }
  if (!writeKeychainSecret(KEYCHAIN_SERVICE, keyHex)) throw new Error('writeKey: Keychain write failed');
}

/**
 * Ensure a DB key exists. Reads from Keychain first; generates + stores
 * a fresh 32-byte key if none is present. Returns the key as hex.
 *
 * Idempotent: safe to call on every boot.
 */
export function loadOrGenerateLocalKey({ allowGenerate = true } = {}) {
  const existing = readKey();
  if (existing) return existing;
  if (!allowGenerate) {
    throw new Error('Local DB key unavailable; refusing to generate a replacement key for an existing encrypted database.');
  }
  if (process.env.NODE_TEST_CONTEXT) {
    const testKey = '0'.repeat(64);
    process.env.ROBOTDOJO_LOCAL_DB_KEY = testKey;
    return testKey;
  }
  const keyHex = crypto.randomBytes(32).toString('hex');
  writeKey(keyHex);
  return keyHex;
}

/**
 * Apply the SQLCipher pragmas that unlock an encrypted DB. Callers should
 * use this immediately after opening the connection and before any other
 * pragma / DDL / query.
 *
 * `better-sqlite3-multiple-ciphers` accepts `PRAGMA key = "x'<hex>'"`
 * (raw key) and `PRAGMA cipher = 'sqlcipher'` (compat layout).
 */
export function applyKeyPragma(db, keyHex) {
  db.pragma(`cipher = 'sqlcipher'`);
  db.pragma(`key = "x'${keyHex}'"`);
}

/**
 * Detect whether the DB at `dbPath` is a plaintext SQLite file.
 *
 * SQLCipher DBs have encrypted headers, while plaintext SQLite DBs start with
 * the fixed `SQLite format 3\0` magic string. Checking the header avoids
 * opening an encrypted DB with the plain SQLite driver, which can hang under
 * launchd/TCC on macOS.
 */
export async function isPlaintext(dbPath) {
  try {
    const header = readFileSync(dbPath, { encoding: null, flag: 'r' }).subarray(0, 16);
    return header.equals(Buffer.from('SQLite format 3\0', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Migrate an unencrypted DB into an encrypted one using
 * `sqlcipher_export`. Writes to a `.encrypted.tmp` file, then renames
 * over the original atomically. Safe to run more than once: if the
 * source is already encrypted the function no-ops.
 *
 * Callers: `lib/db.js` at boot, when it detects a plaintext DB and has
 * a Keychain key in hand.
 */
export async function migrateToEncrypted(dbPath, keyHex) {
  if (!/^[0-9a-f]{64}$/.test(keyHex || '')) {
    throw new Error('migrateToEncrypted: hex key required');
  }

  if (!(await isPlaintext(dbPath))) {
    return { migrated: false, reason: 'already-encrypted' };
  }

  const { default: Plain } = await import('better-sqlite3');
  const src = new Plain(dbPath);
  const tmp = `${dbPath}.encrypted.tmp`;

  try {
    // sqlcipher_export is provided by the SQLCipher-linked binding. We
    // load a fresh encrypted handle for the destination, attach it into
    // the plaintext source via the ATTACH ... KEY clause, and stream.
    const Encrypted = await import('better-sqlite3-multiple-ciphers')
      .then(m => m.default).catch(() => null);
    if (!Encrypted) {
      throw new Error('better-sqlite3-multiple-ciphers not installed');
    }

    // ATTACH uses SQLCipher's page-copy path even when the source is
    // plain — because `sqlcipher_export` is a SQLCipher-only function,
    // the source must be opened with the ciphered binding. We reopen
    // the plaintext file with the ciphered binding (no key = plaintext)
    // and attach the encrypted tmp.
    src.close();
    const ciphered = new Encrypted(dbPath);
    ciphered.prepare(`ATTACH DATABASE '${tmp}' AS encrypted KEY "x'${keyHex}'"`).run();
    ciphered.prepare(`SELECT sqlcipher_export('encrypted')`).get();
    ciphered.prepare(`DETACH DATABASE encrypted`).run();
    ciphered.close();

    renameSync(tmp, dbPath);
    return { migrated: true, path: dbPath };
  } catch (err) {
    try { src.close(); } catch {}
    throw err;
  }
}

/**
 * Reverse of migrateToEncrypted. Used when a user wants an exportable
 * plaintext copy, or during a downgrade test. Production flow does not
 * call this; the DB stays encrypted for the life of the install.
 */
export async function migrateToPlaintext(dbPath, keyHex) {
  if (!/^[0-9a-f]{64}$/.test(keyHex || '')) {
    throw new Error('migrateToPlaintext: hex key required');
  }
  const Encrypted = await import('better-sqlite3-multiple-ciphers')
    .then(m => m.default).catch(() => null);
  if (!Encrypted) {
    throw new Error('better-sqlite3-multiple-ciphers not installed');
  }

  const db = new Encrypted(dbPath);
  applyKeyPragma(db, keyHex);

  const tmp = `${dbPath}.plain.tmp`;
  db.prepare(`ATTACH DATABASE '${tmp}' AS plaintext KEY ''`).run();
  db.prepare(`SELECT sqlcipher_export('plaintext')`).get();
  db.prepare(`DETACH DATABASE plaintext`).run();
  db.close();

  renameSync(tmp, dbPath);
  return { migrated: true, path: dbPath };
}

/**
 * Normalise a key input. Accepts hex (64 chars), base64 (44 chars incl.
 * padding, or 43 unpadded), or raw bytes. Returns 64-char hex.
 */
function normaliseKey(value) {
  const v = String(value).trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  if (/^[0-9a-f]{64}=*$/i.test(v)) return v.replace(/=+$/, '').toLowerCase();
  // base64 → hex (best effort)
  try {
    const buf = Buffer.from(v, 'base64');
    if (buf.length === 32) return buf.toString('hex');
  } catch {}
  throw new Error('normaliseKey: key must be 32 bytes (hex or base64)');
}
