/**
 * Deterministic address normalization.
 * - Strips ZIP+4 tails
 * - Upper-cases components
 * - Standardizes street suffixes (Street -> ST, Avenue -> AVE)
 * - Collapses whitespace and punctuation
 *
 * If GOOGLE_MAPS_API_KEY is available, optionally verify via the Address
 * Validation API. Disabled by default — ontology is deterministic-first.
 */

import config from './config.js';

const SUFFIX_MAP = {
  STREET: 'ST', ST: 'ST',
  AVENUE: 'AVE', AVE: 'AVE', AV: 'AVE',
  BOULEVARD: 'BLVD', BLVD: 'BLVD',
  DRIVE: 'DR', DR: 'DR',
  ROAD: 'RD', RD: 'RD',
  LANE: 'LN', LN: 'LN',
  COURT: 'CT', CT: 'CT',
  PLACE: 'PL', PL: 'PL',
  CIRCLE: 'CIR', CIR: 'CIR',
  PARKWAY: 'PKWY', PKWY: 'PKWY',
  TERRACE: 'TER', TER: 'TER', TERR: 'TER',
  HIGHWAY: 'HWY', HWY: 'HWY',
  TRAIL: 'TRL', TRL: 'TRL',
  WAY: 'WAY',
  PIKE: 'PIKE',
};

const UNIT_MAP = { APARTMENT: 'APT', APT: 'APT', SUITE: 'STE', STE: 'STE', UNIT: 'UNIT' };

const DIRECTIONS = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW' };

function normalizeStreet(street) {
  if (!street) return '';
  return street
    .toUpperCase()
    .replace(/[.,;]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(tok => DIRECTIONS[tok] || SUFFIX_MAP[tok] || UNIT_MAP[tok] || tok)
    .join(' ')
    .trim();
}

function normalizeZip(zip) {
  if (!zip) return '';
  return String(zip).replace(/\D/g, '').slice(0, 5);
}

function normalizeState(region) {
  if (!region) return '';
  return String(region).toUpperCase().trim().slice(0, 2);
}

/**
 * Normalize an address object. Returns:
 * { line1, line2, city, region, postal_code, country, formatted, normalized_string }
 *
 * `normalized_string` is the canonical dedup key.
 */
export function normalizeAddress(input = {}) {
  const line1 = normalizeStreet(input.line1 || input.street || '');
  const line2 = input.line2 ? normalizeStreet(input.line2) : '';
  const city = (input.city || '').toUpperCase().trim();
  const region = normalizeState(input.region || input.state);
  const postal_code = normalizeZip(input.postal_code || input.zip);
  const country = (input.country || 'US').toUpperCase().trim();

  const parts = [line1, line2, city, region, postal_code, country].filter(Boolean);
  const normalized_string = parts.join(', ');

  const formatted = [
    [line1, line2].filter(Boolean).join(' '),
    city,
    [region, postal_code].filter(Boolean).join(' '),
    country,
  ].filter(Boolean).join(', ');

  return { line1, line2, city, region, postal_code, country, formatted, normalized_string };
}

/**
 * Optional: Google Address Validation API verification.
 * Returns the normalized object with coordinates merged in, or null on failure.
 * Never throws — callers fall back to deterministic normalization.
 */
export async function verifyWithGoogle(addr) {
  const key = process.env.GOOGLE_MAPS_API_KEY || config.googleMapsKey;
  if (!key) return null;
  try {
    const url = `https://addressvalidation.googleapis.com/v1:validateAddress?key=${key}`;
    const body = {
      address: {
        addressLines: [addr.line1, addr.line2].filter(Boolean),
        locality: addr.city,
        administrativeArea: addr.region,
        postalCode: addr.postal_code,
        regionCode: addr.country,
      },
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = data?.result;
    if (!result) return null;
    const g = result.geocode?.location;
    return {
      ...addr,
      coordinates: g ? { lat: g.latitude, lon: g.longitude } : undefined,
      geocode_source: 'google',
      geocode_confidence: result.verdict?.geocodeGranularity === 'PREMISE' ? 0.95 : 0.7,
    };
  } catch {
    return null;
  }
}
