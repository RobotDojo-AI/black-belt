/**
 * US street address extraction from structured email content.
 * Targets known high-signal patterns: "Ship to", "Deliver to", "Mailing address".
 * Not a brute-force regex — looks where addresses are explicitly stated.
 */

const SUFFIX_MAP = { STREET: 'ST', AVENUE: 'AVE', BOULEVARD: 'BLVD', DRIVE: 'DR', ROAD: 'RD', LANE: 'LN', COURT: 'CT', PLACE: 'PL', CIRCLE: 'CIR', PARKWAY: 'PKWY', TERRACE: 'TERR', HIGHWAY: 'HWY' };
const UNIT_MAP = { APARTMENT: 'APT', SUITE: 'STE' };

// Context markers — only extract addresses near these phrases
const MARKERS = [
  'ship to', 'shipping to', 'deliver to', 'delivery address', 'delivered to',
  'mailing address', 'statement address', 'billing address', 'your address',
  'address on file', 'ship-to', 'shipping address',
];
const MARKER_RE = new RegExp(`(?:${MARKERS.join('|')})`, 'gi');

// Address block: number + street + optional unit, then city + 2-letter state + 5-digit zip
const ADDR_BLOCK = /(\d{1,5}\s+[\w\s.'-]{2,40}?\b(?:ST|STREET|AVE|AVENUE|BLVD|BOULEVARD|DR|DRIVE|RD|ROAD|LN|LANE|CT|COURT|PL|PLACE|WAY|PKWY|PARKWAY|PIKE|CIR|CIRCLE|TERR|TERRACE|RUN|WALK|HWY|HIGHWAY)\.?)(?:\s+(?:APT|APARTMENT|UNIT|STE|SUITE|#)\s*#?\s*([\w-]+))?\s*[,\n]\s*(?:UNITED\s+STATES\s*[,\n]\s*)?([\w\s]+?)\s*,?\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?/gi;

/**
 * Extract addresses from email body — only those near context markers.
 * Returns [{ street, city, state, zip }].
 */
export function extractAddresses(bodyText) {
  if (!bodyText) return [];
  const text = bodyText.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ');

  // Find all marker positions — only extract addresses within 500 chars after a marker
  const markerPositions = [];
  let mm;
  MARKER_RE.lastIndex = 0;
  while ((mm = MARKER_RE.exec(text)) !== null) markerPositions.push(mm.index);

  // If no markers found, skip this email entirely
  if (!markerPositions.length) return [];

  const results = [];
  let m;
  ADDR_BLOCK.lastIndex = 0;
  while ((m = ADDR_BLOCK.exec(text)) !== null) {
    // Only keep if this address is within 500 chars after a marker
    const pos = m.index;
    const nearMarker = markerPositions.some(mp => pos >= mp && pos <= mp + 500);
    if (!nearMarker) continue;

    let street = m[1].trim();
    if (m[2]) street += ' ' + m[2].trim();
    const city = m[3].trim();
    const state = m[4].toUpperCase();
    const zip = m[5];
    if (city.length < 2 || city.length > 30) continue;
    results.push({ street, city, state, zip });
  }
  return results;
}

/**
 * Normalize address to canonical form: "STREET, CITY, ST ZIP".
 */
export function normalizeAddress(street, city, state, zip) {
  let s = street.toUpperCase()
    .replace(/\b(STREET|AVENUE|BOULEVARD|DRIVE|ROAD|LANE|COURT|PLACE|CIRCLE|PARKWAY|TERRACE|HIGHWAY)\b/g, m => SUFFIX_MAP[m] || m)
    .replace(/\b(APARTMENT|SUITE)\b/g, m => UNIT_MAP[m] || m)
    .replace(/\s+/g, ' ').replace(/[.,]+$/, '').trim();
  return `${s}, ${city.toUpperCase().trim()}, ${state.toUpperCase()} ${zip}`;
}
