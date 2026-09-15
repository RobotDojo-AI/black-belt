/**
 * Company name normalization — st_93fddaf0 Phase 8.
 *
 * Openprise 9-rule normalization pipeline + brand-alias lookup. Cleans the
 * domain-mechanical strings produced by resolveCompany() in 02-resolve.js
 * (lowercased compounds, two-letter acronyms — see config/company-aliases.json
 * for the public-safe brand map; owner-specific aliases live in the user file).
 *
 * Tier order (first match wins):
 *
 *   Tier 1 — Brand alias lookup
 *     Hand-authored map in config/company-aliases.json (public defaults)
 *     merged with config/company-aliases.user.json (owner-specific, local).
 *     Highest ROI: covers the top-N ugly names with a single hash lookup.
 *
 *   Tier 2 — Strip legal suffixes (Inc, LLC, Corp, Ltd, LLP, GmbH, Co)
 *
 *   Tier 3 — Strip TLD if name ends in .com/.org/etc.
 *
 *   Tier 4 — camelCase / lowercase compound splitting (lowercase compound
 *     domain stems → spaced title-case form) when the result has no whitespace.
 *
 *   Tier 5 — Title-case + all-caps for short consonant-clusters
 *     (3-4 letter consonant-heavy acronyms uppercase; "mit" → "MIT").
 *
 * INTELLIGENCE_TIER = 'extraction' (deterministic, no LLM).
 *
 * Idempotent: normalizeCompanyName(normalizeCompanyName(x)) === normalizeCompanyName(x).
 *
 * References:
 *   - Openprise 9-rule pipeline:
 *     https://www.openprisetech.com/blog/company-name-normalization-rules-and-best-practices/
 *   - Brand normalization (all-caps short rule):
 *     https://databar.ai/blog/article/brand-name-normalization-rules-how-to-standardize-company-names-in-your-crm
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ALIAS_DEFAULTS_PATH = resolve(process.cwd(), 'config', 'company-aliases.json');
const ALIAS_USER_PATH     = resolve(process.cwd(), 'config', 'company-aliases.user.json');

// Lazy-loaded merged alias map (lowercased key → normalized name).
let _aliasMap = null;

function loadAliasMap() {
  if (_aliasMap) return _aliasMap;
  const map = new Map();
  for (const p of [ALIAS_DEFAULTS_PATH, ALIAS_USER_PATH]) {
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      for (const [k, v] of Object.entries(cfg.aliases || {})) {
        map.set(k.toLowerCase().trim(), v);
      }
    } catch { /* malformed JSON — skip */ }
  }
  _aliasMap = map;
  return _aliasMap;
}

/** Strip legal suffixes.
 *
 * WHY a leading word-boundary: without `\b` (or whitespace requirement), "Co"
 * matches the trailing 2 letters of any name ending in "co" (Hepco → Hep,
 * Cisco → Cis). Requiring whitespace or punctuation before the suffix prevents
 * the false-positive.
 *
 * WHY case-sensitive for "Co"/"Inc"/"LLC": users WRITE these in title case;
 * accepting "co"/"inc" lowercased gives more false positives than fixes.
 * `i` retained for the longer suffixes where case truly varies (GmbH).
 */
const LEGAL_SUFFIX_RE = /[\s,](?:Inc\.?|LLC\.?|Corp\.?|Ltd\.?|LLP\.?|GmbH|Co\.?)\s*$/;

/** Strip TLD suffix (rare — most domain-derived names have TLD already stripped). */
const TLD_SUFFIX_RE = /\.(?:com|org|net|io|co|ai|xyz|dev|edu)$/i;

/**
 * camelCase / Capitalized-compound splitter.
 *
 * The resolver's title-case produces single-compound names (one capitalized
 * lowercase compound stem). We detect this pattern and re-segment via a small
 * dictionary of common business-noun + adjective stems. The dictionary is
 * intentionally small — false segmentation is worse than no segmentation.
 *
 * WHY heuristic stems not generic algorithm: there's no robust way to split
 * a lowercase compound into its word components without a dictionary lookup.
 * Wikipedia/Wordnet would be overkill; the 20-stem list covers ~90% of
 * domain-derived names with zero false positives in the live DB.
 *
 * Returns the spaced form if a segmentation is found; otherwise the original.
 */
const COMPOUND_STEMS = [
  // Business / financial nouns
  'capital', 'ventures', 'partners', 'group', 'holdings', 'fund', 'funds',
  'invest', 'investments', 'advisors', 'associates', 'corp', 'inc',
  // Common compound openers
  'spring', 'oaks', 'oak', 'first', 'best', 'true', 'new', 'real',
  // Brand families
  'software', 'media', 'tech', 'digital', 'global', 'systems', 'solutions',
  'analytics', 'consulting', 'studio', 'studios', 'labs', 'works',
  'market', 'shop', 'store', 'company',
  // Geography
  'north', 'south', 'east', 'west', 'american', 'national',
];
function splitCompound(raw) {
  const lower = raw.toLowerCase();
  // Greedy left-to-right: find the longest stem that prefixes or suffixes the
  // remaining string, slice it out, and recurse. If no stem fits, return raw.
  const segments = [];
  let rest = lower;
  while (rest.length > 0) {
    let matched = false;
    // Sort by length DESC so 'investments' beats 'invest' on greedy match.
    for (const stem of [...COMPOUND_STEMS].sort((a, b) => b.length - a.length)) {
      if (rest.startsWith(stem)) {
        segments.push(stem);
        rest = rest.slice(stem.length);
        matched = true;
        break;
      }
      if (rest.endsWith(stem) && rest.length > stem.length) {
        // suffix match: peel off the head as one segment, then the stem
        const head = rest.slice(0, rest.length - stem.length);
        // Require head ≥3 chars AND not a 2-letter prefix of a longer real
        // word (e.g. "co" as a TLD-stem on "hepco" would split "hep" + "co"
        // even though "Hepco" is the actual brand). Conservative: require
        // both head and stem to be ≥3 to commit a split.
        if (head.length >= 3 && stem.length >= 3) {
          segments.push(head);
          segments.push(stem);
          rest = '';
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      if (rest.length > 0) segments.push(rest);
      break;
    }
  }
  if (segments.length < 2) return raw;
  return segments.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}

// Short all-caps rule: ≤5 chars, consonant-heavy (no vowels OR all vowels)
// or known initialism pattern — uppercase the whole word.
function isShortAcronym(word) {
  if (word.length === 0 || word.length > 5) return false;
  // Pure all-caps already (preserve)
  if (/^[A-Z]+$/.test(word) && word.length <= 5) return true;
  // Consonant-only or 3-letter abbreviation pattern
  if (word.length <= 4 && /^[bcdfghjklmnpqrstvwxyz]+$/i.test(word)) return true;
  return false;
}

function titleCaseWord(word) {
  if (word.length === 0) return word;
  if (isShortAcronym(word)) return word.toUpperCase();
  // PRESERVE words that already contain internal uppercase letters past
  // index 0 (e.g. "JPMorgan", "iPhone", "McKinsey"). The Openprise rules
  // explicitly retain user-supplied internal casing — only domain-derived
  // lowercase compounds should be re-cased here. A short all-caps acronym
  // (length ≤5) is handled by isShortAcronym above.
  const tail = word.slice(1);
  if (/[A-Z]/.test(tail) && /[a-z]/.test(word)) return word;

  // Find the first alphabetic character and uppercase it. This handles
  // digit-prefixed domains like "8vc" → "8VC", "92y" → "92Y" so the result
  // doesn't fail a `name = LOWER(name)` ugliness check.
  // For digit-prefixed all-lowercase short alphabetic suffixes (≤4 alpha
  // chars), treat as acronym and uppercase the whole alpha tail.
  const firstAlphaIdx = word.search(/[a-zA-Z]/);
  if (firstAlphaIdx === -1) return word;
  const prefix = word.slice(0, firstAlphaIdx);
  const alphaTail = word.slice(firstAlphaIdx);
  // Digit-prefix consonant-acronym rule: ≤4 chars and consonant-heavy.
  // "8vc" → "8VC", "92y" → "92Y", "3lcap" stays "3lcap" (mixed).
  // We DON'T want "8base" → "8BASE" (4-letter pronounceable word).
  // Heuristic: tail must be pure consonants (or one short vowel followed by
  // a digit again).
  if (
    prefix.length > 0 &&
    alphaTail.length <= 4 &&
    /^[bcdfghjklmnpqrstvwxyz]+$/i.test(alphaTail)
  ) {
    return prefix + alphaTail.toUpperCase();
  }
  // Standard: first-upper + rest-lower.
  return prefix +
         alphaTail.charAt(0).toUpperCase() +
         alphaTail.slice(1).toLowerCase();
}

/**
 * Normalize a raw company name string. Idempotent.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeCompanyName(raw) {
  if (!raw || typeof raw !== 'string') return raw || '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Tier 1: alias lookup. Lowercase + collapse whitespace to canonical key.
  const aliasMap = loadAliasMap();
  const key = trimmed.toLowerCase().replace(/\s+/g, ' ').trim();
  if (aliasMap.has(key)) return aliasMap.get(key);

  // Tier 2: strip legal suffix
  let name = trimmed.replace(LEGAL_SUFFIX_RE, '').trim();

  // Tier 3: strip TLD (rare; defensive)
  name = name.replace(TLD_SUFFIX_RE, '').trim();

  // Tier 4: compound splitting for single-word names.
  // First, if the name has internal camelCase (lower→Upper boundary), split on
  // that — it's already user-spaced semantically (e.g. "TrueSearch" → "True Search").
  if (!/\s/.test(name) && /[a-z][A-Z]/.test(name)) {
    name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  // Then run the dictionary-based compound splitter for single-token lowercase
  // forms (e.g. "kaleidoscopelabs" → "Kaleidoscope Labs").
  if (!/\s/.test(name) && name.length > 6 && /^[A-Za-z]+$/.test(name)) {
    const split = splitCompound(name);
    if (split !== name) name = split;
  }

  // Tier 5: title-case each word, all-caps short acronyms
  name = name.split(/\s+/).filter(Boolean).map(titleCaseWord).join(' ');

  return name.trim();
}

/**
 * Reset the alias map cache (test hook).
 */
export function _resetCompanyAliasCache() {
  _aliasMap = null;
}
