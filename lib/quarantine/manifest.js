/**
 * manifest.js — JSONL append-only writer for quarantine decisions.
 *
 * WHY append-only JSONL: the manifest is a forensic record of every classifier
 * decision. Mutating prior entries would erase history; rewriting the file
 * would lose order. JSONL lets us tail/grep/query without parsing the whole
 * thing, and rotations (if ever needed) become file-level.
 *
 * One line per processed file. Schema enforced by scripts/check-manifest-schema.js.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const REQUIRED_FIELDS = Object.freeze([
  'file', 'what_it_is', 'intent', 'action', 'destination',
  'confidence', 'tier', 'signals', 'reason', 'warnings', 'ts',
]);

/**
 * appendEntry — writes one JSON line. Coerces missing optional fields to
 * defaults so the manifest schema check always passes.
 */
export function appendEntry(manifestPath, entry) {
  if (!manifestPath) throw new Error('manifest path required');
  if (!entry || typeof entry !== 'object') throw new Error('entry must be object');

  const line = {
    file:        entry.file || '',
    what_it_is:  entry.what_it_is || '',
    intent:      entry.intent || '',
    action:      entry.action || '',
    destination: entry.destination || '',
    confidence:  typeof entry.confidence === 'number' ? entry.confidence : 0,
    tier:        entry.tier || 'unknown',
    signals:     Array.isArray(entry.signals) ? entry.signals : [],
    reason:      entry.reason || '',
    warnings:    Array.isArray(entry.warnings) ? entry.warnings : [],
    ts:          entry.ts || new Date().toISOString(),
  };

  // Pass through any extra fields (e.g. fallback_reason) without dropping them.
  for (const k of Object.keys(entry)) {
    if (!(k in line)) line[k] = entry[k];
  }

  mkdirSync(dirname(manifestPath), { recursive: true });
  appendFileSync(manifestPath, JSON.stringify(line) + '\n', 'utf8');
  return line;
}

/**
 * readEntries — reads JSONL into an array. Empty file → []. Missing file → [].
 */
export function readEntries(manifestPath) {
  if (!existsSync(manifestPath)) return [];
  const raw = readFileSync(manifestPath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (err) {
      throw new Error(`manifest ${manifestPath} line ${i + 1} malformed: ${err.message}`);
    }
  });
}

/**
 * truncate — for tests. Resets the manifest to empty.
 */
export function truncate(manifestPath) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, '', 'utf8');
}
