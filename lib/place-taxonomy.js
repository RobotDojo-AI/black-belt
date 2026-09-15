/**
 * Place taxonomy — Foursquare 11-top + OSM amenity keyword dictionary.
 *
 * st_93fddaf0 Phase 7. Maps the 10 robotdojo ontology subtypes (declared in
 * routes/network.js ONTOLOGY_PLACE_SUBTYPES) plus two special subtypes
 * (virtual, travel) to keyword arrays for Tier 0 classification.
 *
 * North-star vocabulary: Foursquare's 11-top categorization
 * (https://docs.foursquare.com/data-products/docs/categories) and OSM amenity
 * tags (https://wiki.openstreetmap.org/wiki/Key:amenity). Both are
 * well-established personal-trajectory taxonomies; using their vocabularies
 * means the classifier benefits from decades of cartographic + LBS work.
 *
 * WHY a static dictionary, not an API call: a 1MB JSON map is loaded once at
 * boot; an API call per place would be a 6,191-place network round-trip on
 * every rebuild. Foursquare + OSM provide the vocabulary, not the runtime
 * dependency. Reference: Foursquare top-level docs + OSM Key:amenity wiki.
 *
 * WHY Tier 0 keyword regex (not embeddings): place names are short (median
 * ~3 words) and high-signal — "Joe's Pizzeria" maps cleanly to restaurant
 * without semantic lookup. Embedding-based classification is overkill at this
 * scale; reserve LLM (Haiku) for the long tail of unclassified names.
 *
 * Coverage estimate: ~40% of 6,191 places via Tier 0 (see Hakase research).
 * Remainder stays 'other' or is eligible for a future Haiku batch pass.
 */

/**
 * PLACE_TAXONOMY maps each robotdojo place_subtype to an array of keywords.
 * Keyword match is case-insensitive substring (NOT word-boundary — many
 * restaurants have "café" embedded in compound names like "TheCafé").
 *
 * Order matters: the classifier loops in declaration order, first match wins.
 * Earlier entries (restaurant, bar) catch high-volume cases first.
 *
 * The two trailing subtypes (virtual, travel) are NOT in the ONTOLOGY_PLACE_SUBTYPES
 * list — they classify special-cases for sidebar exclusion (virtual meetings,
 * airports). Setting hidden_in_sidebar=1 keeps them out of the place list while
 * still tagging them for completeness.
 */
export const PLACE_TAXONOMY = {
  restaurant: [
    'restaurant', 'cafe', 'café', 'diner', 'bistro', 'pizzeria', 'pizza',
    'sushi', 'burger', 'steakhouse', 'barbecue', 'barbeque', 'grill',
    'eatery', 'kitchen', 'taqueria', 'ramen', 'noodle', 'deli', 'bakery',
    'panera', 'chipotle', 'sweetgreen', 'shake shack', 'mcdonald',
  ],
  bar: [
    'bar', 'pub', 'tavern', 'brewery', 'brewpub', 'winery', 'wine bar',
    'cocktail', 'speakeasy', 'lounge', 'taproom',
  ],
  hotel: [
    'hotel', 'inn', 'resort', 'motel', 'suites', 'marriott', 'hilton',
    'hyatt', 'westin', 'sheraton', 'ritz', 'four seasons', 'w hotel',
    'airbnb',
  ],
  concert_hall: [
    'concert', 'theater', 'theatre', 'arena', 'stadium', 'amphitheater',
    'amphitheatre', 'music hall', 'opera', 'auditorium', 'venue',
    'performing arts',
  ],
  museum: [
    'museum', 'gallery', 'art museum', 'science museum', 'history museum',
    'exhibition', 'planetarium',
  ],
  library: [
    'library', 'public library', 'branch library',
  ],
  salon_spa: [
    'salon', 'spa', 'nail', 'barber', 'blowout', 'massage', 'beauty',
    'waxing', 'manicure',
  ],
  gym_fitness: [
    'gym', 'fitness', 'crossfit', 'yoga', 'pilates', 'soulcycle', 'soul cycle',
    'peloton', 'equinox', 'la fitness', 'planet fitness', 'workout',
    'climbing', 'spin studio',
  ],
  wellness: [
    'wellness', 'acupuncture', 'chiropractor', 'therapy', 'meditation',
    'physical therapy', 'rehab center', 'recovery', 'cryotherapy',
  ],
  park: [
    ' park', 'trail', 'nature', 'recreation area', 'botanical garden',
    'wildlife refuge', 'state park', 'national park', 'reservoir',
  ],
  // Special: virtual meetings — sidebar-hidden.
  virtual: [
    'teams meeting', 'microsoft teams', 'zoom.us', 'zoom call', 'google meet',
    'webex', 'hangout', 'conference call', 'phone call', 'phone meeting',
  ],
  // Special: travel/transit — sidebar-hidden.
  travel: [
    'airport', 'terminal', 'concourse', 'jfk', ' lax', ' ord', ' iad', ' phl',
    'train station', 'amtrak', 'penn station', 'union station', 'gate ',
  ],
};

// Subtypes that are sidebar-hidden when classified.
export const HIDDEN_SUBTYPES = new Set(['virtual', 'travel']);

/**
 * Classify a place name into one of the PLACE_TAXONOMY subtypes.
 *
 * Returns the first matching subtype (declaration order) or null if no
 * keyword matches. Caller can treat null as 'other' (the existing default).
 *
 * @param {string} name
 * @returns {string|null}
 */
export function classifyPlaceName(name) {
  if (!name || typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  for (const [subtype, keywords] of Object.entries(PLACE_TAXONOMY)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return subtype;
    }
  }
  return null;
}
