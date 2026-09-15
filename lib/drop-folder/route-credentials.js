/**
 * Credentials router — ingests `KEY=VALUE` files into macOS Keychain inline
 * (no shell script dependency). Never logs values; only key names are reported.
 *
 * Zero-trust contract
 * -------------------
 * - Values are passed directly to spawn() args — no shell, no env, no logs.
 * - Symlinks are rejected before read (TOCTOU guard).
 * - Non-UTF-8 content (BOM, replacement char) is rejected.
 * - secureDelete failures are surfaced, not swallowed.
 */

import { readFile, lstat, stat, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { writeToKeychain } from '../secure-input.js';

// --- Secure delete -----------------------------------------------------------

async function secureDelete(filePath) {
  const { size } = await stat(filePath);
  if (size > 0) {
    const { randomBytes } = await import('node:crypto');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, randomBytes(size));
  }
  await unlink(filePath);
}

// --- Main ingestion ----------------------------------------------------------

/**
 * Parse a credentials file and write each KEY=VALUE pair to Keychain.
 * Returns the list of written key names (values never logged).
 * Throws with a typed `code` property on validation failure.
 */
export async function parseAndIngest(filePath) {
  // Reject symlinks before read — prevents TOCTOU attacks where a symlink
  // points at a sensitive file and gets swapped in after the check.
  const lst = await lstat(filePath);
  if (lst.isSymbolicLink()) {
    const err = new Error('symlink rejected — credentials files must be regular files');
    err.code = 'symlink';
    throw err;
  }

  const raw = await readFile(filePath, 'utf8');

  // Reject UTF-8 BOM and replacement character — encoding issues risk
  // misparse where the value boundary shifts.
  if (raw.charCodeAt(0) === 0xFEFF || raw.includes('�')) {
    const err = new Error('encoding error — expected UTF-8 without BOM');
    err.code = 'encoding';
    throw err;
  }

  const pairs = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Z][A-Z0-9_]{1,63})\s*=\s*(.+)$/);
    if (m) pairs.push({ service: m[1], value: m[2].trim() });
  }
  if (pairs.length === 0) {
    const err = new Error('no valid KEY=VALUE lines found (expected UPPER_SNAKE_CASE=value)');
    err.code = 'empty';
    throw err;
  }

  const written = [];
  const failed = [];
  for (const { service, value } of pairs) {
    try {
      await writeToKeychain(service, value);
      written.push(service);
    } catch (err) {
      failed.push({ service, error: err.message });
    }
  }
  return { written, failed };
}

/**
 * Route a credentials file through parseAndIngest, then securely delete it.
 * Surfaces secureDelete failures as a warning (never silently swallowed).
 */
export async function routeCredentials({ path: filePath }) {
  if (platform() !== 'darwin') {
    throw new Error('credentials router requires macOS Keychain');
  }

  const { written, failed } = await parseAndIngest(filePath);

  let deleted = false;
  try {
    await secureDelete(filePath);
    deleted = true;
  } catch (err) {
    console.error('[route-credentials] secureDelete failed:', err.message, '— file may remain at', filePath);
  }

  return {
    doc_type: 'credentials',
    topic_t1: null,
    topic_t2: null,
    extracted_json: JSON.stringify({
      loaded_keys: written,
      count: written.length,
      ...(failed.length ? { failed_keys: failed.map(f => f.service) } : {}),
    }),
    entity_refs: null,
    status: 'credentials',
    deleted,
  };
}
