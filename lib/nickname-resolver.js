/**
 * Nickname + surname-rarity resolver for st_87a0d072.
 *
 * Two purposes:
 *   1. areNicknamesEquivalent(a, b) — true iff a and b are known nickname
 *      pairs (Andrew ↔ Andy, Bob ↔ Robert). Source: carltonnorthern/nicknames
 *      `name1,relationship,name2` CSV (canonical → nickname directional).
 *      We treat it as bidirectional: matching either direction returns true.
 *
 *   2. isSurnameRare(surname) — true iff the surname is OUTSIDE the top 25,000
 *      surnames from the 2010 US Census (mirrored by FiveThirtyEight). Used as
 *      the Phase 2 merge gate so common surnames (Patel, Nguyen, Smith) never
 *      trigger nickname-equivalent merges.
 *
 * Data sources (downloaded once into config/, checked in):
 *   - config/nicknames.json         carltonnorthern/nicknames v1.0.1
 *     https://raw.githubusercontent.com/carltonnorthern/nicknames/master/names.csv
 *     Transformed at download time into a bidirectional JSON map
 *     { canonical_or_nickname: [equivalents...] } via scripts/setup/download-network-libs.sh.
 *   - config/surnames-top-25K.json  Trimmed 2010 Census via FiveThirtyEight
 *     https://raw.githubusercontent.com/fivethirtyeight/data/master/most-common-name/surnames.csv
 *
 * WHY top 25K not top 10K: Hakase's research showed Patel (rank ~172),
 * Nguyen (~147), Garcia (~8) are all common; 25K is the cutoff where surname
 * uniqueness becomes a reliable identity signal across the US population.
 *
 * WHY bidirectional nickname lookup: the CSV is canonical→nickname (one
 * direction). `andy → andrew` is asymmetric in the source. To answer "are
 * Andy and Andrew equivalent" we union both directions into one Map<name,Set>.
 *
 * Known limitation (per Hakase): carltonnorthern is biased toward
 * traditionally African American + Anglo names. Non-Western nicknames are
 * absent. The merge gate stays safe — false negatives (missing a merge)
 * are recoverable; false positives are not.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const NICKNAMES_JSON = resolve(__dirname, '..', 'config', 'nicknames.json');
const SURNAMES_JSON  = resolve(__dirname, '..', 'config', 'surnames-top-25K.json');

let _nicknameMap = null;
let _surnameRanks = null;

/**
 * Load the pre-built bidirectional nickname map: { name: [equivalents...] }.
 * Cached after first call.
 *
 * The source CSV (carltonnorthern/nicknames `name1,has_nickname,name2`) is
 * directional. We pre-process it at download time (download-network-libs.sh)
 * into a JSON map where each name keys to its full equivalence set, so the
 * runtime lookup is O(1).
 */
function loadNicknameMap() {
  if (_nicknameMap) return _nicknameMap;
  const map = new Map();
  try {
    const raw = JSON.parse(readFileSync(NICKNAMES_JSON, 'utf8'));
    for (const [k, arr] of Object.entries(raw)) {
      map.set(k.toLowerCase(), new Set(arr.map(s => s.toLowerCase())));
    }
  } catch (err) {
    // Missing JSON is a soft failure — return empty map. The merge gate
    // will simply never approve nickname equivalences, but the rest of
    // the pipeline keeps working.
    console.warn(`[nickname-resolver] could not load ${NICKNAMES_JSON}: ${err.message}`);
  }
  _nicknameMap = map;
  return map;
}

/**
 * Load the surname rank lookup. JSON shape: { surname: rank }.
 * Cached after first call.
 */
function loadSurnameRanks() {
  if (_surnameRanks) return _surnameRanks;
  try {
    _surnameRanks = JSON.parse(readFileSync(SURNAMES_JSON, 'utf8'));
  } catch (err) {
    console.warn(`[nickname-resolver] could not load ${SURNAMES_JSON}: ${err.message}`);
    _surnameRanks = {};
  }
  return _surnameRanks;
}

/**
 * Are two first names known nickname equivalents?
 *
 * Examples:
 *   areNicknamesEquivalent('andrew', 'andy') → true
 *   areNicknamesEquivalent('andy', 'andrew') → true
 *   areNicknamesEquivalent('andrew', 'matthew') → false
 *   areNicknamesEquivalent('andrew', 'andrew') → true (identical)
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function areNicknamesEquivalent(a, b) {
  if (!a || !b) return false;
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (!al || !bl) return false;
  if (al === bl) return true;
  const map = loadNicknameMap();
  return map.get(al)?.has(bl) === true;
}

/**
 * Return the known equivalents for a first name, including the input token.
 * Used by search/recognition paths, where nickname matching should affect
 * recall without becoming identity evidence for single-token matches.
 *
 * @param {string} name
 * @returns {string[]}
 */
export function nicknameVariants(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return [];
  const map = loadNicknameMap();
  return [...new Set([n, ...(map.get(n) ? [...map.get(n)] : [])])];
}

/**
 * Is a surname uncommon (rank > 25,000) — i.e., safe to use as an identity
 * signal for the nickname-equivalent merge guard?
 *
 * @param {string} surname (case-insensitive)
 * @returns {boolean} true = uncommon (rank > 25K or absent); false = common
 */
export function isSurnameRare(surname) {
  if (!surname) return false;
  const s = surname.toLowerCase().trim();
  if (!s) return false;
  const ranks = loadSurnameRanks();
  const rank = ranks[s];
  // Absent from the top-25K list → rank effectively infinity → rare.
  // Present with rank ≤ 25K → common.
  return rank === undefined || rank > 25000;
}

/**
 * Test-only helper: reset internal caches so the next call reloads from disk.
 * Used by tests/nickname-resolver.test.js after editing CSV / JSON in setup.
 */
export function _resetCachesForTests() {
  _nicknameMap = null;
  _surnameRanks = null;
}
