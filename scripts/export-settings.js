#!/usr/bin/env node
/**
 * export-settings — port the user_settings key/value table from an old
 * Robot Dojo DB to `~/.robotdojo/user-settings.json`.
 *
 * The customer-side install reads preferences (tone, coaching toggle, theme,
 * timezone, etc.) from this JSON. Identity-shaped keys (emails, names, phone,
 * owner_person_id) are filtered out here — they belong in identity.json and
 * are handled by export-identity.js.
 *
 * Usage:
 *   node scripts/export-settings.js --from ~/.robotdojo/robotdojo.db \
 *                                   --to   ~/.robotdojo/user-settings.json
 *
 * Output:
 *   {
 *     "_meta": {
 *       "version": "1.0",
 *       "exported_at": "2026-04-15",
 *       "source_db": "/abs/path/to/robotdojo.db",
 *       "count": <n>
 *     },
 *     "<key>": <value>,
 *     ...
 *   }
 *
 * Values are JSON-decoded if they look like JSON (object/array/bool/null/
 * number); otherwise kept as strings. Keeps the customer-side consumer
 * simple — no eval, no surprises.
 *
 * Exit codes:
 *   0 — success
 *   1 — source DB missing, schema unexpected, or write failure
 */

import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
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
  console.info('Usage: node scripts/export-settings.js --from <src.db> --to <dest.json>');
  console.info('');
  console.info('Reads user_settings from <src.db>, filters identity keys, writes');
  console.info('a JSON object of preferences to <dest.json>. Source is read-only.');
}

// --- Identity-shaped keys belong in identity.json, not here. --------------

const IDENTITY_KEY_PATTERNS = [
  /^owner[_-]?person[_-]?id$/i,
  /^owner[_-]?email/i,
  /^primary[_-]?email$/i,
  /^email$/i,
  /^emails$/i,
  /^phone$/i,
  /^phones$/i,
  /^display[_-]?name/i,
  /^full[_-]?name$/i,
  /^first[_-]?name$/i,
  /^last[_-]?name$/i,
  /^user[_-]?name$/i,
  /^user[_-]?slug$/i,
  /^location$/i,
  /^address$/i,
  // Secrets must never land in a JSON file.
  /token/i,
  /secret/i,
  /password/i,
  /api[_-]?key/i,
  /auth/i,
  /^oauth/i,
];

function isIdentityKey(key) {
  return IDENTITY_KEY_PATTERNS.some((re) => re.test(key));
}

// --- Value coercion -------------------------------------------------------

/**
 * DB stores everything as TEXT. If a value parses as JSON, return the parsed
 * form; otherwise return the raw string. Empty string stays empty string.
 */
function coerceValue(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  if (s.length === 0) return '';
  const trimmed = s.trim();
  // Cheap prefilter: only try JSON.parse on things that could be JSON.
  const first = trimmed[0];
  const looksJson =
    first === '{' ||
    first === '[' ||
    first === '"' ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d/.test(trimmed);
  if (!looksJson) return s;
  try {
    return JSON.parse(trimmed);
  } catch {
    return s;
  }
}

// --- Schema guard ---------------------------------------------------------

function ensureUserSettingsSchema(db) {
  const rows = db.prepare('PRAGMA table_info(user_settings)').all();
  if (rows.length === 0) {
    throw new Error('source DB has no user_settings table — is this a Miyagi DB?');
  }
  const have = new Set(rows.map((r) => r.name));
  if (!have.has('key') || !have.has('value')) {
    throw new Error('user_settings missing required columns (key, value)');
  }
}

// --- Main -----------------------------------------------------------------

function exportSettings(sourcePath) {
  if (!existsSync(sourcePath)) {
    throw new Error(`source DB not found: ${sourcePath}`);
  }
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    ensureUserSettingsSchema(db);
    const rows = db.prepare('SELECT key, value FROM user_settings ORDER BY key').all();

    const settings = {};
    let kept = 0;
    let dropped = 0;

    for (const { key, value } of rows) {
      if (!key) { dropped++; continue; }
      if (isIdentityKey(key)) { dropped++; continue; }
      settings[key] = coerceValue(value);
      kept++;
    }
    return { settings, kept, dropped, total: rows.length };
  } finally {
    db.close();
  }
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
    result = exportSettings(fromPath);
  } catch (err) {
    console.error(`[export-settings] FAILED: ${err.message}`);
    process.exit(1);
  }

  // Idempotency: reuse prior exported_at if the settings payload is unchanged.
  let previousExportedAt = null;
  if (existsSync(toPath)) {
    try {
      const prev = JSON.parse(readFileSync(toPath, 'utf8'));
      const { _meta: _prevMeta, ...prevSettings } = prev;
      if (JSON.stringify(sortKeys(prevSettings)) === JSON.stringify(sortKeys(result.settings))) {
        previousExportedAt = prev._meta?.exported_at || null;
      }
    } catch {
      // ignore malformed prior file
    }
  }

  const output = {
    _meta: {
      version: '1.0',
      exported_at: previousExportedAt || new Date().toISOString().split('T')[0],
      source_db: fromPath,
      count: result.kept,
    },
    ...sortKeys(result.settings),
  };

  try {
    mkdirSync(dirname(toPath), { recursive: true, mode: 0o700 });
    writeFileSync(toPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error(`[export-settings] failed to write ${toPath}: ${err.message}`);
    process.exit(1);
  }

  const { size } = statSync(toPath);
  console.info(`[export-settings] wrote ${toPath} (${size} bytes)`);
  console.info(`[export-settings] kept ${result.kept} settings, dropped ${result.dropped} identity/secret keys (of ${result.total} total)`);
  if (result.total === 0) {
    console.info('[export-settings] note: user_settings was empty — output contains metadata only.');
  }
}

/** Sort object keys alphabetically for deterministic output. */
function sortKeys(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

main();
